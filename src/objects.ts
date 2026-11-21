// 立起来的物件：海带、珊瑚（切片叠层，从海床往上一层层画），
// 固定深度的漂浮层：水母群（半透明圆顶 + 触须）和鱼群（小剪影）。
// 所有物件按深度从远到近排序后绘制，并与地形做逐像素深度测试。

import { Camera, WORLD, Projected } from './camera';
import { Renderer } from './renderer';
import { World, Band, SURFACE_H } from './world';
import { Water } from './water';
import { fbmMap, hash2, smoothstep } from './noise';
import { hex, mixRGB, pack, RGB } from './color';
import { fillRect, fillEllipse, blendEllipse, blendPixel, nearFade } from './draw';

export const FLOAT_H = 128; // 漂浮层（水母）的高度

const enum Kind { Kelp, Tube, Branch, Bush }

interface Plant {
  x: number; y: number; h0: number; len: number; kind: Kind; phase: number; region: number; seed: number;
}
interface Jelly { x: number; y: number; h: number; size: number; phase: number; region: number; drift: number }
interface School { ax: number; ay: number; rad: number; speed: number; h: number; n: number; phase: number; dark: boolean }

// 颜色（青绿区 / 紫雾区）
const KELP_DARK: [RGB, RGB] = [hex('#2F5A3A'), hex('#3A2A52')];
const KELP_MID: [RGB, RGB] = [hex('#7FB04A'), hex('#8A5A9C')];
const KELP_TIP: [RGB, RGB] = [hex('#C8E07A'), hex('#C49AD0')];
const TUBE: RGB = hex('#C9B26A');
const TUBE_IN: RGB = hex('#5E4E2A');
const BRANCH: RGB = hex('#D88AA8');
const BRANCH_TIP: RGB = hex('#F6C6D6');
const BUSH: RGB = hex('#A04A9C');
const BUSH_HI: RGB = hex('#D07ACB');
const JELLY: [RGB, RGB] = [hex('#BFF6F2'), hex('#F0B8E4')];
const FISH_DARK: RGB = hex('#1B3644');
const FISH_LIGHT: RGB = hex('#A9D8DA');

function shadeAt(h: number) {
  return 0.72 + 0.4 * smoothstep(0, SURFACE_H, h);
}

export class Life {
  plants: Plant[] = [];
  jellies: Jelly[] = [];
  schools: School[] = [];
  lastCount = 0;

  // 每帧的绘制队列
  private qDepth = new Float32Array(8192);
  private qType = new Uint8Array(8192);
  private qIdx = new Int32Array(8192);
  private qU = new Float32Array(8192);
  private qV = new Float32Array(8192);
  private order: number[] = [];
  private pj: Projected = { x: 0, y: 0, depth: 0, k: 0 };

