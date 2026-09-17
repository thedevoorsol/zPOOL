import { useEffect, useRef } from 'react';

/**
 * Full-screen encrypted field. Pure canvas 2D, no assets.
 *
 * Three parallax layers of a hex-glyph grid drift slowly. Every cell's state is a pure
 * function of (world column, world row, time), so drifting costs nothing and there is no
 * per-cell mutable state. Cells "resolve": they flicker through noise, lock onto a glyph,
 * hold, then dissolve. On top: a few ciphertext fragments and two slow scanning bands.
 * Glyphs fade out toward the centre so the card always sits on calm ground.
 *
 * Depth: four parallax layers (far/dim/large to near/small/sharp) plus a CSS vignette (.bg-vignette,
 * zero per-frame cost).
 * Every ~20 s a "decrypt sweep" crosses the screen: a narrow vertical band where every
 * cell briefly resolves into readable hex, then dissolves back into noise behind it.
 */

const GLYPHS = '0123456789abcdef';
const NOISE = '0123456789abcdef#:=/<>{}[]|~*';
const ACCENT = { r: 160, g: 145, b: 255 }; // cool violet
const NEUTRAL = { r: 168, g: 166, b: 196 };
const BRIGHT = { r: 236, g: 235, b: 250 }; // sweep: glyphs resolved into readable hex

const SWEEP_EVERY = 20; // seconds between decrypt sweeps (+ jitter)
const SWEEP_DUR = 2.6; // seconds for the band to cross the screen
const SWEEP_HALF = 70; // css px, half width of the resolved band
const SWEEP_TRAIL = 220; // css px behind the band where glyphs dissolve

type Layer = {
  cell: number; // css px
  font: number;
  vx: number; // drift, css px / s
  vy: number;
  alpha: number; // max alpha
  density: number; // 0..1 share of cells that ever light up
  seed: number;
  atlas: HTMLCanvasElement | null;
  atlasNoise: HTMLCanvasElement | null;
  atlasBright: HTMLCanvasElement | null;
  sprite: number; // device px per sprite
};

const LAYERS: Omit<Layer, 'atlas' | 'atlasNoise' | 'atlasBright' | 'sprite'>[] = [
  { cell: 44, font: 19, vx: 2.2, vy: -1.2, alpha: 0.07, density: 0.18, seed: 5 }, // far: big, dim, slow
  { cell: 30, font: 13, vx: 4.5, vy: -2.5, alpha: 0.28, density: 0.30, seed: 11 },
  { cell: 22, font: 11, vx: -3.0, vy: -1.6, alpha: 0.20, density: 0.28, seed: 23 },
  { cell: 16, font: 9, vx: 1.5, vy: 1.0, alpha: 0.11, density: 0.24, seed: 37 },
];

function hash(a: number, b: number, c: number): number {
  let h = (a * 374761393 + b * 668265263 + c * 2246822519) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return h >>> 0;
}

// Smooth bump: 0 -> 1 -> 0 across u in [0, 1]. Returns [alpha, phase] where phase is
// 0 = resolving from noise, 1 = locked, 2 = dissolving.
function envelope(u: number): [number, number] {
  if (u < 0.22) return [smooth(u / 0.22), 0];
  if (u < 0.62) return [1, 1];
  if (u < 0.86) return [1 - smooth((u - 0.62) / 0.24), 2];
  return [0, 2];
}
function smooth(x: number): number {
  return x * x * (3 - 2 * x);
}

function makeAtlas(chars: string, font: number, sprite: number, dpr: number, tint: { r: number; g: number; b: number }): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = sprite * chars.length;
  c.height = sprite;
  const g = c.getContext('2d')!;
  g.font = `500 ${font * dpr}px "Geist Mono", "JetBrains Mono", ui-monospace, Menlo, monospace`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillStyle = `rgb(${tint.r},${tint.g},${tint.b})`;
  for (let i = 0; i < chars.length; i++) g.fillText(chars[i], i * sprite + sprite / 2, sprite / 2 + 0.5 * dpr);
  return c;
}

type Fragment = { text: string; x: number; y: number; speed: number; t0: number; life: number; layer: number };

function randomCipher(): string {
  const n = 6 + Math.floor(Math.random() * 8);
  const words: string[] = [];
  for (let i = 0; i < n; i++) {
    let w = '';
    const len = 2 + Math.floor(Math.random() * 4);
    for (let j = 0; j < len; j++) w += GLYPHS[Math.floor(Math.random() * 16)];
    words.push(w);
  }
  return words.join(' ');
}

