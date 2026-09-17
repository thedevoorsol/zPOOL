import type { SVGProps } from 'react';

const base: SVGProps<SVGSVGElement> = { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true };

export const Lock = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base} {...p}><rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></svg>
);
export const Qr = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base} {...p}><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><path d="M14 14h3v3h-3zM20 14v.01M14 20h.01M17.5 20.5H21v-3" /></svg>
);
export const Check = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base} {...p}><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>
);
export const Close = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base} {...p}><path d="M6 6l12 12M18 6L6 18" /></svg>
);
export const Chevron = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base} {...p}><path d="M7 10l5 5 5-5" /></svg>
);
export const Copy = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base} {...p}><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V6a2 2 0 0 1 2-2h9" /></svg>
);
export const External = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base} {...p}><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" /></svg>
);
export const Search = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base} {...p}><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" /></svg>
);
export const Wallet = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base} {...p}><path d="M3 7a2 2 0 0 1 2-2h13a1 1 0 0 1 1 1v2" /><rect x="3" y="7" width="18" height="12" rx="2" /><path d="M16 13h2" /></svg>
);
export const Spinner = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base} {...p} className={`spin ${p.className ?? ''}`}><path d="M12 3a9 9 0 1 0 9 9" /></svg>
);
export const Alert = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base} {...p}><circle cx="12" cy="12" r="9" /><path d="M12 8v5M12 16v.01" /></svg>
);