  constructor(private world: World, seed = 3) {
    const N = WORLD;
    const forest = fbmMap(N, 8, 2, seed + 91); // 海带林密度
    const reef = fbmMap(N, 16, 2, seed + 92); // 珊瑚密度
    const floatMap = fbmMap(N, 4, 2, seed + 93); // 漂浮层（水母）密度：另一张独立的循环噪声图
    const G = 6;
    for (let gy = 0; gy < N / G; gy++) {
      for (let gx = 0; gx < N / G; gx++) {
        const hx = hash2(gx, gy, seed), hy = hash2(gx, gy, seed + 1), hk = hash2(gx, gy, seed + 2);
        const x = gx * G + hx * G, y = gy * G + hy * G;
        const i = (Math.floor(y) & (N - 1)) * N + (Math.floor(x) & (N - 1));
        const b = world.band[i];
        const h0 = world.height[i];
        const reg = world.region[i];
        const f = forest[i];
        if ((b === Band.Grass || b === Band.Carpet || b === Band.LightSand) && f > 0.5 && hk < (f - 0.5) * 3.2) {
          this.plants.push({ x, y, h0, len: 34 + hash2(gx, gy, seed + 3) * 52 * (0.6 + f), kind: Kind.Kelp, phase: hk * 40, region: reg, seed: Math.floor(hk * 1000) });
        } else if ((b === Band.Sand || b === Band.LightSand || b === Band.Carpet) && reef[i] > 0.52 && hk < (reef[i] - 0.52) * 1.4) {
          const r3 = hash2(gx, gy, seed + 4);
          const kind = r3 < 0.38 ? Kind.Tube : r3 < 0.72 ? Kind.Branch : Kind.Bush;
          this.plants.push({ x, y, h0, len: 5 + hash2(gx, gy, seed + 5) * 7, kind, phase: hk * 40, region: reg, seed: Math.floor(r3 * 1000) });
        }
      }
    }
    // 水母：漂浮层噪声高的地方成群出现
    for (let gy = 0; gy < N / 32; gy++) {
      for (let gx = 0; gx < N / 32; gx++) {
        const cxw = gx * 32 + 16, cyw = gy * 32 + 16;
        const d = floatMap[cyw * N + cxw];
        if (d < 0.6) continue;
        const n = 1 + Math.floor((d - 0.6) * 10);
        for (let j = 0; j < n; j++) {
          const x = cxw + (hash2(gx * 7 + j, gy, 11) - 0.5) * 34;
          const y = cyw + (hash2(gx, gy * 7 + j, 12) - 0.5) * 34;
          this.jellies.push({
            x, y, h: FLOAT_H + (hash2(gx + j, gy, 13) - 0.5) * 22, size: 2.6 + hash2(gx, gy + j, 14) * 2.4,
            phase: hash2(j, gx + gy, 15) * 6.28, region: world.regionAt(x, y), drift: hash2(gx, gy, 16) * 6.28,
          });
        }
      }
    }
    // 鱼群：绕着锚点转圈
    for (let s = 0; s < 14; s++) {
      this.schools.push({
        ax: hash2(s, 1, 21) * N, ay: hash2(s, 2, 21) * N, rad: 30 + hash2(s, 3, 21) * 60,
        speed: (0.12 + hash2(s, 4, 21) * 0.12) * (s % 2 ? 1 : -1), h: 40 + hash2(s, 5, 21) * 90,
        n: 14 + Math.floor(hash2(s, 6, 21) * 26), phase: hash2(s, 7, 21) * 6.28, dark: hash2(s, 8, 21) < 0.7,
      });
    }
  }

  /** 与潜艇一起绘制；subDepth / drawSub 由外部给出，保证潜艇和海带之间遮挡正确 */
  draw(r: Renderer, cam: Camera, water: Water, t: number, far: number, subDepth: number, drawSub: () => void, chase = 0, subX = 0, subY = 0, inside = false) {
    // 挡在镜头和潜艇之间的物件做半透明（尾随）；潜望镜里贴着镜头的不画、稍远的半透明
    // 潜望镜里：贴着镜头的物件不画，稍远一点的半透明，免得窗外全是巨大的色块
    nearFade.dither = inside ? 70 : chase > 0.5 ? subDepth - 6 : subDepth - 2;
    nearFade.hide = inside ? 24 : chase > 0.5 ? 22 : 0;
    nearFade.cx = subX;
    nearFade.cy = subY;
    nearFade.r2 = chase > 0.5 ? Infinity : (24 * cam.zoom) ** 2;
    const pj = this.pj;
    const ahead = cam.cosP * Math.min(far * 0.45, 220); // 循环窗口往前挪，尾随时能看到更远
    const wcx = cam.x + cam.sinH * ahead, wcy = cam.y + cam.cosH * ahead;
    let n = 0;
    const halfW = r.W * 0.5 + 20;
    const push = (type: number, idx: number, wx: number, wy: number, wh: number) => {
      let dx = wx - wcx, dy = wy - wcy;
      dx -= Math.round(dx / WORLD) * WORLD;
      dy -= Math.round(dy / WORLD) * WORLD;
      dx += wcx - cam.x;
      dy += wcy - cam.y;
      const u = dx * cam.cosH - dy * cam.sinH;
      const v = dx * cam.sinH + dy * cam.cosH;
      if (!cam.projectCam(u, v, wh - cam.h, pj)) return;
      if (pj.depth > far) return;
      if (Math.abs(pj.x - cam.cx) > halfW + 26 * pj.k) return;
      // 物件从底部往上长：底部在屏幕顶边以上、或整株都在底边以下，就不画
      if (pj.y < -12 || pj.y - 95 * Math.max(0.05, cam.lift) * pj.k > r.H + 4) return;
      if (n >= this.qDepth.length) return;
      this.qDepth[n] = pj.depth;
      this.qType[n] = type;
      this.qIdx[n] = idx;
      this.qU[n] = u;
      this.qV[n] = v;
      n++;
    };
    for (let i = 0; i < this.plants.length; i++) {
      const p = this.plants[i];
      push(0, i, p.x, p.y, p.h0);
    }
    for (let i = 0; i < this.jellies.length; i++) {
      const j = this.jellies[i];
      push(1, i, j.x + Math.cos(j.drift) * t * 0.9, j.y + Math.sin(j.drift) * t * 0.9, j.h);
    }
    for (let i = 0; i < this.schools.length; i++) {
      const s = this.schools[i];
      const a = s.phase + t * s.speed;
      push(2, i, s.ax + Math.cos(a) * s.rad, s.ay + Math.sin(a) * s.rad, s.h);
    }
    // 潜艇
    if (n < this.qDepth.length) {
      this.qDepth[n] = subDepth;
      this.qType[n] = 3;
      this.qIdx[n] = 0;
      n++;
    }
    this.lastCount = n;
    const order = this.order;
    order.length = n;
    for (let i = 0; i < n; i++) order[i] = i;
    const qd = this.qDepth;
    order.sort((a, b) => qd[b] - qd[a]);
    for (const q of order) {
      const type = this.qType[q];
      if (type === 0) this.drawPlant(r, cam, water, t, this.plants[this.qIdx[q]], this.qU[q], this.qV[q]);
      else if (type === 1) this.drawJelly(r, cam, water, t, this.jellies[this.qIdx[q]], this.qU[q], this.qV[q]);
      else if (type === 2) this.drawSchool(r, cam, water, t, this.schools[this.qIdx[q]], this.qU[q], this.qV[q]);
      else drawSub();
    }
    nearFade.dither = nearFade.hide = 0;
  }