export function Background() {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current as HTMLCanvasElement | null;
    if (!canvas) return;
    const cv: HTMLCanvasElement = canvas;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)');
    if (reduce.matches) return; // static gradient from CSS

    const ctx = canvas.getContext('2d', { alpha: true });
    if (!ctx) return;

    let dpr = 1;
    let W = 0;
    let H = 0;
    let raf = 0;
    let running = true;
    const layers: Layer[] = LAYERS.map((l) => ({ ...l, atlas: null, atlasNoise: null, atlasBright: null, sprite: 0 }));
    const fragments: Fragment[] = [];
    let bandGrad: CanvasGradient | null = null;
    let sweepAt = 7 + Math.random() * 4; // first sweep a few seconds after landing
    let sweepDir = 1;

    function resize() {
      dpr = Math.min(window.devicePixelRatio || 1, 1.5);
      W = window.innerWidth;
      H = window.innerHeight;
      cv.width = Math.round(W * dpr);
      cv.height = Math.round(H * dpr);
      for (const l of layers) {
        l.sprite = Math.ceil(l.cell * dpr);
        l.atlas = makeAtlas(GLYPHS, l.font, l.sprite, dpr, NEUTRAL);
        l.atlasNoise = makeAtlas(NOISE, l.font, l.sprite, dpr, ACCENT);
        l.atlasBright = makeAtlas(GLYPHS, l.font, l.sprite, dpr, BRIGHT);
      }
      bandGrad = ctx!.createLinearGradient(0, 0, 0, 160 * dpr);
      bandGrad.addColorStop(0, 'rgba(160,145,255,0)');
      bandGrad.addColorStop(0.5, 'rgba(160,145,255,0.045)');
      bandGrad.addColorStop(1, 'rgba(160,145,255,0)');
    }

    function spawnFragment(now: number, initial = false) {
      const layer = Math.random() < 0.5 ? 0 : 1;
      fragments.push({
        text: randomCipher(),
        x: Math.random() * W,
        y: Math.random() * H,
        speed: (Math.random() < 0.5 ? -1 : 1) * (4 + Math.random() * 6),
        t0: initial ? now - Math.random() * 10 : now,
        life: 12 + Math.random() * 10,
        layer,
      });
    }

    const start = performance.now();
    let last = start;

    function frame(nowMs: number) {
      if (!running) return;
      const t = (nowMs - start) / 1000;
      const dt = Math.min(0.05, (nowMs - last) / 1000);
      last = nowMs;

      ctx!.setTransform(1, 0, 0, 1, 0, 0);
      ctx!.clearRect(0, 0, cv.width, cv.height);

      const cx = W / 2;
      const cy = H / 2;
      const calmR = Math.min(W, H) * 0.24; // radius where the card sits
      const fadeR = Math.min(W, H) * 0.42;

      // Decrypt sweep: a band crossing horizontally. sweepX < -1e8 means inactive.
      let sweepX = -1e9;
      if (t >= sweepAt) {
        const u = (t - sweepAt) / SWEEP_DUR;
        if (u >= 1) {
          sweepAt = t + SWEEP_EVERY - 3 + Math.random() * 6;
          sweepDir = Math.random() < 0.5 ? -1 : 1;
        } else {
          const span = W + 2 * (SWEEP_HALF + SWEEP_TRAIL);
          const e = u < 0.5 ? 2 * u * u : 1 - Math.pow(-2 * u + 2, 2) / 2; // ease in-out
          sweepX = sweepDir > 0 ? -(SWEEP_HALF + SWEEP_TRAIL) + e * span : W + SWEEP_HALF + SWEEP_TRAIL - e * span;
        }
      }
      const sweeping = sweepX > -1e8;

      // Glyph layers, far to near.
      for (let li = 0; li < layers.length; li++) {
        const l = layers[li];
        if (!l.atlas || !l.atlasNoise || !l.atlasBright) continue;
        const cs = l.cell;
        const ox = t * l.vx;
        const oy = t * l.vy;
        const c0 = Math.floor(ox / cs);
        const r0 = Math.floor(oy / cs);
        const fx = ox - c0 * cs; // fractional offset in css px
        const fy = oy - r0 * cs;
        const cols = Math.ceil(W / cs) + 2;
        const rows = Math.ceil(H / cs) + 2;
        const sp = l.sprite;
        const gate = l.density * 4294967295;

        const sweepGate = 0.92 * 4294967295; // inside the band nearly every cell lights up

        for (let r = -1; r < rows; r++) {
          const y = r * cs - fy;
          const wr = r + r0;
          for (let c = -1; c < cols; c++) {
            const wc = c + c0;
            const h = hash(wc, wr, l.seed);
            const x = c * cs - fx;

            // Sweep influence for this column: band (resolve) and trail (dissolve).
            let band = 0;
            let trail = 0;
            if (sweeping) {
              const dxs = (x - sweepX) * sweepDir; // >0 ahead of the band, <0 behind it
              if (dxs > -SWEEP_HALF && dxs < SWEEP_HALF) band = 1 - Math.abs(dxs) / SWEEP_HALF;
              else if (dxs <= -SWEEP_HALF && dxs > -SWEEP_HALF - SWEEP_TRAIL) trail = 1 - (-dxs - SWEEP_HALF) / SWEEP_TRAIL;
            }

            if (h > gate && !(band > 0 && h <= sweepGate) && !(trail > 0 && h <= sweepGate)) continue;
            const period = 7 + (h & 7) * 1.3;
            const phase = ((h >>> 3) & 1023) / 1024;
            const u = (t / period + phase) % 1;
            let [a0, ph] = envelope(u);
            if (h > gate) a0 = 0; // a cell only lit by the sweep
            if (band > 0) {
              a0 = Math.max(a0, smooth(band));
              ph = 1;
            } else if (trail > 0) {
              a0 = Math.max(a0, 0.7 * trail * trail);
              if (h > gate || ph !== 1) ph = 2;
            }
            if (a0 <= 0.01) continue;
            // Calm zone behind the card.
            const dx = x - cx;
            const dy = y - cy;
            const d = Math.sqrt(dx * dx + dy * dy);
            let a = a0 * l.alpha;
            if (d < fadeR) {
              const k = d < calmR ? 0 : (d - calmR) / (fadeR - calmR);
              a *= 0.08 + 0.92 * smooth(k);
            }
            if (a <= 0.01) continue;
            const accentCell = ((h >>> 13) & 15) === 0;
            let atlas = l.atlas;
            let idx: number;
            if (band > 0) {
              // Resolved: readable hex, brighter the closer to the band's centre.
              idx = (h >>> 17) & 15;
              atlas = band > 0.35 ? l.atlasBright : l.atlas;
              a = Math.min(1, a * (1 + 1.6 * band));
            } else if (ph === 1) {
              idx = (h >>> 17) & 15;
              if (accentCell) atlas = l.atlasNoise;
            } else {
              // Resolving or dissolving: flicker through noise.
              const tick = Math.floor(t * 14 + (h & 255));
              idx = hash(tick, wc ^ wr, l.seed) % NOISE.length;
              atlas = l.atlasNoise;
              a *= 0.85;
            }
            ctx!.globalAlpha = a;
            ctx!.drawImage(atlas, idx * sp, 0, sp, sp, Math.round(x * dpr), Math.round(y * dpr), sp, sp);
          }
        }
      }

      // Ciphertext fragments.
      while (fragments.length < 9) spawnFragment(t, fragments.length === 0);
      ctx!.textBaseline = 'middle';
      for (let i = fragments.length - 1; i >= 0; i--) {
        const f = fragments[i];
        const age = t - f.t0;
        if (age > f.life) {
          fragments.splice(i, 1);
          continue;
        }
        f.x += f.speed * dt;
        const u = age / f.life;
        const fade = u < 0.2 ? u / 0.2 : u > 0.8 ? (1 - u) / 0.2 : 1;
        const dx = f.x - cx;
        const dy = f.y - cy;
        const d = Math.sqrt(dx * dx + dy * dy);
        const calm = d < calmR ? 0.1 : d < fadeR ? 0.1 + 0.9 * smooth((d - calmR) / (fadeR - calmR)) : 1;
        const size = f.layer === 0 ? 11 : 9.5;
        ctx!.font = `400 ${size * dpr}px "Geist Mono", "JetBrains Mono", ui-monospace, Menlo, monospace`;
        ctx!.globalAlpha = 0.28 * fade * calm;
        ctx!.fillStyle = 'rgb(180,176,215)';
        ctx!.fillText(f.text, f.x * dpr, f.y * dpr);
      }

      // Scanning bands.
      if (bandGrad) {
        ctx!.globalAlpha = 1;
        ctx!.fillStyle = bandGrad;
        const y1 = ((t * 9) % (H + 320)) - 160;
        const y2 = H + 160 - ((t * 5.5 + 300) % (H + 320));
        ctx!.setTransform(1, 0, 0, 1, 0, y1 * dpr);
        ctx!.fillRect(0, 0, W * dpr, 160 * dpr);
        ctx!.setTransform(1, 0, 0, 1, 0, y2 * dpr);
        ctx!.fillRect(0, 0, W * dpr, 160 * dpr);
      }

      // Sweep glow: a thin vertical light where glyphs are resolving.
      if (sweeping) {
        ctx!.setTransform(1, 0, 0, 1, 0, 0);
        const g = ctx!.createLinearGradient((sweepX - SWEEP_HALF) * dpr, 0, (sweepX + SWEEP_HALF) * dpr, 0);
        g.addColorStop(0, 'rgba(160,145,255,0)');
        g.addColorStop(0.5, 'rgba(200,190,255,0.06)');
        g.addColorStop(1, 'rgba(160,145,255,0)');
        ctx!.globalAlpha = 1;
        ctx!.fillStyle = g;
        ctx!.fillRect((sweepX - SWEEP_HALF) * dpr, 0, 2 * SWEEP_HALF * dpr, H * dpr);
      }

      raf = requestAnimationFrame(frame);
    }

    const onVisibility = () => {
      if (document.hidden) {
        running = false;
        cancelAnimationFrame(raf);
      } else if (!running) {
        running = true;
        last = performance.now();
        raf = requestAnimationFrame(frame);
      }
    };

    resize();
    window.addEventListener('resize', resize);
    document.addEventListener('visibilitychange', onVisibility);
    raf = requestAnimationFrame(frame);
    // Fonts may finish loading after the first atlas; rebuild once they do.
    document.fonts?.ready.then(() => resize()).catch(() => undefined);

    return () => {
      running = false;
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', resize);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);

  return (
    <>
      <canvas ref={ref} className="bg" aria-hidden="true" />
      <div className="bg-vignette" aria-hidden="true" />
    </>
  );
}
