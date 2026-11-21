// 舰桥：开始界面 / 菜单。玩家坐在艇长位上，一圈操作台：主操作台 → 潜艇升级 → 潜艇机库 →（绕回）主操作台。
// 全部是像素画，直接画进游戏的帧缓冲区（像素大小和游戏画面一致）。三层视差：
//   后墙和天花板（0.7 倍速，循环花纹）、操作台（1 倍）、前景空座椅（1.25 倍）。
// 主操作台中间的大圆窗是透明的，透过它看得到实时的海底和潜艇。
// 文字和按钮用 HTML 叠在上面（位置按这里算出的布局放），由 main.ts 跟着平移。
// 进入游戏时整块舰桥以圆窗为中心放大（镜头穿过玻璃），回来时反过来。

import { hash2 } from './noise';
import { Renderer } from './renderer';

type RGB = [number, number, number];
const C: Record<string, RGB> = {
  out: [62, 42, 46],
  cream: [232, 216, 164], creamHi: [250, 240, 204], creamSh: [200, 180, 128], creamDk: [168, 146, 100],
  mauve: [150, 110, 122], mauveHi: [176, 138, 148], mauveSh: [116, 82, 96], ceil: [84, 62, 78],
  pipe: [128, 136, 148], pipeHi: [184, 192, 200], pipeSh: [84, 90, 104],
  lilac: [198, 182, 238], lilacHi: [230, 222, 252], lilacSh: [150, 132, 196],
  purple: [128, 92, 176], purpleHi: [204, 176, 242], purpleSh: [88, 60, 128],
  seat: [192, 206, 86], seatHi: [222, 232, 132], seatSh: [140, 154, 50], cushion: [40, 62, 106], cushionHi: [66, 94, 142],
  crt: [22, 50, 44], crtLine: [30, 66, 56], crtGlow: [120, 244, 170],
  slate: [58, 64, 78], slateHi: [96, 104, 120],
  red: [226, 76, 62], redOff: [120, 60, 56], blue: [120, 200, 236], green: [112, 212, 130], amber: [255, 196, 90], white: [252, 252, 246],
};
const pk = (c: RGB) => (0xff000000 | (c[2] << 16) | (c[1] << 8) | c[0]) >>> 0;
const sh = (c: RGB, k: number): RGB => [Math.min(255, c[0] * k) | 0, Math.min(255, c[1] * k) | 0, Math.min(255, c[2] * k) | 0];

export interface Rect { x: number; y: number; w: number; h: number }
export const STATIONS = ['主操作台', '潜艇升级', '潜艇机库'];
export const N_ST = STATIONS.length;
const BACK_K = 0.7, FG_K = 1.25;

/** 一层像素画：颜色 + 透明度（255 不透明，0 透明，1 = 圆窗玻璃：透出游戏画面，按 mul 压暗 / add 提亮） */
class Layer {
  col: Uint32Array;
  a: Uint8Array;
  mul: Uint8Array;
  add: Uint8Array;
  constructor(public W: number, public H: number, glass = false) {
    this.col = new Uint32Array(W * H);
    this.a = new Uint8Array(W * H);
    this.mul = new Uint8Array(glass ? W * H : 0);
    this.add = new Uint8Array(glass ? W * H : 0);
  }
  set(x: number, y: number, c: RGB, k = 1) {
    x = Math.round(x);
    y = Math.round(y);
    if (x < 0 || y < 0 || x >= this.W || y >= this.H) return;
    const i = y * this.W + x;
    this.col[i] = pk(k === 1 ? c : sh(c, k));
    this.a[i] = 255;
  }
  rect(x0: number, y0: number, w: number, h: number, c: RGB, noise = 0, seed = 0) {
    for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) this.set(x, y, c, noise ? 1 - noise / 2 + hash2(x, y, seed) * noise : 1);
  }
  /** 带描边的面板：四角缺一格，左上亮、右下暗 */
  panel(r: Rect, face: RGB, hi: RGB, shd: RGB, bev = 1, noise = 0.05) {
    const { x: x0, y: y0, w, h } = r;
    for (let y = y0; y < y0 + h; y++)
      for (let x = x0; x < x0 + w; x++) {
        const dx = x - x0, dy = y - y0, ex = w - 1 - dx, ey = h - 1 - dy;
        if ((dx === 0 || ex === 0) && (dy === 0 || ey === 0)) continue;
        let c = face;
        if (dx === 0 || dy === 0 || ex === 0 || ey === 0) c = C.out;
        else if (dx <= bev || dy <= bev) c = hi;
        else if (ex <= bev || ey <= bev) c = shd;
        this.set(x, y, c, c === C.out ? 1 : 1 - noise / 2 + hash2(x, y, 7) * noise);
      }
  }
  disc(cx: number, cy: number, r: number, f: (dx: number, dy: number, d: number) => RGB | null | 'hole') {
    for (let y = Math.floor(cy - r - 1); y <= Math.ceil(cy + r + 1); y++)
      for (let x = Math.floor(cx - r - 1); x <= Math.ceil(cx + r + 1); x++) {
        const dx = x + 0.5 - cx, dy = y + 0.5 - cy, d = Math.hypot(dx, dy);
        const c = f(dx, dy, d);
        if (c === 'hole') this.hole(x, y, 255, 0);
        else if (c) this.set(x, y, c);
      }
  }
  hole(x: number, y: number, mul: number, add: number) {
    if (x < 0 || y < 0 || x >= this.W || y >= this.H) return;
    const i = y * this.W + x;
    this.a[i] = 1;
    this.mul[i] = mul;
    this.add[i] = add;
  }
  rivet(x: number, y: number) {
    this.set(x, y, C.creamHi);
    this.set(x + 1, y + 1, C.creamDk);
  }
}

