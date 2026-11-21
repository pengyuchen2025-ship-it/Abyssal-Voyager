// 潜望镜视角：驾驶舱里的潜望镜观察窗。卡通风格的奶油色控制面板中间嵌一个圆形观察窗，
// 窗外是潜望镜看到的世界；窗上有白色细线分划（两端带短横的十字线、边缘一圈小三角、左下右下两道弧形括号）。
// 面板上：八角形铆钉底板、淡紫色小屏（方位 / 深度 / 航速）、声呐圆屏、氮气指示条、紫色圆顶灯，
// 底部操作台上一排按钮和贴近海床时闪红的警示灯。描边统一用深棕色。
// 进入时面板从放大状态缩回来（像眼睛从观察窗前退回座位），退出时反过来。
// 静态部分每个分辨率生成一次，动态部分（分划线、读数、声呐、灯）每帧画。

import { Renderer } from './renderer';
import { World } from './world';
import { hash2 } from './noise';
import { pack } from './color';

// ---- 3×5 像素字体 ----
const GLYPHS: Record<string, string> = {
  '0': '111101101101111', '1': '010110010010111', '2': '111001111100111', '3': '111001111001111',
  '4': '101101111001001', '5': '111100111001111', '6': '111100111101111', '7': '111001010010010',
  '8': '111101111101111', '9': '111101111001111', B: '110101110101110', D: '110101101101110',
  G: '011100101101011', N: '101111111111101', P: '110101110100100', R: '110101110101101',
  S: '011100010001110', T: '111010010010010', ' ': '000000000000000',
};
const textWidth = (str: string) => str.length * 4 - 1;

type RGB = [number, number, number];
const C: Record<string, RGB> = {
  out: [74, 50, 48],
  wall: [222, 202, 146], wallSeam: [184, 160, 108], wallHi: [240, 228, 186],
  mauve: [156, 116, 124], mauveDark: [118, 84, 94],
  plate: [234, 218, 166], plateHi: [248, 238, 204], plateShade: [206, 186, 132],
  rim: [248, 240, 210], rimShade: [196, 176, 126],
  slot: [96, 70, 74],
  screen: [204, 188, 238], screenHi: [232, 222, 252], screenText: [70, 46, 112],
  sonarBg: [18, 58, 44], sonarLine: [44, 110, 80], sonar: [120, 250, 170],
  purple: [126, 90, 176], purpleHi: [196, 168, 236], purpleGlow: [236, 210, 255],
  red: [230, 78, 64], redOff: [128, 70, 62],
  console: [190, 164, 118], consoleHi: [216, 194, 148],
  green: [96, 200, 120], blue: [110, 190, 230],
  reticle: [246, 252, 246],
};
const P = (c: RGB) => pack(c[0], c[1], c[2]);

/** 观察窗的位置和大小（镜头也用它：画面中心 = 圆心） */
export interface ScopeLayout { cx: number; cy: number; R: number; plate: number }
export function scopeLayout(W: number, H: number): ScopeLayout {
  const R = Math.floor(Math.min(W * 0.42, H * 0.41));
  const cy = Math.min(H - R - 14, Math.max(R + 6, Math.round(H * 0.36)));
  return { cx: W / 2, cy, R, plate: R + Math.max(7, Math.round(R * 0.12)) };
}

export interface ScopeData {
  t: number; heading: number;
  depth: number; speedKn: number;
  nitro: number; nitroOn: boolean; clearance: number;
  subX: number; subY: number; subH: number;
}

interface Widget { kind: 'screen' | 'sonar' | 'nitro' | 'dome'; x: number; y: number; w: number; h: number; id?: string }

export class Periscope {
  private W = 0;
  private H = 0;
  private L!: ScopeLayout;
  /** 静态层：颜色；solid = 1 不透明面板，0 观察窗玻璃 */
  private col = new Uint32Array(0);
  private solid = new Uint8Array(0);
  /** 玻璃：边缘压暗（乘数 0..255）和高光（白色叠加 0..255） */
  private gMul = new Uint8Array(0);
  private gAdd = new Uint8Array(0);
  private widgets: Widget[] = [];
  private lamp = { x: 0, y: 0 };

