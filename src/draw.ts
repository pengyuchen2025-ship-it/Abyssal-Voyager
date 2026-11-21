// 小图元：带深度测试的矩形、椭圆、半透明点。所有物件都由它们拼成。

import { Renderer } from './renderer';

/** 比这个深度更近的物件做棋盘格半透明（挡在镜头和潜艇之间时不遮住潜艇），更近的直接不画 */
export const nearFade = { dither: 0, hide: 0, cx: 0, cy: 0, r2: Infinity };

function dithered(x: number, y: number) {
  if (!((x + y) & 1)) return false;
  const dx = x - nearFade.cx, dy = y - nearFade.cy;
  return dx * dx + dy * dy < nearFade.r2;
}

export function fillRect(r: Renderer, x0: number, y0: number, x1: number, y1: number, c: number, depth: number, writeZ = true) {
  const { W, H, buf, z } = r;
  if (depth < nearFade.hide) return;
  const dith = depth < nearFade.dither;
  if (x0 < 0) x0 = 0;
  if (y0 < 0) y0 = 0;
  if (x1 > W - 1) x1 = W - 1;
  if (y1 > H - 1) y1 = H - 1;
  for (let y = y0; y <= y1; y++) {
    let i = y * W + x0;
    for (let x = x0; x <= x1; x++, i++) {
      if (depth < z[i]) {
        if (dith && dithered(x, y)) continue;
        buf[i] = c;
        if (writeZ) z[i] = depth;
      }
    }
  }
}

/** 实心椭圆（水平切片在屏幕上的样子） */
export function fillEllipse(r: Renderer, cx: number, cy: number, rx: number, ry: number, c: number, depth: number) {
  if (depth < nearFade.hide) return;
  const dith = depth < nearFade.dither;
  if (rx < 0.75 && ry < 0.75) {
    fillRect(r, Math.floor(cx), Math.floor(cy), Math.floor(cx), Math.floor(cy), c, depth);
    return;
  }
  const { W, H, buf, z } = r;
  const y0 = Math.max(0, Math.floor(cy - ry)), y1 = Math.min(H - 1, Math.floor(cy + ry));
  for (let y = y0; y <= y1; y++) {
    const dy = (y + 0.5 - cy) / Math.max(ry, 0.5);
    const w = dy * dy >= 1 ? (ry < 1 ? rx : -1) : rx * Math.sqrt(1 - dy * dy);
    if (w < 0) continue;
    const x0 = Math.max(0, Math.round(cx - w)), x1 = Math.min(W - 1, Math.round(cx + w) - 1);
    let i = y * W + x0;
    for (let x = x0; x <= Math.max(x0, x1); x++, i++) {
      if (x >= W) break;
      if (depth < z[i]) {
        if (dith && dithered(x, y)) continue;
        buf[i] = c;
        z[i] = depth;
      }
    }
  }
}

/** 半透明混合一个像素（不写深度） */
export function blendPixel(r: Renderer, x: number, y: number, cr: number, cg: number, cb: number, a: number, depth: number) {
  x = Math.floor(x);
  y = Math.floor(y);
  if (x < 0 || y < 0 || x >= r.W || y >= r.H) return;
  const i = y * r.W + x;
  if (depth >= r.z[i]) return;
  const c = r.buf[i];
  const R = (c & 255) + (cr - (c & 255)) * a;
  const G = ((c >> 8) & 255) + (cg - ((c >> 8) & 255)) * a;
  const B = ((c >> 16) & 255) + (cb - ((c >> 16) & 255)) * a;
  r.buf[i] = (0xff000000 | ((B < 0 ? 0 : B > 255 ? 255 : B | 0) << 16) | ((G < 0 ? 0 : G > 255 ? 255 : G | 0) << 8) | (R < 0 ? 0 : R > 255 ? 255 : R | 0)) >>> 0;
}

/** 半透明实心椭圆 */
export function blendEllipse(r: Renderer, cx: number, cy: number, rx: number, ry: number, cr: number, cg: number, cb: number, a: number, depth: number) {
  const y0 = Math.floor(cy - ry), y1 = Math.floor(cy + ry);
  for (let y = y0; y <= y1; y++) {
    const dy = (y + 0.5 - cy) / Math.max(ry, 0.5);
    if (dy * dy > 1 && ry >= 1) continue;
    const w = ry < 1 ? rx : rx * Math.sqrt(Math.max(0, 1 - dy * dy));
    const x0 = Math.round(cx - w), x1 = Math.max(x0, Math.round(cx + w) - 1);
    for (let x = x0; x <= x1; x++) blendPixel(r, x, y, cr, cg, cb, a, depth);
  }
}

/** 加法提亮一个像素（光点、气泡） */
export function addPixel(r: Renderer, x: number, y: number, ar: number, ag: number, ab: number, depth: number) {
  x = Math.floor(x);
  y = Math.floor(y);
  if (x < 0 || y < 0 || x >= r.W || y >= r.H) return;
  const i = y * r.W + x;
  if (depth >= r.z[i]) return;
  const c = r.buf[i];
  let R = (c & 255) + ar, G = ((c >> 8) & 255) + ag, B = ((c >> 16) & 255) + ab;
  if (R > 255) R = 255;
  if (G > 255) G = 255;
  if (B > 255) B = 255;
  r.buf[i] = (0xff000000 | ((B | 0) << 16) | ((G | 0) << 8) | (R | 0)) >>> 0;
}