  private col(c: RGB, k: number, depth: number, y: number, water: Water) {
    return water.fog(pack(c[0] * k, c[1] * k, c[2] * k), depth, y);
  }

  private drawPlant(r: Renderer, cam: Camera, water: Water, t: number, p: Plant, u0: number, v0: number) {
    const pj = this.pj;
    const dh0 = p.h0 - cam.h;
    if (!cam.projectCam(u0, v0, dh0, pj)) return;
    const kb = pj.k;
    const lift = Math.max(0.05, cam.lift);
    if (p.kind === Kind.Kelp) {
      const rt = p.region;
      const d0 = KELP_DARK[0], d1 = KELP_DARK[1], m0 = KELP_MID[0], m1 = KELP_MID[1], t0 = KELP_TIP[0], t1 = KELP_TIP[1];
      const dr = d0[0] + (d1[0] - d0[0]) * rt, dg = d0[1] + (d1[1] - d0[1]) * rt, db = d0[2] + (d1[2] - d0[2]) * rt;
      const mr = m0[0] + (m1[0] - m0[0]) * rt, mg = m0[1] + (m1[1] - m0[1]) * rt, mb = m0[2] + (m1[2] - m0[2]) * rt;
      const tr = t0[0] + (t1[0] - t0[0]) * rt, tg = t0[1] + (t1[1] - t0[1]) * rt, tb = t0[2] + (t1[2] - t0[2]) * rt;
      // 近处细分得更密（每层只占 1~2 像素），远处跳层省时间
      const step = Math.max(0.3, 1.1 / (lift * kb));
      const leafWin = Math.max(0.9, step); // 叶片薄：每 5 层里只有不到 1 层伸出叶子
      const wob = t * 0.8 + p.phase, wob2 = t * 0.6 + p.phase * 1.3;
      for (let z = 0; z < p.len; z += step) {
        const sway = Math.sin(wob + z * 0.07) * z * 0.06;
        const sway2 = Math.cos(wob2 + z * 0.05) * z * 0.04;
        if (!cam.projectCam(u0 + sway, v0 + sway2, dh0 + z, pj)) continue;
        const k = pj.k;
        const tz = z / p.len;
        const m = Math.min(1, tz * 1.6);
        const lightK = shadeAt(p.h0 + z) * (0.85 + 0.3 * tz);
        const br = (dr + (mr - dr) * m) * lightK, bg = (dg + (mg - dg) * m) * lightK, bb = (db + (mb - db) * m) * lightK;
        const hpx = Math.max(1, Math.ceil(step * lift * k));
        const y1 = Math.floor(pj.y), y0 = y1 - hpx + 1;
        const w = Math.max(1, Math.round(1.2 * k));
        const x0 = Math.round(pj.x - w / 2);
        fillRect(r, x0, y0, x0 + w - 1, y1, water.fog(pack(br, bg, bb), pj.depth, pj.y), pj.depth);
        // 叶片：每隔几层向一侧伸出
        const zs = z + p.seed;
        if (zs % 5 < leafWin && z > 4) {
          const li = Math.floor(zs / 5);
          const side = li % 2 ? 1 : -1;
          const len = Math.max(1, Math.round((2.2 + (li % 3) * 0.8) * k));
          const lt = 0.35 + 0.5 * tz, lk = 1.05;
          const lc = water.fog(pack((br + (tr * lightK - br) * lt) * lk, (bg + (tg * lightK - bg) * lt) * lk, (bb + (tb * lightK - bb) * lt) * lk), pj.depth, pj.y);
          if (side > 0) fillRect(r, x0 + w, y0, x0 + w + len - 1, y1, lc, pj.depth);
          else fillRect(r, x0 - len, y0, x0 - 1, y1, lc, pj.depth);
        }
      }
      return;
    }
    // 珊瑚
    const lightK = shadeAt(p.h0) * 1.05;
    const g = Math.max(0.15, cam.ground);
    if (p.kind === Kind.Tube) {
      const tubes = 2 + (p.seed % 3);
      for (let ti = 0; ti < tubes; ti++) {
        const a = ti * 2.2 + p.seed;
        const ox = Math.cos(a) * 1.8, oy = Math.sin(a) * 1.8;
        const len = p.len * (0.6 + ((p.seed * (ti + 3)) % 7) / 14);
        const step = Math.max(0.6, 0.9 / (lift * kb));
        for (let z = 0; z <= len; z += step) {
          if (!cam.projectCam(u0 + ox, v0 + oy, dh0 + z, pj)) continue;
          const top = z + step > len;
          const c = this.col(top ? TUBE_IN : TUBE, lightK * (0.8 + 0.3 * (z / len)), pj.depth, pj.y, water);
          fillEllipse(r, pj.x, pj.y, 1.2 * pj.k, 1.2 * pj.k * g, c, pj.depth);
        }
      }
    } else if (p.kind === Kind.Branch) {
      const br = 4 + (p.seed % 3);
      for (let bi = 0; bi < br; bi++) {
        const a = bi * (6.28 / br) + p.seed;
        const step = Math.max(0.5, 0.9 / (lift * kb));
        for (let z = 0; z <= p.len; z += step) {
          const s = z * 0.32;
          if (!cam.projectCam(u0 + Math.cos(a) * s, v0 + Math.sin(a) * s, dh0 + z, pj)) continue;
          const tip = z + step > p.len;
          const c = this.col(tip ? BRANCH_TIP : BRANCH, lightK * (0.75 + 0.35 * (z / p.len)), pj.depth, pj.y, water);
          const w = Math.max(1, Math.round(0.8 * pj.k));
          fillRect(r, Math.round(pj.x - w / 2), Math.floor(pj.y) - Math.max(0, Math.ceil(step * lift * pj.k) - 1), Math.round(pj.x - w / 2) + w - 1, Math.floor(pj.y), c, pj.depth);
        }
      }
    } else {
      // 扇形珊瑚：一片竖立的镂空扇面，沿固定方向展开
      const a = p.seed * 0.37;
      const fx = Math.cos(a), fy = Math.sin(a);
      const fu = fx * cam.cosH - fy * cam.sinH, fv = fx * cam.sinH + fy * cam.cosH;
      const len = p.len * 1.1;
      const step = Math.max(0.7, 0.9 / (lift * kb));
      for (let z = 0; z <= len; z += step) {
        const tz = z / len;
        const half = Math.sin(Math.min(1, tz * 1.15) * 2.4) * len * 0.45 + 0.6;
        const cnt = Math.max(1, Math.round(half * 2 * Math.max(0.5, kb) / 1.2));
        for (let q = 0; q <= cnt; q++) {
          const s = -half + (2 * half * q) / cnt;
          const hsh = hash2(Math.floor(z), q, p.seed);
          if (hsh < 0.42 && q !== 0 && q !== cnt && tz > 0.15) continue; // 镂空
          if (!cam.projectCam(u0 + fu * s, v0 + fv * s, dh0 + z, pj)) continue;
          const edge = tz > 0.85 || hsh > 0.9;
          const c = this.col(edge ? BUSH_HI : BUSH, lightK * (0.7 + 0.4 * tz), pj.depth, pj.y, water);
          const w = Math.max(1, Math.round(0.7 * pj.k));
          fillRect(r, Math.round(pj.x), Math.floor(pj.y) - w + 1, Math.round(pj.x) + w - 1, Math.floor(pj.y), c, pj.depth);
        }
      }
    }
  }