export interface Layout {
  W: number; H: number; portrait: boolean;
  deskY: number;
  plate: Rect; // 每个操作台顶上的铭牌
  win: { cx: number; cy: number; R: number; P: number };
  /** 主操作台：左右两块面板上的屏幕（开始潜航 / 操作指导） */
  screenL: Rect; screenR: Rect;
  /** 升级台、机库台的大屏幕 */
  upScreen: Rect; hgScreen: Rect;
  hgCards: Rect[];
}

interface Lamp { st: number; x: number; y: number; c: RGB; period: number; phase: number }

export class Bridge {
  L!: Layout;
  private W = 0;
  private H = 0;
  private back!: Layer;
  private con!: Layer;
  private fg!: Layer;
  private lamps: Lamp[] = [];

  private layout(W: number, H: number): Layout {
    const portrait = W < H * 0.9;
    const plateH = Math.max(18, Math.round(H * (portrait ? 0.065 : 0.09)));
    const plateW = Math.min(Math.round(W * (portrait ? 0.78 : 0.36)), 170);
    const plate = { x: Math.round(W / 2 - plateW / 2), y: 4, w: plateW, h: plateH };
    const deskY = H - Math.max(22, Math.round(H * (portrait ? 0.13 : 0.16)));
    let R: number, cy: number;
    if (portrait) {
      R = Math.floor(Math.min(W * 0.38, H * 0.22));
      const P0 = R + Math.max(6, Math.round(R * 0.1));
      cy = plate.y + plate.h + 6 + P0;
    } else {
      R = Math.floor(Math.min(H * 0.33, W * 0.24));
      cy = Math.round(Math.max(plate.y + plate.h + 8 + R, H * 0.47));
    }
    const P = R + Math.max(6, Math.round(R * 0.1));
    const cx = W / 2;
    let screenL: Rect, screenR: Rect;
    if (portrait) {
      const y = cy + P + 10, w = Math.round(W / 2 - 16), h = Math.max(22, Math.round(H * 0.075));
      screenL = { x: 10, y, w, h };
      screenR = { x: W - 10 - w, y, w, h };
    } else {
      const side = cx - P - 16;
      const w = Math.round(Math.min(side - 20, 110)), h = Math.max(22, Math.round(H * 0.12));
      const y = Math.round(cy - R * 0.55);
      screenL = { x: Math.round(side / 2 - w / 2) + 2, y, w, h };
      screenR = { x: W - screenL.x - w, y, w, h };
    }
    const top = plate.y + plate.h + 10;
    const upScreen = portrait
      ? { x: 12, y: top + 22, w: W - 24, h: Math.round((deskY - top) * 0.62) }
      : { x: Math.round(W * 0.24), y: top + 22, w: Math.round(W * 0.52), h: deskY - top - 34 };
    const hgScreen = portrait
      ? { x: 10, y: top + 10, w: W - 20, h: Math.round((deskY - top) * 0.72) }
      : { x: Math.round(W * 0.12), y: top + 10, w: Math.round(W * 0.76), h: deskY - top - 34 };
    const hgCards: Rect[] = [];
    {
      const n = 3, pad = 8, gap = 6;
      if (portrait) {
        const ch = Math.floor((hgScreen.h - pad * 2 - gap * (n - 1) - 12) / n);
        for (let i = 0; i < n; i++) hgCards.push({ x: hgScreen.x + pad, y: hgScreen.y + pad + 12 + i * (ch + gap), w: hgScreen.w - pad * 2, h: ch });
      } else {
        const cw = Math.floor((hgScreen.w - pad * 2 - gap * (n - 1)) / n);
        for (let i = 0; i < n; i++) hgCards.push({ x: hgScreen.x + pad + i * (cw + gap), y: hgScreen.y + pad + 12, w: cw, h: hgScreen.h - pad * 2 - 12 });
      }
    }
    return { W, H, portrait, deskY, plate, win: { cx, cy, R, P }, screenL, screenR, upScreen, hgScreen, hgCards };
  }

