// 海床：4 层可平铺 value noise 生成 512×512 循环高度图，按高度分带上色。
// 青绿区和紫雾区各一套颜色，按一张低频「区域图」混合（浅处青绿、某些区域渐变成紫雾）。

import { WORLD } from './camera';
import { fbmMap, hash2, smoothstep } from './noise';
import { hex, mixRGB, pack, RGB } from './color';

export const MAX_H = 90; // 海床最高
export const SURFACE_H = 170; // 水面高度

// 分带（从低到高）
export const enum Band {
  Trench, Silt, Sand, LightSand, Carpet, Grass, Rock, RockTop,
}
// 各带占海床面积的累计比例（按高度分位数定阈值，换种子也能保持比例）
const BAND_CUM = [0.05, 0.13, 0.36, 0.49, 0.64, 0.79, 0.95, 1];

// 青绿区 / 紫雾区 各带的两种颜色（交替做纹理）
const TEAL: [RGB, RGB][] = [
  [hex('#1E2433'), hex('#232B3B')],
  [hex('#2C4E5E'), hex('#2A4858')],
  [hex('#4E8F92'), hex('#4A888A')],
  [hex('#8CCFC6'), hex('#7EC2BA')],
  [hex('#3A2050'), hex('#6B2F7A')],
  [hex('#2F5A3A'), hex('#3F7A4A')],
  [hex('#4E6F73'), hex('#435F66')],
  [hex('#8FB8A8'), hex('#76A394')],
];
// 紫雾区：低处的沙地也铺满深紫红的海草地毯（参考图 5、7、9）
const VIOLET: [RGB, RGB][] = [
  [hex('#261D2A'), hex('#2A2030')],
  [hex('#312237'), hex('#3A2A42')],
  [hex('#3A2450'), hex('#4E2E62')],
  [hex('#938CA5'), hex('#A4A5BB')],
  [hex('#6B2F7A'), hex('#A04A9C')],
  [hex('#4E7F6A'), hex('#5F8F78')],
  [hex('#423D4B'), hex('#4C4E5D')],
  [hex('#938CA5'), hex('#7E8A99')],
];

export interface Mip {
  size: number;
  shift: number; // 世界坐标 → 该层格子的右移位数
  height: Float32Array;
  color: Uint32Array;
}

export class World {
  height: Float32Array;
  band: Uint8Array;
  region: Float32Array; // 0 = 青绿，1 = 紫雾
  color: Uint32Array;
  mips: Mip[] = [];
  bandTop: number[] = [];

