// 潜望镜目镜：第一人称看出去是一个圆形视野，外面是黑色的镜筒壳体。
// 进入时圆框从屏幕外收拢（像光圈合上），退出时张开。
// 视野里：十字分划线（带测距刻度）、顶部方位刻度带、边缘暗角；
// 壳体上：声呐（扫描线扫出比潜艇高的岩壁）和方位、深度、航速、氮气读数。
// 静态部分（壳体纹理、每个像素到圆心的距离）每个分辨率生成一次，其余每帧画。

import { Renderer } from './renderer';
import { World } from './world';
import { hash2 } from './noise';
import { pack } from './color';

// ---- 3×5 像素字体 ----
const GLYPHS: Record<string, string> = {
  '0': '111101101101111', '1': '010110010010111', '2': '111001111100111', '3': '111001111001111',
  '4': '101101111001001', '5': '111100111001111', '6': '111100111101111', '7': '111001010010010',
  '8': '111101111101111', '9': '111101111001111', A: '010101111101101', B: '110101110101110',
  C: '011100100100011', D: '110101101101110', E: '111100110100111', G: '011100101101011',
  H: '101101111101101', K: '101110100110101', L: '100100100100111', M: '101111111101101',
  N: '101111111111101', O: '010101101101010', P: '110101110100100', R: '110101110101101',
  S: '011100010001110', T: '111010010010010', W: '101101111111101',
  '-': '000000111000000', '.': '000000000000010', ' ': '000000000000000',
};

/** 航向（弧度，可能已经转了好几圈）→ 0..360 的方位角 */
function bearing(heading: number) {
  const d = ((heading * 180) / Math.PI) % 360;
  return d < 0 ? d + 360 : d;
}

function textWidth(str: string) {
  return str.length * 4 - 1;
}

const C = {
  sonarBg: [8, 34, 22], sonarLine: [28, 92, 58], sonar: [80, 236, 140],
  reticle: [6, 12, 16], amber: [255, 196, 110], green: [120, 250, 200], label: [110, 128, 136],
  warn: [255, 80, 56],
};

export interface ScopeData {
  t: number; heading: number;
  depth: number; speedKn: number;
  nitro: number; nitroOn: boolean; clearance: number;
  subX: number; subY: number; subH: number;
}

export class Periscope {
  private W = 0;
  private H = 0;
  private cx = 0;
  private cy = 0;
  /** 目镜圆完全收拢后的半径 */
  private R0 = 0;
  private dist = new Float32Array(0);
  private housing = new Uint32Array(0);