  private build(W: number, H: number) {
    this.W = W;
    this.H = H;
    const L = (this.L = this.layout(W, H));
    this.lamps = [];
    // ---- 后墙（循环花纹，宽度 = 一圈 × 0.7） ----
    const BW = Math.round(N_ST * W * BACK_K);
    const back = (this.back = new Layer(BW, H));
    const ceilH = Math.round(H * 0.1);
    const ribN = N_ST * 3, ribGap = BW / ribN;
    for (let y = 0; y < H; y++)
      for (let x = 0; x < BW; x++) {
        let c = y < ceilH ? C.ceil : C.mauve;
        if (y === ceilH) c = C.out;
        else if (y === ceilH + 1) c = C.mauveSh;
        else if (y > ceilH && (y - ceilH) % 34 === 0) c = C.mauveSh;
        else if (y > ceilH && (y - ceilH) % 34 === 1) c = C.mauveHi;
        back.set(x, y, c, 0.96 + hash2(x, y, 3) * 0.06);
      }
    // 天花板上两根管子
    for (const [py, pr] of [[Math.round(ceilH * 0.35), Math.max(2, Math.round(H * 0.014))], [Math.round(ceilH * 0.75), Math.max(2, Math.round(H * 0.01))]])
      for (let x = 0; x < BW; x++)
        for (let d = -pr; d <= pr; d++) back.set(x, py + d, d === -pr || d === pr ? C.out : d < 0 ? C.pipeHi : d === 0 ? C.pipe : C.pipeSh);
    // 竖肋 + 大圆表
    for (let i = 0; i < ribN; i++) {
      const x0 = Math.round(i * ribGap);
      back.panel({ x: x0, y: ceilH, w: 7, h: H - ceilH }, C.cream, C.creamHi, C.creamSh);
      for (let y = ceilH + 6; y < H; y += 12) back.rivet(x0 + 3, y);
      const gx = x0 + ribGap / 2, gy = ceilH + H * 0.1, gr = Math.max(8, Math.round(H * 0.075));
      back.disc(gx, gy, gr + 3, (dx, dy, d) => (d > gr + 3 ? null : d > gr + 2 ? C.out : d > gr ? (dx + dy < 0 ? C.creamHi : C.creamSh) : d > gr - 1 ? C.out : C.slate));
      for (let q = 0; q < 8; q++) {
        const a = (q / 8) * Math.PI * 2;
        back.set(gx + Math.cos(a) * (gr - 2), gy + Math.sin(a) * (gr - 2), C.slateHi);
      }
    }

    // ---- 操作台（三台并排，宽 3W） ----
    const con = (this.con = new Layer(N_ST * W, H, true));
    const fg = (this.fg = new Layer(Math.round(N_ST * W * FG_K), H));
    for (let s = 0; s < N_ST; s++) {
      const ox = s * W;
      // 铭牌
      con.panel({ x: ox + L.plate.x, y: L.plate.y, w: L.plate.w, h: L.plate.h }, C.cream, C.creamHi, C.creamSh);
      con.rivet(ox + L.plate.x + 3, L.plate.y + 3);
      con.rivet(ox + L.plate.x + L.plate.w - 5, L.plate.y + 3);
      con.rivet(ox + L.plate.x + 3, L.plate.y + L.plate.h - 5);
      con.rivet(ox + L.plate.x + L.plate.w - 5, L.plate.y + L.plate.h - 5);
      // 两边的立柱（相邻操作台之间的隔板）
      con.panel({ x: ox, y: 0, w: 6, h: H }, C.creamSh, C.cream, C.creamDk);
      con.panel({ x: ox + W - 6, y: 0, w: 6, h: H }, C.creamSh, C.cream, C.creamDk);
      if (s === 0) this.buildMain(con, ox);
      else if (s === 1) this.buildUpgrade(con, ox);
      else this.buildHangar(con, ox);
      this.desk(con, ox, s);
      // 前景：空座椅
      const fox = Math.round(s * W * FG_K);
      const swd = Math.round(W * (L.portrait ? 0.34 : 0.2)), sht = Math.round(H * (L.portrait ? 0.2 : 0.3));
      if (s === 0) {
        this.seat(fg, fox + Math.round(W * 0.03), H - Math.round(sht * 0.8), swd, sht, false);
        this.seat(fg, fox + W - Math.round(W * 0.03) - swd, H - Math.round(sht * 0.8), swd, sht, true);
      } else {
        this.seat(fg, fox + Math.round(W * (s === 1 ? 0.06 : 0.7)), H - Math.round(sht * 0.62), swd, sht, s === 2);
      }
    }
  }

