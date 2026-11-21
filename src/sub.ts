// 潜艇：16 张 32×32 的调色板索引切片（从底到顶），即一个 32×32×16 的体素体。
// 绘制时把它切成水平层，每层在屏幕上按镜头投影摆放；层内每个屏幕像素用逆向映射
// （逆航向 → 逆俯仰 → 逆横滚）回到模型坐标，最近邻取体素，保留像素轮廓。

import { Camera, Projected } from './camera';
import { Renderer } from './renderer';
import { hex, pack, RGB } from './color';

const NX = 32, NY = 32, NZ = 16;
const CX = 16, CY = 16, CZ = 8; // 体素体的中心
const R = 17; // 包围半径（含螺旋桨）

// 调色板（暖色，和青色海水拉开）
const PAL: RGB[] = [
  [0, 0, 0],
  hex('#F2A23A'), // 1 艇身上半
  hex('#C2582A'), // 2 艇身下半
  hex('#2B3540'), // 3 深色饰条 / 指挥塔顶
  hex('#8EF4F3'), // 4 舷窗玻璃（自发光）
  hex('#E0623A'), // 5 鳍 / 舵
  hex('#C9B26A'), // 6 黄铜螺旋桨毂
  hex('#FFF6D8'), // 7 艇首探照灯（自发光）
  hex('#F7C46A'), // 8 艇身高光带
  hex('#B8A25C'), // 9 螺旋桨桨叶（动态）
];
const EMISSIVE = [0, 0, 0, 0, 1, 0, 0, 1, 0, 0];
const PROP = 9;

export class SubModel {
  vox = new Uint8Array(NX * NY * NZ);
  nx = new Float32Array(NX * NY * NZ);
  ny = new Float32Array(NX * NY * NZ);
  nz = new Float32Array(NX * NY * NZ);

  constructor() {
    this.build();
    this.buildNormals();
  }

  /** 体素体按切片导出（第 z 张 = 从底往上第 z 层），便于检查 */
  slice(z: number): Uint8Array {
    return this.vox.subarray(z * NX * NY, (z + 1) * NX * NY);
  }

  private set(i: number, j: number, z: number, c: number) {
    if (i < 0 || j < 0 || z < 0 || i >= NX || j >= NY || z >= NZ) return;
    this.vox[(z * NY + j) * NX + i] = c;
  }

  private build() {
    const hullZ = 6.5 - CZ; // 艇身中心线（相对体中心）
    for (let z = 0; z < NZ; z++) {
      for (let j = 0; j < NY; j++) {
        for (let i = 0; i < NX; i++) {
          const a = i + 0.5 - CX; // 前后（+ 为艇首）
          const c = j + 0.5 - CY; // 左右
          const h = z + 0.5 - CZ; // 上下
          let col = 0;

          // 艇身：旋转体，艇尾收窄，艇首椭球
          let r = 0;
          if (a >= -13 && a < -6) {
            const t = (a + 13) / 7;
            r = 1.8 + 3.4 * (t * t * (3 - 2 * t));
          } else if (a >= -6 && a < 7) r = 5.2;
          else if (a >= 7 && a < 13.5) r = 5.2 * Math.sqrt(Math.max(0, 1 - ((a - 7) / 6.5) ** 2));
          const dh = h - hullZ;
          if (r > 0 && c * c + dh * dh * 1.08 <= r * r) {
            col = dh < -1.2 ? 2 : 1;
            if (dh > 2.2 && Math.abs(c) < 2.2 && a > -8 && a < 8) col = 8; // 背脊高光
            if (a > 5.5 && a < 6.6) col = 3; // 饰条
            // 舷窗
            for (const pa of [-3.5, 0.5]) {
              if (Math.abs(a - pa) < 0.8 && Math.abs(dh - 0.3) < 0.9 && Math.abs(c) > 4.2) col = 4;
            }
            // 艇首观察窗和探照灯
            if (a > 10.2 && Math.abs(c) < 2.4 && dh > -0.6 && dh < 2.2) col = 4;
            if (a > 12.2 && Math.abs(c) < 1.2 && dh < -0.6 && dh > -2.4) col = 7;
          }

          // 指挥塔
          if (a >= -3.5 && a <= 5.5 && Math.abs(c) < 2.3 && h >= hullZ + 3 && h < 7.5) {
            const front = 5.5 - (h - (hullZ + 3)) * 0.45; // 前缘后掠
            if (a <= front) {
              col = h > 6.5 ? 3 : 1;
              if (Math.abs(a - 2.5) < 1.1 && Math.abs(h - 5) < 0.6 && Math.abs(c) > 1.2) col = 4;
            }
          }
          // 指挥塔上的水平舵
          if (a >= 1 && a <= 3.5 && Math.abs(c) >= 2 && Math.abs(c) < 5.5 && Math.abs(h - 4.5) < 0.5) col = 5;
          // 尾部水平舵
          if (a >= -12.5 && a <= -9 && Math.abs(c) < 8.5 && Math.abs(h - hullZ) < 0.5) {
            if (Math.abs(c) > 1 || col === 0) col = 5;
          }
          // 垂直舵
          if (a >= -13.5 && a <= -9.5 && Math.abs(c) < 0.6 && h > hullZ - 6 && h < hullZ + 6.5) col = 5;
          // 螺旋桨毂
          if (a >= -14.5 && a < -13 && Math.abs(c) < 1.3 && Math.abs(dh) < 1.3) col = 6;
          // 螺旋桨盘（桨叶在绘制时按角度判断）
          if (a >= -15.5 && a < -14.5 && c * c + dh * dh < 4.8 * 4.8 && c * c + dh * dh > 1) col = PROP;

          if (col) this.set(i, j, z, col);
        }
      }
    }
  }