  private drawJelly(r: Renderer, cam: Camera, water: Water, t: number, j: Jelly, u0: number, v0: number) {
    const pj = this.pj;
    const pulse = 1 + Math.sin(t * 2.2 + j.phase) * 0.14;
    const bob = Math.sin(t * 0.9 + j.phase) * 2.5;
    const dh0 = j.h + bob - cam.h;
    const base = mixRGB(JELLY[0], JELLY[1], j.region);
    const g = Math.max(0.15, cam.ground);
    // 触须
    for (let ti = 0; ti < 5; ti++) {
      const a = ti * 1.26 + j.phase;
      const rx = Math.cos(a) * j.size * 0.6, ry = Math.sin(a) * j.size * 0.6;
      for (let z = 0; z < j.size * 3.2; z += 1) {
        const sw = Math.sin(t * 1.6 + j.phase + z * 0.35 + ti) * z * 0.12;
        if (!cam.projectCam(u0 + rx + sw, v0 + ry, dh0 - z, pj)) continue;
        const c = water.fog(pack(base[0], base[1], base[2]), pj.depth, pj.y);
        blendPixel(r, pj.x, pj.y, c & 255, (c >> 8) & 255, (c >> 16) & 255, 0.35 * (1 - z / (j.size * 3.2)), pj.depth);
      }
    }
    // 圆顶：从下到上的圆盘，越往上越小。层数按屏幕上的高度定（层间不露缝），
    // 每层透明度按层数折算，叠起来中间更实、边缘更透
    const hTot = j.size * 1.1;
    if (!cam.projectCam(u0, v0, dh0, pj)) return;
    const layers = Math.max(5, Math.min(40, Math.ceil(hTot * Math.max(0.05, cam.lift) * pj.k * 1.2)));
    const aLayer = 1 - Math.pow(1 - 0.62, 1 / layers);
    for (let l = 0; l <= layers; l++) {
      const tz = l / layers;
      const rad = j.size * pulse * Math.cos(tz * 1.45);
      if (!cam.projectCam(u0, v0, dh0 + tz * hTot, pj)) continue;
      const lk = 0.85 + tz * 0.3;
      const c = water.fog(pack(base[0] * lk, base[1] * lk, base[2] * lk), pj.depth, pj.y);
      blendEllipse(r, pj.x, pj.y, Math.max(0.6, rad * pj.k), Math.max(0.5, rad * pj.k * g), c & 255, (c >> 8) & 255, (c >> 16) & 255, l === layers ? 0.5 : aLayer, pj.depth);
    }
    // 圆顶下缘一圈亮边
    if (cam.projectCam(u0, v0, dh0, pj)) {
      const rr = j.size * pulse * pj.k;
      const c = water.fog(pack(255, 255, 250), pj.depth, pj.y);
      for (let a = 0; a < 6.28; a += 0.5 / Math.max(1, rr)) {
        blendPixel(r, pj.x + Math.cos(a) * rr, pj.y + Math.sin(a) * rr * g, c & 255, (c >> 8) & 255, (c >> 16) & 255, 0.35, pj.depth);
      }
    }
  }

