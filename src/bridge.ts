// 舰桥：开始界面 / 菜单。玩家坐在艇长位上，一圈操作台：主操作台 → 潜艇升级 → 潜艇机库 →（绕回）主操作台。
// 全部是像素画，直接画进游戏的帧缓冲区（像素大小和游戏画面一致），切换操作台时横向平移，前景（座椅、栏杆）走得快一点。
//
// 画法：先画「底色 + 材质」（受光 / 自发光 / 玻璃），再统一算一遍光照——
//   暗暖色环境光 + 窗口的大片蓝光（墙、地板、座椅都被染蓝）+ 几盏暖橙色的灯 + 四周压暗。
// 冷暖对比和透视（地板格栅、风管朝窗口收拢，桌面是斜的梯形）让画面有纵深。
// 主操作台的大圆窗是透明的，透过它看得到实时的海底和潜艇。
// 文字和按钮用 HTML 叠在上面（位置按这里算出的布局放），由 main.ts 跟着平移。
// 进入游戏时整块舰桥以圆窗为中心放大（镜头穿过玻璃），回来时反过来。

import { hash2 } from './noise';
import { Renderer } from './renderer';

type RGB = [number, number, number];
const pk = (c: RGB) => (0xff000000 | (Math.max(0, Math.min(255, c[2] | 0)) << 16) | (Math.max(0, Math.min(255, c[1] | 0)) << 8) | Math.max(0, Math.min(255, c[0] | 0))) >>> 0;
const mix = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const k3 = (c: RGB, k: number): RGB => [c[0] * k, c[1] * k, c[2] * k];

// 底色（受光前）。舱内是暖色金属，窗外光和灯光决定最后的颜色。
const C = {
  out: [26, 18, 20] as RGB,
  wall: [178, 112, 66] as RGB, wallSeam: [122, 74, 46] as RGB, wallHi: [204, 136, 84] as RGB,
  ceil: [92, 66, 58] as RGB, ceilDk: [56, 40, 38] as RGB,
  steel: [128, 140, 156] as RGB, steelHi: [196, 208, 220] as RGB, steelSh: [70, 78, 92] as RGB,
  duct: [150, 150, 158] as RGB,
  floor: [74, 66, 70] as RGB, floorLine: [40, 34, 38] as RGB,
  desk: [190, 124, 70] as RGB, deskHi: [236, 176, 112] as RGB, deskFace: [112, 70, 44] as RGB,
  dark: [52, 46, 54] as RGB, navy: [48, 60, 86] as RGB,
  bezel: [44, 42, 50] as RGB,
  red: [210, 60, 44] as RGB, brass: [214, 160, 80] as RGB,
};
// 自发光的颜色
const E = {
  screen: [206, 236, 246] as RGB, screen2: [150, 200, 232] as RGB,
  water: [92, 168, 236] as RGB, waterDeep: [24, 70, 150] as RGB, waterHi: [176, 226, 255] as RGB,
  orange: [255, 176, 86] as RGB, orangeDk: [190, 92, 40] as RGB,
  crt: [18, 54, 40] as RGB, crtLine: [26, 70, 52] as RGB,
  sign: [40, 26, 22] as RGB, signRim: [255, 150, 70] as RGB,
  led: [120, 255, 170] as RGB,
};

export interface Rect { x: number; y: number; w: number; h: number }
export const STATIONS = ['主操作台', '潜艇升级', '潜艇机库'];
export const N_ST = STATIONS.length;
const FG_K = 1.25;

interface Light { x: number; y: number; r: number; c: RGB; s: number }

const M_NONE = 0, M_LIT = 1, M_EMIT = 2, M_GLASS = 3;

/** 一层像素画：底色、材质；算完光照后 col 是最后的颜色 */
class Layer {
  alb: Uint32Array;
  col: Uint32Array;
  m: Uint8Array;
  mul: Uint8Array;
  add: Uint8Array;
  constructor(public W: number, public H: number) {
    const n = W * H;
    this.alb = new Uint32Array(n);
    this.col = new Uint32Array(n);
    this.m = new Uint8Array(n);
    this.mul = new Uint8Array(n);
    this.add = new Uint8Array(n);
  }
}