  private buildMain(con: Layer, ox: number) {
    const L = this.L, { W, H } = this;
    const { cx, cy, R, P } = L.win;
    const X = ox + cx;
    // 左右面板
    const pTop = L.portrait ? cy + P - 4 : Math.round(cy - R * 0.8);
    if (L.portrait) {
      con.panel({ x: ox + 6, y: pTop, w: W - 12, h: L.deskY - pTop + 2 }, C.cream, C.creamHi, C.creamSh);
    } else {
      const side = Math.round(cx - P + 6);
      con.panel({ x: ox + 6, y: pTop, w: side, h: L.deskY - pTop + 2 }, C.cream, C.creamHi, C.creamSh);
      con.panel({ x: ox + W - 6 - side, y: pTop, w: side, h: L.deskY - pTop + 2 }, C.cream, C.creamHi, C.creamSh);
      // 斜撑
      // 斜撑：圆窗底板两侧往外的三角楔
      const S = Math.round(R * 0.4), y0 = Math.round(cy - R * 0.35);
      for (const sgn of [-1, 1]) {
        const x0 = X + sgn * (P - 2);
        for (let k = 0; k < S; k++)
          for (let q = 0; q < S - k; q++) con.set(x0 + sgn * q, y0 + k, k === 0 || q === S - k - 1 ? C.out : k < 2 ? C.creamSh : C.creamDk);
      }
    }
    // 八角形底板
    const oct = (x: number, y: number) => {
      const ax = Math.abs(x + 0.5 - X), ay = Math.abs(y + 0.5 - cy);
      return Math.max(ax, ay, ((ax + ay) / Math.SQRT2) * 1.08);
    };
    for (let y = Math.floor(cy - P - 2); y <= cy + P + 2; y++)
      for (let x = Math.floor(X - P - 2); x <= X + P + 2; x++) {
        const o = oct(x, y);
        if (o > P + 1) continue;
        if (o > P) con.set(x, y, C.out);
        else con.set(x, y, o > P - 2 ? (x - X + y - cy < 0 ? C.creamHi : C.creamSh) : C.cream, 0.97 + hash2(x, y, 5) * 0.05);
      }
    // 铆钉一圈
    const rr = (R + P) / 2 + 1, n = Math.max(10, Math.round((Math.PI * 2 * rr) / 12));
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + 0.2;
      const x = X + Math.cos(a) * rr, y = cy + Math.sin(a) * rr;
      if (oct(x, y) < P - 2) con.rivet(Math.round(x), Math.round(y));
    }
    // 圆窗：粗窗框 + 玻璃（透明，边缘压暗、左上高光）
    const T = Math.max(3, Math.round(R * 0.05));
    con.disc(X, cy, R + T + 1, (dx, dy, d) => {
      if (d < R) {
        const f = Math.max(0, (d - R * 0.84) / (R * 0.16));
        const ang = Math.atan2(dy, dx);
        let add = 0;
        if (d > R * 0.86 && d < R * 0.92 && ang > -2.55 && ang < -1.95) add = 80;
        if (d > R * 0.8 && d < R * 0.83 && ang > -2.45 && ang < -2.15) add = 55;
        con.hole(Math.floor(X + dx), Math.floor(cy + dy), Math.round(255 * (1 - f * f * 0.5)), add);
        return null;
      }
      if (d < R + 1) return C.out;
      if (d < R + T) return dx + dy < 0 ? (d < R + 2 ? C.creamSh : C.creamHi) : d < R + 2 ? C.creamHi : C.creamSh;
      if (d < R + T + 1) return C.out;
      return null;
    });
    // 窗上方的深色槽
    {
      const y1 = Math.round(cy - R - T - 3), y0 = Math.max(L.plate.y + L.plate.h + 2, Math.round(cy - P + 3));
      const hw = Math.round(R * 0.3);
      for (let y = y0; y <= y1; y++) for (let x = Math.round(X - hw + (y - y0)); x <= Math.round(X + hw - (y - y0)); x++) con.set(x, y, y === y0 ? C.out : C.mauveSh);
    }
    // 两块屏幕的底座（屏幕本身是按钮，画浅紫色）
    for (const s of [L.screenL, L.screenR]) {
      con.panel({ x: ox + s.x - 3, y: s.y - 3, w: s.w + 6, h: s.h + 6 }, C.creamSh, C.cream, C.creamDk);
      con.panel({ x: ox + s.x, y: s.y, w: s.w, h: s.h }, C.lilac, C.lilacHi, C.lilacSh, 1, 0.02);
    }
    // 面板上的小零件：紫色圆顶灯、红色指示条、彩色按钮
    const deco = (x: number, y: number, flip: boolean) => {
      const dr = Math.max(5, Math.round(Math.min(W, H) * 0.03));
      con.disc(ox + x, y, dr + 1, (dx, dy, d) => (d > dr + 1 ? null : d > dr ? C.out : Math.hypot(dx + dr * 0.35, dy + dr * 0.35) < dr * 0.3 ? C.purpleHi : dx + dy > dr * 0.6 ? C.purpleSh : C.purple));
      const bx = flip ? x - dr * 2 - 18 : x + dr + 8;
      for (let i = 0; i < 3; i++) {
        con.rect(ox + bx - 1, y - dr + i * 5 - 1, 16, 5, C.out);
        this.lamps.push({ st: 0, x: bx, y: y - dr + i * 5, c: C.red, period: 1.6 + i * 0.7, phase: i * 0.37 });
      }
    };
    if (L.portrait) {
      const y = L.screenL.y + L.screenL.h + 16;
      deco(Math.round(W * 0.16), y, false);
      deco(Math.round(W * 0.84), y, true);
      this.filler(con, ox, y + 16, L.deskY - 8);
    } else {
      const y = L.screenL.y + L.screenL.h + Math.max(16, Math.round(H * 0.09));
      deco(L.screenL.x + 8, y, false);
      deco(L.screenR.x + L.screenR.w - 8, y, true);
      // 底部一排小圆按钮
      for (const s of [L.screenL, L.screenR])
        for (let i = 0; i < 4; i++) {
          const bx = ox + s.x + 6 + i * Math.round((s.w - 12) / 3), by = Math.min(L.deskY - 8, y + Math.max(18, Math.round(H * 0.1)));
          const col = [C.blue, C.green, C.blue, C.amber][i];
          con.disc(bx, by, 3, (dx, dy, d) => (d > 3.4 ? null : d > 2.4 ? C.out : dx + dy < -1 ? C.white : col));
        }
    }
  }

  private buildUpgrade(con: Layer, ox: number) {
    const L = this.L, { W, H } = this;
    const top = L.plate.y + L.plate.h + 10;
    con.panel({ x: ox + 6, y: top, w: W - 12, h: L.deskY - top + 2 }, C.cream, C.creamHi, C.creamSh);
    // 上面一排表盘
    const s = L.upScreen;
    const gr = Math.max(6, Math.round(Math.min(W, H) * 0.035));
    const ng = L.portrait ? 3 : 5;
    for (let i = 0; i < ng; i++) {
      const gx = ox + s.x + ((i + 0.5) / ng) * s.w, gy = top + 4 + gr;
      con.disc(gx, gy, gr + 2, (_dx, _dy, d) => (d > gr + 2 ? null : d > gr + 1 ? C.out : d > gr ? C.creamDk : C.white));
      const a = -2.2 + i * 0.9;
      for (let q = 0; q < gr - 1; q++) con.set(gx + Math.sin(a) * q, gy - Math.cos(a) * q, C.red);
      con.set(gx, gy, C.out);
    }
    this.crt(con, ox, s);
    // 两边：拉杆 / 按钮格
    const side = L.portrait ? null : { l: ox + 18, r: ox + s.x + s.w + 14, w: s.x - 30 };
    if (side) {
      for (let i = 0; i < 3; i++) {
        const lx = side.l + Math.round(((i + 0.5) / 3) * side.w), ly0 = s.y + 10, ly1 = s.y + s.h - 10;
        con.rect(lx - 1, ly0, 3, ly1 - ly0, C.out);
        const ky = Math.round(ly0 + (ly1 - ly0) * [0.3, 0.65, 0.45][i]);
        con.rect(lx - 4, ky - 2, 9, 5, C.out);
        con.rect(lx - 3, ky - 1, 7, 3, C.red);
        con.set(lx - 3, ky - 1, [255, 160, 140]);
      }
      const gw = ox + W - 6 - side.r - 10;
      for (let j = 0; j < 4; j++)
        for (let i = 0; i < 3; i++) {
          const bx = side.r + 4 + Math.round(((i + 0.5) / 3) * gw), by = s.y + 14 + j * 14;
          con.rect(bx - 4, by - 3, 9, 7, C.out);
          con.rect(bx - 3, by - 2, 7, 5, [C.lilac, C.blue, C.green, C.amber][(i + j) % 4]);
          con.set(bx - 3, by - 2, C.white);
        }
      for (let i = 0; i < 3; i++) this.lamps.push({ st: 1, x: side.r - ox + 8 + i * 10, y: s.y + s.h - 12, c: [C.green, C.amber, C.red][i], period: 1.3 + i * 0.5, phase: i * 0.4 });
    } else {
      for (let i = 0; i < 5; i++) this.lamps.push({ st: 1, x: Math.round(W * (0.2 + i * 0.15)) - 3, y: s.y + s.h + 10, c: [C.green, C.amber, C.red, C.green, C.blue][i], period: 1.2 + i * 0.4, phase: i * 0.3 });
      this.filler(con, ox, s.y + s.h + 22, L.deskY - 8);
    }
  }

  private buildHangar(con: Layer, ox: number) {
    const L = this.L, { W } = this;
    const top = L.plate.y + L.plate.h + 10;
    con.panel({ x: ox + 6, y: top, w: W - 12, h: L.deskY - top + 2 }, C.cream, C.creamHi, C.creamSh);
    const s = L.hgScreen;
    con.panel({ x: ox + s.x - 3, y: s.y - 3, w: s.w + 6, h: s.h + 6 }, C.creamSh, C.cream, C.creamDk);
    con.panel({ x: ox + s.x, y: s.y, w: s.w, h: s.h }, C.lilacSh, C.lilac, C.purpleSh, 1, 0.03);
    // 每格：深色卡片 + 潜艇剪影 + 小锁
    for (const c of L.hgCards) {
      con.panel({ x: ox + c.x, y: c.y, w: c.w, h: c.h }, [96, 78, 140], [130, 110, 180], [70, 54, 108], 1, 0.02);
      const scx = ox + c.x + c.w / 2, scy = c.y + c.h * (L.portrait ? 0.5 : 0.42);
      const sw = Math.min(c.w * 0.62, c.h * (L.portrait ? 1.4 : 1.1)), shh = sw * 0.32;
      const dark: RGB = [52, 40, 82];
      for (let y = Math.floor(scy - shh * 1.3); y <= scy + shh; y++)
        for (let x = Math.floor(scx - sw / 2 - 3); x <= scx + sw / 2 + 2; x++) {
          const u = (x + 0.5 - scx) / (sw / 2), v = (y + 0.5 - scy) / shh;
          const hull = u * u + v * v * 1.1 < 1;
          const sail = Math.abs(u + 0.1) < 0.16 && v > -1.45 && v < 0;
          const fin = u < -0.8 && u > -1.12 && Math.abs(v) < 0.9 - (u + 1.12) * 0.5;
          if (hull || sail || fin) con.set(x, y, dark);
        }
      // 锁
      const lx = Math.round(scx), ly = Math.round(scy + shh * 0.1);
      con.rect(lx - 4, ly - 1, 9, 7, C.out);
      con.rect(lx - 3, ly, 7, 5, C.amber);
      con.set(lx, ly + 2, C.out);
      for (let q = -2; q <= 2; q++) con.set(lx + q, ly - 4, C.out);
      con.set(lx - 3, ly - 3, C.out); con.set(lx - 3, ly - 2, C.out);
      con.set(lx + 3, ly - 3, C.out); con.set(lx + 3, ly - 2, C.out);
    }
    for (let i = 0; i < 4; i++) this.lamps.push({ st: 2, x: s.x + 8 + i * 10, y: s.y + s.h + 8, c: [C.blue, C.green, C.amber, C.red][i], period: 0.9 + i * 0.45, phase: i * 0.2 });
    if (L.portrait) this.filler(con, ox, s.y + s.h + 18, L.deskY - 8);
  }

  /** 填空用的小面板：通风格栅 + 两个小表盘（竖屏下面空出来的地方） */
  private filler(con: Layer, ox: number, y0: number, y1: number) {
    const { W } = this;
    const h = Math.min(y1 - y0, 60);
    if (h < 22) return;
    const r = { x: ox + 14, y: Math.round(y0 + (y1 - y0 - h) / 2), w: W - 28, h };
    con.panel(r, C.creamSh, C.cream, C.creamDk);
    const gw = Math.round(r.w * 0.5);
    for (let i = 0; i < Math.floor((h - 10) / 4); i++) con.rect(r.x + 8, r.y + 6 + i * 4, gw, 2, C.out);
    const gr = Math.max(5, Math.min(Math.round(h * 0.22), Math.round((r.w - gw - 30) / 4)));
    for (let i = 0; i < 2; i++) {
      const gx = r.x + gw + 14 + gr + i * (gr * 2 + 8), gy = r.y + h / 2;
      con.disc(gx, gy, gr + 2, (_dx, _dy, d) => (d > gr + 2 ? null : d > gr + 1 ? C.out : d > gr ? C.creamDk : C.white));
      const a = i ? 0.9 : -1.4;
      for (let q = 0; q < gr - 1; q++) con.set(gx + Math.sin(a) * q, gy - Math.cos(a) * q, C.red);
    }
  }

  /** 绿色显像管屏幕：粗边框、圆角、扫描线 */
  private crt(con: Layer, ox: number, s: Rect) {
    con.panel({ x: ox + s.x - 4, y: s.y - 4, w: s.w + 8, h: s.h + 8 }, C.creamSh, C.cream, C.creamDk);
    for (let y = s.y; y < s.y + s.h; y++)
      for (let x = s.x; x < s.x + s.w; x++) {
        const dx = Math.min(x - s.x, s.x + s.w - 1 - x), dy = Math.min(y - s.y, s.y + s.h - 1 - y);
        if (dx + dy < 3) { con.set(ox + x, y, C.creamDk); continue; }
        const edge = dx === 0 || dy === 0 || dx + dy === 3;
        con.set(ox + x, y, edge ? C.out : (y - s.y) % 2 ? C.crtLine : C.crt);
      }
  }

  /** 操作台下沿的桌面：台面亮边 + 前脸 */
  private desk(con: Layer, ox: number, st: number) {
    const L = this.L, { W, H } = this;
    for (let y = L.deskY; y < H; y++)
      for (let x = ox + 6; x < ox + W - 6; x++) {
        const dy = y - L.deskY;
        let c = dy === 0 ? C.out : dy < 3 ? C.creamHi : dy < 7 ? C.cream : dy === 7 ? C.out : C.creamSh;
        if (dy > 7 && (x - ox) % 48 === 0) c = C.creamDk;
        con.set(x, y, c, 0.97 + hash2(x, y, 9) * 0.05);
      }
    // 台面上一排按钮
    const n = Math.max(4, Math.floor(W / 40));
    for (let i = 0; i < n; i++) {
      const bx = ox + Math.round(((i + 0.5) / n) * W), by = L.deskY + 12;
      if (by > H - 4) break;
      const col = [C.green, C.blue, C.amber, C.blue][(i + st) % 4];
      con.disc(bx, by, 3, (dx, dy, d) => (d > 3.5 ? null : d > 2.5 ? C.out : dx + dy < -1.2 ? C.white : col));
    }
  }

  /** 空座椅的椅背：黄绿色框 + 深蓝靠垫，右上角一个圆孔 */
  private seat(fg: Layer, x0: number, y0: number, w: number, h: number, flip: boolean) {
    const r = Math.max(3, Math.round(w * 0.12));
    // 上面两个圆角的矩形，往下一直到屏幕底；ins：往里缩几像素
    const inside = (x: number, y: number, ins: number) => {
      const dx = x - x0, dy = y - y0;
      if (dx < ins || dx >= w - ins || dy < ins) return false;
      if (dy < r && (dx < r || dx >= w - r)) {
        const ccx = dx < r ? r : w - 1 - r;
        return Math.hypot(dx - ccx, dy - r) <= r - ins + 0.3;
      }
      return true;
    };
    for (let y = y0; y < this.H; y++)
      for (let x = x0; x < x0 + w; x++) {
        if (!inside(x, y, 0)) continue;
        let c: RGB;
        if (!inside(x, y, 1)) c = C.out;
        else if (!inside(x, y, 4)) c = x - x0 < w * 0.5 && y - y0 < 6 ? C.seatHi : x - x0 < 3 ? C.seatHi : C.seat;
        else if (!inside(x, y, 5)) c = C.out;
        else c = y - y0 < 9 ? C.cushionHi : C.cushion;
        fg.set(x, y, c, 0.97 + hash2(x, y, 13) * 0.05);
      }
    // 圆孔
    const hx = flip ? x0 + w * 0.28 : x0 + w * 0.72, hy = y0 + h * 0.32, hr = Math.max(2, Math.round(w * 0.06));
    fg.disc(hx, hy, hr + 1, (_dx, _dy, d) => (d > hr + 1 ? null : d > hr ? C.out : [16, 22, 36]));
  }

  /** 第 st 个操作台此刻在屏幕上的 x 偏移（帧缓冲像素）。pan 以帧缓冲像素计，一圈 = N_ST × W */
  stationX(st: number, pan: number) {
    const ring = N_ST * this.W;
    let x = (((st * this.W - pan) % ring) + ring) % ring;
    if (x > ring - this.W * 1.5) x -= ring;
    return x;
  }

  /** 主圆窗是否在屏幕上（不在就不用画游戏世界） */
  windowVisible(pan: number) {
    const x = this.stationX(0, pan) + this.L.win.cx;
    return x + this.L.win.P > 0 && x - this.L.win.P < this.W;
  }

  ensure(W: number, H: number) {
    if (W !== this.W || H !== this.H) this.build(W, H);
  }

  /**
   * 把舰桥合成到帧缓冲（游戏世界已经画在里面，圆窗处透出来）。
   * zoom ≥ 1：以圆窗中心为原点放大（进出游戏的过渡）。
   */
  draw(r: Renderer, pan: number, t: number, zoom: number) {
    this.ensure(r.W, r.H);
    const { W, H } = this, buf = r.buf;
    const ring = N_ST * W;
    const con = this.con, back = this.back, fg = this.fg;
    const BW = back.W, FW = fg.W;
    const p = Math.round(pan);
    const pb = Math.round(pan * BACK_K), pf = Math.round(pan * FG_K);
    const zx = this.stationX(0, pan) + this.L.win.cx, zy = this.L.win.cy;
    for (let y = 0; y < H; y++) {
      const sy = zoom === 1 ? y : Math.floor(zy + (y + 0.5 - zy) / zoom);
      if (sy < 0 || sy >= H) continue;
      const rowC = sy * ring, rowB = sy * BW, rowF = sy * FW;
      let i = y * W;
      for (let x = 0; x < W; x++, i++) {
        const sx = zoom === 1 ? x : Math.floor(zx + (x + 0.5 - zx) / zoom);
        const fx = ((((sx + pf) % FW) + FW) % FW);
        if (fg.a[rowF + fx]) {
          buf[i] = fg.col[rowF + fx];
          continue;
        }
        const cx = (((sx + p) % ring) + ring) % ring;
        const ci = rowC + cx;
        const a = con.a[ci];
        if (a === 255) buf[i] = con.col[ci];
        else if (a === 1) {
          const m = con.mul[ci], ad = con.add[ci];
          if (m === 255 && ad === 0) continue;
          const c = buf[i];
          let R0 = ((c & 255) * m) >> 8, G0 = (((c >> 8) & 255) * m) >> 8, B0 = (((c >> 16) & 255) * m) >> 8;
          if (ad) {
            R0 += ((255 - R0) * ad) >> 8;
            G0 += ((255 - G0) * ad) >> 8;
            B0 += ((255 - B0) * ad) >> 8;
          }
          buf[i] = (0xff000000 | (B0 << 16) | (G0 << 8) | R0) >>> 0;
        } else {
          const bx = ((((sx + pb) % BW) + BW) % BW);
          buf[i] = back.col[rowB + bx];
        }
      }
    }
    if (zoom !== 1) return;
    // ---- 会动的部分：指示灯、显像管扫描线 ----
    const put = (x: number, y: number, c: RGB) => {
      x = Math.round(x);
      y = Math.round(y);
      if (x >= 0 && y >= 0 && x < W && y < H) buf[y * W + x] = pk(c);
    };
    for (const l of this.lamps) {
      const sx = this.stationX(l.st, pan) + l.x;
      if (sx < -20 || sx > W + 20) continue;
      const on = ((t / l.period + l.phase) % 1) < 0.55;
      const w = l.st === 0 ? 14 : 6, h = l.st === 0 ? 3 : 4;
      for (let yy = 0; yy < h; yy++) for (let xx = 0; xx < w; xx++) put(sx + xx, l.y + yy, on ? (yy === 0 ? sh(l.c, 1.3) : l.c) : sh(l.c, 0.45));
    }
    {
      const s = this.L.upScreen, sx0 = this.stationX(1, pan) + s.x;
      if (sx0 < W && sx0 + s.w > 0) {
        const ly = s.y + 2 + Math.floor(((t * 0.35) % 1) * (s.h - 4));
        for (let x = 2; x < s.w - 2; x++) {
          const X = sx0 + x;
          if (X < 0 || X >= W) continue;
          const b = buf[ly * W + X];
          buf[ly * W + X] = pk([Math.min(255, (b & 255) + 24), Math.min(255, ((b >> 8) & 255) + 60), Math.min(255, ((b >> 16) & 255) + 40)]);
        }
      }
    }
  }
}