  constructor(seed = 7) {
    const N = WORLD;
    const base = fbmMap(N, 4, 4, seed); // 大地形
    const ridge = fbmMap(N, 16, 3, seed + 11); // 岩石起伏
    const detail = fbmMap(N, 64, 2, seed + 23); // 纹理
    const reg = fbmMap(N, 2, 2, seed + 37); // 区域
    this.height = new Float32Array(N * N);
    this.band = new Uint8Array(N * N);
    this.region = new Float32Array(N * N);
    this.color = new Uint32Array(N * N);

    for (let i = 0; i < N * N; i++) {
      const n = base[i];
      const rock = smoothstep(0.56, 0.72, n); // 岩体：高处陡升成岩壁
      const rr = 1 - Math.abs(ridge[i] * 2 - 1);
      let h = 4 + n * 36 + rock * (24 + rr * 20) + (detail[i] - 0.5) * 3;
      // 低处压成海沟
      h -= smoothstep(0.3, 0.12, n) * 7;
      this.height[i] = Math.max(0, Math.min(MAX_H, h));
      this.region[i] = smoothstep(0.56, 0.7, reg[i]);
    }

    // 分带阈值 = 高度分位数
    const sorted = Float32Array.from(this.height).sort();
    const BAND_TOP = BAND_CUM.map((q) => (q >= 1 ? 999 : sorted[Math.floor(q * (sorted.length - 1))]));
    this.bandTop = BAND_TOP;

    // 分带 + 上色
    const H = this.height;
    const at = (x: number, y: number) => H[(y & (N - 1)) * N + (x & (N - 1))];
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        const i = y * N + x;
        const h = H[i];
        const gx = at(x + 1, y) - at(x - 1, y);
        const gy = at(x, y + 1) - at(x, y - 1);
        const slope = Math.hypot(gx, gy);
        const jitter = (hash2(x, y, 5) - 0.5) * 1.2 + (detail[i] - 0.5) * 5;
        let b = 0;
        while (h + jitter > BAND_TOP[b]) b++;
        if (slope > 4.2 && b >= Band.Sand) b = h > BAND_TOP[Band.Rock] ? Band.RockTop : Band.Rock;
        this.band[i] = b;

        const alt = detail[i] + (hash2(x, y, 9) - 0.5) * 0.12 > 0.5 ? 1 : 0;
        const t = this.region[i];
        let c = mixRGB(TEAL[b][alt], VIOLET[b][alt], t);
        // 斜坡光照：光从西北上方来
        const lit = Math.max(0.6, Math.min(1.3, 1 + (gx - gy) * 0.06));
        // 越深越暗
        const att = 0.74 + 0.3 * smoothstep(0, 70, h);
        // 海草和紫色地毯纹理更粗糙，偶尔有亮点
        const rough = b === Band.Carpet || b === Band.Grass ? 0.3 : 0.07;
        let tex = 0.92 + detail[i] * 0.16 + (hash2(x, y, 3) - 0.5) * rough;
        if (b === Band.Carpet) tex *= 0.82;
        const k = lit * att * tex;
        c = [c[0] * k, c[1] * k, c[2] * k];
        const sp = hash2(x, y, 17);
        if ((b === Band.Carpet && sp > 0.965) || (b === Band.Grass && sp > 0.985)) c = [c[0] * 1.5 + 30, c[1] * 1.4 + 20, c[2] * 1.4 + 30];
        this.color[i] = pack(c[0], c[1], c[2]);
      }
    }
    this.buildMips();
  }

  private buildMips() {
    this.mips.push({ size: WORLD, shift: 0, height: this.height, color: this.color });
    for (let l = 1; l <= 3; l++) {
      const prev = this.mips[l - 1];
      const S = prev.size >> 1;
      const height = new Float32Array(S * S);
      const color = new Uint32Array(S * S);
      for (let y = 0; y < S; y++) {
        for (let x = 0; x < S; x++) {
          let hm = 0, r = 0, g = 0, b = 0;
          // 高度取平均（取最大值会让远处变成一根根方柱）
          for (let dy = 0; dy < 2; dy++)
            for (let dx = 0; dx < 2; dx++) {
              const j = (y * 2 + dy) * prev.size + x * 2 + dx;
              hm += prev.height[j] / 4;
              const c = prev.color[j];
              r += c & 255;
              g += (c >> 8) & 255;
              b += (c >> 16) & 255;
            }
          height[y * S + x] = hm;
          color[y * S + x] = pack(r / 4, g / 4, b / 4);
        }
      }
      this.mips.push({ size: S, shift: l, height, color });
    }
  }

  heightAt(wx: number, wy: number): number {
    return this.height[((Math.floor(wy) & (WORLD - 1)) << 9) | (Math.floor(wx) & (WORLD - 1))];
  }

  /** 双线性高度（给潜艇贴地避让用） */
  heightSmooth(wx: number, wy: number): number {
    const x0 = Math.floor(wx), y0 = Math.floor(wy);
    const tx = wx - x0, ty = wy - y0;
    const a = this.heightAt(x0, y0), b = this.heightAt(x0 + 1, y0);
    const c = this.heightAt(x0, y0 + 1), d = this.heightAt(x0 + 1, y0 + 1);
    return a + (b - a) * tx + (c - a) * ty + (a - b - c + d) * tx * ty;
  }

  /** 找一个青绿区的沙地做起点 */
  findStart(): [number, number] {
    for (let r = 0; r < WORLD * 4; r += 3) {
      const a = r * 0.37;
      const x = 256 + Math.cos(a) * r * 0.25, y = 256 + Math.sin(a) * r * 0.25;
      const b = this.bandAt(x, y);
      if (this.regionAt(x, y) < 0.02 && (b === Band.Sand || b === Band.LightSand)) {
        // 周围也要平坦开阔
        let ok = true;
        for (let d = 0; d < 6.28 && ok; d += 0.8) if (this.heightAt(x + Math.cos(d) * 30, y + Math.sin(d) * 30) > 40) ok = false;
        if (ok) return [x, y];
      }
    }
    return [256, 256];
  }

  regionAt(wx: number, wy: number): number {
    return this.region[((Math.floor(wy) & (WORLD - 1)) << 9) | (Math.floor(wx) & (WORLD - 1))];
  }

  bandAt(wx: number, wy: number): number {
    return this.band[((Math.floor(wy) & (WORLD - 1)) << 9) | (Math.floor(wx) & (WORLD - 1))];
  }
}