  private buildNormals() {
    const at = (i: number, j: number, z: number) =>
      i < 0 || j < 0 || z < 0 || i >= NX || j >= NY || z >= NZ ? 0 : this.vox[(z * NY + j) * NX + i] ? 1 : 0;
    for (let z = 0; z < NZ; z++)
      for (let j = 0; j < NY; j++)
        for (let i = 0; i < NX; i++) {
          const idx = (z * NY + j) * NX + i;
          if (!this.vox[idx]) continue;
          let gx = 0, gy = 0, gz = 0;
          for (let dz = -1; dz <= 1; dz++)
            for (let dj = -1; dj <= 1; dj++)
              for (let di = -1; di <= 1; di++) {
                const o = at(i + di, j + dj, z + dz);
                gx -= di * o;
                gy -= dj * o;
                gz -= dz * o;
              }
          const l = Math.hypot(gx, gy, gz) || 1;
          this.nx[idx] = gx / l;
          this.ny[idx] = gy / l;
          this.nz[idx] = gz / l;
        }
  }
}

export interface SubPose {
  x: number;
  y: number;
  h: number;
  heading: number; // 世界航向
  roll: number; // 横滚（转弯侧倾 + 翻滚）
  pitch: number; // 抬头为正
  prop: number; // 螺旋桨角度
}

const OUTLINE = pack(14, 20, 28);

/** 每个像素的后处理（雾等），由场景提供 */
export type PixelTint = (c: number, depth: number, sy: number) => number;

export class SubRenderer {
  private col = new Uint32Array(0);
  private mask = new Uint8Array(0);
  private pal: number[][] = []; // [调色板索引][亮度级 0..15]
  private pj: Projected = { x: 0, y: 0, depth: 0, k: 0 };
  /** 上一次绘制的屏幕信息（给 HUD / 输入用） */
  screen = { x: 0, y: 0, k: 1, depth: 0, visible: false };

  constructor(private m: SubModel) {
    for (let p = 0; p < PAL.length; p++) {
      const row: number[] = [];
      for (let l = 0; l < 16; l++) {
        const k = EMISSIVE[p] ? 1.05 : 0.38 + (l / 15) * 0.82;
        row.push(pack(PAL[p][0] * k, PAL[p][1] * k, PAL[p][2] * k));
      }
      this.pal.push(row);
    }
  }

