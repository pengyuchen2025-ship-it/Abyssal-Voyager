// 座舱：第一人称视角下的潜艇驾驶舱，全部用代码画成像素图。
// 静态部分（舱壁、铆钉铜框观察窗、仪表台、表盘外圈、标签）每个分辨率只生成一次；
// 动态部分（声呐扫描、姿态球、航向带、指针、读数、指示灯、玻璃上的准星）每帧画。

import { Renderer } from './renderer';
import { World } from './world';
import { hash2 } from './noise';
import { pack } from './color';

// ---- 3×5 像素字体 ----
const GLYPHS: Record<string, string> = {
  '0': '111101101101111', '1': '010110010010111', '2': '111001111100111', '3': '111001111001111',
  '4': '101101111001001', '5': '111100111001111', '6': '111100111101111', '7': '111001010010010',
  '8': '111101111101111', '9': '111101111001111', A: '010101111101101', D: '110101101101110',
  E: '111100110100111', H: '101101111101101', I: '111010010010111', K: '101110100110101',
  M: '101111111101101', N: '101111111111101', O: '010101101101010', P: '110101110100100',
  R: '110101110101101', S: '011100010001110', T: '111010010010010', W: '101101111111101',
  '-': '000000111000000', '.': '000000000000010', ' ': '000000000000000',
};

function textWidth(str: string) {
  return str.length * 4 - 1;
}

const C = {
  wallDark: [22, 28, 34], wall: [38, 47, 56], wallLight: [58, 70, 80],
  brassDark: [92, 62, 28], brass: [176, 128, 60], brassLight: [236, 196, 120],
  panel: [52, 62, 72], panelLight: [96, 112, 124], panelDark: [26, 31, 37],
  bezel: [18, 22, 26], bezelHi: [130, 144, 154],
  sonarBg: [8, 34, 22], sonarLine: [28, 92, 58], sonar: [80, 236, 140],
  ballTop: [63, 143, 162], ballBot: [94, 72, 42],
  needle: [242, 162, 58], label: [140, 160, 168], screenGreen: [96, 240, 150],
};

interface Circle { x: number; y: number; r: number }
interface Layout {
  wcx: number; wcy: number; wa: number; wb: number; frame: number; panelTop: number;
  sonar: Circle; ball: Circle; g1: Circle; g2: Circle;
  tapeY: number; tapeW: number;
  nitro: { x: number; y0: number; y1: number; w: number };
  lamps: { x: number; y: number; n: number; s: number };
}

export interface CockpitData {
  t: number; heading: number; roll: number; pitch: number;
  depth: number; depthFrac: number; speedKn: number; speedFrac: number;
  nitro: number; nitroOn: boolean; boosting: boolean; clearance: number;
  subX: number; subY: number; subH: number;
}

export class Cockpit {
  private W = 0;
  private H = 0;
  private col = new Uint32Array(0);
  private alpha = new Uint8Array(0);
  L!: Layout;