/** 往一层上画：坐标是这个操作台自己的（左上角为原点），ox 是它在整条长图里的起点 */
class Painter {
  constructor(public L: Layer, public ox: number) {}
  px(x: number, y: number, c: RGB, m = M_LIT) {
    x = Math.floor(x) + this.ox;
    y = Math.floor(y);
    const { L } = this;
    if (x < 0 || y < 0 || x >= L.W || y >= L.H) return;
    const i = y * L.W + x;
    L.alb[i] = pk(c);
    L.m[i] = m;
  }
  glass(x: number, y: number, mul: number, add: number) {
    x = Math.floor(x) + this.ox;
    y = Math.floor(y);
    const { L } = this;
    if (x < 0 || y < 0 || x >= L.W || y >= L.H) return;
    const i = y * L.W + x;
    L.m[i] = M_GLASS;
    L.mul[i] = mul;
    L.add[i] = add;
  }
  rect(x0: number, y0: number, w: number, h: number, c: RGB | ((x: number, y: number) => RGB | null), m = M_LIT) {
    for (let y = Math.floor(y0); y < Math.floor(y0 + h); y++)
      for (let x = Math.floor(x0); x < Math.floor(x0 + w); x++) {
        const cc = typeof c === 'function' ? c(x, y) : c;
        if (cc) this.px(x, y, cc, m);
      }
  }
  /** 扫描线填多边形（奇偶规则） */
  poly(pts: [number, number][], c: RGB | ((x: number, y: number) => RGB | null), m = M_LIT) {
    let y0 = Infinity, y1 = -Infinity;
    for (const p of pts) { y0 = Math.min(y0, p[1]); y1 = Math.max(y1, p[1]); }
    const xs: number[] = [];
    for (let y = Math.floor(y0); y <= Math.ceil(y1); y++) {
      const sy = y + 0.5;
      xs.length = 0;
      for (let i = 0; i < pts.length; i++) {
        const a = pts[i], b = pts[(i + 1) % pts.length];
        if ((a[1] <= sy && b[1] > sy) || (b[1] <= sy && a[1] > sy)) xs.push(a[0] + ((sy - a[1]) / (b[1] - a[1])) * (b[0] - a[0]));
      }
      xs.sort((p, q) => p - q);
      for (let k = 0; k + 1 < xs.length; k += 2)
        for (let x = Math.round(xs[k]); x < Math.round(xs[k + 1]); x++) {
          const cc = typeof c === 'function' ? c(x, y) : c;
          if (cc) this.px(x, y, cc, m);
        }
    }
  }
  /** 多边形描边 */
  outline(pts: [number, number][], c: RGB = C.out, m = M_LIT) {
    for (let i = 0; i < pts.length; i++) this.line(pts[i][0], pts[i][1], pts[(i + 1) % pts.length][0], pts[(i + 1) % pts.length][1], c, m);
  }
  line(x0: number, y0: number, x1: number, y1: number, c: RGB, m = M_LIT) {
    const n = Math.max(1, Math.ceil(Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0))));
    for (let i = 0; i <= n; i++) this.px(x0 + ((x1 - x0) * i) / n, y0 + ((y1 - y0) * i) / n, c, m);
  }
  disc(cx: number, cy: number, r: number, f: (dx: number, dy: number, d: number) => RGB | null, m = M_LIT) {
    for (let y = Math.floor(cy - r - 1); y <= Math.ceil(cy + r + 1); y++)
      for (let x = Math.floor(cx - r - 1); x <= Math.ceil(cx + r + 1); x++) {
        const dx = x + 0.5 - cx, dy = y + 0.5 - cy, d = Math.hypot(dx, dy);
        if (d > r + 0.5) continue;
        const c = f(dx, dy, d);
        if (c) this.px(x, y, c, m);
      }
  }
  /** 圆柱（管子、风管）：沿中心线从 (x0,y0) 半径 r0 到 (x1,y1) 半径 r1，横截面左上亮右下暗，两边描边 */
  tube(x0: number, y0: number, x1: number, y1: number, r0: number, r1: number, base: RGB, rings = 0) {
    const dx = x1 - x0, dy = y1 - y0, len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len, ny = dx / len;
    const pts: [number, number][] = [[x0 + nx * r0, y0 + ny * r0], [x1 + nx * r1, y1 + ny * r1], [x1 - nx * r1, y1 - ny * r1], [x0 - nx * r0, y0 - ny * r0]];
    this.poly(pts, (x, y) => {
      const px = x + 0.5 - x0, py = y + 0.5 - y0;
      const t = Math.max(0, Math.min(1, (px * dx + py * dy) / (len * len)));
      const r = r0 + (r1 - r0) * t;
      const s = (px * nx + py * ny) / r; // -1..1 横截面位置
      if (Math.abs(s) > 0.86) return C.out;
      const lit = ny < 0 ? -s : s; // 朝上那边亮
      let k = 0.75 + 0.45 * Math.max(0, lit) - 0.25 * Math.max(0, -lit);
      if (lit > 0.35 && lit < 0.55) k = 1.35;
      if (rings && Math.floor(t * len / rings) % 2 === 0 && Math.abs(((t * len) % rings) - 1) < 1) k *= 0.7;
      return k3(base, k * (0.97 + hash2(x, y, 3) * 0.05));
    });
  }
  /** 斜面面板：外描边，内侧左上亮、右下暗 */
  panel(r: Rect, face: RGB, bev = 1, m = M_LIT) {
    const { x: x0, y: y0, w, h } = r;
    this.rect(x0, y0, w, h, (x, y) => {
      const dx = x - Math.floor(x0), dy = y - Math.floor(y0), ex = Math.floor(x0 + w) - 1 - x, ey = Math.floor(y0 + h) - 1 - y;
      if (dx === 0 || dy === 0 || ex === 0 || ey === 0) return C.out;
      if (dx <= bev || dy <= bev) return k3(face, 1.25);
      if (ex <= bev || ey <= bev) return k3(face, 0.7);
      return k3(face, 0.97 + hash2(x, y, 7) * 0.06);
    }, m);
  }
  rivet(x: number, y: number) {
    this.px(x, y, C.wallHi);
    this.px(x + 1, y + 1, C.wallSeam);
  }
}

export interface Layout {
  W: number; H: number; portrait: boolean;
  win: { cx: number; cy: number; R: number; P: number };
  /** 每个操作台的名牌（主操作台上是游戏标题） */
  plate: Rect;
  /** 主操作台桌上的两台显示器：开始潜航 / 操作指导 */
  screenL: Rect; screenR: Rect;
  upScreen: Rect; hgScreen: Rect; hgCards: Rect[];
}

interface Lamp { st: number; x: number; y: number; c: RGB; period: number; phase: number }

export class Bridge {
  L!: Layout;
  private W = 0;
  private H = 0;
  private con!: Layer;
  private fg!: Layer;
  private lamps: Lamp[] = [];