  draw(r: Renderer, cam: Camera, s: SubPose, tint: PixelTint | null) {
    const pj = this.pj;
    this.screen.visible = false;
    if (!cam.project(s.x, s.y, s.h, pj)) return;
    const k = pj.k;
    const px = pj.x, py = pj.y;
    this.screen = { x: px, y: py, k, depth: pj.depth, visible: true };

    const bx0 = Math.floor(px - R * k) - 1, bx1 = Math.ceil(px + R * k) + 1;
    const by0 = Math.floor(py - R * k) - 1, by1 = Math.ceil(py + R * k) + 1;
    const bw = bx1 - bx0 + 1, bh = by1 - by0 + 1;
    if (bx1 < 0 || by1 < 0 || bx0 >= r.W || by0 >= r.H) return;
    if (this.col.length < bw * bh) {
      this.col = new Uint32Array(bw * bh * 2);
      this.mask = new Uint8Array(bw * bh * 2);
    }
    const col = this.col, mask = this.mask;
    mask.fill(0, 0, bw * bh);

    const { vox, nx, ny, nz } = this.m;
    const sinP = Math.max(0.02, cam.ground), cosP = cam.lift;
    const beta = s.heading - cam.heading;
    const sb = Math.sin(beta), cb = Math.cos(beta);
    const sa = Math.sin(s.pitch), ca = Math.cos(s.pitch);
    const sr = Math.sin(s.roll), cr = Math.cos(s.roll);
    const prop = s.prop;

    // 层间距超过 1 像素时细分切片，避免层与层之间露缝
    const step = Math.min(1, 0.85 / Math.max(0.01, k * cosP));
    for (let dz = -R; dz <= R; dz += step) {
      // 这一层在屏幕上覆盖的行
      const yTop = py - (R * sinP + dz * cosP) * k;
      const yBot = py - (-R * sinP + dz * cosP) * k;
      const ys = Math.max(by0, Math.floor(yTop)), ye = Math.min(by1, Math.ceil(yBot));
      for (let sy = ys; sy <= ye; sy++) {
        const vv = ((py - (sy + 0.5)) / k - dz * cosP) / sinP;
        if (vv < -R || vv > R) continue;
        const ur = Math.sqrt(R * R - vv * vv);
        const xs = Math.max(bx0, Math.floor(px - ur * k)), xe = Math.min(bx1, Math.ceil(px + ur * k));
        // u' 处的线性变换：先在 u'=0 处求值，再按 du 递增
        const u0 = (xs + 0.5 - px) / k, du = 1 / k;
        // 镜头系 → 艇体航向系
        const al0 = u0 * sb + vv * cb, alD = du * sb;
        const ac0 = u0 * cb - vv * sb, acD = du * cb;
        // 逆俯仰
        const am0 = al0 * ca + dz * sa, amD = alD * ca;
        const z10 = -al0 * sa + dz * ca, z1D = -alD * sa;
        // 逆横滚
        const cm0 = ac0 * cr + z10 * sr, cmD = acD * cr + z1D * sr;
        const zm0 = -ac0 * sr + z10 * cr, zmD = -acD * sr + z1D * cr;
        let am = am0, cm = cm0, zm = zm0;
        const rowOff = (sy - by0) * bw - bx0;
        for (let sx = xs; sx <= xe; sx++, am += amD, cm += cmD, zm += zmD) {
          const i = Math.floor(am + CX), j = Math.floor(cm + CY), z = Math.floor(zm + CZ);
          if (i < 0 || j < 0 || z < 0 || i >= NX || j >= NY || z >= NZ) continue;
          const idx = (z * NY + j) * NX + i;
          let c = vox[idx];
          if (!c) continue;
          if (c === PROP) {
            const ang = Math.atan2(zm - (6.5 - CZ), cm) - prop;
            const m = ((ang % 2.0944) + 2.0944) % 2.0944;
            if (m > 0.75) continue;
          }
          // 法线转到世界：横滚 → 俯仰，取朝上分量和朝镜头的分量做光照
          const nnx = nx[idx], nny = ny[idx], nnz = nz[idx];
          const ny1 = nny * cr - nnz * sr;
          const nz1 = nny * sr + nnz * cr;
          const nz2 = nnx * sa + nz1 * ca;
          const nx2 = nnx * ca - nz1 * sa;
          // 光从上方偏前照下
          let L = 0.5 + 0.5 * nz2 + 0.18 * (nx2 * cb - ny1 * sb);
          L = L < 0 ? 0 : L > 1 ? 1 : L;
          col[rowOff + sx] = this.pal[c][(L * 15) | 0];
          mask[rowOff + sx] = 1;
        }
      }
    }

    // 合成到帧缓冲：深度测试 + 1 像素深色描边
    const { W, H, buf, z: zb } = r;
    const depth = pj.depth;
    for (let y = 0; y < bh; y++) {
      const sy = y + by0;
      if (sy < 0 || sy >= H) continue;
      for (let x = 0; x < bw; x++) {
        const sx = x + bx0;
        if (sx < 0 || sx >= W) continue;
        const bi = y * bw + x;
        const fi = sy * W + sx;
        if (depth >= zb[fi]) continue;
        let c: number;
        if (mask[bi]) c = col[bi];
        else if (
          (x > 0 && mask[bi - 1]) || (x < bw - 1 && mask[bi + 1]) ||
          (y > 0 && mask[bi - bw]) || (y < bh - 1 && mask[bi + bw])
        ) c = OUTLINE;
        else continue;
        buf[fi] = tint ? tint(c, depth, sy) : c;
        zb[fi] = depth;
      }
    }
  }
}

/** 模型坐标（前后 a、左右 c、上下 h，相对体素体中心）→ 世界坐标（与绘制时的逆变换互逆） */
export function modelToWorld(p: SubPose, a: number, c: number, h: number, out: { x: number; y: number; h: number }) {
  const sr = Math.sin(p.roll), cr = Math.cos(p.roll);
  const sa = Math.sin(p.pitch), ca = Math.cos(p.pitch);
  const ac = c * cr - h * sr;
  const z1 = c * sr + h * cr;
  const al = a * ca - z1 * sa;
  const z0 = a * sa + z1 * ca;
  const sh = Math.sin(p.heading), chh = Math.cos(p.heading);
  out.x = p.x + al * sh + ac * chh;
  out.y = p.y + al * chh - ac * sh;
  out.h = p.h + z0;
}
