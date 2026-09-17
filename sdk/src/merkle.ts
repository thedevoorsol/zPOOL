/** Client-side mirror of the on-chain Poseidon Merkle tree (height 26, zero leaf = 0). */
import { poseidon } from './crypto';

export const TREE_LEVELS = 26;

export class MerkleTree {
  readonly levels: number;
  private zeros: string[] = [];
  private layers: string[][] = [];

  constructor(levels = TREE_LEVELS, leaves: string[] = []) {
    this.levels = levels;
    this.zeros[0] = '0';
    for (let i = 1; i <= levels; i++) this.zeros[i] = poseidon([this.zeros[i - 1], this.zeros[i - 1]]);
    this.layers[0] = [...leaves];
    this.rebuild();
  }

  private rebuild(from = 0): void {
    for (let level = 1; level <= this.levels; level++) {
      const below = this.layers[level - 1];
      const layer = (this.layers[level] ??= []);
      const start = Math.floor(from / 2 ** level);
      const count = Math.ceil(below.length / 2);
      for (let i = start; i < count; i++) {
        const left = below[i * 2];
        const right = i * 2 + 1 < below.length ? below[i * 2 + 1] : this.zeros[level - 1];
        layer[i] = poseidon([left, right]);
      }
      layer.length = count;
    }
  }

  get size(): number {
    return this.layers[0].length;
  }

  root(): string {
    return this.layers[this.levels].length ? this.layers[this.levels][0] : this.zeros[this.levels];
  }

  insert(leaf: string): number {
    const idx = this.layers[0].length;
    this.layers[0].push(leaf);
    this.rebuild(idx);
    return idx;
  }

  bulkInsert(leaves: string[]): void {
    if (!leaves.length) return;
    const from = this.layers[0].length;
    this.layers[0].push(...leaves);
    this.rebuild(from);
  }

  /** Sibling path for a leaf: elements bottom-up; pathIndices is the leaf index itself (circuit does Num2Bits). */
  path(index: number): { pathElements: string[]; pathIndices: number } {
    if (index < 0 || index >= this.layers[0].length) throw new Error(`leaf ${index} not in tree`);
    const pathElements: string[] = [];
    let i = index;
    for (let level = 0; level < this.levels; level++) {
      const sibling = i % 2 === 0 ? i + 1 : i - 1;
      pathElements.push(sibling < this.layers[level].length ? this.layers[level][sibling] : this.zeros[level]);
      i = Math.floor(i / 2);
    }
    return { pathElements, pathIndices: index };
  }

  zeroPath(): string[] {
    return new Array(this.levels).fill('0');
  }
}