  private layout(W: number, H: number): Layout {
    const portrait = W < H * 0.9;
    const r = (x: number, y: number, w: number, h: number): Rect => ({ x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) });
    let win, plate, screenL, screenR, upScreen, hgScreen;
    const hgCards: Rect[] = [];
    if (!portrait) {
      const R = Math.round(Math.min(H * 0.36, W * 0.25));
      win = { cx: Math.round(W * 0.6), cy: Math.round(H * 0.45), R, P: R + Math.max(6, Math.round(R * 0.12)) };
      plate = r(W * 0.035, H * 0.055, W * 0.3, Math.max(16, H * 0.1));
      screenL = r(W * 0.035, H * 0.47, W * 0.14, H * 0.15);
      screenR = r(W * 0.19, H * 0.47, W * 0.14, H * 0.15);
      upScreen = r(W * 0.3, H * 0.2, W * 0.4, H * 0.4);
      hgScreen = r(W * 0.05, H * 0.2, W * 0.9, H * 0.52);
      for (let i = 0; i < 3; i++) {
        const cw = hgScreen.w * 0.27;
        hgCards.push(r(hgScreen.x + ((i + 0.5) / 3) * hgScreen.w - cw / 2, hgScreen.y + hgScreen.h * 0.7, cw, hgScreen.h * 0.25));
      }
    } else {
      const R = Math.round(Math.min(W * 0.4, H * 0.22));
      win = { cx: Math.round(W * 0.5), cy: Math.round(H * 0.08 + 14 + R), R, P: R + Math.max(6, Math.round(R * 0.12)) };
      plate = r(W * 0.12, H * 0.02, W * 0.76, Math.max(16, H * 0.055));
      const my = win.cy + win.P + 14;
      screenL = r(W * 0.06, my, W * 0.42, H * 0.09);
      screenR = r(W * 0.52, my, W * 0.42, H * 0.09);
      upScreen = r(W * 0.07, H * 0.12, W * 0.86, H * 0.34);
      hgScreen = r(W * 0.06, H * 0.11, W * 0.88, H * 0.62);
      for (let i = 0; i < 3; i++) {
        const rh = hgScreen.h / 3;
        hgCards.push(r(hgScreen.x + hgScreen.w * 0.52, hgScreen.y + i * rh + rh * 0.28, hgScreen.w * 0.44, rh * 0.44));
      }
    }
    return { W, H, portrait, win, plate, screenL, screenR, upScreen, hgScreen, hgCards };
  }

  private build(W: number, H: number) {
    this.W = W;
    this.H = H;
    const L = (this.L = this.layout(W, H));
    this.lamps = [];
    this.con = new Layer(N_ST * W, H);
    this.fg = new Layer(Math.round(N_ST * W * FG_K), H);
    for (let s = 0; s < N_ST; s++) {
      const p = new Painter(this.con, s * W);
      const f = new Painter(this.fg, Math.round(s * W * FG_K));
      const lights = s === 0 ? this.buildMain(p, f) : s === 1 ? this.buildUpgrade(p, f) : this.buildHangar(p, f);
      // 相邻操作台之间的立柱
      this.pillar(p, 0);
      this.pillar(p, W - 8);
      this.light(this.con, s * W, W, lights);
      this.light(this.fg, Math.round(s * W * FG_K), Math.round(W * FG_K), lights);
    }
    void L;
  }

  // ---------------------------------------------------------------- 公用部件

  /** 墙：暖色钢板，错缝接缝 + 铆钉 */
  private wall(p: Painter, y0: number, y1: number) {
    const { W } = this;
    const ph = Math.max(26, Math.round(this.H * 0.15)), pw = Math.max(40, Math.round(W * 0.15));
    p.rect(0, y0, W, y1 - y0, (x, y) => {
      const row = Math.floor((y - y0) / ph), sy = (y - y0) % ph;
      const sx = (x + (row % 2) * (pw >> 1)) % pw;
      if (sy === 0 || sx === 0) return C.wallSeam;
      if (sy === 1 || sx === 1) return C.wallHi;
      if ((sy === 3 || sy === ph - 3) && (sx === 3 || sx === pw - 3)) return C.wallHi;
      return k3(C.wall, 0.95 + hash2(x, y, 11) * 0.08 - (sy / ph) * 0.06);
    });
  }

  /** 天花板：深色，底边一道梁 */
  private ceiling(p: Painter, h: number) {
    const { W } = this;
    p.rect(0, 0, W, h, (x, y) => (y === h - 1 ? C.out : y === h - 2 ? k3(C.ceil, 1.3) : (x >> 3) % 2 === 0 && y % 6 === 0 ? C.ceilDk : k3(C.ceil, 0.95 + hash2(x, y, 5) * 0.08)));
  }

  /** 地板：格栅，纵线朝消失点 (vx, vy) 收拢，横线越远越密 */
  private floor(p: Painter, y0: number, vx: number, vy: number) {
    const { W, H } = this;
    p.rect(0, y0, W, H - y0, (x, y) => {
      const t = (y - y0) / (H - y0); // 0 远 1 近
      // 横线：透视间距
      const u = Math.sqrt(t) * 7;
      if (Math.abs(u - Math.round(u)) < 0.07 + t * 0.03) return C.floorLine;
      // 纵线：把 x 投影回最近处
      const k = (y - vy) / (H - vy);
      const xb = vx + (x + 0.5 - vx) / Math.max(0.05, k);
      const cell = W / 7;
      if (Math.abs(((xb % cell) + cell) % cell - cell / 2) < 1.2 / Math.max(0.2, k)) return C.floorLine;
      return k3(C.floor, 0.9 + hash2(x, y, 17) * 0.12);
    });
    p.rect(0, y0, W, 1, C.out);
  }

  /** 立柱：深色金属，带铆钉 */
  private pillar(p: Painter, x0: number) {
    const { H } = this;
    p.rect(x0, 0, 8, H, (x, y) => {
      const dx = x - x0;
      if (dx === 0 || dx === 7) return C.out;
      if (y % 18 === 9 && (dx === 2 || dx === 5)) return C.steelHi;
      return k3(C.steelSh, dx < 3 ? 1.25 : dx > 5 ? 0.75 : 1);
    });
  }

  /** 名牌：深色背光板，橙色光边（字由 HTML 叠上去） */
  private sign(p: Painter, r: Rect) {
    p.rect(r.x - 2, r.y - 2, r.w + 4, r.h + 4, C.out);
    p.rect(r.x, r.y, r.w, r.h, (x, y) => {
      const e = Math.min(x - r.x, y - r.y, r.x + r.w - 1 - x, r.y + r.h - 1 - y);
      return e === 0 ? E.signRim : e === 1 ? mix(E.signRim, E.sign, 0.6) : E.sign;
    }, M_EMIT);
    // 两颗吊挂螺栓
    p.rect(r.x + 4, r.y - 5, 2, 3, C.steel);
    p.rect(r.x + r.w - 6, r.y - 5, 2, 3, C.steel);
  }

  /** 显示器：深色边框，亮的屏幕（自发光），屏上淡淡的扫描线 */
  private monitor(p: Painter, r: Rect, a: RGB = E.screen, b: RGB = E.screen2) {
    p.panel({ x: r.x - 4, y: r.y - 4, w: r.w + 8, h: r.h + 8 }, C.bezel, 1);
    p.rect(r.x, r.y, r.w, r.h, (_x, y) => {
      const t = (y - r.y) / r.h;
      const c = mix(a, b, t);
      return (y - r.y) % 3 === 2 ? k3(c, 0.93) : c;
    }, M_EMIT);
    // 底座
    p.rect(r.x + r.w / 2 - 3, r.y + r.h + 4, 6, 3, C.bezel);
  }

  /** 小圆舷窗：粗边框 + 发光的蓝色海水、气泡、高光 */
  private porthole(p: Painter, cx: number, cy: number, r: number) {
    const T = Math.max(3, Math.round(r * 0.2));
    p.disc(cx, cy, r + T, (dx, dy, d) => {
      if (d < r) return null;
      if (d < r + 1 || d > r + T - 1) return C.out;
      return k3(C.steel, dx + dy < 0 ? 1.2 : 0.8);
    });
    p.disc(cx, cy, r, (dx, dy, d) => {
      const t = (dy / r + 1) / 2;
      let c = mix(E.waterHi, E.waterDeep, t * 0.9);
      if (d > r * 0.8 && dx + dy < -r * 0.6) c = mix(c, [255, 255, 255], 0.5);
      if (hash2(Math.floor(dx), Math.floor(dy), Math.floor(cx)) > 0.985) c = E.waterHi;
      return c;
    }, M_EMIT);
  }

  /** 斜放的桌子：桌面（四边形）+ 前脸 + 亮边 */
  private desk(p: Painter, top: [number, number][], faceH: number) {
    p.poly(top, (x, y) => k3(C.desk, 0.95 + hash2(x, y, 23) * 0.08));
    const [a, b] = [top[3], top[2]]; // 前沿
    p.poly([a, b, [b[0], b[1] + faceH], [a[0], a[1] + faceH]], (x, y) => k3(C.deskFace, 0.92 + hash2(x, y, 29) * 0.1));
    p.line(a[0], a[1], b[0], b[1], C.deskHi);
    p.outline([...top]);
    p.line(a[0], a[1] + faceH, b[0], b[1] + faceH, C.out);
    p.line(b[0], b[1], b[0], b[1] + faceH, C.out);
  }

  /** 空椅子（前景）：圆角靠背、坐垫、立柱、五爪底座；朝窗那侧有蓝色轮廓光 */
  private chair(p: Painter, cx: number, top: number, w: number, h: number, floorY: number) {
    const bw = w, bh = h * 0.55;
    const x0 = cx - bw / 2;
    const r = Math.max(3, bw * 0.2);
    p.rect(x0, top, bw, bh, (x, y) => {
      const dx = x + 0.5 - x0, dy = y + 0.5 - top;
      const cxr = dx < r ? r : dx > bw - r ? bw - r : dx, cyr = dy < r ? r : dy > bh - r ? bh - r : dy;
      const d = Math.hypot(dx - cxr, dy - cyr);
      if (d > r) return null;
      if (d > r - 1) return C.out;
      if (dx > bw - 3) return [120, 190, 255];
      return k3(C.navy, dy < bh * 0.2 ? 1.2 : 1);
    });
    // 头枕上的小牌
    p.rect(cx - bw * 0.18, top + bh * 0.2, bw * 0.36, bh * 0.25, k3(C.steel, 0.9));
    // 坐垫
    const sy = top + bh + 2;
    p.poly([[cx - w * 0.75, sy], [cx + w * 0.75, sy], [cx + w * 0.62, sy + h * 0.14], [cx - w * 0.62, sy + h * 0.14]], (x) => (x > cx + w * 0.55 ? [120, 190, 255] : C.navy));
    p.outline([[cx - w * 0.75, sy], [cx + w * 0.75, sy], [cx + w * 0.62, sy + h * 0.14], [cx - w * 0.62, sy + h * 0.14]]);
    // 立柱 + 底座
    p.rect(cx - 2, sy + h * 0.14, 4, floorY - sy - h * 0.14 - 2, C.dark);
    p.rect(cx - 1, sy + h * 0.14, 1, floorY - sy - h * 0.14 - 2, C.steel);
    p.poly([[cx - w * 0.7, floorY], [cx + w * 0.7, floorY], [cx + w * 0.5, floorY - 4], [cx - w * 0.5, floorY - 4]], C.dark);
    p.outline([[cx - w * 0.7, floorY], [cx + w * 0.7, floorY], [cx + w * 0.5, floorY - 4], [cx - w * 0.5, floorY - 4]]);
  }

  /** 小指示灯（每帧闪） */
  private led(st: number, x: number, y: number, c: RGB, i: number) {
    this.lamps.push({ st, x, y, c, period: 0.9 + (i % 4) * 0.45, phase: (i * 0.37) % 1 });
  }

  // ---------------------------------------------------------------- 三台操作台

  private buildMain(p: Painter, f: Painter): Light[] {
    const L = this.L, { W, H } = this;
    const { cx, cy, R } = L.win;
    const ceilH = Math.round(H * (L.portrait ? 0.035 : 0.05));
    const floorY = Math.round(H * (L.portrait ? 0.86 : 0.85));
    this.wall(p, ceilH, floorY);
    this.ceiling(p, ceilH);
    this.floor(p, floorY, cx, cy);
    // 天花板下的风管和设备箱（透视：往窗口方向变细）
    if (!L.portrait) {
      p.rect(0, ceilH, W * 0.34, H * 0.035, (x, y) => (y === ceilH + Math.round(H * 0.035) - 1 ? C.out : k3(C.ceilDk, 1.1 + hash2(x, y, 2) * 0.1)));
      p.tube(-6, H * 0.12, W * 0.44, H * 0.035, H * 0.05, H * 0.03, C.duct, 9);
      p.tube(W * 0.79, -4, W + 6, H * 0.14, H * 0.035, H * 0.055, C.duct, 9);
      p.tube(W * 0.385, H * 0.08, W * 0.385, floorY, 3, 3, C.steel);
      p.tube(W * 0.4, H * 0.07, W * 0.4, floorY, 2, 2, C.brass);
    } else {
      p.tube(-4, H * 0.06, W + 4, H * 0.05, H * 0.018, H * 0.018, C.duct, 9);
      p.tube(W * 0.05, H * 0.1, W * 0.05, floorY, 3, 3, C.steel);
      p.tube(W * 0.95, H * 0.1, W * 0.95, floorY, 3, 3, C.steel);
    }

    // 大圆窗：钢框（斜面、螺栓、右上角一个卡箍），玻璃透明
    const T = Math.max(5, Math.round(R * 0.1));
    p.disc(cx, cy, R + T + 3, (dx, dy, d) => {
      if (d < R) return null;
      if (d > R + T + 2) return null;
      if (d > R + T + 1) return k3(C.wallSeam, 0.7); // 外圈阴影
      if (d < R + 1 || d > R + T) return C.out;
      const t = (d - R) / T, lit = (dx + dy) / d;
      let k = t < 0.3 ? 1 - lit * 0.25 : 1 + -lit * 0.3;
      if (t > 0.48 && t < 0.56) k *= 0.75;
      return k3(C.steel, k * (0.96 + hash2(Math.floor(dx), Math.floor(dy), 3) * 0.06));
    });
    const nb = Math.max(12, Math.round((Math.PI * 2 * (R + T * 0.75)) / 12));
    for (let i = 0; i < nb; i++) {
      const a = (i / nb) * Math.PI * 2;
      const bx = cx + Math.cos(a) * (R + T * 0.76), by = cy + Math.sin(a) * (R + T * 0.76);
      p.px(bx, by, C.steelHi);
      p.px(bx + 1, by + 1, C.steelSh);
    }
    {
      const a = -0.75, bx = cx + Math.cos(a) * (R + T / 2), by = cy + Math.sin(a) * (R + T / 2);
      const s = Math.max(4, Math.round(T * 0.9));
      p.poly([[bx - s, by - s * 0.6], [bx + s * 0.6, by - s], [bx + s, by + s * 0.6], [bx - s * 0.6, by + s]], (x, y) => k3(C.steel, 1.1 + hash2(x, y, 1) * 0.1));
      p.outline([[bx - s, by - s * 0.6], [bx + s * 0.6, by - s], [bx + s, by + s * 0.6], [bx - s * 0.6, by + s]]);
    }
    for (let y = Math.floor(cy - R); y <= cy + R; y++)
      for (let x = Math.floor(cx - R); x <= cx + R; x++) {
        const dx = x + 0.5 - cx, dy = y + 0.5 - cy, d = Math.hypot(dx, dy);
        if (d >= R) continue;
        const f2 = Math.max(0, (d - R * 0.8) / (R * 0.2));
        const ang = Math.atan2(dy, dx);
        let add = 0;
        if (d > R * 0.86 && d < R * 0.92 && ang > -2.55 && ang < -1.95) add = 70;
        if (d > R * 0.79 && d < R * 0.82 && ang > -2.45 && ang < -2.15) add = 45;
        p.glass(x, y, Math.round(255 * (1 - f2 * f2 * 0.55)), add);
      }

    // 名牌（标题）
    this.sign(p, L.plate);

    const lights: Light[] = [
      { x: cx, y: cy, r: R * 2.6, c: [0.45, 0.8, 1.45], s: 1 },
      { x: cx, y: H, r: R * 1.7, c: [0.4, 0.75, 1.35], s: 0.8 },
    ];
    if (!L.portrait) {
      // 左边：三个小舷窗
      const pr = Math.round(Math.min(W * 0.036, H * 0.07));
      const py = Math.round(H * 0.31);
      for (const fx of [0.075, 0.18, 0.285]) {
        this.porthole(p, W * fx, py, pr);
        lights.push({ x: W * fx, y: py, r: pr * 3, c: [0.4, 0.7, 1.3], s: 0.55 });
      }
      // 斜放的操作桌 + 两台显示器
      const dy0 = H * 0.66, dy1 = H * 0.75;
      this.monitor(p, L.screenL);
      this.monitor(p, L.screenR);
      this.desk(p, [[0, dy0 + 2], [W * 0.38, dy0], [W * 0.42, dy1 - 2], [0, dy1 + 2]], Math.round(H * 0.07));
      // 桌上的键盘和小物件
      p.poly([[W * 0.05, dy0 + 6], [W * 0.16, dy0 + 5], [W * 0.17, dy0 + 12], [W * 0.05, dy0 + 13]], C.dark);
      for (let i = 0; i < 9; i++) p.px(W * 0.06 + i * 4, dy0 + 8, C.steelHi);
      p.rect(W * 0.24, dy0 + 2, 10, 8, C.steel);
      p.rect(W * 0.3, dy0 + 4, 14, 6, C.dark);
      for (let i = 0; i < 4; i++) this.led(0, Math.round(W * 0.3) + 2 + i * 3, Math.round(dy0) + 6, [E.led, [255, 190, 90] as RGB, [255, 90, 70] as RGB, E.led][i], i);
      lights.push({ x: L.screenL.x + L.screenL.w, y: L.screenL.y + L.screenL.h / 2, r: W * 0.22, c: [0.75, 0.95, 1.1], s: 0.65 });
      // 右边：橙光展示柜 + 小桌
      const cab = { x: W * 0.875, y: H * 0.2, w: W * 0.115, h: H * 0.6 };
      p.panel({ x: cab.x - 4, y: cab.y - 4, w: cab.w + 8, h: cab.h + 8 }, C.dark, 1);
      p.rect(cab.x, cab.y, cab.w, cab.h, (x, y) => {
        const t = (y - cab.y) / cab.h;
        let c = mix(E.orange, E.orangeDk, t);
        const shelf = Math.floor(t * 4), sy = (t * 4) % 1;
        if (sy > 0.93) c = k3(E.orangeDk, 0.6);
        // 架子上的瓶瓶罐罐（剪影）
        const fxx = (x - cab.x) / cab.w;
        if (sy > 0.55 && sy < 0.93 && hash2(Math.floor(fxx * 6), shelf, 5) > 0.35 && (fxx * 6) % 1 > 0.25 && (fxx * 6) % 1 < 0.75) c = k3(E.orangeDk, 0.5);
        return c;
      }, M_EMIT);
      lights.push({ x: cab.x + cab.w / 2, y: cab.y + cab.h * 0.4, r: W * 0.33, c: [1.45, 0.72, 0.32], s: 0.9 });
      this.desk(p, [[W * 0.76, H * 0.75], [W, H * 0.73], [W, H * 0.8], [W * 0.75, H * 0.82]], Math.round(H * 0.05));
      p.poly([[W * 0.8, H * 0.765], [W * 0.88, H * 0.755], [W * 0.885, H * 0.78], [W * 0.8, H * 0.79]], C.dark);
      // 小名牌
      p.rect(W * 0.82, H * 0.07, W * 0.08, H * 0.05, C.dark);
      p.rect(W * 0.825, H * 0.08, W * 0.07, H * 0.03, k3(C.steel, 0.8));
      // 天花板暖灯
      lights.push({ x: W * 0.2, y: H * 0.06, r: W * 0.3, c: [1.3, 0.85, 0.5], s: 0.7 });
      lights.push({ x: W * 0.93, y: H * 0.05, r: W * 0.2, c: [1.3, 0.8, 0.45], s: 0.6 });
      // 前景椅子
      this.chair(f, W * 0.42, H * 0.58, W * 0.075, H * 0.3, floorY + Math.round(H * 0.1));
    } else {
      // 竖屏：窗下一张桌子，两台显示器在桌上
      this.monitor(p, L.screenL);
      this.monitor(p, L.screenR);
      const ty = L.screenL.y + L.screenL.h + 8;
      this.desk(p, [[0, ty + 2], [W, ty + 2], [W, ty + 14], [0, ty + 14]], Math.round(H * 0.06));
      for (let i = 0; i < 6; i++) this.led(0, Math.round(W * 0.3) + i * 5, ty + 6, [E.led, [255, 190, 90] as RGB, [255, 90, 70] as RGB][i % 3], i);
      // 两边小舷窗
      const pr = Math.round(W * 0.06);
      this.porthole(p, W * 0.16, ty + Math.round(H * 0.12), pr);
      this.porthole(p, W * 0.84, ty + Math.round(H * 0.12), pr);
      lights.push({ x: W / 2, y: L.screenL.y + L.screenL.h / 2, r: W * 0.6, c: [0.75, 0.95, 1.1], s: 0.6 });
      lights.push({ x: W * 0.5, y: H * 0.72, r: W * 0.7, c: [1.35, 0.75, 0.4], s: 0.6 });
      this.chair(f, W * 0.5, H * 0.8, W * 0.2, H * 0.22, H + 8);
    }
    return lights;
  }

  private buildUpgrade(p: Painter, f: Painter): Light[] {
    const L = this.L, { W, H } = this;
    const ceilH = Math.round(H * (L.portrait ? 0.035 : 0.05));
    const floorY = Math.round(H * 0.86);
    const s = L.upScreen;
    this.wall(p, ceilH, floorY);
    this.ceiling(p, ceilH);
    this.floor(p, floorY, W / 2, s.y + s.h / 2);
    this.sign(p, L.plate);
    // 中间：大显像管（绿屏）+ 两边斜放的小屏
    p.panel({ x: s.x - 6, y: s.y - 6, w: s.w + 12, h: s.h + 12 }, C.dark, 1);
    p.rect(s.x, s.y, s.w, s.h, (x, y) => {
      const dx = Math.min(x - s.x, s.x + s.w - 1 - x), dy = Math.min(y - s.y, s.y + s.h - 1 - y);
      if (dx + dy < 3) return C.dark;
      return (y - s.y) % 2 ? E.crtLine : E.crt;
    }, M_EMIT);
    const lights: Light[] = [{ x: s.x + s.w / 2, y: s.y + s.h / 2, r: s.w * 0.9, c: [0.5, 1.1, 0.8], s: 0.55 }];
    const benchY = L.portrait ? Math.round(H * 0.7) : Math.round(H * 0.68);
    if (!L.portrait) {
      for (const sgn of [-1, 1]) {
        const x0 = sgn < 0 ? s.x - 12 : s.x + s.w + 12;
        const x1 = x0 + sgn * W * 0.08;
        const q: [number, number][] = [[x0, s.y + 8], [x1, s.y + 16], [x1, s.y + s.h - 16], [x0, s.y + s.h - 8]];
        p.poly(q, C.dark);
        const qi: [number, number][] = [[x0 + sgn * 3, s.y + 12], [x1 - sgn * 3, s.y + 19], [x1 - sgn * 3, s.y + s.h - 19], [x0 + sgn * 3, s.y + s.h - 12]];
        p.poly(qi, (_x, y) => (y % 3 === 0 ? k3([70, 180, 170], 0.85) : [70, 180, 170]), M_EMIT);
        p.outline(q);
      }
      // 左边：一排竖管 + 红色阀门
      for (let i = 0; i < 3; i++) {
        const x = W * (0.035 + i * 0.05);
        p.tube(x, ceilH, x, benchY, 4 - i * 0.5, 4 - i * 0.5, i === 1 ? C.brass : C.steel, 7);
        const vy = H * (0.3 + i * 0.12);
        p.disc(x, vy, 6, (_dx, _dy, d) => (d > 6 ? null : d > 5 ? C.out : d > 3.5 ? C.red : d > 2.2 ? null : C.steel));
      }
      // 大屏下面一排小表盘
      const gr = Math.max(5, Math.min(7, Math.floor((benchY - s.y - s.h - 10) / 2)));
      for (let i = 0; i < 4; i++) {
        const gx = s.x + s.w * (0.2 + i * 0.2), gy = s.y + s.h + 7 + gr;
        p.disc(gx, gy, gr, (dx, dy, d) => (d > gr ? null : d > gr - 1 ? C.out : d > gr - 2 ? k3(C.steel, dx + dy < 0 ? 1.2 : 0.8) : [236, 230, 214]), M_LIT);
        p.line(gx, gy, gx + Math.cos(i * 1.7 - 1) * (gr - 3), gy + Math.sin(i * 1.7 - 1) * (gr - 3), C.red);
      }
      // 右边：工具墙
      const tw = { x: W * 0.75, y: H * 0.17, w: W * 0.21, h: H * 0.43 };
      p.panel(tw, [92, 70, 60], 1);
      for (let y = tw.y + 5; y < tw.y + tw.h - 3; y += 6) for (let x = tw.x + 5; x < tw.x + tw.w - 3; x += 6) p.px(x, y, C.out);
      const tool = (x: number, y: number, h: number, kind: number) => {
        if (kind === 0) { // 扳手
          p.rect(x - 1, y, 3, h, C.steel);
          p.disc(x, y, 3.5, (_dx, _dy, d) => (d > 3.5 ? null : d < 1.5 ? null : C.steel));
        } else if (kind === 1) { // 锤子
          p.rect(x - 1, y, 3, h, C.desk);
          p.rect(x - 5, y - 2, 11, 5, C.steel);
        } else { // 螺丝刀
          p.rect(x - 2, y, 5, h * 0.45, C.red);
          p.rect(x, y + h * 0.45, 1, h * 0.55, C.steelHi);
        }
      };
      for (let i = 0; i < 5; i++) tool(tw.x + tw.w * (0.12 + i * 0.19), tw.y + 10 + (i % 2) * 6, tw.h * 0.45, i % 3);
      // 两盏吊灯
      for (const fx of [0.2, 0.82]) {
        const lx = W * fx, ly = H * 0.12;
        p.line(lx, ceilH, lx, ly - 5, C.out);
        p.poly([[lx - 3, ly - 5], [lx + 3, ly - 5], [lx + 8, ly + 1], [lx - 8, ly + 1]], C.dark);
        p.rect(lx - 4, ly + 1, 8, 2, [255, 226, 170], M_EMIT);
        lights.push({ x: lx, y: ly + 30, r: W * 0.3, c: [1.45, 0.92, 0.52], s: 0.95 });
      }
    } else {
      for (let i = 0; i < 2; i++) p.tube(W * (0.04 + i * 0.92), ceilH, W * (0.04 + i * 0.92), benchY, 3, 3, C.steel, 7);
      // 工具墙（屏幕和桌子之间）
      const tw = { x: W * 0.12, y: s.y + s.h + 14, w: W * 0.76, h: benchY - s.y - s.h - 26 };
      if (tw.h > 16) {
        p.panel(tw, [92, 70, 60], 1);
        for (let y = tw.y + 5; y < tw.y + tw.h - 3; y += 6) for (let x = tw.x + 5; x < tw.x + tw.w - 3; x += 6) p.px(x, y, C.out);
        for (let i = 0; i < 4; i++) p.rect(tw.x + tw.w * (0.15 + i * 0.22), tw.y + 6, 3, tw.h * 0.6, [C.steel, C.red, C.steel, C.desk][i]);
      }
      const lx = W / 2, ly = s.y + s.h + 8;
      lights.push({ x: lx, y: ly + 40, r: W * 0.8, c: [1.45, 0.92, 0.52], s: 0.9 });
    }
    // 工作台 + 台上的东西
    this.desk(p, [[0, benchY], [W, benchY], [W, benchY + H * 0.06], [0, benchY + H * 0.06]], Math.round(H * 0.08));
    const by = benchY + H * 0.03;
    // 螺旋桨
    const px0 = W * (L.portrait ? 0.25 : 0.3);
    p.disc(px0, by - 6, 9, (dx, dy, d) => {
      if (d > 9) return null;
      const a = Math.atan2(dy, dx);
      const blade = Math.abs(((a / (Math.PI * 2 / 3)) % 1 + 1) % 1 - 0.5) < 0.17;
      if (d < 2.5) return C.out;
      return blade ? k3(C.brass, dx + dy < 0 ? 1.2 : 0.9) : null;
    });
    // 红色工具箱
    const tbx = W * (L.portrait ? 0.62 : 0.66);
    p.panel({ x: tbx, y: by - 12, w: L.portrait ? 30 : 34, h: 12 }, C.red, 1);
    p.rect(tbx + 10, by - 15, L.portrait ? 10 : 14, 3, C.dark);
    for (let i = 0; i < 4; i++) this.led(1, Math.round(W * 0.46) + i * 4, Math.round(benchY + H * 0.065), [E.led, [255, 190, 90] as RGB, E.led, [255, 90, 70] as RGB][i], i);
    // 前景：一张小凳子
    const fx = L.portrait ? W * 0.78 : W * 0.56;
    const sw = L.portrait ? W * 0.14 : W * 0.06;
    f.poly([[fx - sw, H * 0.9], [fx + sw, H * 0.9], [fx + sw * 0.85, H * 0.93], [fx - sw * 0.85, H * 0.93]], C.navy);
    f.outline([[fx - sw, H * 0.9], [fx + sw, H * 0.9], [fx + sw * 0.85, H * 0.93], [fx - sw * 0.85, H * 0.93]]);
    f.rect(fx - 2, H * 0.93, 4, H * 0.08, C.dark);
    lights.push({ x: W / 2, y: H, r: W * 0.6, c: [1.2, 0.7, 0.45], s: 0.35 });
    return lights;
  }

  private buildHangar(p: Painter, f: Painter): Light[] {
    const L = this.L, { W, H } = this;
    const ceilH = Math.round(H * (L.portrait ? 0.035 : 0.05));
    const floorY = Math.round(H * (L.portrait ? 0.8 : 0.79));
    const s = L.hgScreen;
    this.wall(p, ceilH, floorY);
    this.ceiling(p, ceilH);
    this.floor(p, floorY, W / 2, s.y + s.h / 2);
    this.sign(p, L.plate);
    // 机库观察窗：粗钢框 + 螺栓
    const T = 6;
    p.panel({ x: s.x - T, y: s.y - T, w: s.w + T * 2, h: s.h + T * 2 }, C.steel, 2);
    for (let x = s.x - 3; x < s.x + s.w + 3; x += 10) { p.px(x, s.y - 3, C.steelHi); p.px(x, s.y + s.h + 2, C.steelSh); }
    for (let y = s.y; y < s.y + s.h; y += 10) { p.px(s.x - 3, y, C.steelHi); p.px(s.x + s.w + 2, y, C.steelSh); }
    // 窗外：蓝色水下机库，光束、气泡、三艘吊着的潜艇（剪影）
    p.rect(s.x, s.y, s.w, s.h, (x, y) => {
      const t = (y - s.y) / s.h;
      let c = mix(E.water, E.waterDeep, Math.min(1, t * 1.15));
      const ray = ((x - s.x) * 0.55 + (y - s.y)) / (s.w * 0.18);
      if (t < 0.75 && Math.abs((ray % 1) - 0.5) < 0.12 * (1 - t)) c = mix(c, E.waterHi, 0.25 * (1 - t));
      if (hash2(x, y, 41) > 0.992) c = E.waterHi;
      // 机库地面
      if (t > 0.9) c = k3(E.waterDeep, 0.6 + (Math.floor((x - s.x) / 8) % 2) * 0.08);
      return c;
    }, M_EMIT);
    const subDark: RGB = [16, 36, 76];
    const sub = (cx: number, cy: number, len: number) => {
      const h = len * 0.3;
      // 吊缆
      p.line(cx - len * 0.2, s.y, cx - len * 0.2, cy - h * 0.6, [40, 80, 140], M_EMIT);
      p.line(cx + len * 0.2, s.y, cx + len * 0.2, cy - h * 0.6, [40, 80, 140], M_EMIT);
      p.rect(cx - len * 0.5, cy + h * 0.75, len, 2, [30, 64, 120], M_EMIT);
      for (let y = Math.floor(cy - h * 1.5); y <= cy + h; y++)
        for (let x = Math.floor(cx - len * 0.6); x <= cx + len * 0.55; x++) {
          const u = (x + 0.5 - cx) / (len / 2), v = (y + 0.5 - cy) / h;
          const hull = u * u + v * v * 1.1 < 1;
          const sail = Math.abs(u + 0.05) < 0.14 && v > -1.5 && v < 0;
          const fin = u < -0.85 && u > -1.15 && Math.abs(v) < 0.95 - (u + 1.15) * 0.6;
          if (hull || sail || fin) p.px(x, y, v < -0.5 && hull ? k3(subDark, 1.4) : subDark, M_EMIT);
        }
      // 锁
      const lx = Math.round(cx), ly = Math.round(cy - 1);
      p.rect(lx - 3, ly, 7, 5, [255, 196, 90], M_EMIT);
      p.px(lx, ly + 2, subDark, M_EMIT);
      for (let q = -2; q <= 2; q++) p.px(lx + q, ly - 3, [255, 196, 90], M_EMIT);
      p.px(lx - 2, ly - 2, [255, 196, 90], M_EMIT); p.px(lx - 2, ly - 1, [255, 196, 90], M_EMIT);
      p.px(lx + 2, ly - 2, [255, 196, 90], M_EMIT); p.px(lx + 2, ly - 1, [255, 196, 90], M_EMIT);
    };
    if (!L.portrait) for (let i = 0; i < 3; i++) sub(s.x + ((i + 0.5) / 3) * s.w, s.y + s.h * 0.42, s.w * 0.22);
    else for (let i = 0; i < 3; i++) sub(s.x + s.w * 0.26, s.y + (i + 0.5) * (s.h / 3), s.w * 0.4);
    const lights: Light[] = [
      { x: s.x + s.w / 2, y: s.y + s.h / 2, r: Math.max(s.w, s.h) * 0.9, c: [0.45, 0.8, 1.45], s: 1 },
      { x: W / 2, y: H, r: W * 0.7, c: [0.4, 0.75, 1.35], s: 0.6 },
      { x: W * 0.05, y: H * 0.05, r: W * 0.3, c: [1.3, 0.8, 0.45], s: 0.5 },
      { x: W * 0.95, y: H * 0.05, r: W * 0.3, c: [1.3, 0.8, 0.45], s: 0.5 },
    ];
    // 窗下的控制条
    const cy0 = s.y + s.h + T + 4;
    for (let i = 0; i < 6; i++) this.led(2, Math.round(s.x + 6 + i * 6), cy0, [E.led, [255, 190, 90] as RGB, [120, 200, 255] as RGB][i % 3], i);
    // 前景：栏杆
    const ry = Math.round(H * (L.portrait ? 0.86 : 0.84));
    f.tube(-4, ry, W * FG_K + 4, ry, 2.5, 2.5, C.steel);
    f.tube(-4, ry + H * 0.06, W * FG_K + 4, ry + H * 0.06, 2, 2, C.steel);
    for (let i = 0; i < 5; i++) {
      const x = (i + 0.5) * (W / 5);
      f.tube(x, ry - 2, x, H + 4, 2.5, 2.5, C.steel);
    }
    return lights;
  }

  // ---------------------------------------------------------------- 光照

  /** 对 [ox, ox+W) 这一段算光：暗暖环境光 + 各个灯；四周压暗。自发光和玻璃不受影响 */
  private light(Lr: Layer, ox: number, w: number, lights: Light[]) {
    const { W, H } = this;
    const amb: RGB = [0.34, 0.26, 0.24];
    for (let y = 0; y < H; y++)
      for (let x = 0; x < w && ox + x < Lr.W; x++) {
        const i = y * Lr.W + ox + x;
        const m = Lr.m[i];
        if (m === M_GLASS || m === M_NONE) continue;
        const a = Lr.alb[i];
        if (m === M_EMIT) { Lr.col[i] = a; continue; }
        let lr = amb[0], lg = amb[1], lb = amb[2];
        for (const l of lights) {
          const d2 = ((x - l.x) ** 2 + (y - l.y) ** 2) / (l.r * l.r);
          if (d2 >= 1) continue;
          const fall = (1 - d2) * (1 - d2) * l.s;
          lr += l.c[0] * fall; lg += l.c[1] * fall; lb += l.c[2] * fall;
        }
        // 四周压暗（上面最暗）
        const vx = (x / W - 0.5) * 2, vy = (y / H - 0.55) * 2;
        const v = 1 - Math.min(0.55, (vx * vx * 0.35 + vy * vy * 0.45) * 0.6);
        lr *= v; lg *= v; lb *= v;
        Lr.col[i] = pk([(a & 255) * lr, ((a >> 8) & 255) * lg, ((a >> 16) & 255) * lb]);
      }
  }

  // ---------------------------------------------------------------- 对外

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
   * 把舰桥合成到帧缓冲（游戏世界已经画在里面，圆窗处透出来，带一点蓝色调）。
   * zoom ≥ 1：以圆窗中心为原点放大（进出游戏的过渡）。
   */
  draw(r: Renderer, pan: number, t: number, zoom: number) {
    this.ensure(r.W, r.H);
    const { W, H } = this, buf = r.buf;
    const ring = N_ST * W;
    const con = this.con, fg = this.fg;
    const FW = fg.W;
    const p = Math.round(pan), pf = Math.round(pan * FG_K);
    const zx = this.stationX(0, pan) + this.L.win.cx, zy = this.L.win.cy;
    for (let y = 0; y < H; y++) {
      const sy = zoom === 1 ? y : Math.floor(zy + (y + 0.5 - zy) / zoom);
      if (sy < 0 || sy >= H) continue;
      const rowC = sy * ring, rowF = sy * FW;
      let i = y * W;
      for (let x = 0; x < W; x++, i++) {
        const sx = zoom === 1 ? x : Math.floor(zx + (x + 0.5 - zx) / zoom);
        const fx = (((sx + pf) % FW) + FW) % FW;
        if (fg.m[rowF + fx]) {
          buf[i] = fg.col[rowF + fx];
          continue;
        }
        const ci = rowC + ((((sx + p) % ring) + ring) % ring);
        const m = con.m[ci];
        if (m === M_GLASS) {
          const mm = con.mul[ci], ad = con.add[ci];
          const c = buf[i];
          let R0 = ((c & 255) * mm * 0.86) / 255, G0 = (((c >> 8) & 255) * mm * 0.97) / 255, B0 = (((c >> 16) & 255) * mm) / 255 + 14;
          if (ad) {
            R0 += ((255 - R0) * ad) / 255;
            G0 += ((255 - G0) * ad) / 255;
            B0 += ((255 - B0) * ad) / 255;
          }
          buf[i] = (0xff000000 | (Math.min(255, B0 | 0) << 16) | (Math.min(255, G0 | 0) << 8) | (R0 | 0)) >>> 0;
        } else buf[i] = con.col[ci];
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
      if (sx < -4 || sx > W + 4) continue;
      const on = ((t / l.period + l.phase) % 1) < 0.55;
      put(sx, l.y, on ? l.c : k3(l.c, 0.3));
      put(sx + 1, l.y, on ? l.c : k3(l.c, 0.3));
    }
    {
      const s = this.L.upScreen, sx0 = this.stationX(1, pan) + s.x;
      if (sx0 < W && sx0 + s.w > 0) {
        const ly = s.y + 2 + Math.floor(((t * 0.35) % 1) * (s.h - 4));
        for (let x = 2; x < s.w - 2; x++) {
          const X = sx0 + x;
          if (X < 0 || X >= W) continue;
          const b = buf[ly * W + X];
          buf[ly * W + X] = pk([(b & 255) + 20, ((b >> 8) & 255) + 50, ((b >> 16) & 255) + 34]);
        }
      }
    }
  }
}