  private drawSchool(r: Renderer, cam: Camera, water: Water, t: number, s: School, u0: number, v0: number) {
    const pj = this.pj;
    const a = s.phase + t * s.speed;
    // 游动方向（圆周切线），转到镜头系
    const dirX = -Math.sin(a) * Math.sign(s.speed), dirY = Math.cos(a) * Math.sign(s.speed);
    const du = dirX * cam.cosH - dirY * cam.sinH, dv = dirX * cam.sinH + dirY * cam.cosH;
    const dh0 = s.h - cam.h;
    for (let i = 0; i < s.n; i++) {
      const ox = (hash2(i, 1, s.n) - 0.5) * 22 + Math.sin(t * 1.3 + i) * 1.5;
      const oy = (hash2(i, 2, s.n) - 0.5) * 22 + Math.cos(t * 1.1 + i * 2) * 1.5;
      const oz = (hash2(i, 3, s.n) - 0.5) * 10;
      const ou = ox * cam.cosH - oy * cam.sinH, ov = ox * cam.sinH + oy * cam.cosH;
      if (!cam.projectCam(u0 + ou + du * 1.4, v0 + ov + dv * 1.4, dh0 + oz, pj)) continue;
      const hx = pj.x, hy = pj.y, depth = pj.depth;
      if (!cam.projectCam(u0 + ou - du * 1.4, v0 + ov - dv * 1.4, dh0 + oz, pj)) continue;
      const tx = pj.x, ty = pj.y;
      const glint = Math.sin(t * 3 + i * 1.7) > 0.93;
      const base = s.dark ? FISH_DARK : FISH_LIGHT;
      const c = water.fog(glint ? pack(230, 250, 250) : pack(base[0], base[1], base[2]), depth, hy);
      // 头到尾画一条短线
      const steps = Math.max(1, Math.ceil(Math.max(Math.abs(hx - tx), Math.abs(hy - ty))));
      for (let q = 0; q <= steps; q++) {
        const f = q / steps;
        const x = Math.floor(tx + (hx - tx) * f), y = Math.floor(ty + (hy - ty) * f);
        fillRect(r, x, y, x, y, c, depth);
      }
    }
  }