  private build(W: number, H: number) {
    this.W = W;
    this.H = H;
    const L = (this.L = scopeLayout(W, H));
    const n = W * H;
    this.col = new Uint32Array(n);
    this.solid = new Uint8Array(n).fill(1);
    this.gMul = new Uint8Array(n).fill(255);
    this.gAdd = new Uint8Array(n);
    const col = this.col;
    const set = (x: number, y: number, c: RGB, k = 1) => {
      if (x < 0 || y < 0 || x >= W || y >= H) return;
      col[y * W + x] = pack(c[0] * k, c[1] * k, c[2] * k);
    };
    const { cx, cy, R, plate } = L;
    const consoleH = Math.max(14, Math.round(H * 0.07));
    const consoleY = H - consoleH;
    const band = Math.max(4, Math.round(H * 0.035));

    // ---- 舱壁：奶油色钢板，接缝 + 铆钉；顶上一条紫灰色横梁 ----
    const seamX = Math.max(30, Math.round(R * 0.5)), seamY = Math.max(26, Math.round(R * 0.42));
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        const k = 0.97 + hash2(x, y, 13) * 0.05;
        if (y < band) {
          set(x, y, y === band - 1 ? C.out : y === band - 2 ? C.mauveDark : C.mauve, k);
          continue;
        }
        const sx = (((x - Math.round(cx)) % seamX) + seamX) % seamX, sy = (y - band) % seamY;
        let c = C.wall;
        if (sx === 0 || sy === 0) c = C.wallSeam;
        else if (sx === 1 || sy === 1) c = C.wallHi;
        set(x, y, c, k);
        if ((sx === 4 || sx === seamX - 3) && (sy === 4 || sy === seamY - 3)) set(x, y, C.wallSeam);
      }

    // ---- 八角形底板 + 铆钉 ----
    const octo = (x: number, y: number) => {
      const ax = Math.abs(x + 0.5 - cx), ay = Math.abs(y + 0.5 - cy);
      return Math.max(ax, ay, (ax + ay) / Math.SQRT2 * 1.08);
    };
    for (let y = Math.max(0, Math.floor(cy - plate - 2)); y < Math.min(H, cy + plate + 2); y++)
      for (let x = Math.max(0, Math.floor(cx - plate - 2)); x < Math.min(W, cx + plate + 2); x++) {
        const o = octo(x, y);
        if (o > plate + 1) continue;
        if (o > plate) set(x, y, C.out);
        else {
          // 左上亮、右下暗的斜面
          const edge = o > plate - 2;
          const lit = x - cx + (y - cy) < 0;
          set(x, y, edge ? (lit ? C.plateHi : C.plateShade) : C.plate, 0.98 + hash2(x, y, 17) * 0.04);
        }
      }
    // 观察窗上方的深色槽
    {
      const y1 = Math.round(cy - R - 4), y0 = Math.max(band + 1, Math.round(cy - plate + 3));
      const hw = Math.round(R * 0.32);
      for (let y = y0; y <= y1; y++)
        for (let x = Math.round(cx - hw + (y - y0)); x <= Math.round(cx + hw - (y - y0)); x++) set(x, y, y === y0 ? C.out : C.slot);
    }
    const rivR = (R + plate) / 2 + 1;
    const nr = Math.max(8, Math.round((Math.PI * 2 * rivR) / 16));
    for (let i = 0; i < nr; i++) {
      const a = (i / nr) * Math.PI * 2 + 0.2;
      const x = Math.round(cx + Math.cos(a) * rivR), y = Math.round(cy + Math.sin(a) * rivR);
      if (octo(x, y) > plate - 2) continue;
      set(x, y, C.out);
      set(x - 1, y - 1, C.plateHi);
    }

    // ---- 观察窗：粗奶油色窗框 + 玻璃（边缘压暗、左上一道弧形高光） ----
    const rimW = Math.max(3, Math.round(R * 0.045));
    for (let y = Math.max(0, Math.floor(cy - R - rimW - 2)); y < Math.min(H, cy + R + rimW + 2); y++)
      for (let x = Math.max(0, Math.floor(cx - R - rimW - 2)); x < Math.min(W, cx + R + rimW + 2); x++) {
        const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
        const i = y * W + x;
        if (d < R) {
          this.solid[i] = 0;
          const f = Math.max(0, (d - R * 0.82) / (R * 0.18));
          this.gMul[i] = Math.round(255 * (1 - f * f * 0.45));
          const ang = Math.atan2(y + 0.5 - cy, x + 0.5 - cx);
          if (d > R * 0.86 && d < R * 0.92 && ang > -2.55 && ang < -1.95) this.gAdd[i] = 90;
          if (d > R * 0.8 && d < R * 0.83 && ang > -2.45 && ang < -2.15) this.gAdd[i] = 60;
          continue;
        }
        if (d < R + 1) set(x, y, C.out);
        else if (d < R + rimW) {
          const lit = x - cx + (y - cy) < 0;
          set(x, y, d < R + 2 ? (lit ? C.rimShade : C.rim) : lit ? C.rim : C.rimShade);
        } else if (d < R + rimW + 1) set(x, y, C.out);
      }

