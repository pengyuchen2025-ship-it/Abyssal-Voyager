// 海床绘制：每个屏幕列从近到远走，按镜头投影把高度图的点投到屏幕上，
// 只往这一列还没被占用的像素里写（占用掩码 = 每列当前最高的已写行 ybuf），
// 所以近处地形自然挡住远处。顶面像素加焦散光，下面的竖直面做暗。

import { Camera } from './camera';
import { Renderer } from './renderer';
import { World, MAX_H } from './world';
import { Water } from './water';

const OFF = 512 * 4096; // 让坐标为正，用 |0 代替 Math.floor

export interface TerrainOpts {
  far: number;
  caustics: number; // 焦散强度 0..1
}

export function renderTerrain(r: Renderer, cam: Camera, world: World, water: Water, o: TerrainOpts) {
  const { W, H, buf, z } = r;
  const D = cam.dist, s = cam.persp, zoom = cam.zoom;
  const cosP = cam.cosP, sinP = cam.sinP, gv = cam.ground, gl = cam.lift;
  const cx = cam.cx, cy = cam.cy, ch = cam.h, near = cam.near;
  const sinH = cam.sinH, cosH = cam.cosH, camX = cam.x, camY = cam.y;
  const mips = world.mips;
  const rowPacked = water.rowPacked;
  const fogLut = water.fogLut;
  const rowR = water.rowR, rowG = water.rowG, rowB = water.rowB;
  const caus = o.caustics;

  // 背景：每行的雾色，深度无限远
  for (let y = 0; y < H; y++) buf.fill(rowPacked[y], y * W, (y + 1) * W);
  z.fill(Infinity);

  // 起点：最高的地形平面落在屏幕底边时的前向距离；且不能在镜头背后
  let v0 = cam.rowToPlane(H + 2, MAX_H - ch);
  const vNear = cosP > 0.02 ? (near + 1 - D + Math.max(0, MAX_H - ch) * sinP) / cosP : -Infinity;
  if (Number.isNaN(v0)) v0 = vNear;
  v0 = Math.max(v0, vNear);
  // 终点：最低平面落在屏幕顶边的位置（看到水平线以上时用雾的极限距离）
  let vFar = cam.rowToPlane(-2, -ch);
  if (Number.isNaN(vFar) || vFar > o.far) vFar = o.far;
  if (!(v0 < vFar)) return;

  // 取样点对齐到世界里固定的网格（步长取 2 的幂），镜头移动时每帧取到的是同一批格子，
  // 画面只是整体平移，不会因为取样位置错开而闪烁
  const pvW = camX * sinH + camY * cosH;
  // 步长只看前向距离（不看地形高低），同一个取样点不会因为高低不同来回跳档
  const stepFor = (k: number) => {
    const d = 1.6 / k;
    return d < 1 ? 0.5 : d < 2 ? 1 : d < 4 ? 2 : d < 8 ? 4 : d < 16 ? 8 : 16;
  };
  for (let x = 0; x < W; x++) {
    let ybuf = H;
    let hPrev = Math.min(ch, 40);
    let lastDv = 1;
    const d0 = stepFor(zoom * (1 - s + (s * D) / Math.max(near, D + v0 * cosP)));
    let v = Math.ceil((v0 + pvW) / d0) * d0 - pvW;
    const px = x + 0.5 - cx;
    while (v < vFar && ybuf > 0) {
      // 用上一个点的高度估计深度和缩放，求出这一列在该前向距离处的横向位置
      // （高度差带来的缩放误差很小，省掉第二次采样）
      let dh = hPrev - ch;
      let depth = D + v * cosP - dh * sinP;
      if (depth < near) {
        v = (Math.floor((v + pvW) * 2 + 1e-9) + 1) / 2 - pvW;
        continue;
      }
      let k = zoom * (1 - s + (s * D) / depth);
      const lvl = k >= 0.75 ? 0 : k >= 0.38 ? 1 : k >= 0.19 ? 2 : 3;
      const mip = mips[lvl];
      const msz = mip.size - 1, mh = mip.height, sh = mip.shift;
      const u = px / k;
      const wx = camX + u * cosH + v * sinH;
      const wy = camY - u * sinH + v * cosH;
      const ix = (wx + OFF) | 0, iy = (wy + OFF) | 0;
      const idx = (((iy >> sh) & msz) * mip.size) + ((ix >> sh) & msz);
      const hh = lvl === 0 ? mh[idx] : bilerp(mh, mip.size, wx + OFF, wy + OFF, sh);
      dh = hh - ch;
      depth = D + v * cosP - dh * sinP;
      if (depth < near) {
        v = (Math.floor((v + pvW) * 2 + 1e-9) + 1) / 2 - pvW;
        hPrev = hh;
        continue;
      }
      k = zoom * (1 - s + (s * D) / depth);
      const sy = cy - (v * gv + dh * gl) * k;
      const top = Math.floor(sy);
      if (top < ybuf) {
        const ys = top < 0 ? 0 : top;
        const c = mip.color[idx];
        let r0 = c & 255, g0 = (c >> 8) & 255, b0 = (c >> 16) & 255;
        let fi = (depth * 0.5) | 0;
        if (fi > 2047) fi = 2047;
        const f = fogLut[fi];
        // 顶面：焦散（浅处更亮）
        if (caus > 0 && top >= 0) {
          const cv = water.causticAt(wx, wy) * caus * (0.35 + 0.65 * (hh / MAX_H));
          r0 += 95 * cv;
          g0 += 125 * cv;
          b0 += 110 * cv;
        }
        // 这一步的地面本身在屏幕上占几行；超出部分（且比上一个点高）才是竖直面
        const faceFrom = hh > hPrev + 0.5 ? top + Math.max(1, Math.ceil(lastDv * gv * k)) : 1 << 30;
        for (let y = ys; y < ybuf; y++) {
          let R = r0, G = g0, B = b0;
          if (y >= faceFrom) {
            // 竖直面：更暗、更冷
            R = (c & 255) * 0.62;
            G = ((c >> 8) & 255) * 0.68;
            B = ((c >> 16) & 255) * 0.74;
          }
          if (f > 0.002) {
            R += (rowR[y] - R) * f;
            G += (rowG[y] - G) * f;
            B += (rowB[y] - B) * f;
          }
          if (R > 255) R = 255;
          if (G > 255) G = 255;
          if (B > 255) B = 255;
          const i = y * W + x;
          buf[i] = (0xff000000 | ((B | 0) << 16) | ((G | 0) << 8) | (R | 0)) >>> 0;
          z[i] = depth;
        }
        ybuf = ys;
      }
      hPrev = hh;
      // 竖直方向上地面被压缩得很厉害，按约 1.5 像素前进就够了；步长取 2 的幂并对齐网格
      const dv = stepFor(zoom * (1 - s + (s * D) / Math.max(near, D + v * cosP)));
      v = (Math.floor((v + pvW) / dv + 1e-9) + 1) * dv - pvW;
      lastDv = dv;
    }
  }
}

/** 低精度层用双线性高度，远处地形更平滑 */
function bilerp(mh: Float32Array, size: number, wx: number, wy: number, sh: number): number {
  const m = size - 1;
  const fx = wx / (1 << sh) - 0.5, fy = wy / (1 << sh) - 0.5;
  const x0 = Math.floor(fx), y0 = Math.floor(fy);
  const tx = fx - x0, ty = fy - y0;
  const a = mh[(y0 & m) * size + (x0 & m)], b = mh[(y0 & m) * size + ((x0 + 1) & m)];
  const c = mh[((y0 + 1) & m) * size + (x0 & m)], d = mh[((y0 + 1) & m) * size + ((x0 + 1) & m)];
  return a + (b - a) * tx + (c - a) * ty + (a - b - c + d) * tx * ty;
}