  private build(W: number, H: number, cy: number) {
    this.W = W;
    this.H = H;
    this.cx = W / 2;
    this.cy = cy;
    this.R0 = Math.floor(Math.min(W * 0.47, H * 0.46));
    this.dist = new Float32Array(W * H);
    this.housing = new Uint32Array(W * H);
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        const d = Math.hypot(x + 0.5 - this.cx, y + 0.5 - cy);
        this.dist[i] = d;
        // 壳体：发蓝的黑色金属，一圈圈车削纹，离目镜越近越亮一点
        const near = Math.max(0, 1 - (d - this.R0) / 40);
        const ring = (Math.floor(d / 3) & 1) * 0.06;
        const k = 0.8 + near * 0.5 + ring + hash2(x, y, 9) * 0.12;
        this.housing[i] = pack(13 * k, 17 * k, 21 * k);
      }
  }

  /** amount：0..1，潜望镜程度。圆框随它从屏幕外收拢。圆心在画面正中（潜望镜镜头 fy = 0.5） */
  draw(r: Renderer, d: ScopeData, world: World, amount: number) {
    if (amount <= 0.01) return;
    const { W, H, buf } = r;
    if (W !== this.W || H !== this.H) this.build(W, H, H / 2);
    const cx = this.cx, cy = this.cy, R0 = this.R0;
    const diag = Math.hypot(W, H) / 2 + 6;
    const e = 1 - amount;
    const R = R0 + (diag - R0) * e * e;
    const warn = d.clearance < 13 && Math.sin(d.t * 12) > 0;

    // ---- 圆框：外面是壳体，边上一圈金属环，里面边缘暗下去 ----
    const band = R0 * 0.16;
    const rim = pack(...((warn ? [120, 40, 30] : [64, 74, 80]) as [number, number, number]));
    const rimHi = pack(150, 162, 168);
    const dist = this.dist, hs = this.housing;
    for (let i = 0, n = W * H; i < n; i++) {
      const dd = dist[i];
      if (dd > R + 3) buf[i] = hs[i];
      else if (dd > R) buf[i] = dd > R + 1.6 ? rim : rimHi;
      else if (dd > R - band) {
        const f = (dd - (R - band)) / band;
        const k = 1 - f * f * 0.85;
        const c = buf[i];
        buf[i] = pack((c & 255) * k, ((c >> 8) & 255) * k, ((c >> 16) & 255) * k);
      }
    }
    if (amount < 0.97) return;

    const put = (x: number, y: number, c: number) => {
      x = Math.round(x);
      y = Math.round(y);
      if (x >= 0 && y >= 0 && x < W && y < H) buf[y * W + x] = c;
    };
    const glow = (x: number, y: number, c: number[], a: number) => {
      x = Math.round(x);
      y = Math.round(y);
      if (x < 0 || y < 0 || x >= W || y >= H) return;
      const i = y * W + x, b = buf[i];
      buf[i] = pack((b & 255) + (c[0] - (b & 255)) * a, ((b >> 8) & 255) + (c[1] - ((b >> 8) & 255)) * a, ((b >> 16) & 255) + (c[2] - ((b >> 16) & 255)) * a);
    };
    const inCircle = (x: number, y: number, m: number) => Math.hypot(x + 0.5 - cx, y + 0.5 - cy) < R0 - m;
    const t = d.t;
    const icx = Math.round(cx), icy = Math.round(cy);

    // ---- 十字分划线：细黑线，带测距刻度，中间留空 ----
    {
      const c = C.reticle;
      const gap = 4, len = R0 - 3;
      for (let q = gap; q <= len; q++) {
        glow(icx - q, icy, c, 0.8);
        glow(icx + q, icy, c, 0.8);
        if (q < R0 * 0.62) glow(icx, icy - q, c, 0.8); // 上方留给方位刻度带
        glow(icx, icy + q, c, 0.8);
      }
      // 刻度
      const sp = Math.max(5, Math.round(R0 / 9));
      for (let n = 1; n * sp < len - 2; n++) {
        const h = n % 2 === 0 ? 3 : 2;
        for (let q = 1; q <= h; q++) {
          glow(icx - n * sp, icy - q, c, 0.8);
          glow(icx + n * sp, icy - q, c, 0.8);
          if (n * sp < R0 * 0.62) {
            glow(icx - q, icy - n * sp, c, 0.8);
          }
          glow(icx + q, icy + n * sp, c, 0.8);
        }
      }
      // 中心小框
      for (let q = -1; q <= 1; q++) {
        glow(icx + q, icy - 2, c, 0.6);
        glow(icx + q, icy + 2, c, 0.6);
        glow(icx - 2, icy + q, c, 0.6);
        glow(icx + 2, icy + q, c, 0.6);
      }
    }

    // ---- 顶部方位刻度带（真方位，随航向滚动） ----
    {
      const y0 = Math.round(icy - R0 + Math.max(9, R0 * 0.14));
      const half = Math.min(R0 * 0.55, Math.sqrt(Math.max(0, R0 * R0 - (y0 - icy) ** 2)) - 6);
      const deg = bearing(d.heading);
      const ppd = half / 30; // 左右各看 30°
      const every = ppd * 10 >= 15 ? 10 : ppd * 20 >= 15 ? 20 : 30;
      for (let a = Math.floor((deg - 32) / 5) * 5; a <= deg + 32; a += 5) {
        const x = icx + (a - deg) * ppd;
        if (Math.abs(x - icx) > half) continue;
        const aa = ((a % 360) + 360) % 360;
        const fade = 1 - (Math.abs(x - icx) / half) ** 3;
        glow(x, y0 + 8, C.amber, 0.85 * fade);
        if (aa % 10 === 0) glow(x, y0 + 7, C.amber, 0.85 * fade);
        if (aa % every === 0) {
          const lab = String(aa).padStart(3, '0');
          this.text(r, lab, Math.round(x - textWidth(lab) / 2), y0, aa % 90 === 0 ? [255, 246, 216] : C.amber, 0.85 * fade);
        }
      }
      // 读数指针
      glow(icx, y0 + 10, C.amber, 1);
      glow(icx - 1, y0 + 11, C.amber, 1);
      glow(icx + 1, y0 + 11, C.amber, 1);
    }

    // ---- 壳体上的读数（只画在圆框外面） ----
    const pad = 6;
    const housingText = (str: string, x: number, y: number, c: number[]) => {
      if (inCircle(x, y, -4) || inCircle(x + textWidth(str), y, -4) || inCircle(x, y + 4, -4) || inCircle(x + textWidth(str), y + 4, -4)) return;
      this.text(r, str, x, y, c, 1);
    };
    {
      const lines: [string, string, number[]][] = [
        ['BRG', String(Math.round(bearing(d.heading)) % 360).padStart(3, '0'), C.amber],
        ['DPT', String(Math.round(d.depth)).padStart(3, '0'), C.green],
        ['SPD', String(Math.round(d.speedKn)).padStart(3, '0'), C.green],
      ];
      const right = W - pad;
      let y = H - pad - 5 - 9;
      // 氮气：8 格
      const segW = 3, segs = 8, nx0 = right - segs * (segW + 1) + 1;
      if (!inCircle(nx0, y + 9, -4)) {
        this.text(r, 'N2', nx0 - 10, y + 9, C.label, 1);
        for (let s = 0; s < segs; s++) {
          const on = d.nitro * segs > s + 0.25;
          const c = !on ? [24, 40, 34] : d.nitroOn ? [255, 246, 216] : d.nitro >= 0.25 ? [142, 244, 243] : [80, 140, 140];
          for (let yy = 0; yy < 5; yy++) for (let q = 0; q < segW; q++) put(nx0 + s * (segW + 1) + q, y + 9 + yy, pack(c[0], c[1], c[2]));
        }
      }
      for (let n = lines.length - 1; n >= 0; n--) {
        const [lab, val, c] = lines[n];
        housingText(val, right - textWidth(val), y, c);
        housingText(lab, right - textWidth(val) - 5 - textWidth(lab), y, C.label);
        y -= 8;
      }
      if (warn) housingText('LOW', right - textWidth('LOW'), y - 2, C.warn);
    }

    // ---- 声呐（左下角壳体上） ----
    {
      const sr = Math.max(10, Math.round(Math.min(W, H) * 0.075));
      const S = { x: pad + sr + 2, y: H - pad - sr - 2, r: sr };
      const dc = Math.hypot(S.x - cx, S.y - cy);
      if (dc - sr - 3 > R0) {
        // 外圈
        for (let y = -S.r - 2; y <= S.r + 2; y++)
          for (let x = -S.r - 2; x <= S.r + 2; x++) {
            const rr = Math.hypot(x + 0.5, y + 0.5);
            if (rr > S.r && rr <= S.r + 2) put(S.x + x, S.y + y, x + y < 0 ? pack(96, 108, 116) : pack(34, 40, 46));
          }
        const sweep = (t * 2.2) % (Math.PI * 2);
        for (let y = -S.r; y <= S.r; y++)
          for (let x = -S.r; x <= S.r; x++) {
            const rr = Math.hypot(x + 0.5, y + 0.5);
            if (rr > S.r) continue;
            let c = C.sonarBg;
            if (Math.abs(rr - S.r * 0.5) < 0.5 || x === 0 || y === 0) c = C.sonarLine;
            const ang = Math.atan2(x + 0.5, -(y + 0.5));
            let age = (sweep - ang) % (Math.PI * 2);
            if (age < 0) age += Math.PI * 2;
            const k = Math.max(0, 1 - age / 1.3);
            put(S.x + x, S.y + y, pack(c[0] + 20 * k, c[1] + 70 * k, c[2] + 40 * k));
          }
        const range = 190;
        const sh = Math.sin(d.heading), chh = Math.cos(d.heading);
        const NA = 40, NR = 10;
        for (let ai = 0; ai < NA; ai++) {
          const ang = (ai / NA) * Math.PI * 2;
          let age = (sweep - ang) % (Math.PI * 2);
          if (age < 0) age += Math.PI * 2;
          const k = Math.exp(-age * 0.9);
          if (k < 0.08) continue;
          const ca = Math.cos(ang), sa = Math.sin(ang);
          for (let ri = 1; ri <= NR; ri++) {
            const dd = (ri / NR) * range;
            // 声呐图上「上」= 潜艇前方
            const fx = sa * dd, fy = ca * dd;
            const wx = d.subX + fx * chh + fy * sh;
            const wy = d.subY - fx * sh + fy * chh;
            if (world.heightAt(wx, wy) < d.subH - 6) continue;
            glow(S.x + sa * (ri / NR) * (S.r - 2), S.y - ca * (ri / NR) * (S.r - 2), C.sonar, k);
          }
        }
        for (let q = 0; q < S.r; q++) glow(S.x + Math.sin(sweep) * q, S.y - Math.cos(sweep) * q, C.sonar, 0.85);
        put(S.x, S.y - 1, pack(255, 246, 216));
        put(S.x - 1, S.y + 1, pack(255, 246, 216));
        put(S.x + 1, S.y + 1, pack(255, 246, 216));
      }
    }
  }

  /** 半透明地把字叠到画面上 */
  private text(r: Renderer, str: string, x: number, y: number, c: number[], a: number) {
    const { W, H, buf } = r;
    for (let n = 0; n < str.length; n++) {
      const g = GLYPHS[str[n]] ?? GLYPHS[' '];
      for (let i = 0; i < 15; i++) {
        if (g[i] !== '1') continue;
        const px = x + n * 4 + (i % 3), py = y + Math.floor(i / 3);
        if (px < 0 || py < 0 || px >= W || py >= H) continue;
        const b = buf[py * W + px];
        buf[py * W + px] = pack((b & 255) + (c[0] - (b & 255)) * a, ((b >> 8) & 255) + (c[1] - ((b >> 8) & 255)) * a, ((b >> 16) & 255) + (c[2] - ((b >> 16) & 255)) * a);
      }
    }
  }
}