    // ---- 面板上的仪表：横屏放在观察窗两侧，竖屏放在下面 ----
    const sideW = cx - plate;
    const side = sideW >= 50;
    const sw = 40, sh = 11;
    const sr = Math.max(10, Math.min(16, Math.round(R * 0.13)));
    const left: Widget[] = [
      { kind: 'screen', x: 0, y: 0, w: sw, h: sh, id: 'BRG' },
      { kind: 'screen', x: 0, y: 0, w: sw, h: sh, id: 'DPT' },
      { kind: 'sonar', x: 0, y: 0, w: sr * 2 + 4, h: sr * 2 + 4 },
    ];
    const right: Widget[] = [
      { kind: 'screen', x: 0, y: 0, w: sw, h: sh, id: 'SPD' },
      { kind: 'nitro', x: 0, y: 0, w: 30, h: 21 },
      { kind: 'dome', x: 0, y: 0, w: 18, h: 18 },
    ];
    const gap = 7;
    const stackH = (ws: Widget[]) => ws.reduce((a, w) => a + w.h, 0) + gap * (ws.length - 1);
    const place = (ws: Widget[], colX: number, y0: number) => {
      let y = y0;
      for (const w of ws) {
        w.x = Math.round(colX - w.w / 2);
        w.y = Math.round(y);
        y += w.h + gap;
      }
    };
    if (side) {
      const colOff = plate + sideW / 2;
      place(left, cx - colOff, cy - stackH(left) / 2);
      place(right, cx + colOff, cy - stackH(right) / 2);
    } else {
      const top = cy + plate + 8;
      const room = consoleY - 4 - top;
      const y0 = top + Math.max(0, (room - Math.max(stackH(left), stackH(right))) / 2);
      place(left, cx - W * 0.25, y0);
      place(right, cx + W * 0.25, y0);
    }
    this.widgets = [...left, ...right];
    const rect = (x0: number, y0: number, w: number, h: number, fill: RGB, hi: RGB) => {
      for (let y = y0 - 1; y <= y0 + h; y++)
        for (let x = x0 - 1; x <= x0 + w; x++) {
          const edge = y === y0 - 1 || y === y0 + h || x === x0 - 1 || x === x0 + w;
          set(x, y, edge ? C.out : y === y0 || x === x0 ? hi : fill);
        }
    };
    const disc = (x0: number, y0: number, r: number, f: (dx: number, dy: number, d: number) => RGB | null) => {
      for (let y = Math.floor(y0 - r - 1); y <= y0 + r + 1; y++)
        for (let x = Math.floor(x0 - r - 1); x <= x0 + r + 1; x++) {
          const dx = x + 0.5 - x0, dy = y + 0.5 - y0, d = Math.hypot(dx, dy);
          const c = f(dx, dy, d);
          if (c) set(x, y, c);
        }
    };
    for (const w of this.widgets) {
      if (w.kind === 'screen') {
        // 屏幕外面一圈浅色底座
        rect(w.x - 2, w.y - 2, w.w + 4, w.h + 4, C.plate, C.plateHi);
        rect(w.x, w.y, w.w, w.h, C.screen, C.screenHi);
      } else if (w.kind === 'sonar') {
        const r = (w.w - 4) / 2, x0 = w.x + w.w / 2, y0 = w.y + w.h / 2;
        disc(x0, y0, r + 2, (dx, dy, d) => (d > r + 2.5 ? null : d > r + 1.5 ? C.out : d > r ? (dx + dy < 0 ? C.plateHi : C.plateShade) : C.sonarBg));
      } else if (w.kind === 'nitro') {
        rect(w.x, w.y, w.w, w.h, C.console, C.consoleHi);
      } else if (w.kind === 'dome') {
        const r = w.w / 2 - 1, x0 = w.x + w.w / 2, y0 = w.y + w.h / 2;
        disc(x0, y0, r + 1, (_dx, _dy, d) => (d > r + 1.5 ? null : d > r + 0.5 ? C.out : C.plateShade));
      }
    }

