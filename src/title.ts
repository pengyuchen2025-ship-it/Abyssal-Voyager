// 开始 / 暂停界面：潜艇控制台。整块面板是像素画（和游戏画面同样大小的像素），文字和按键用 HTML 叠在上面。
// 布局交给 HTML / CSS（横屏、竖屏自动排），这里按各个元素的位置把背后的像素画画出来：
// 刷绿漆的钢板舱壁（接缝 + 铆钉）、顶部深色横梁、铜铭牌、带螺栓的铜框圆舷窗（中间透明，看得到游戏画面）、
// 铜操作铭牌、黄黑警示条底座，以及红色「启动」按钮本身。
// 只在布局变化时重画（打开界面、窗口大小变了、字体加载完）。

import { hash2 } from './noise';

type RGB = [number, number, number];
const C: Record<string, RGB> = {
  steel: [78, 116, 106], steelHi: [104, 144, 132], steelDark: [56, 88, 80], seam: [40, 64, 58], out: [20, 32, 30],
  band: [48, 74, 68], bandHi: [80, 112, 102],
  brass: [214, 164, 72], brassHi: [248, 214, 132], brassSh: [156, 104, 40], brassOut: [66, 40, 14], engrave: [170, 118, 48],
  bolt: [112, 76, 30],
  yellow: [236, 192, 44], black: [30, 30, 32], well: [34, 46, 44],
  red: [214, 50, 40], redHi: [255, 128, 104], redSh: [140, 22, 18], redOut: [52, 10, 10],
};
const pk = (c: RGB, a = 255) => ((a << 24) | (c[2] << 16) | (c[1] << 8) | c[0]) >>> 0;
const shade = (c: RGB, k: number): RGB => [Math.min(255, c[0] * k) | 0, Math.min(255, c[1] * k) | 0, Math.min(255, c[2] * k) | 0];

interface Rect { x: number; y: number; w: number; h: number }

export class TitleArt {
  private ctx: CanvasRenderingContext2D;
  private bctx: CanvasRenderingContext2D;
  private W = 0;
  private H = 0;
  private buf = new Uint32Array(0);

  constructor(
    private inner: HTMLElement,
    private cv: HTMLCanvasElement,
    private el: { header: HTMLElement; name: HTMLElement; port: HTMLElement; plaque: HTMLElement; base: HTMLElement; btn: HTMLCanvasElement },
  ) {
    this.ctx = cv.getContext('2d')!;
    this.bctx = el.btn.getContext('2d')!;
  }