  private build(W: number, H: number) {
    this.W = W;
    this.H = H;
    this.col = new Uint32Array(W * H);
    this.alpha = new Uint8Array(W * H);
    const u = Math.min(W, H * 1.6) / 427;
    const panelTop = Math.round(H * 0.7);
    const wcx = W / 2, wcy = H * 0.355;
    const wa = W * 0.47, wb = panelTop - 4 - wcy;
    const frame = Math.max(4, Math.round(7 * u));
    const portrait = W < H;
    const ra = Math.max(9, Math.round(Math.min(H * 0.095, W * (portrait ? 0.082 : 0.095))));
    // 横屏和竖屏（手机）各一套仪表位置
    const X = portrait ? [0.14, 0.4, 0.64, 0.82, 0.95] : [0.15, 0.5, 0.665, 0.8, 0.915];
    const iy = Math.round(panelTop + (H - panelTop) * 0.5);
    const L: Layout = {
      wcx, wcy, wa, wb, frame, panelTop,
      sonar: { x: Math.round(W * X[0]), y: iy, r: Math.round(ra * 1.08) },
      ball: { x: Math.round(W * X[1]), y: iy + 2, r: ra },
      g1: { x: Math.round(W * X[2]), y: iy, r: Math.round(ra * 0.72) },
      g2: { x: Math.round(W * X[3]), y: iy, r: Math.round(ra * 0.72) },
      tapeY: panelTop + 4, tapeW: Math.round(ra * 2.6),
      nitro: { x: Math.round(W * X[4]) - (portrait ? 3 : 0), y0: iy - ra, y1: iy + ra, w: Math.max(5, Math.round(7 * u)) },
      lamps: { x: Math.round(W * 0.5), y: panelTop - 1, n: 5, s: Math.max(3, Math.round(4 * u)) },
    };
    this.L = L;
    const col = this.col, al = this.alpha;
    const set = (x: number, y: number, c: number[], a = 255) => {
      if (x < 0 || y < 0 || x >= W || y >= H) return;
      const i = y * W + x;
      col[i] = pack(c[0], c[1], c[2]);
      al[i] = a;
    };
    const shade = (c: number[], k: number) => [c[0] * k, c[1] * k, c[2] * k];

    // 舱壁 / 观察窗 / 铜框
    const minR = Math.min(wa, wb);
    for (let y = 0; y < panelTop; y++) {
      for (let x = 0; x < W; x++) {
        const nx = (x + 0.5 - wcx) / wa, ny = (y + 0.5 - wcy) / wb;
        const d = Math.pow(nx ** 4 + ny ** 4, 0.25);
        const px = (d - 1) * minR; // 到窗边的大致像素距离
        if (px < 0) {
          // 玻璃：透明，两角各有几道斜的反光
          const diag = x + y * 0.9;
          const band = (diag - wcx * 0.15) % 46;
          const corner = (nx < -0.62 && ny < -0.35) || (nx > 0.66 && ny < -0.4);
          if (corner && band > 0 && band < 3 && hash2(x, y, 3) > 0.25) set(x, y, [235, 250, 250], 30);
          continue;
        }
        if (px < frame) {
          const t = px / frame;
          let c = C.brass;
          if (t < 0.22) c = ny < 0.1 ? C.brassDark : C.brassLight; // 内缘斜面（上暗下亮：光从窗外照进来）
          else if (t > 0.82) c = C.brassDark;
          else if (ny < -0.3) c = shade(C.brass, 1.08);
          set(x, y, shade(c, 0.93 + hash2(x, y, 5) * 0.12));
          continue;
        }
        // 钢板舱壁：竖缝、横缝、噪点，越往上越暗
        const seam = Math.round(44 * u);
        let c = C.wall;
        const sx = x % seam, sy = y % Math.round(38 * u);
        if (sx === 0 || sy === 0) c = C.wallDark;
        else if (sx === 1 || sy === 1) c = C.wallLight;
        const k = (0.75 + 0.25 * (y / panelTop)) * (0.94 + hash2(x, y, 7) * 0.1);
        set(x, y, shade(c, k));
        // 缝上的铆钉
        if ((sx === 3 || sy === 3) && (x + y) % Math.round(9 * u) === 0) set(x, y, C.brassLight);
      }
    }
    // 铜框上的铆钉
    const nr = Math.round((2 * (wa + wb)) / (14 * u));
    for (let i = 0; i < nr; i++) {
      const a = (i / nr) * Math.PI * 2;
      const ca = Math.cos(a), sa = Math.sin(a);
      const rr = 1 + frame / 2 / minR;
      const x = Math.round(wcx + wa * rr * Math.sign(ca) * Math.sqrt(Math.abs(ca)));
      const y = Math.round(wcy + wb * rr * Math.sign(sa) * Math.sqrt(Math.abs(sa)));
      if (y >= panelTop - 1) continue;
      set(x, y, C.brassLight);
      set(x + 1, y, C.brass);
      set(x, y + 1, C.brassDark);
      set(x + 1, y + 1, C.brassDark);
    }

    // 仪表台
    for (let y = panelTop; y < H; y++) {
      for (let x = 0; x < W; x++) {
        let c = C.panel;
        const dy = y - panelTop;
        if (dy === 0) c = C.panelDark;
        else if (dy === 1 || dy === 2) c = C.panelLight;
        else if (dy === 3) c = C.panelDark;
        const k = (1 - (dy / (H - panelTop)) * 0.35) * (0.95 + hash2(x, y, 11) * 0.08);
        set(x, y, shade(c, dy < 4 ? 1 : k));
      }
    }
    // 中间凸起的灯座
    const lp = L.lamps;
    const lw = lp.n * (lp.s + 3) + 5;
    for (let y = panelTop - lp.s - 5; y < panelTop + 1; y++)
      for (let x = Math.round(lp.x - lw / 2); x < Math.round(lp.x + lw / 2); x++)
        set(x, y, y === panelTop - lp.s - 5 ? C.panelLight : C.panelDark);

    // 表盘外圈
    const bezel = (c: Circle) => {
      for (let y = c.y - c.r - 4; y <= c.y + c.r + 4; y++)
        for (let x = c.x - c.r - 4; x <= c.x + c.r + 4; x++) {
          const d = Math.hypot(x + 0.5 - c.x, y + 0.5 - c.y);
          if (d > c.r + 3.5 || d <= c.r) continue;
          const hi = x - c.x + (y - c.y) < 0;
          set(x, y, d > c.r + 2.4 ? C.bezel : hi ? C.bezelHi : shade(C.bezelHi, 0.55));
        }
      // 四颗螺丝
      for (const [ox, oy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
        const sx = Math.round(c.x + ox * (c.r + 5)), sy = Math.round(c.y + oy * (c.r + 5));
        if (sy > panelTop + 4) {
          set(sx, sy, C.bezelHi);
          set(sx + 1, sy + 1, C.bezel);
        }
      }
    };
    for (const c of [L.sonar, L.ball, L.g1, L.g2]) bezel(c);
    // 能量格外框
    const nb = L.nitro;
    for (let y = nb.y0 - 2; y <= nb.y1 + 2; y++)
      for (let x = nb.x - 2; x <= nb.x + nb.w + 1; x++)
        set(x, y, y === nb.y0 - 2 || x === nb.x - 2 ? C.bezel : C.panelDark);

    // 标签
    const label = (str: string, cx: number, y: number) => this.text(this.col, this.alpha, W, H, str, Math.round(cx - textWidth(str) / 2), y, C.label, 255);
    const ly = Math.min(H - 10, L.sonar.y + L.sonar.r + 6);
    label('SONAR', L.sonar.x, ly);
    label('DEPTH', L.g1.x, ly);
    label('SPEED', L.g2.x, ly);
    label('N2', nb.x + nb.w / 2, ly);
  }

  /** 在缓冲区里写字（静态层或帧缓冲都可以） */
  private text(buf: Uint32Array, al: Uint8Array | null, W: number, H: number, str: string, x: number, y: number, c: number[], a: number) {
    const p = pack(c[0], c[1], c[2]);
    for (let n = 0; n < str.length; n++) {
      const g = GLYPHS[str[n]] ?? GLYPHS[' '];
      for (let i = 0; i < 15; i++) {
        if (g[i] !== '1') continue;
        const px = x + n * 4 + (i % 3), py = y + Math.floor(i / 3);
        if (px < 0 || py < 0 || px >= W || py >= H) continue;
        buf[py * W + px] = p;
        if (al) al[py * W + px] = a;
      }
    }
  }

  /** amount：0..1，座舱程度。仪表台和框从下往上滑进来 */
  draw(r: Renderer, d: CockpitData, world: World, amount: number) {
    if (amount <= 0.01) return;
    const { W, H, buf } = r;
    if (W !== this.W || H !== this.H) this.build(W, H);
    const shift = Math.round((1 - amount) * (1 - amount) * H);
    const col = this.col, al = this.alpha;
    // 静态层
    for (let y = shift; y < H; y++) {
      const sy = y - shift;
      let i = y * W, j = sy * W;
      for (let x = 0; x < W; x++, i++, j++) {
        const a = al[j];
        if (a === 0) continue;
        if (a === 255) buf[i] = col[j];
        else {
          const c = buf[i], s = col[j], f = a / 255;
          const R = (c & 255) + ((s & 255) - (c & 255)) * f;
          const G = ((c >> 8) & 255) + (((s >> 8) & 255) - ((c >> 8) & 255)) * f;
          const B = ((c >> 16) & 255) + (((s >> 16) & 255) - ((c >> 16) & 255)) * f;
          buf[i] = (0xff000000 | ((B | 0) << 16) | ((G | 0) << 8) | (R | 0)) >>> 0;
        }
      }
    }
    if (amount < 0.98) return;
    const L = this.L;
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
    const t = d.t;

    // ---- 声呐：扫描线扫过时，周围比潜艇高的海床（岩壁）亮起来 ----
    {
      const S = L.sonar;
      const sweep = (t * 2.2) % (Math.PI * 2);
      for (let y = -S.r; y <= S.r; y++)
        for (let x = -S.r; x <= S.r; x++) {
          const rr = Math.hypot(x + 0.5, y + 0.5);
          if (rr > S.r) continue;
          let c = C.sonarBg;
          const ring = Math.abs(rr - S.r * 0.33) < 0.5 || Math.abs(rr - S.r * 0.66) < 0.5 || x === 0 || y === 0;
          if (ring) c = C.sonarLine;
          // 扫描后的余辉
          const ang = Math.atan2(x + 0.5, -(y + 0.5));
          let age = (sweep - ang) % (Math.PI * 2);
          if (age < 0) age += Math.PI * 2;
          const k = Math.max(0, 1 - age / 1.3);
          put(S.x + x, S.y + y, pack(c[0] + 20 * k, c[1] + 70 * k, c[2] + 40 * k));
        }
      const range = 190;
      const sh = Math.sin(d.heading), chh = Math.cos(d.heading);
      const NA = 48, NR = 12;
      for (let ai = 0; ai < NA; ai++) {
        const ang = (ai / NA) * Math.PI * 2;
        let age = (sweep - ang) % (Math.PI * 2);
        if (age < 0) age += Math.PI * 2;
        const k = Math.exp(-age * 0.9);
        if (k < 0.08) continue;
        const ca = Math.cos(ang), sa = Math.sin(ang);
        for (let ri = 1; ri <= NR; ri++) {
          const dist = (ri / NR) * range;
          // 声呐图上「上」= 潜艇前方
          const fx = sa * dist, fy = ca * dist;
          const wx = d.subX + fx * chh + fy * sh;
          const wy = d.subY - fx * sh + fy * chh;
          const hgt = world.heightAt(wx, wy);
          if (hgt < d.subH - 6) continue;
          const px = S.x + sa * (ri / NR) * (S.r - 2), py = S.y - ca * (ri / NR) * (S.r - 2);
          glow(px, py, C.sonar, k);
          if (S.r > 18) glow(px + 1, py, C.sonar, k * 0.6);
        }
      }
      // 扫描线
      for (let q = 0; q < S.r; q++) glow(S.x + Math.sin(sweep) * q, S.y - Math.cos(sweep) * q, C.sonar, 0.85);
      // 自己（中间一个小三角）
      put(S.x, S.y - 1, pack(255, 246, 216));
      put(S.x - 1, S.y + 1, pack(255, 246, 216));
      put(S.x + 1, S.y + 1, pack(255, 246, 216));
    }

    // ---- 姿态球：随横滚旋转、随俯仰上下移 ----
    {
      const B = L.ball;
      const ca = Math.cos(d.roll), sa = Math.sin(d.roll);
      const off = d.pitch * B.r * 2.2;
      for (let y = -B.r; y <= B.r; y++)
        for (let x = -B.r; x <= B.r; x++) {
          const rr = Math.hypot(x + 0.5, y + 0.5);
          if (rr > B.r) continue;
          const yr = -(x + 0.5) * sa + (y + 0.5) * ca;
          let c = yr < off ? C.ballTop : C.ballBot;
          const shadeK = 1 - (rr / B.r) ** 2 * 0.35;
          if (Math.abs(yr - off) < 0.6) c = [240, 240, 230];
          else if (Math.abs(Math.abs(yr - off) - B.r * 0.35) < 0.5 && Math.abs((x + 0.5) * ca + (y + 0.5) * sa) < B.r * 0.3) c = [220, 230, 230];
          put(B.x + x, B.y + y, pack(c[0] * shadeK, c[1] * shadeK, c[2] * shadeK));
        }
      // 固定的艇身标记
      const o = pack(...(C.needle as [number, number, number]));
      for (let q = -Math.round(B.r * 0.55); q <= Math.round(B.r * 0.55); q++) if (Math.abs(q) > 2) put(B.x + q, B.y, o);
      put(B.x, B.y, o);
      put(B.x, B.y + 1, o);
    }

    // ---- 航向带 ----
    {
      const cx = L.ball.x, y = L.tapeY, w = L.tapeW;
      const deg = ((d.heading * 180) / Math.PI + 360) % 360;
      for (let x = -w / 2; x < w / 2; x++)
        for (let yy = 0; yy < 9; yy++) put(cx + x, y + yy, pack(14, 20, 24));
      const pxPerDeg = w / 90;
      for (let a = Math.floor((deg - 45) / 5) * 5; a <= deg + 45; a += 5) {
        const x = cx + (a - deg) * pxPerDeg;
        if (Math.abs(x - cx) > w / 2 - 1) continue;
        const aa = ((a % 360) + 360) % 360;
        const major = aa % 30 === 0;
        put(x, y + 8, pack(...(C.label as [number, number, number])));
        if (major) {
          put(x, y + 7, pack(...(C.label as [number, number, number])));
          const lab = aa === 0 ? 'N' : aa === 90 ? 'E' : aa === 180 ? 'S' : aa === 270 ? 'W' : String(aa / 10);
          this.text(buf, null, W, H, lab, Math.round(x - textWidth(lab) / 2), y + 1, aa % 90 === 0 ? [255, 246, 216] : C.label, 255);
        }
      }
      const o = pack(...(C.needle as [number, number, number]));
      put(cx, y + 9, o);
      put(cx - 1, y + 10, o);
      put(cx + 1, y + 10, o);
    }

    // ---- 深度表、航速表 ----
    const gauge = (G: Circle, frac: number, value: string) => {
      for (let y = -G.r; y <= G.r; y++)
        for (let x = -G.r; x <= G.r; x++) {
          const rr = Math.hypot(x + 0.5, y + 0.5);
          if (rr > G.r) continue;
          put(G.x + x, G.y + y, pack(16, 22, 26));
        }
      // 刻度：从左下（-135°）到右下（+135°）
      for (let i = 0; i <= 10; i++) {
        const a = (-135 + i * 27) * (Math.PI / 180);
        const r1 = G.r - 1, r0 = G.r - (i % 5 === 0 ? 3 : 2);
        for (let q = r0; q <= r1; q++) put(G.x + Math.sin(a) * q, G.y - Math.cos(a) * q, pack(...(C.label as [number, number, number])));
      }
      const a = (-135 + Math.max(0, Math.min(1, frac)) * 270) * (Math.PI / 180);
      const o = pack(...(C.needle as [number, number, number]));
      for (let q = 0; q < G.r - 2; q++) put(G.x + Math.sin(a) * q, G.y - Math.cos(a) * q, o);
      this.text(buf, null, W, H, value, Math.round(G.x - textWidth(value) / 2), Math.round(G.y + G.r * 0.35), C.screenGreen, 255);
    };
    gauge(L.g1, d.depthFrac, String(Math.round(d.depth)));
    gauge(L.g2, d.speedFrac, String(Math.round(d.speedKn)));

    // ---- 氮气能量格 ----
    {
      const nb = L.nitro;
      const segs = 8, h = (nb.y1 - nb.y0 + 1) / segs;
      for (let sgi = 0; sgi < segs; sgi++) {
        const on = d.nitro * segs > sgi + 0.25;
        const c = !on ? [24, 40, 34] : d.nitroOn ? [255, 246, 216] : d.nitro >= 0.25 ? [142, 244, 243] : [80, 140, 140];
        const y1 = Math.round(nb.y1 - sgi * h), y0 = Math.round(y1 - h + 2);
        for (let y = y0; y <= y1; y++) for (let x = nb.x; x < nb.x + nb.w; x++) put(x, y, pack(c[0], c[1], c[2]));
      }
    }

    // ---- 指示灯：加速（琥珀）、氮气可用（青）、氮气喷射（白）、贴近海床（红闪）、电源（绿慢闪） ----
    {
      const lp = L.lamps;
      const states: [boolean, number[]][] = [
        [d.boosting, [255, 170, 60]],
        [d.nitro >= 0.25 && !d.nitroOn, [120, 240, 240]],
        [d.nitroOn, [255, 250, 230]],
        [d.clearance < 13 && Math.sin(t * 12) > 0, [255, 70, 50]],
        [Math.sin(t * 2) > -0.6, [90, 230, 120]],
      ];
      const x0 = Math.round(lp.x - (lp.n * (lp.s + 3)) / 2) + 2;
      states.forEach(([on, c], i) => {
        const x = x0 + i * (lp.s + 3);
        const k = on ? 1 : 0.22;
        for (let y = lp.y - lp.s - 2; y < lp.y - 2; y++) for (let q = 0; q < lp.s; q++) put(x + q, y, pack(c[0] * k, c[1] * k, c[2] * k));
      });
    }

    // ---- 玻璃上的准星和读数 ----
    {
      const hc = [120, 250, 200];
      const cx = Math.round(W / 2), cy = Math.round(L.wcy + L.wb * 0.08);
      for (let q = 3; q <= 7; q++) {
        glow(cx - q, cy, hc, 0.8);
        glow(cx + q, cy, hc, 0.8);
        glow(cx, cy - q, hc, 0.8);
        glow(cx, cy + q, hc, 0.8);
      }
      // 两侧括号
      const bx = Math.round(L.wa * 0.32);
      for (let q = -6; q <= 6; q++) {
        glow(cx - bx, cy + q, hc, 0.45);
        glow(cx + bx, cy + q, hc, 0.45);
      }
      for (let q = 0; q < 3; q++) {
        glow(cx - bx + q, cy - 6, hc, 0.45);
        glow(cx - bx + q, cy + 6, hc, 0.45);
        glow(cx + bx - q, cy - 6, hc, 0.45);
        glow(cx + bx - q, cy + 6, hc, 0.45);
      }
      const sp = String(Math.round(d.speedKn)), dp = String(Math.round(d.depth)).padStart(3, '0');
      this.textGlow(r, sp, cx - bx - 4 - textWidth(sp), cy - 2, hc);
      this.textGlow(r, dp, cx + bx + 5, cy - 2, hc);
    }
  }

  private textGlow(r: Renderer, str: string, x: number, y: number, c: number[]) {
    const { W, H, buf } = r;
    for (let n = 0; n < str.length; n++) {
      const g = GLYPHS[str[n]] ?? GLYPHS[' '];
      for (let i = 0; i < 15; i++) {
        if (g[i] !== '1') continue;
        const px = x + n * 4 + (i % 3), py = y + Math.floor(i / 3);
        if (px < 0 || py < 0 || px >= W || py >= H) continue;
        const b = buf[py * W + px];
        buf[py * W + px] = pack((b & 255) * 0.25 + c[0] * 0.75, ((b >> 8) & 255) * 0.25 + c[1] * 0.75, ((b >> 16) & 255) * 0.25 + c[2] * 0.75);
      }
    }
  }
}
