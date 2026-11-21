// 颜色工具：帧缓冲区用 Uint32（小端序 ABGR），这里集中处理打包、拆分和混合。

export type RGB = [number, number, number];

export function hex(h: string): RGB {
  const n = parseInt(h.replace('#', ''), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function pack(r: number, g: number, b: number): number {
  r = r < 0 ? 0 : r > 255 ? 255 : r | 0;
  g = g < 0 ? 0 : g > 255 ? 255 : g | 0;
  b = b < 0 ? 0 : b > 255 ? 255 : b | 0;
  return (0xff000000 | (b << 16) | (g << 8) | r) >>> 0;
}

export function packRGB(c: RGB): number {
  return pack(c[0], c[1], c[2]);
}

export function mixRGB(a: RGB, b: RGB, t: number): RGB {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

export function scaleRGB(a: RGB, k: number): RGB {
  return [a[0] * k, a[1] * k, a[2] * k];
}

/** 两个打包颜色按 t（0..1）混合 */
export function mixPacked(a: number, b: number, t: number): number {
  const ar = a & 255, ag = (a >> 8) & 255, ab = (a >> 16) & 255;
  const br = b & 255, bg = (b >> 8) & 255, bb = (b >> 16) & 255;
  return pack(ar + (br - ar) * t, ag + (bg - ag) * t, ab + (bb - ab) * t);
}

/** 打包颜色乘亮度 */
export function shadePacked(a: number, k: number): number {
  return pack((a & 255) * k, ((a >> 8) & 255) * k, ((a >> 16) & 255) * k);
}

/** 打包颜色叠加（加法） */
export function addPacked(a: number, r: number, g: number, b: number): number {
  return pack((a & 255) + r, ((a >> 8) & 255) + g, ((a >> 16) & 255) + b);
}