  /** 舷窗在屏幕上的圆心和半径（CSS 像素），给镜头对准用 */
  hole() {
    const r = this.el.port.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, r: r.width / 2 };
  }

  paint(u: number) {
    const ir = this.inner.getBoundingClientRect();
    const W = (this.W = Math.ceil(ir.width / u)), H = (this.H = Math.ceil(ir.height / u));
    if (W < 4 || H < 4) return;
    this.cv.width = W;
    this.cv.height = H;
    this.cv.style.width = W * u + 'px';
    this.cv.style.height = H * u + 'px';
    const img = this.ctx.createImageData(W, H);
    this.buf = new Uint32Array(img.data.buffer);
    const rel = (e: Element): Rect => {
      const r = e.getBoundingClientRect();
      const x = Math.round((r.left - ir.left) / u), y = Math.round((r.top - ir.top) / u);
      return { x, y, w: Math.round((r.right - ir.left) / u) - x, h: Math.round((r.bottom - ir.top) / u) - y };
    };

    this.bulkhead(rel(this.el.header));
    this.brassPlate(rel(this.el.name), 3);
    this.porthole(rel(this.el.port));
    this.brassPlate(rel(this.el.plaque), 3);
    this.hazard(rel(this.el.base));
    this.ctx.putImageData(img, 0, 0);

    // 红色启动按钮（单独一张小画布，好做悬停 / 按下效果）
    const br = this.el.btn.getBoundingClientRect();
    const bw = Math.max(8, Math.round(br.width / u));
    this.el.btn.width = bw;
    this.el.btn.height = bw;
    const bimg = this.bctx.createImageData(bw, bw);
    this.redButton(new Uint32Array(bimg.data.buffer), bw);
    this.bctx.putImageData(bimg, 0, 0);
  }

  private set(x: number, y: number, c: RGB, a = 255) {
    if (x < 0 || y < 0 || x >= this.W || y >= this.H) return;
    this.buf[y * this.W + x] = pk(c, a);
  }

  /** 舱壁：绿漆钢板，接缝、铆钉、轻微噪点，下面暗一点；顶部一条深色横梁 */
  private bulkhead(header: Rect) {
    const { W, H } = this;
    const bandH = header.y + header.h;
    const pw = 44, ph = 30;
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        const n = 0.95 + hash2(x, y, 31) * 0.07;
        if (y < bandH) {
          let c = C.band;
          if (y === bandH - 1) c = C.out;
          else if (y === bandH - 2) c = C.bandHi;
          else if (y % 4 === 0 && (x >> 1) % 2 === 0) c = shade(C.band, 0.92); // 防滑纹
          this.set(x, y, shade(c, n));
          continue;
        }
        const py = y - bandH;
        const sx = x % pw, sy = py % ph;
        let c = C.steel;
        if (sx === 0 || sy === 0) c = C.seam;
        else if (sx === 1 || sy === 1) c = C.steelHi;
        else if (sx === pw - 1 || sy === ph - 1) c = C.steelDark;
        const k = n * (1 - (y / H) * 0.18);
        this.set(x, y, shade(c, k));
        // 每块钢板四角一颗铆钉
        if ((sx === 4 || sx === pw - 4) && (sy === 4 || sy === ph - 4)) {
          this.set(x, y, C.steelHi);
        } else if ((sx === 5 || sx === pw - 3) && (sy === 5 || sy === ph - 3)) this.set(x, y, C.seam);
      }
    // 横梁下面一道阴影
    for (let x = 0; x < W; x++) this.set(x, bandH, shade(C.steel, 0.7));
  }

  private screw(x: number, y: number) {
    this.set(x, y, C.brassHi);
    this.set(x + 1, y, C.bolt);
    this.set(x, y + 1, C.bolt);
    this.set(x + 1, y + 1, C.brassOut);
  }

  /** 铜铭牌：描边、左上亮右下暗的斜边、离边 inset 的一圈刻线、四角螺丝 */
  private brassPlate(r: Rect, inset: number) {
    const { x: x0, y: y0, w, h } = r;
    for (let y = y0; y < y0 + h; y++)
      for (let x = x0; x < x0 + w; x++) {
        const dx = x - x0, dy = y - y0, ex = w - 1 - dx, ey = h - 1 - dy;
        // 四角缺一格
        if ((dx === 0 || ex === 0) && (dy === 0 || ey === 0)) continue;
        let c = C.brass;
        if (dx === 0 || dy === 0 || ex === 0 || ey === 0) c = C.brassOut;
        else if (dx === 1 || dy === 1) c = C.brassHi;
        else if (ex === 1 || ey === 1 || ex === 2 || ey === 2) c = C.brassSh;
        else if ((dx === inset + 2 || ex === inset + 2) && dy >= inset + 2 && ey >= inset + 2) c = C.engrave;
        else if ((dy === inset + 2 || ey === inset + 2) && dx >= inset + 2 && ex >= inset + 2) c = C.engrave;
        this.set(x, y, shade(c, 0.97 + hash2(x, y, 41) * 0.06));
      }
    // 投影
    for (let x = x0 + 2; x < x0 + w + 1; x++) this.set(x, y0 + h, shade(C.steel, 0.6));
    for (let y = y0 + 2; y < y0 + h + 1; y++) this.set(x0 + w, y, shade(C.steel, 0.6));
    for (const [sx, sy] of [[x0 + 3, y0 + 3], [x0 + w - 5, y0 + 3], [x0 + 3, y0 + h - 5], [x0 + w - 5, y0 + h - 5]]) this.screw(sx, sy);
  }

  /** 圆舷窗：中间透明（看得到游戏画面），铜框带螺栓，玻璃边缘一圈暗、左上一道高光 */
  private porthole(r: Rect) {
    const cx = r.x + r.w / 2, cy = r.y + r.h / 2, R = r.w / 2;
    const T = Math.max(5, Math.round(R * 0.14));
    const x0 = Math.floor(cx - R - T - 3), x1 = Math.ceil(cx + R + T + 3);
    const y0 = Math.floor(cy - R - T - 3), y1 = Math.ceil(cy + R + T + 3);
    for (let y = y0; y <= y1; y++)
      for (let x = x0; x <= x1; x++) {
        const dx = x + 0.5 - cx, dy = y + 0.5 - cy, d = Math.hypot(dx, dy);
        if (d < R) {
          // 玻璃
          const ang = Math.atan2(dy, dx);
          if (d > R - 2) this.set(x, y, [6, 14, 18], 150);
          else if (d > R * 0.8 && d < R * 0.87 && ang > -2.6 && ang < -1.9) this.set(x, y, [255, 255, 255], 70);
          else if (d > R * 0.72 && d < R * 0.75 && ang > -2.45 && ang < -2.1) this.set(x, y, [255, 255, 255], 50);
          else this.set(x, y, [0, 0, 0], 0);
          continue;
        }
        if (d < R + 1) this.set(x, y, C.brassOut);
        else if (d < R + T) {
          // 铜框：外半圈左上亮、右下暗；内半圈反过来（斜面）
          const t = (d - R) / T;
          const lit = (dx + dy) / d; // -1 左上 … 1 右下
          let k = t < 0.35 ? 1 + lit * 0.18 : 1 - lit * 0.22;
          if (t > 0.45 && t < 0.55) k *= 0.88; // 中间一道细槽
          this.set(x, y, shade(C.brass, k * (0.96 + hash2(x, y, 43) * 0.06)));
        } else if (d < R + T + 1) this.set(x, y, C.brassOut);
        else if (d < R + T + 3 && dx + dy > 0) this.set(x, y, shade(C.steel, 0.62)); // 投影
      }
    // 螺栓
    const rb = R + T / 2;
    const n = Math.max(8, Math.round((Math.PI * 2 * rb) / 11));
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + 0.15;
      const bx = Math.round(cx + Math.cos(a) * rb - 1), by = Math.round(cy + Math.sin(a) * rb - 1);
      this.set(bx, by, C.brassHi);
      this.set(bx + 1, by, C.brass);
      this.set(bx, by + 1, C.bolt);
      this.set(bx + 1, by + 1, C.brassOut);
    }
  }

  /** 启动按钮底座：黄黑斜纹边框，里面是深色凹槽 */
  private hazard(r: Rect) {
    const { x: x0, y: y0, w, h } = r;
    const b = Math.max(3, Math.round(Math.min(w, h) * 0.1));
    for (let y = y0; y < y0 + h; y++)
      for (let x = x0; x < x0 + w; x++) {
        const dx = x - x0, dy = y - y0, ex = w - 1 - dx, ey = h - 1 - dy;
        if ((dx === 0 || ex === 0) && (dy === 0 || ey === 0)) continue;
        let c: RGB;
        if (dx === 0 || dy === 0 || ex === 0 || ey === 0) c = C.out;
        else if (dx <= b || dy <= b || ex <= b || ey <= b) c = ((x + y) >> 2) % 2 ? C.yellow : C.black;
        else if (dx === b + 1 || dy === b + 1) c = C.out;
        else c = dx < b + 4 || dy < b + 4 ? shade(C.well, 0.8) : C.well;
        this.set(x, y, c);
      }
    for (let x = x0 + 2; x < x0 + w + 1; x++) this.set(x, y0 + h, shade(C.steel, 0.6));
    for (let y = y0 + 2; y < y0 + h + 1; y++) this.set(x0 + w, y, shade(C.steel, 0.6));
  }

  /** 红色圆按钮：描边、侧面（下半圈深色厚度）、顶面左上高光 */
  private redButton(buf: Uint32Array, n: number) {
    const cx = n / 2, cy = n / 2 - n * 0.04, R = n / 2 - 1.2;
    const side = Math.max(2, Math.round(n * 0.08));
    for (let y = 0; y < n; y++)
      for (let x = 0; x < n; x++) {
        const dx = x + 0.5 - cx;
        // 顶面圆 + 往下延伸 side 像素的侧面
        const dTop = Math.hypot(dx, y + 0.5 - cy);
        const dSide = Math.hypot(dx, y + 0.5 - (cy + side));
        const inTop = dTop < R - side * 0.5;
        const inBody = inTop || dSide < R - side * 0.5 || (Math.abs(dx) < R - side * 0.5 && y + 0.5 > cy && y + 0.5 < cy + side);
        const inOut = dTop < R - side * 0.5 + 1 || dSide < R - side * 0.5 + 1 || (Math.abs(dx) < R - side * 0.5 + 1 && y + 0.5 > cy && y + 0.5 < cy + side);
        let c: RGB | null = null;
        if (inTop) {
          const rr = dTop / (R - side * 0.5);
          const hx = dx / R, hy = (y + 0.5 - cy) / R;
          c = C.red;
          if (rr > 0.86) c = hx + hy < 0 ? C.redHi : C.redSh;
          else if (Math.hypot(hx + 0.5, hy + 0.42) < 0.1) c = [255, 220, 206];
          else if (hx + hy < -0.55) c = shade(C.red, 1.14);
        } else if (inBody) c = C.redSh;
        else if (inOut) c = C.redOut;
        buf[y * n + x] = c ? pk(c) : 0;
      }
  }
}