    // ---- 底部操作台：一排圆按钮，中间是警示灯 ----
    for (let y = consoleY; y < H; y++)
      for (let x = 0; x < W; x++) set(x, y, y === consoleY ? C.out : y === consoleY + 1 ? C.consoleHi : C.console, 0.97 + hash2(x, y, 21) * 0.05);
    const by = Math.round(consoleY + consoleH / 2 + 1);
    const nb = Math.max(4, Math.floor(W / 46));
    for (let i = 0; i < nb; i++) {
      const bx = Math.round(((i + 0.5) / nb) * W);
      if (Math.abs(bx - cx) < 12) continue;
      const c = i % 2 ? C.blue : C.green;
      disc(bx, by, 4, (dx, dy, d) => (d > 4.5 ? null : d > 3.5 ? C.out : d > 2.5 ? C.consoleHi : dx + dy < -1.5 ? [255, 255, 255] : c));
    }
    this.lamp = { x: Math.round(cx), y: by };
    disc(this.lamp.x, by, 4, (_dx, _dy, d) => (d > 4.5 ? null : d > 3.5 ? C.out : C.redOff));
  }

  /** amount：0..1，潜望镜程度 */
  draw(r: Renderer, d: ScopeData, world: World, amount: number) {
    if (amount <= 0.01) return;
    const { W, H, buf } = r;
    if (W !== this.W || H !== this.H) this.build(W, H);
    const { cx, cy, R } = this.L;

    // ---- 静态层（过渡时整体从放大缩回原大小） ----
    const e = 1 - amount;
    const s = 1 + 2.4 * e * e;
    const col = this.col, solid = this.solid, gMul = this.gMul, gAdd = this.gAdd;
    for (let y = 0; y < H; y++) {
      const sy = Math.min(H - 1, Math.max(0, Math.floor(cy + (y + 0.5 - cy) / s)));
      const row = sy * W;
      let i = y * W;
      for (let x = 0; x < W; x++, i++) {
        const sx = s === 1 ? x : Math.min(W - 1, Math.max(0, Math.floor(cx + (x + 0.5 - cx) / s)));
        const j = row + sx;
        if (solid[j]) buf[i] = col[j];
        else {
          const m = gMul[j], a = gAdd[j];
          if (m === 255 && a === 0) continue;
          const c = buf[i];
          let R0 = ((c & 255) * m) >> 8, G0 = (((c >> 8) & 255) * m) >> 8, B0 = (((c >> 16) & 255) * m) >> 8;
          if (a) {
            R0 += ((255 - R0) * a) >> 8;
            G0 += ((255 - G0) * a) >> 8;
            B0 += ((255 - B0) * a) >> 8;
          }
          buf[i] = (0xff000000 | (B0 << 16) | (G0 << 8) | R0) >>> 0;
        }
      }
    }
    if (amount < 0.97) return;

    const put = (x: number, y: number, c: number) => {
      x = Math.round(x);
      y = Math.round(y);
      if (x >= 0 && y >= 0 && x < W && y < H) buf[y * W + x] = c;
    };
    const glow = (x: number, y: number, c: RGB, a: number) => {
      x = Math.round(x);
      y = Math.round(y);
      if (x < 0 || y < 0 || x >= W || y >= H) return;
      const i = y * W + x, b = buf[i];
      buf[i] = pack((b & 255) + (c[0] - (b & 255)) * a, ((b >> 8) & 255) + (c[1] - ((b >> 8) & 255)) * a, ((b >> 16) & 255) + (c[2] - ((b >> 16) & 255)) * a);
    };
    const icx = Math.round(cx - 0.5), icy = Math.round(cy);

    // ---- 分划：白色细线 ----
    {
      const c = C.reticle, A = 0.88;
      const len = Math.round(R * 0.9);
      for (let q = -len; q <= len; q++) {
        glow(icx + q, icy, c, A);
        if (q !== 0) glow(icx, icy + q, c, A);
      }
      // 两端的短横
      for (let q = -2; q <= 2; q++) {
        glow(icx - len, icy + q, c, A);
        glow(icx + len, icy + q, c, A);
        glow(icx + q, icy - len, c, A);
        glow(icx + q, icy + len, c, A);
      }
      // 边缘一圈小三角（指向圆心）
      const ts = Math.max(2, Math.round(R * 0.03));
      for (const deg of [-150, -120, -60, -30, 60, 120]) {
        const a = (deg * Math.PI) / 180, ca = Math.cos(a), sa = Math.sin(a);
        const rt = R * 0.86, rb = R * 0.86 + ts * 1.8;
        const tx = cx + ca * rt, ty = cy + sa * rt;
        const bx = cx + ca * rb, by = cy + sa * rb;
        // 三角形：尖端 (tx,ty)，底边中点 (bx,by)，半宽 ts
        for (let y = Math.floor(Math.min(ty, by) - ts - 1); y <= Math.max(ty, by) + ts + 1; y++)
          for (let x = Math.floor(Math.min(tx, bx) - ts - 1); x <= Math.max(tx, bx) + ts + 1; x++) {
            const px = x + 0.5 - tx, py = y + 0.5 - ty;
            const along = px * ca + py * sa; // 0 在尖端，ts*1.8 在底边
            const across = Math.abs(-px * sa + py * ca);
            if (along < 0 || along > ts * 1.8 || across > (along / (ts * 1.8)) * ts) continue;
            const edge = along > ts * 1.8 - 1 || across > (along / (ts * 1.8)) * ts - 1;
            glow(x, y, c, edge ? A : 0.25);
          }
      }
      // 左下、右下的弧形括号（空心）
      const r0 = R * 0.7, r1 = R * 0.79, a0 = 0.12, a1 = 0.85;
      const inBand = (x: number, y: number, sgn: number) => {
        const dx = (x + 0.5 - cx) * sgn, dy = y + 0.5 - cy;
        if (dx >= 0) return false;
        const dd = Math.hypot(dx, dy), ang = Math.atan2(dy, -dx);
        return dd >= r0 && dd <= r1 && ang >= a0 && ang <= a1;
      };
      for (const sgn of [-1, 1]) {
        const xs = sgn < 0 ? cx - r1 - 1 : cx + r1 * Math.cos(a1) - 2;
        const xe = sgn < 0 ? cx - r1 * Math.cos(a1) + 2 : cx + r1 + 1;
        for (let y = Math.floor(cy); y <= cy + r1 + 1; y++)
          for (let x = Math.floor(xs); x <= xe; x++) {
            if (!inBand(x, y, -sgn)) continue;
            const edge = !inBand(x - 1, y, -sgn) || !inBand(x + 1, y, -sgn) || !inBand(x, y - 1, -sgn) || !inBand(x, y + 1, -sgn);
            glow(x, y, c, edge ? A : 0.12);
          }
      }
    }

    // ---- 面板仪表 ----
    const bearing = (((d.heading * 180) / Math.PI) % 360 + 360) % 360;
    for (const w of this.widgets) {
      if (w.kind === 'screen') {
        const val = w.id === 'BRG' ? String(Math.round(bearing) % 360).padStart(3, '0')
          : w.id === 'DPT' ? String(Math.round(d.depth)).padStart(3, '0') : String(Math.round(d.speedKn)).padStart(3, '0');
        const str = `${w.id} ${val}`;
        this.text(r, str, Math.round(w.x + (w.w - textWidth(str)) / 2), w.y + 3, C.screenText);
      } else if (w.kind === 'sonar') this.sonarDraw(r, d, world, w, glow, put);
      else if (w.kind === 'nitro') {
        // 一列红色指示条（像参考图左下的那组）：亮几根 = 剩多少氮气；喷射时全白闪
        const bars = 4, bh = 3;
        this.text(r, 'N2', w.x + 3, w.y + Math.round((w.h - 5) / 2), C.out);
        for (let b = 0; b < bars; b++) {
          const on = d.nitro * bars > bars - 1 - b + 0.25;
          const cc: RGB = d.nitroOn ? (Math.sin(d.t * 30) > 0 ? [255, 246, 216] : C.red) : on ? C.red : C.redOff;
          const y0 = w.y + 2 + b * (bh + 2), x0 = w.x + 13;
          for (let y = 0; y < bh; y++) for (let x = 0; x < w.w - 16; x++) put(x0 + x, y0 + y, y === 0 && on ? pack(255, 170, 150) : P(cc));
        }
      } else if (w.kind === 'dome') {
        // 紫色圆顶灯：氮气能用时亮，喷射时最亮
        const r0 = w.w / 2 - 2, x0 = w.x + w.w / 2, y0 = w.y + w.h / 2;
        const k = d.nitroOn ? 1.25 : d.nitro >= 0.25 ? 1 : 0.6;
        for (let y = Math.floor(y0 - r0); y <= y0 + r0; y++)
          for (let x = Math.floor(x0 - r0); x <= x0 + r0; x++) {
            const dx = x + 0.5 - x0, dy = y + 0.5 - y0, dd = Math.hypot(dx, dy);
            if (dd > r0) continue;
            let c = d.nitroOn ? C.purpleGlow : C.purple;
            if (Math.hypot(dx + r0 * 0.35, dy + r0 * 0.35) < r0 * 0.3) c = C.purpleHi;
            put(x, y, pack(Math.min(255, c[0] * k), Math.min(255, c[1] * k), Math.min(255, c[2] * k)));
          }
      }
    }
    // 警示灯：贴近海床时闪红
    if (d.clearance < 13 && Math.sin(d.t * 12) > 0) {
      const { x, y } = this.lamp;
      for (let yy = -3; yy <= 3; yy++) for (let xx = -3; xx <= 3; xx++) if (xx * xx + yy * yy <= 10) put(x + xx, y + yy, xx + yy < -2 ? pack(255, 220, 200) : P(C.red));
    }
  }

  private sonarDraw(_r: Renderer, d: ScopeData, world: World, w: Widget, glow: (x: number, y: number, c: RGB, a: number) => void, put: (x: number, y: number, c: number) => void) {
    const S = { x: w.x + w.w / 2, y: w.y + w.h / 2, r: (w.w - 4) / 2 };
    const sweep = (d.t * 2.2) % (Math.PI * 2);
    const ri = Math.ceil(S.r);
    for (let y = -ri; y <= ri; y++)
      for (let x = -ri; x <= ri; x++) {
        const rr = Math.hypot(x + 0.5 - (S.x % 1), y + 0.5 - (S.y % 1));
        if (rr > S.r) continue;
        let c = C.sonarBg;
        if (Math.abs(rr - S.r * 0.5) < 0.5 || x === 0 || y === 0) c = C.sonarLine;
        const ang = Math.atan2(x + 0.5, -(y + 0.5));
        let age = (sweep - ang) % (Math.PI * 2);
        if (age < 0) age += Math.PI * 2;
        const k = Math.max(0, 1 - age / 1.3);
        put(Math.floor(S.x) + x, Math.floor(S.y) + y, pack(c[0] + 20 * k, c[1] + 70 * k, c[2] + 40 * k));
      }
    const range = 190, NA = 40, NR = 10;
    const sh = Math.sin(d.heading), chh = Math.cos(d.heading);
    for (let ai = 0; ai < NA; ai++) {
      const ang = (ai / NA) * Math.PI * 2;
      let age = (sweep - ang) % (Math.PI * 2);
      if (age < 0) age += Math.PI * 2;
      const k = Math.exp(-age * 0.9);
      if (k < 0.08) continue;
      const ca = Math.cos(ang), sa = Math.sin(ang);
      for (let rI = 1; rI <= NR; rI++) {
        const dd = (rI / NR) * range;
        const fx = sa * dd, fy = ca * dd; // 声呐图上「上」= 潜艇前方
        if (world.heightAt(d.subX + fx * chh + fy * sh, d.subY - fx * sh + fy * chh) < d.subH - 6) continue;
        glow(S.x + sa * (rI / NR) * (S.r - 2), S.y - ca * (rI / NR) * (S.r - 2), C.sonar, k);
      }
    }
    for (let q = 0; q < S.r; q++) glow(S.x + Math.sin(sweep) * q, S.y - Math.cos(sweep) * q, C.sonar, 0.85);
    const me = pack(255, 246, 216);
    put(S.x, S.y - 1, me);
    put(S.x - 1, S.y + 1, me);
    put(S.x + 1, S.y + 1, me);
  }

  private text(r: Renderer, str: string, x: number, y: number, c: RGB) {
    const { W, H, buf } = r;
    const p = P(c);
    for (let n = 0; n < str.length; n++) {
      const g = GLYPHS[str[n]] ?? GLYPHS[' '];
      for (let i = 0; i < 15; i++) {
        if (g[i] !== '1') continue;
        const px = x + n * 4 + (i % 3), py = y + Math.floor(i / 3);
        if (px >= 0 && py >= 0 && px < W && py < H) buf[py * W + px] = p;
      }
    }
  }
}