  /** 潜艇在海床上的影子：艇身俯视轮廓（椭圆）投在正下方的地形上 */
  drawShadow(r: Renderer, cam: Camera, sx: number, sy: number, sh: number, heading: number) {
    const ground = this.world.heightSmooth(sx, sy);
    const gap = sh - ground;
    const alpha = 0.5 * (1 - smoothstep(10, 120, gap));
    if (alpha <= 0.02) return;
    const pj = this.pj;
    if (!cam.project(sx, sy, ground, pj)) return;
    const k = pj.k, px = pj.x, py = pj.y;
    const gv = Math.max(0.05, cam.ground);
    const beta = heading - cam.heading;
    const sb = Math.sin(beta), cb = Math.cos(beta);
    const blur = 1 + gap * 0.02;
    const L = 13.5 * blur, Wd = 4.6 * blur;
    const R = L + 1;
    const { W, H, buf, z } = r;
    const y0 = Math.max(0, Math.floor(py - R * k * gv)), y1 = Math.min(H - 1, Math.ceil(py + R * k * gv));
    const x0 = Math.max(0, Math.floor(px - R * k)), x1 = Math.min(W - 1, Math.ceil(px + R * k));
    const tol = 6 + 40 * (1 - gv);
    for (let y = y0; y <= y1; y++) {
      const vv = (py - (y + 0.5)) / (k * gv);
      for (let x = x0; x <= x1; x++) {
        const uu = (x + 0.5 - px) / k;
        const al = uu * sb + vv * cb, ac = uu * cb - vv * sb;
        const e = (al * al) / (L * L) + (ac * ac) / (Wd * Wd);
        if (e > 1) continue;
        const i = y * W + x;
        if (Math.abs(z[i] - pj.depth) > tol) continue;
        const a = alpha * (e > 0.7 ? 0.6 : 1);
        const c = buf[i];
        const m = 1 - a;
        buf[i] = (0xff000000 | ((((c >> 16) & 255) * m) << 16) | ((((c >> 8) & 255) * m) << 8) | ((c & 255) * m)) >>> 0;
      }
    }
  }
}
