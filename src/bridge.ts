// 舰桥：开始界面 / 菜单。玩家站在舰桥上，一圈操作台：主操作台 → 潜艇升级 → 潜艇机库 →（绕回）主操作台。
//
// 画法：用 Canvas 2D（渐变、圆弧、贝塞尔曲线、发光、图层混合）在一张中等分辨率的画布上画好每个操作台，
// 再像素放大显示（比游戏画面细一些，像高位像素画）。每个操作台按这个顺序画：
//   1. 墙、天花板、地板、管线、桌子等「受光」的东西（中间调）；
//   2. 光照：先整体乘一层暗暖色（离窗越远越暗），再用滤色叠上窗口的蓝光和几盏暖橙色灯；
//   3. 自发光的东西（屏幕、小舷窗、展示柜）带光晕画在最上面；
//   4. 主操作台把大圆窗挖空——下面的游戏画布透出来，再盖一层玻璃的暗边和反光。
// 静态部分每个分辨率只画一次（每台一张离屏画布），每帧只是按朝向把两台拼起来，再画闪烁的小灯。
// 文字和按钮是 HTML，叠在上面（main.ts 按这里的布局摆放）。

export interface Rect { x: number; y: number; w: number; h: number }
export const STATIONS = ['主操作台', '潜艇升级', '潜艇机库'];
export const N_ST = STATIONS.length;
const FG_K = 1.25; // 前景（栏杆）平移得快一点

type Ctx = CanvasRenderingContext2D;
type Light = { x: number; y: number; r: number; rgb: string; a: number };

export interface Layout {
  W: number; H: number; portrait: boolean;
  win: { cx: number; cy: number; R: number };
  plate: Rect;
  screenL: Rect; screenR: Rect;
  upScreen: Rect; hgScreen: Rect; hgCards: Rect[];
}

interface Led { st: number; x: number; y: number; c: string; period: number; phase: number }

const COL = {
  wall: '#9a6444', wallLt: '#c88a5c', wallDk: '#5a3624', seam: '#3c2418',
  ceil: '#3a2a2a', ceilDk: '#1e1618',
  steelLt: '#c4d0dc', steelDk: '#3a404c', steelXd: '#20242c',
  brass: '#c8964c', brassLt: '#f0c878', brassDk: '#7a5628',
  desk: '#a8704a', deskLt: '#d8a070', deskDk: '#5c3a26',
  floor: '#2e2a30', floorLn: '#16141a',
  red: '#d04030',
};
const PIPE: [string, string, string] = ['#8a96a6', '#d0dae6', '#3a4250'];
const DUCT: [string, string, string] = ['#9aa0ac', '#e0e6ee', '#4a505c'];
const BRASS: [string, string, string] = [COL.brass, COL.brassLt, COL.brassDk];

// ---------------------------------------------------------------- 画图小工具

function rr(ctx: Ctx, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}

/** 带斜面的金属面板：竖直渐变 + 亮上沿 + 暗下沿 + 描边 */
function plate(ctx: Ctx, x: number, y: number, w: number, h: number, r: number, base: string, lt: string, dk: string) {
  const g = ctx.createLinearGradient(0, y, 0, y + h);
  g.addColorStop(0, lt);
  g.addColorStop(Math.min(0.3, 2 / h), base);
  g.addColorStop(Math.max(0.7, 1 - 3 / h), base);
  g.addColorStop(1, dk);
  rr(ctx, x, y, w, h, r);
  ctx.fillStyle = g;
  ctx.fill();
  ctx.strokeStyle = 'rgba(10,6,6,0.85)';
  ctx.lineWidth = 1;
  ctx.stroke();
}

/** 铆钉：小圆点 + 投影 + 高光 */
function rivet(ctx: Ctx, x: number, y: number, r = 1.3) {
  ctx.fillStyle = 'rgba(20,10,8,0.6)';
  ctx.beginPath();
  ctx.arc(x + 0.5, y + 0.6, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#d8a478';
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = 'rgba(255,240,220,0.8)';
  ctx.fillRect(x - r * 0.5, y - r * 0.6, Math.max(0.8, r * 0.6), Math.max(0.8, r * 0.6));
}

/** 管子：沿折线画几遍（黑边、暗底、本色、高光），看起来是圆柱 */
function pipe(ctx: Ctx, pts: [number, number][], r: number, [base, lt, dk]: [string, string, string]) {
  const path = () => {
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
  };
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  path();
  ctx.strokeStyle = '#120c0c';
  ctx.lineWidth = r * 2 + 1.5;
  ctx.stroke();
  path();
  ctx.strokeStyle = dk;
  ctx.lineWidth = r * 2;
  ctx.stroke();
  ctx.translate(-r * 0.15, -r * 0.25);
  path();
  ctx.strokeStyle = base;
  ctx.lineWidth = r * 1.4;
  ctx.stroke();
  ctx.translate(-r * 0.15, -r * 0.3);
  path();
  ctx.strokeStyle = lt;
  ctx.lineWidth = Math.max(0.8, r * 0.45);
  ctx.stroke();
  ctx.restore();
}

/** 管子上的法兰（一圈箍） */
function flange(ctx: Ctx, x: number, y: number, w: number, h: number) {
  const g = ctx.createLinearGradient(x, 0, x + w, 0);
  g.addColorStop(0, COL.steelDk);
  g.addColorStop(0.35, COL.steelLt);
  g.addColorStop(1, COL.steelXd);
  ctx.fillStyle = g;
  ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = '#100c0c';
  ctx.lineWidth = 0.8;
  ctx.strokeRect(x, y, w, h);
}

/** 圆形表盘 */
function gauge(ctx: Ctx, x: number, y: number, r: number, v: number) {
  const g = ctx.createLinearGradient(x - r, y - r, x + r, y + r);
  g.addColorStop(0, COL.brassLt);
  g.addColorStop(1, COL.brassDk);
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = '#100a08';
  ctx.lineWidth = 0.8;
  ctx.stroke();
  ctx.fillStyle = '#f2ead8';
  ctx.beginPath();
  ctx.arc(x, y, r * 0.78, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = '#3a3030';
  ctx.lineWidth = 0.6;
  for (let i = 0; i <= 8; i++) {
    const a = Math.PI * 0.75 + (i / 8) * Math.PI * 1.5;
    ctx.beginPath();
    ctx.moveTo(x + Math.cos(a) * r * 0.55, y + Math.sin(a) * r * 0.55);
    ctx.lineTo(x + Math.cos(a) * r * 0.7, y + Math.sin(a) * r * 0.7);
    ctx.stroke();
  }
  const a = Math.PI * 0.75 + v * Math.PI * 1.5;
  ctx.strokeStyle = COL.red;
  ctx.lineWidth = Math.max(0.8, r * 0.12);
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x + Math.cos(a) * r * 0.62, y + Math.sin(a) * r * 0.62);
  ctx.stroke();
  ctx.fillStyle = '#201818';
  ctx.beginPath();
  ctx.arc(x, y, Math.max(0.8, r * 0.1), 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,0.35)';
  ctx.beginPath();
  ctx.ellipse(x - r * 0.25, y - r * 0.3, r * 0.35, r * 0.18, -0.6, 0, Math.PI * 2);
  ctx.fill();
}

/** 发光：滤色叠加一个径向渐变 */
function glow(ctx: Ctx, x: number, y: number, r: number, rgb: string, a: number) {
  ctx.save();
  ctx.globalCompositeOperation = 'screen';
  const g = ctx.createRadialGradient(x, y, 0, x, y, r);
  g.addColorStop(0, `rgba(${rgb},${a})`);
  g.addColorStop(0.45, `rgba(${rgb},${a * 0.4})`);
  g.addColorStop(1, `rgba(${rgb},0)`);
  ctx.fillStyle = g;
  ctx.fillRect(x - r, y - r, r * 2, r * 2);
  ctx.restore();
}

/** 线缆：一段下垂的贝塞尔曲线 */
function cable(ctx: Ctx, x0: number, y0: number, x1: number, y1: number, sag: number, w: number, col: string) {
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.bezierCurveTo(x0 + (x1 - x0) * 0.3, y0 + sag, x0 + (x1 - x0) * 0.7, y1 + sag, x1, y1);
  ctx.strokeStyle = '#0c0808';
  ctx.lineWidth = w + 1;
  ctx.stroke();
  ctx.strokeStyle = col;
  ctx.lineWidth = w;
  ctx.stroke();
}

/** 斜纹布满一块区域（用来做格栅、通风口） */
function grille(ctx: Ctx, x: number, y: number, w: number, h: number) {
  plate(ctx, x, y, w, h, 2, '#3a3036', '#6a5a60', '#181216');
  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  for (let yy = y + 3; yy < y + h - 2; yy += 3) ctx.fillRect(x + 3, yy, w - 6, 1.4);
}

// ---------------------------------------------------------------- 舰桥

export class Bridge {
  L!: Layout;
  /** 画布像素到 CSS 像素的放大倍数 */
  a = 2;
  private vw = 0;
  private vh = 0;
  private st: HTMLCanvasElement[] = [];
  private fg: HTMLCanvasElement[] = [];
  private leds: Led[] = [];
  private ctx: Ctx;

  constructor(public cv: HTMLCanvasElement) {
    this.ctx = cv.getContext('2d')!;
  }

  private layout(W: number, H: number): Layout {
    const portrait = W < H * 0.9;
    const r = (x: number, y: number, w: number, h: number): Rect => ({ x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) });
    const hgCards: Rect[] = [];
    if (!portrait) {
      const R = Math.round(Math.min(H * 0.36, W * 0.25));
      const hgScreen = r(W * 0.07, H * 0.2, W * 0.86, H * 0.5);
      for (let i = 0; i < 3; i++) {
        const cw = hgScreen.w * 0.27;
        hgCards.push(r(hgScreen.x + ((i + 0.5) / 3) * hgScreen.w - cw / 2, hgScreen.y + hgScreen.h * 0.7, cw, hgScreen.h * 0.18));
      }
      return {
        W, H, portrait,
        win: { cx: Math.round(W * 0.6), cy: Math.round(H * 0.45), R },
        plate: r(W * 0.04, H * 0.065, W * 0.29, H * 0.1),
        screenL: r(W * 0.05, H * 0.49, W * 0.13, H * 0.13),
        screenR: r(W * 0.205, H * 0.49, W * 0.13, H * 0.13),
        upScreen: r(W * 0.32, H * 0.2, W * 0.36, H * 0.38),
        hgScreen, hgCards,
      };
    }
    const R = Math.round(Math.min(W * 0.4, H * 0.21));
    const cy = Math.round(H * 0.09 + 18 + R);
    const my = cy + R + Math.round(R * 0.16) + 20;
    const hgScreen = r(W * 0.08, H * 0.13, W * 0.84, H * 0.6);
    for (let i = 0; i < 3; i++) {
      const rh = hgScreen.h / 3;
      hgCards.push(r(hgScreen.x + hgScreen.w * 0.55, hgScreen.y + i * rh + rh * 0.3, hgScreen.w * 0.4, rh * 0.4));
    }
    return {
      W, H, portrait,
      win: { cx: Math.round(W / 2), cy, R },
      plate: r(W * 0.12, H * 0.025, W * 0.76, H * 0.055),
      screenL: r(W * 0.08, my, W * 0.38, H * 0.08),
      screenR: r(W * 0.54, my, W * 0.38, H * 0.08),
      upScreen: r(W * 0.09, H * 0.13, W * 0.82, H * 0.31),
      hgScreen, hgCards,
    };
  }

  /** 视口大小变了就重画（vw、vh：CSS 像素） */
  ensure(vw: number, vh: number) {
    if (vw === this.vw && vh === this.vh) return;
    this.vw = vw;
    this.vh = vh;
    this.a = Math.max(1, Math.round(Math.min(vw, vh) / 380));
    const W = Math.ceil(vw / this.a), H = Math.ceil(vh / this.a);
    this.cv.width = W;
    this.cv.height = H;
    this.cv.style.width = W * this.a + 'px';
    this.cv.style.height = H * this.a + 'px';
    this.L = this.layout(W, H);
    this.leds = [];
    this.st = [];
    this.fg = [];
    for (let s = 0; s < N_ST; s++) {
      const c = document.createElement('canvas');
      c.width = W;
      c.height = H;
      const f = document.createElement('canvas');
      f.width = Math.ceil(W * FG_K);
      f.height = H;
      const ctx = c.getContext('2d')!, fctx = f.getContext('2d')!;
      if (s === 0) this.main(ctx);
      else if (s === 1) this.upgrade(ctx);
      else this.hangar(ctx, fctx);
      this.pillars(ctx);
      this.st.push(c);
      this.fg.push(f);
    }
  }

  // ---------------------------------------------------------------- 公用部件

  /** 墙：大块钢板，接缝、铆钉、上亮下暗 */
  private wall(ctx: Ctx, y0: number, y1: number, seed: number) {
    const { W, H } = this.L;
    const g = ctx.createLinearGradient(0, y0, 0, y1);
    g.addColorStop(0, COL.wallDk);
    g.addColorStop(0.45, COL.wall);
    g.addColorStop(1, COL.wallDk);
    ctx.fillStyle = g;
    ctx.fillRect(0, y0, W, y1 - y0);
    const ph = Math.max(30, Math.round(H * 0.17)), pw = Math.max(50, Math.round(W * 0.17));
    for (let row = 0, y = y0; y < y1; row++, y += ph) {
      for (let x = -((row % 2) * pw) / 2 - ((seed * 13) % pw); x < W; x += pw) {
        ctx.fillStyle = 'rgba(255,210,160,0.12)';
        ctx.fillRect(x + 1, y + 1, pw - 2, 1.5);
        ctx.fillStyle = 'rgba(30,14,8,0.25)';
        ctx.fillRect(x + 1, y + ph - 3, pw - 2, 2);
        ctx.fillStyle = COL.seam;
        ctx.fillRect(x, y, pw, 1);
        ctx.fillRect(x, y, 1, ph);
        rivet(ctx, x + 4, y + 4);
        rivet(ctx, x + pw - 4, y + 4);
        rivet(ctx, x + 4, y + ph - 5);
        rivet(ctx, x + pw - 4, y + ph - 5);
      }
    }
  }

  /** 天花板：深色，暗条纹，底边一道横梁 */
  private ceiling(ctx: Ctx, h: number) {
    const { W } = this.L;
    const g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, COL.ceilDk);
    g.addColorStop(1, COL.ceil);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, h);
    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    for (let x = 0; x < W; x += 14) ctx.fillRect(x, 0, 6, h - 3);
    plate(ctx, -2, h - 4, W + 4, 6, 1, '#5a4440', '#8a6a60', '#2a1e1e');
  }

  /** 地板：格栅，纵线朝消失点收拢，横线越远越密 */
  private floor(ctx: Ctx, y0: number, vx: number, vy: number) {
    const { W, H } = this.L;
    const g = ctx.createLinearGradient(0, y0, 0, H);
    g.addColorStop(0, '#1c181c');
    g.addColorStop(1, COL.floor);
    ctx.fillStyle = g;
    ctx.fillRect(0, y0, W, H - y0);
    ctx.strokeStyle = COL.floorLn;
    ctx.lineWidth = 1;
    const t = (y0 - vy) / (H - vy);
    for (let i = -12; i <= 12; i++) {
      const xb = vx + i * W * 0.11;
      ctx.beginPath();
      ctx.moveTo(vx + (xb - vx) * t, y0);
      ctx.lineTo(xb, H);
      ctx.stroke();
    }
    for (let k = 1; k < 8; k++) {
      const y = y0 + (H - y0) * (k / 8) ** 1.6;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(W, y);
      ctx.stroke();
    }
    ctx.fillStyle = 'rgba(255,220,180,0.18)';
    ctx.fillRect(0, y0, W, 1);
    ctx.fillStyle = '#0c0a0c';
    ctx.fillRect(0, y0 - 1, W, 1);
  }

  /** 两侧的立柱（相邻操作台的分界） */
  private pillars(ctx: Ctx) {
    const { W, H } = this.L;
    const pw = Math.max(8, Math.round(W * 0.018));
    for (const x of [0, W - pw]) {
      const g = ctx.createLinearGradient(x, 0, x + pw, 0);
      g.addColorStop(0, '#16121a');
      g.addColorStop(0.4, '#4a4450');
      g.addColorStop(1, '#100c12');
      ctx.fillStyle = g;
      ctx.fillRect(x, 0, pw, H);
      for (let y = 10; y < H; y += 22) rivet(ctx, x + pw / 2, y, 1);
    }
  }

  /** 名牌：深色背光板，橙色光边（字由 HTML 叠上去） */
  private sign(ctx: Ctx, r: Rect) {
    for (const x of [r.x + 8, r.x + r.w - 8]) {
      ctx.fillStyle = COL.steelDk;
      ctx.fillRect(x - 1, 0, 2, r.y);
    }
    ctx.save();
    ctx.shadowColor = 'rgba(255,140,50,0.8)';
    ctx.shadowBlur = 10;
    rr(ctx, r.x, r.y, r.w, r.h, 3);
    ctx.fillStyle = '#1c1212';
    ctx.fill();
    ctx.restore();
    rr(ctx, r.x + 1.5, r.y + 1.5, r.w - 3, r.h - 3, 2);
    ctx.strokeStyle = '#ff9a48';
    ctx.lineWidth = 1.2;
    ctx.stroke();
  }

  /** 显示器：深色外壳、屏幕发亮、扫描线和斜反光（字由 HTML 叠上去） */
  private monitor(ctx: Ctx, r: Rect, a: string, b: string, glowRgb: string) {
    const p = Math.max(3, Math.round(r.h * 0.12));
    ctx.fillStyle = '#18161c';
    ctx.fillRect(r.x + r.w / 2 - 3, r.y + r.h + p, 6, p + 3);
    plate(ctx, r.x - p, r.y - p, r.w + p * 2, r.h + p * 2, 3, '#2c2a34', '#5a5866', '#121018');
    ctx.save();
    ctx.shadowColor = `rgba(${glowRgb},0.9)`;
    ctx.shadowBlur = 12;
    const g = ctx.createLinearGradient(0, r.y, 0, r.y + r.h);
    g.addColorStop(0, a);
    g.addColorStop(1, b);
    ctx.fillStyle = g;
    ctx.fillRect(r.x, r.y, r.w, r.h);
    ctx.restore();
    ctx.fillStyle = 'rgba(0,30,60,0.06)';
    for (let y = r.y; y < r.y + r.h; y += 2) ctx.fillRect(r.x, y, r.w, 1);
    ctx.fillStyle = 'rgba(255,255,255,0.16)';
    ctx.beginPath();
    ctx.moveTo(r.x, r.y);
    ctx.lineTo(r.x + r.w * 0.4, r.y);
    ctx.lineTo(r.x + r.w * 0.2, r.y + r.h);
    ctx.lineTo(r.x, r.y + r.h);
    ctx.closePath();
    ctx.fill();
    glow(ctx, r.x + r.w / 2, r.y + r.h / 2, Math.max(r.w, r.h) * 1.1, glowRgb, 0.3);
  }

  /** 小圆舷窗：铜框、螺栓、发光的海水、气泡、高光 */
  private porthole(ctx: Ctx, x: number, y: number, r: number) {
    const T = Math.max(3, r * 0.24);
    const g = ctx.createLinearGradient(x - r - T, y - r - T, x + r + T, y + r + T);
    g.addColorStop(0, COL.brassLt);
    g.addColorStop(0.5, COL.brass);
    g.addColorStop(1, COL.brassDk);
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, r + T, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#140c08';
    ctx.lineWidth = 1;
    ctx.stroke();
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2 + 0.3;
      rivet(ctx, x + Math.cos(a) * (r + T * 0.5), y + Math.sin(a) * (r + T * 0.5), 0.9);
    }
    ctx.save();
    ctx.shadowColor = 'rgba(90,180,255,0.9)';
    ctx.shadowBlur = 10;
    const w = ctx.createRadialGradient(x - r * 0.3, y - r * 0.4, r * 0.1, x, y, r);
    w.addColorStop(0, '#bfe8ff');
    w.addColorStop(0.5, '#4aa0e8');
    w.addColorStop(1, '#123a80');
    ctx.fillStyle = w;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    ctx.fillStyle = 'rgba(220,245,255,0.8)';
    for (let i = 0; i < 6; i++) {
      const bx = x + Math.sin(i * 2.3 + x) * r * 0.55, by = y + Math.cos(i * 1.7 + y) * r * 0.55;
      ctx.beginPath();
      ctx.arc(bx, by, 0.5 + (i % 3) * 0.35, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.strokeStyle = 'rgba(255,255,255,0.55)';
    ctx.lineWidth = Math.max(1, r * 0.08);
    ctx.beginPath();
    ctx.arc(x, y, r * 0.78, Math.PI * 1.1, Math.PI * 1.45);
    ctx.stroke();
    ctx.strokeStyle = 'rgba(0,10,40,0.5)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(x, y, r - 0.5, 0, Math.PI * 2);
    ctx.stroke();
  }

  /** 斜桌：桌面（四边形，渐变）+ 前脸 + 亮边 + 抽屉缝 */
  private desk(ctx: Ctx, top: [number, number][], face: number) {
    const ys = top.map((p) => p[1]);
    const g = ctx.createLinearGradient(0, Math.min(...ys), 0, Math.max(...ys));
    g.addColorStop(0, COL.deskDk);
    g.addColorStop(1, COL.desk);
    ctx.beginPath();
    top.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])));
    ctx.closePath();
    ctx.fillStyle = g;
    ctx.fill();
    ctx.strokeStyle = '#140a06';
    ctx.lineWidth = 1;
    ctx.stroke();
    const a = top[3], b = top[2];
    const fg = ctx.createLinearGradient(0, a[1], 0, a[1] + face);
    fg.addColorStop(0, '#4a2c1c');
    fg.addColorStop(1, '#22140e');
    ctx.beginPath();
    ctx.moveTo(a[0], a[1]);
    ctx.lineTo(b[0], b[1]);
    ctx.lineTo(b[0], b[1] + face);
    ctx.lineTo(a[0], a[1] + face);
    ctx.closePath();
    ctx.fillStyle = fg;
    ctx.fill();
    ctx.stroke();
    ctx.strokeStyle = COL.deskLt;
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(a[0], a[1]);
    ctx.lineTo(b[0], b[1]);
    ctx.stroke();
    ctx.strokeStyle = 'rgba(0,0,0,0.4)';
    ctx.lineWidth = 1;
    for (let k = 1; k < 4; k++) {
      const x = a[0] + (b[0] - a[0]) * (k / 4), y = a[1] + (b[1] - a[1]) * (k / 4);
      ctx.beginPath();
      ctx.moveTo(x, y + 2);
      ctx.lineTo(x, y + face - 2);
      ctx.stroke();
    }
  }

  /** 光照：整体乘一层（离主光源越远越暗，天花板和地面更暗），再用滤色叠上各盏灯 */
  private lighting(ctx: Ctx, key: { x: number; y: number; r: number }, lights: Light[]) {
    const { W, H } = this.L;
    ctx.save();
    ctx.globalCompositeOperation = 'multiply';
    const g = ctx.createRadialGradient(key.x, key.y, key.r * 0.25, key.x, key.y, Math.hypot(W, H) * 0.75);
    g.addColorStop(0, '#fff4ec');
    g.addColorStop(0.45, '#b08672');
    g.addColorStop(1, '#3c2620');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
    const v = ctx.createLinearGradient(0, 0, 0, H);
    v.addColorStop(0, '#6a5450');
    v.addColorStop(0.18, '#ffffff');
    v.addColorStop(0.82, '#ffffff');
    v.addColorStop(1, '#5a5058');
    ctx.fillStyle = v;
    ctx.fillRect(0, 0, W, H);
    ctx.restore();
    for (const l of lights) glow(ctx, l.x, l.y, l.r, l.rgb, l.a);
  }

  private led(st: number, x: number, y: number, c: string, i: number) {
    this.leds.push({ st, x, y, c, period: 0.9 + (i % 4) * 0.45, phase: (i * 0.37) % 1 });
  }

  // ---------------------------------------------------------------- 主操作台

  private main(ctx: Ctx) {
    const L = this.L, { W, H } = L, { cx, cy, R } = L.win;
    const ceilH = Math.round(H * (L.portrait ? 0.05 : 0.07));
    const floorY = Math.round(H * (L.portrait ? 0.88 : 0.86));
    this.wall(ctx, ceilH, floorY, 0);
    this.ceiling(ctx, ceilH);
    this.floor(ctx, floorY, cx, cy);
    const T = Math.max(8, Math.round(R * 0.13));
    const lights: Light[] = [
      { x: cx, y: cy, r: R * 2.7, rgb: '80,160,255', a: 0.55 },
      { x: cx, y: H, r: R * 1.6, rgb: '70,150,255', a: 0.45 },
    ];
    // 大圆窗外圈的厚底座（带投影）
    const base = () => {
      ctx.save();
      ctx.shadowColor = 'rgba(0,0,0,0.6)';
      ctx.shadowBlur = 12;
      ctx.shadowOffsetY = 4;
      ctx.fillStyle = '#3a3c48';
      ctx.beginPath();
      ctx.arc(cx, cy, R + T + 5, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    };
    if (!L.portrait) {
      // 天花板上的风管、设备箱、线缆
      pipe(ctx, [[-10, H * 0.14], [W * 0.18, H * 0.12], [W * 0.42, H * 0.055]], H * 0.042, DUCT);
      flange(ctx, W * 0.14, H * 0.08, 4, H * 0.09);
      flange(ctx, W * 0.3, H * 0.05, 4, H * 0.085);
      pipe(ctx, [[W * 0.8, -6], [W * 0.9, H * 0.09], [W + 10, H * 0.14]], H * 0.034, DUCT);
      plate(ctx, W * 0.44, -2, W * 0.18, H * 0.055, 2, '#4a3e40', '#7a6a6a', '#201818');
      cable(ctx, W * 0.46, H * 0.05, W * 0.6, H * 0.05, H * 0.05, 1.5, '#2a2a34');
      cable(ctx, W * 0.48, H * 0.05, W * 0.57, H * 0.055, H * 0.08, 1.2, '#6a2a24');
      // 窗左边的两根竖管
      pipe(ctx, [[W * 0.385, H * 0.12], [W * 0.385, floorY]], 3, PIPE);
      pipe(ctx, [[W * 0.402, H * 0.1], [W * 0.402, floorY]], 2, BRASS);
      for (const y of [H * 0.3, H * 0.62]) flange(ctx, W * 0.377, y, W * 0.032, 3);
      base();
      // 左：三个小舷窗的底板、斜桌、桌上的东西
      const pr = Math.round(Math.min(W * 0.034, H * 0.066));
      const py = Math.round(H * 0.31);
      plate(ctx, W * 0.03, py - pr - 10, W * 0.31, pr * 2 + 20, 4, '#6a4a3a', '#9a6e56', '#2e1e16');
      grille(ctx, W * 0.05, H * 0.43, W * 0.28, H * 0.03);
      const dy0 = H * 0.68, dy1 = H * 0.765;
      this.desk(ctx, [[0, dy0 + 3], [W * 0.37, dy0], [W * 0.41, dy1 - 2], [0, dy1 + 3]], Math.round(H * 0.085));
      ctx.save();
      ctx.transform(1, -0.01, -0.3, 1, W * 0.2, 0);
      plate(ctx, W * 0.05, dy0 + 6, W * 0.11, H * 0.026, 1, '#2a2a32', '#4a4a56', '#101014');
      ctx.fillStyle = '#8a8a98';
      for (let i = 0; i < 12; i++) for (let j = 0; j < 2; j++) ctx.fillRect(W * 0.053 + i * W * 0.0088, dy0 + 7.5 + j * 2.6, W * 0.006, 1.6);
      ctx.restore();
      ctx.save();
      ctx.translate(W * 0.25, dy0 + 6);
      ctx.rotate(-0.12);
      ctx.fillStyle = '#e8dcc0';
      ctx.fillRect(0, 0, W * 0.05, H * 0.03);
      ctx.fillStyle = '#d8ccb0';
      ctx.fillRect(3, 3, W * 0.05, H * 0.03);
      ctx.fillStyle = 'rgba(60,50,40,0.5)';
      for (let k = 0; k < 4; k++) ctx.fillRect(6, 6 + k * 2, W * 0.03, 0.8);
      ctx.restore();
      // 杯子
      ctx.fillStyle = '#d8d0c4';
      ctx.fillRect(W * 0.035, dy0 + 2, 5, 6);
      ctx.strokeStyle = '#d8d0c4';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(W * 0.035 + 6, dy0 + 5, 2, -Math.PI / 2, Math.PI / 2);
      ctx.stroke();
      plate(ctx, W * 0.31, dy0 + 2, W * 0.045, H * 0.03, 2, '#3a3a44', '#6a6a78', '#18181e');
      for (let i = 0; i < 4; i++) this.led(0, W * 0.316 + i * 3.2, dy0 + 6, ['#7cffb0', '#ffc85a', '#ff5a46', '#7cffb0'][i], i);
      // 右：展示柜、小桌、表
      const cab = { x: W * 0.865, y: H * 0.19, w: W * 0.115, h: H * 0.6 };
      plate(ctx, cab.x - 5, cab.y - 5, cab.w + 10, cab.h + 10, 3, '#3a2e2e', '#6a5656', '#160e0e');
      this.desk(ctx, [[W * 0.77, H * 0.765], [W, H * 0.74], [W, H * 0.8], [W * 0.76, H * 0.83]], Math.round(H * 0.06));
      ctx.save();
      ctx.translate(W * 0.8, H * 0.77);
      ctx.rotate(-0.05);
      plate(ctx, 0, 0, W * 0.07, H * 0.025, 2, '#2a2a34', '#50505e', '#101016');
      ctx.restore();
      plate(ctx, W * 0.765, H * 0.17, W * 0.08, H * 0.2, 3, '#5a4a44', '#8a7468', '#241a16');
      gauge(ctx, W * 0.805, H * 0.22, H * 0.032, 0.6);
      gauge(ctx, W * 0.805, H * 0.31, H * 0.028, 0.3);
      grille(ctx, W * 0.765, H * 0.42, W * 0.08, H * 0.12);
      this.lighting(ctx, { x: cx, y: cy, r: R }, [
        ...lights,
        { x: W * 0.18, y: py, r: W * 0.2, rgb: '90,170,255', a: 0.35 },
        { x: W * 0.19, y: L.screenL.y + L.screenL.h / 2, r: W * 0.25, rgb: '150,220,255', a: 0.3 },
        { x: cab.x + cab.w / 2, y: cab.y + cab.h * 0.45, r: W * 0.3, rgb: '255,140,50', a: 0.55 },
        { x: W * 0.2, y: H * 0.04, r: W * 0.22, rgb: '255,170,90', a: 0.35 },
      ]);
      for (const f of [0.075, 0.18, 0.285]) this.porthole(ctx, W * f, py, pr);
      this.monitor(ctx, L.screenL, '#d8f4ff', '#8cc8ec', '140,210,255');
      this.monitor(ctx, L.screenR, '#d8f4ff', '#8cc8ec', '140,210,255');
      this.cabinet(ctx, cab);
    } else {
      pipe(ctx, [[-10, H * 0.075], [W + 10, H * 0.065]], H * 0.018, DUCT);
      pipe(ctx, [[W * 0.05, H * 0.1], [W * 0.05, floorY]], 3, PIPE);
      pipe(ctx, [[W * 0.95, H * 0.1], [W * 0.95, floorY]], 3, PIPE);
      base();
      const ty = L.screenL.y + L.screenL.h + 12;
      this.desk(ctx, [[0, ty + 2], [W, ty + 2], [W, ty + 14], [0, ty + 14]], Math.round(H * 0.06));
      for (let i = 0; i < 6; i++) this.led(0, W * 0.3 + i * 6, ty + 7, ['#7cffb0', '#ffc85a', '#ff5a46'][i % 3], i);
      const pr = Math.round(W * 0.07);
      const py = ty + Math.round(H * 0.14);
      plate(ctx, W * 0.26, py - pr * 0.9, W * 0.48, pr * 1.8, 3, '#6a4a3a', '#9a6e56', '#2e1e16');
      gauge(ctx, W * 0.4, py, pr * 0.65, 0.6);
      gauge(ctx, W * 0.6, py, pr * 0.65, 0.25);
      this.lighting(ctx, { x: cx, y: cy, r: R }, [
        ...lights,
        { x: W / 2, y: L.screenL.y + L.screenL.h / 2, r: W * 0.6, rgb: '150,220,255', a: 0.3 },
        { x: W / 2, y: py, r: W * 0.6, rgb: '255,150,70', a: 0.35 },
      ]);
      this.porthole(ctx, W * 0.13, py, pr);
      this.porthole(ctx, W * 0.87, py, pr);
      this.monitor(ctx, L.screenL, '#d8f4ff', '#8cc8ec', '140,210,255');
      this.monitor(ctx, L.screenR, '#d8f4ff', '#8cc8ec', '140,210,255');
    }
    this.sign(ctx, L.plate);

    // 大圆窗的钢框：三圈渐变环、螺栓、两个卡箍
    const ring = (r0: number, r1: number, a: string, b: string) => {
      const g = ctx.createLinearGradient(cx - r1, cy - r1, cx + r1, cy + r1);
      g.addColorStop(0, a);
      g.addColorStop(1, b);
      ctx.beginPath();
      ctx.arc(cx, cy, r1, 0, Math.PI * 2);
      ctx.arc(cx, cy, r0, 0, Math.PI * 2, true);
      ctx.fillStyle = g;
      ctx.fill();
    };
    ring(R + T * 0.55, R + T + 3, '#d6e0ec', '#3a4250');
    ring(R + T * 0.45, R + T * 0.55, '#1a1c24', '#1a1c24');
    ring(R, R + T * 0.45, '#2e3440', '#b8c6d8');
    ctx.strokeStyle = '#0c0e12';
    ctx.lineWidth = 1;
    for (const r0 of [R, R + T + 3]) {
      ctx.beginPath();
      ctx.arc(cx, cy, r0, 0, Math.PI * 2);
      ctx.stroke();
    }
    const nb = Math.max(16, Math.round((Math.PI * 2 * R) / 14));
    for (let i = 0; i < nb; i++) {
      const a = (i / nb) * Math.PI * 2, rb = R + T * 0.78;
      ctx.fillStyle = '#20242c';
      ctx.beginPath();
      ctx.arc(cx + Math.cos(a) * rb + 0.4, cy + Math.sin(a) * rb + 0.5, 1.6, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#e8eef6';
      ctx.beginPath();
      ctx.arc(cx + Math.cos(a) * rb, cy + Math.sin(a) * rb, 1.3, 0, Math.PI * 2);
      ctx.fill();
    }
    for (const a of [-0.78, Math.PI + 0.35]) {
      ctx.save();
      ctx.translate(cx + Math.cos(a) * (R + T * 0.5), cy + Math.sin(a) * (R + T * 0.5));
      ctx.rotate(a);
      plate(ctx, -T * 0.9, -T * 1.1, T * 1.8, T * 2.2, 2, '#9aa6b6', '#e4ecf4', '#3a4250');
      ctx.fillStyle = '#20242c';
      ctx.fillRect(-1, -T * 0.6, 2, T * 1.2);
      ctx.restore();
    }
    glow(ctx, cx - R * 0.2, cy - R * 0.2, R * 1.5, '90,170,255', 0.22);
    // 挖空玻璃（下面的游戏画布透出来），再盖一层玻璃：边缘暗圈、淡蓝色调、两道弧形反光
    ctx.save();
    ctx.globalCompositeOperation = 'destination-out';
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    const gl = ctx.createRadialGradient(cx, cy, R * 0.7, cx, cy, R);
    gl.addColorStop(0, 'rgba(20,60,140,0.06)');
    gl.addColorStop(0.85, 'rgba(8,24,60,0.22)');
    gl.addColorStop(1, 'rgba(4,10,30,0.7)');
    ctx.fillStyle = gl;
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.26)';
    ctx.lineWidth = Math.max(2, R * 0.035);
    ctx.beginPath();
    ctx.arc(cx, cy, R * 0.9, Math.PI * 1.08, Math.PI * 1.42);
    ctx.stroke();
    ctx.lineWidth = Math.max(1, R * 0.015);
    ctx.strokeStyle = 'rgba(255,255,255,0.18)';
    ctx.beginPath();
    ctx.arc(cx, cy, R * 0.82, Math.PI * 1.12, Math.PI * 1.32);
    ctx.stroke();
  }

  /** 橙光展示柜：发光的架子，上面摆着瓶瓶罐罐的剪影 */
  private cabinet(ctx: Ctx, c: Rect) {
    ctx.save();
    ctx.shadowColor = 'rgba(255,140,50,0.9)';
    ctx.shadowBlur = 14;
    const g = ctx.createLinearGradient(0, c.y, 0, c.y + c.h);
    g.addColorStop(0, '#ffc070');
    g.addColorStop(1, '#c05a24');
    ctx.fillStyle = g;
    ctx.fillRect(c.x, c.y, c.w, c.h);
    ctx.restore();
    for (let k = 1; k <= 4; k++) {
      const y = c.y + (c.h * k) / 4.4;
      ctx.fillStyle = '#5a2810';
      ctx.fillRect(c.x, y, c.w, 2);
      let x = c.x + 3;
      let i = 0;
      while (x < c.x + c.w - 6) {
        const w = 3 + ((k * 7 + i * 5) % 5), h = 6 + ((k * 3 + i * 7) % 9);
        ctx.fillStyle = (i + k) % 3 ? 'rgba(80,30,10,0.75)' : 'rgba(60,90,110,0.7)';
        if ((i + k) % 4 === 0) {
          ctx.beginPath();
          ctx.arc(x + w / 2, y - h / 2, w * 0.7, 0, Math.PI * 2);
          ctx.fill();
        } else ctx.fillRect(x, y - h, w, h);
        x += w + 2 + ((i * 3) % 3);
        i++;
      }
    }
    ctx.fillStyle = 'rgba(255,255,255,0.15)';
    ctx.beginPath();
    ctx.moveTo(c.x, c.y);
    ctx.lineTo(c.x + c.w * 0.4, c.y);
    ctx.lineTo(c.x, c.y + c.h * 0.5);
    ctx.closePath();
    ctx.fill();
    glow(ctx, c.x + c.w / 2, c.y + c.h / 2, c.h * 0.6, '255,140,60', 0.25);
  }

  // ---------------------------------------------------------------- 升级台

  private upgrade(ctx: Ctx) {
    const L = this.L, { W, H } = L, s = L.upScreen;
    const ceilH = Math.round(H * (L.portrait ? 0.05 : 0.07));
    const floorY = Math.round(H * 0.87);
    const benchY = Math.round(H * (L.portrait ? 0.7 : 0.68));
    this.wall(ctx, ceilH, floorY, 3);
    this.ceiling(ctx, ceilH);
    this.floor(ctx, floorY, W / 2, s.y + s.h / 2);
    const lights: Light[] = [];
    if (!L.portrait) {
      // 左：一束竖管、红阀门、横管
      [0.035, 0.075, 0.11].forEach((f, i) => {
        const x = W * f;
        pipe(ctx, [[x, ceilH], [x, benchY]], 4.5 - i, i === 1 ? BRASS : PIPE);
        flange(ctx, x - 6 + i, H * (0.25 + i * 0.1), 12 - i * 2, 3);
      });
      pipe(ctx, [[W * 0.11, H * 0.45], [W * 0.2, H * 0.45], [W * 0.2, H * 0.62]], 3, PIPE);
      this.valve(ctx, W * 0.075, H * 0.36, H * 0.04);
      this.valve(ctx, W * 0.2, H * 0.52, H * 0.035);
      plate(ctx, W * 0.15, H * 0.15, W * 0.13, H * 0.2, 3, '#5a4a44', '#8a7468', '#241a16');
      gauge(ctx, W * 0.185, H * 0.21, H * 0.035, 0.7);
      gauge(ctx, W * 0.245, H * 0.21, H * 0.035, 0.35);
      gauge(ctx, W * 0.215, H * 0.29, H * 0.028, 0.55);
      // 右：工具墙
      const tw = { x: W * 0.73, y: H * 0.15, w: W * 0.24, h: H * 0.46 };
      this.pegboard(ctx, tw);
      for (const f of [0.22, 0.8]) {
        this.lamp(ctx, W * f, ceilH, H * 0.12);
        lights.push({ x: W * f, y: H * 0.25, r: W * 0.3, rgb: '255,170,90', a: 0.55 });
      }
    } else {
      pipe(ctx, [[W * 0.05, ceilH], [W * 0.05, benchY]], 3.5, PIPE);
      pipe(ctx, [[W * 0.95, ceilH], [W * 0.95, benchY]], 3.5, PIPE);
      const tw = { x: W * 0.12, y: s.y + s.h + 18, w: W * 0.76, h: benchY - s.y - s.h - 30 };
      if (tw.h > 20) this.pegboard(ctx, tw);
      lights.push({ x: W / 2, y: benchY - 10, r: W * 0.7, rgb: '255,170,90', a: 0.5 });
    }
    // 大显像管的外壳、两侧副屏的外壳
    plate(ctx, s.x - 8, s.y - 8, s.w + 16, s.h + 16, 4, '#2e2c34', '#5a5866', '#121016');
    const side = (sg: number, ins: number) => {
      const x0 = sg < 0 ? s.x - 14 - ins : s.x + s.w + 14 + ins, x1 = x0 + sg * (W * 0.07 - ins * 2);
      ctx.beginPath();
      ctx.moveTo(x0, s.y + 6 + ins);
      ctx.lineTo(x1, s.y + 16 + ins);
      ctx.lineTo(x1, s.y + s.h - 16 - ins);
      ctx.lineTo(x0, s.y + s.h - 6 - ins);
      ctx.closePath();
    };
    if (!L.portrait)
      for (const sg of [-1, 1]) {
        side(sg, 0);
        ctx.fillStyle = '#26242c';
        ctx.fill();
        ctx.strokeStyle = '#0c0a0e';
        ctx.stroke();
      }
    // 工作台和台上的东西
    this.desk(ctx, [[0, benchY], [W, benchY], [W, benchY + H * 0.06], [0, benchY + H * 0.06]], Math.round(H * 0.09));
    this.propeller(ctx, W * (L.portrait ? 0.27 : 0.32), benchY + H * 0.015, H * 0.045);
    const tbx = W * (L.portrait ? 0.6 : 0.62), tbw = W * (L.portrait ? 0.18 : 0.08);
    plate(ctx, tbx, benchY - H * 0.035, tbw, H * 0.05, 2, '#c84434', '#f07a5e', '#6a1a12');
    ctx.fillStyle = '#2a2020';
    ctx.fillRect(tbx + tbw * 0.25, benchY - H * 0.045, tbw * 0.5, 2.5);
    for (let i = 0; i < 4; i++) this.led(1, W * 0.47 + i * 4, benchY + H * 0.08, ['#7cffb0', '#ffc85a', '#7cffb0', '#ff5a46'][i], i);
    this.lighting(ctx, { x: W / 2, y: s.y + s.h / 2, r: s.w * 0.6 }, [...lights, { x: s.x + s.w / 2, y: s.y + s.h / 2, r: s.w * 0.9, rgb: '80,230,150', a: 0.25 }]);
    if (!L.portrait) for (const f of [0.22, 0.8]) this.lampGlow(ctx, W * f, ceilH + H * 0.12);
    else this.lamp(ctx, W / 2, s.y + s.h + 6, 6);
    // 自发光：显像管、副屏
    ctx.save();
    ctx.shadowColor = 'rgba(80,240,160,0.8)';
    ctx.shadowBlur = 14;
    rr(ctx, s.x, s.y, s.w, s.h, 6);
    const g = ctx.createRadialGradient(s.x + s.w / 2, s.y + s.h / 2, 0, s.x + s.w / 2, s.y + s.h / 2, s.w * 0.6);
    g.addColorStop(0, '#1c5a40');
    g.addColorStop(1, '#0a2a1e');
    ctx.fillStyle = g;
    ctx.fill();
    ctx.restore();
    ctx.fillStyle = 'rgba(0,0,0,0.18)';
    for (let y = s.y; y < s.y + s.h; y += 2) ctx.fillRect(s.x, y, s.w, 1);
    if (!L.portrait)
      for (const sg of [-1, 1]) {
        ctx.save();
        ctx.shadowColor = 'rgba(80,220,220,0.7)';
        ctx.shadowBlur = 8;
        side(sg, 3);
        const sg2 = ctx.createLinearGradient(0, s.y, 0, s.y + s.h);
        sg2.addColorStop(0, '#5ad0d0');
        sg2.addColorStop(1, '#1a6a78');
        ctx.fillStyle = sg2;
        ctx.fill();
        ctx.restore();
        ctx.strokeStyle = 'rgba(220,255,255,0.45)';
        ctx.lineWidth = 0.8;
        const xa = sg < 0 ? s.x - 14 - W * 0.07 + 6 : s.x + s.w + 20;
        for (let k = 0; k < 5; k++) {
          const y = s.y + 24 + k * ((s.h - 48) / 5);
          ctx.beginPath();
          ctx.moveTo(xa, y);
          ctx.lineTo(xa + (W * 0.07 - 12) * (0.4 + ((k * 37) % 50) / 100), y);
          ctx.stroke();
        }
      }
    this.sign(ctx, L.plate);
  }

  private pegboard(ctx: Ctx, tw: Rect) {
    plate(ctx, tw.x, tw.y, tw.w, tw.h, 3, '#6a5040', '#9a7a62', '#2a1a12');
    ctx.fillStyle = 'rgba(20,10,6,0.6)';
    for (let y = tw.y + 6; y < tw.y + tw.h - 4; y += 6) for (let x = tw.x + 6; x < tw.x + tw.w - 4; x += 6) ctx.fillRect(x, y, 1.2, 1.2);
    const n = Math.max(3, Math.floor(tw.w / 16));
    for (let i = 0; i < n; i++) {
      const x = tw.x + tw.w * ((i + 0.6) / (n + 0.2)), y = tw.y + 8 + (i % 2) * 5, h = tw.h * 0.55;
      ctx.save();
      ctx.shadowColor = 'rgba(0,0,0,0.5)';
      ctx.shadowOffsetX = 1.5;
      ctx.shadowOffsetY = 1.5;
      switch (i % 4) {
        case 0: // 扳手
          ctx.fillStyle = '#c4ccd6';
          ctx.fillRect(x - 1.5, y + 4, 3, h - 4);
          ctx.beginPath();
          ctx.arc(x, y + 3, 4, 0, Math.PI * 2);
          ctx.fill();
          ctx.fillStyle = '#6a5040';
          ctx.fillRect(x - 1.2, y - 1, 2.4, 4);
          break;
        case 1: // 锤子
          ctx.fillStyle = '#a8704a';
          ctx.fillRect(x - 1.5, y + 2, 3, h);
          ctx.fillStyle = '#8a96a6';
          ctx.fillRect(x - 6, y - 2, 12, 5);
          break;
        case 2: // 螺丝刀
          ctx.fillStyle = '#d04030';
          ctx.fillRect(x - 2.5, y, 5, h * 0.4);
          ctx.fillStyle = '#d0dae6';
          ctx.fillRect(x - 0.7, y + h * 0.4, 1.4, h * 0.6);
          break;
        default: // 钳子
          ctx.strokeStyle = '#3a6ab0';
          ctx.lineWidth = 2.5;
          ctx.beginPath();
          ctx.moveTo(x - 3, y + h);
          ctx.lineTo(x, y + h * 0.4);
          ctx.lineTo(x + 3, y + h);
          ctx.stroke();
          ctx.fillStyle = '#9aa6b6';
          ctx.fillRect(x - 1.5, y, 3, h * 0.42);
      }
      ctx.restore();
    }
  }

  private valve(ctx: Ctx, x: number, y: number, r: number) {
    ctx.strokeStyle = '#140808';
    ctx.lineWidth = r * 0.45;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.strokeStyle = COL.red;
    ctx.lineWidth = r * 0.3;
    ctx.stroke();
    ctx.strokeStyle = '#ff8a70';
    ctx.lineWidth = r * 0.1;
    ctx.beginPath();
    ctx.arc(x, y, r, Math.PI * 1.1, Math.PI * 1.6);
    ctx.stroke();
    ctx.strokeStyle = '#7a1a10';
    ctx.lineWidth = r * 0.15;
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * Math.PI;
      ctx.beginPath();
      ctx.moveTo(x - Math.cos(a) * r, y - Math.sin(a) * r);
      ctx.lineTo(x + Math.cos(a) * r, y + Math.sin(a) * r);
      ctx.stroke();
    }
    ctx.fillStyle = COL.steelLt;
    ctx.beginPath();
    ctx.arc(x, y, r * 0.2, 0, Math.PI * 2);
    ctx.fill();
  }

  /** 吊灯：吊线 + 灯罩（光照前画） */
  private lamp(ctx: Ctx, x: number, y0: number, len: number) {
    ctx.strokeStyle = '#100c0c';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, y0);
    ctx.lineTo(x, y0 + len);
    ctx.stroke();
    const y = y0 + len;
    ctx.beginPath();
    ctx.moveTo(x - 4, y);
    ctx.lineTo(x + 4, y);
    ctx.lineTo(x + 11, y + 8);
    ctx.lineTo(x - 11, y + 8);
    ctx.closePath();
    const g = ctx.createLinearGradient(x - 11, 0, x + 11, 0);
    g.addColorStop(0, '#2a2a30');
    g.addColorStop(0.4, '#6a6a76');
    g.addColorStop(1, '#1a1a1e');
    ctx.fillStyle = g;
    ctx.fill();
    ctx.strokeStyle = '#0c0a0c';
    ctx.stroke();
  }

  /** 吊灯亮着的灯口和光锥（光照后画） */
  private lampGlow(ctx: Ctx, x: number, y: number) {
    ctx.save();
    ctx.shadowColor = 'rgba(255,200,120,1)';
    ctx.shadowBlur = 10;
    ctx.fillStyle = '#fff0c8';
    ctx.fillRect(x - 8, y + 8, 16, 2);
    ctx.restore();
    ctx.save();
    ctx.globalCompositeOperation = 'screen';
    const c = ctx.createLinearGradient(0, y + 8, 0, y + 100);
    c.addColorStop(0, 'rgba(255,190,110,0.32)');
    c.addColorStop(1, 'rgba(255,190,110,0)');
    ctx.fillStyle = c;
    ctx.beginPath();
    ctx.moveTo(x - 9, y + 9);
    ctx.lineTo(x + 9, y + 9);
    ctx.lineTo(x + 50, y + 100);
    ctx.lineTo(x - 50, y + 100);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  private propeller(ctx: Ctx, x: number, y: number, r: number) {
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(1, 0.45);
    for (let i = 0; i < 3; i++) {
      ctx.rotate((Math.PI * 2) / 3);
      const g = ctx.createLinearGradient(0, -r, r * 0.4, 0);
      g.addColorStop(0, COL.brassLt);
      g.addColorStop(1, COL.brassDk);
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.ellipse(0, -r * 0.55, r * 0.28, r * 0.55, 0.3, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#2a1a0a';
      ctx.lineWidth = 0.8;
      ctx.stroke();
    }
    ctx.fillStyle = '#5a4026';
    ctx.beginPath();
    ctx.arc(0, 0, r * 0.18, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  // ---------------------------------------------------------------- 机库台

  private hangar(ctx: Ctx, fctx: Ctx) {
    const L = this.L, { W, H } = L, s = L.hgScreen;
    const ceilH = Math.round(H * (L.portrait ? 0.05 : 0.07));
    const floorY = Math.round(H * (L.portrait ? 0.82 : 0.8));
    this.wall(ctx, ceilH, floorY, 6);
    this.ceiling(ctx, ceilH);
    this.floor(ctx, floorY, W / 2, s.y + s.h / 2);
    const T = 9;
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.6)';
    ctx.shadowBlur = 12;
    ctx.shadowOffsetY = 4;
    plate(ctx, s.x - T, s.y - T, s.w + T * 2, s.h + T * 2, 8, '#8a96a6', '#dce6f0', '#363c48');
    ctx.restore();
    plate(ctx, s.x - T, s.y - T, s.w + T * 2, s.h + T * 2, 8, '#8a96a6', '#dce6f0', '#363c48');
    for (let x = s.x; x <= s.x + s.w; x += 14) {
      rivet(ctx, x, s.y - T / 2, 1.1);
      rivet(ctx, x, s.y + s.h + T / 2, 1.1);
    }
    for (let y = s.y + 7; y < s.y + s.h; y += 14) {
      rivet(ctx, s.x - T / 2, y, 1.1);
      rivet(ctx, s.x + s.w + T / 2, y, 1.1);
    }
    const bar = { x: s.x + s.w * 0.3, y: s.y + s.h + T + 4, w: s.w * 0.4, h: H * 0.04 };
    plate(ctx, bar.x, bar.y, bar.w, bar.h, 2, '#3a3a44', '#6a6a78', '#16161c');
    for (let i = 0; i < 8; i++) this.led(2, bar.x + 6 + i * ((bar.w - 12) / 8), bar.y + bar.h / 2 - 1, ['#7cffb0', '#ffc85a', '#78c8ff'][i % 3], i);
    this.lighting(ctx, { x: s.x + s.w / 2, y: s.y + s.h / 2, r: s.w * 0.5 }, [
      { x: s.x + s.w / 2, y: s.y + s.h / 2, r: Math.max(s.w, s.h) * 0.95, rgb: '80,160,255', a: 0.55 },
      { x: W / 2, y: H, r: W * 0.7, rgb: '70,150,255', a: 0.4 },
      { x: W * 0.06, y: H * 0.05, r: W * 0.25, rgb: '255,170,90', a: 0.3 },
      { x: W * 0.94, y: H * 0.05, r: W * 0.25, rgb: '255,170,90', a: 0.3 },
    ]);
    // 窗外：水下机库（自发光）
    ctx.save();
    rr(ctx, s.x, s.y, s.w, s.h, 4);
    ctx.clip();
    const g = ctx.createLinearGradient(0, s.y, 0, s.y + s.h);
    g.addColorStop(0, '#5ab4f4');
    g.addColorStop(0.55, '#2a6ac8');
    g.addColorStop(1, '#0c2a6a');
    ctx.fillStyle = g;
    ctx.fillRect(s.x, s.y, s.w, s.h);
    ctx.globalCompositeOperation = 'screen';
    for (let i = 0; i < 6; i++) {
      const x = s.x + s.w * (0.1 + i * 0.17);
      const rg = ctx.createLinearGradient(0, s.y, 0, s.y + s.h * 0.8);
      rg.addColorStop(0, 'rgba(200,240,255,0.28)');
      rg.addColorStop(1, 'rgba(200,240,255,0)');
      ctx.fillStyle = rg;
      ctx.beginPath();
      ctx.moveTo(x, s.y);
      ctx.lineTo(x + s.w * 0.05, s.y);
      ctx.lineTo(x + s.w * 0.16, s.y + s.h * 0.8);
      ctx.lineTo(x + s.w * 0.06, s.y + s.h * 0.8);
      ctx.closePath();
      ctx.fill();
    }
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = '#183262';
    ctx.fillRect(s.x, s.y + s.h * 0.04, s.w, 3);
    ctx.fillStyle = '#0a2050';
    ctx.fillRect(s.x, s.y + s.h * 0.9, s.w, s.h * 0.1);
    ctx.fillStyle = 'rgba(120,180,255,0.25)';
    for (let x = s.x; x < s.x + s.w; x += 10) ctx.fillRect(x, s.y + s.h * 0.9, 1, s.h * 0.1);
    const subs: [number, number, number][] = L.portrait
      ? [0, 1, 2].map((i) => [s.x + s.w * 0.28, s.y + (i + 0.45) * (s.h / 3), s.w * 0.42])
      : [0, 1, 2].map((i) => [s.x + ((i + 0.5) / 3) * s.w, s.y + s.h * 0.4, s.w * 0.22]);
    for (const [x, y, len] of subs) this.dockedSub(ctx, x, y, len, s.y + s.h * 0.04);
    ctx.fillStyle = 'rgba(220,245,255,0.7)';
    for (let i = 0; i < 40; i++) {
      const bx = s.x + (((i * 97) % 1000) / 1000) * s.w, by = s.y + (((i * 61) % 1000) / 1000) * s.h * 0.9;
      ctx.beginPath();
      ctx.arc(bx, by, 0.5 + (i % 3) * 0.4, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillStyle = 'rgba(255,255,255,0.08)';
    ctx.beginPath();
    ctx.moveTo(s.x, s.y);
    ctx.lineTo(s.x + s.w * 0.25, s.y);
    ctx.lineTo(s.x + s.w * 0.1, s.y + s.h);
    ctx.lineTo(s.x, s.y + s.h);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
    glow(ctx, s.x + s.w / 2, s.y + s.h / 2, s.w * 0.55, '90,170,255', 0.12);
    this.sign(ctx, L.plate);
    // 前景：栏杆（平移得快一点），被窗光染蓝
    const fw = Math.ceil(W * FG_K);
    const ry = Math.round(H * (L.portrait ? 0.87 : 0.85));
    pipe(fctx, [[-4, ry], [fw + 4, ry]], 2.6, ['#7c8a9c', '#c8d6e6', '#2a303c']);
    pipe(fctx, [[-4, ry + H * 0.06], [fw + 4, ry + H * 0.06]], 2, ['#7c8a9c', '#c8d6e6', '#2a303c']);
    for (let i = 0; i < 6; i++) pipe(fctx, [[(i + 0.5) * (fw / 6), ry - 3], [(i + 0.5) * (fw / 6), H + 6]], 2.6, ['#7c8a9c', '#c8d6e6', '#2a303c']);
    fctx.save();
    fctx.globalCompositeOperation = 'source-atop';
    const fg = fctx.createLinearGradient(0, ry - 10, 0, H);
    fg.addColorStop(0, 'rgba(90,160,255,0.35)');
    fg.addColorStop(1, 'rgba(10,10,20,0.4)');
    fctx.fillStyle = fg;
    fctx.fillRect(0, 0, fw, H);
    fctx.restore();
  }

  /** 吊在机库里的潜艇（剪影 + 顶上的蓝色轮廓光 + 舷窗 + 发光的小锁） */
  private dockedSub(ctx: Ctx, x: number, y: number, len: number, top: number) {
    const h = len * 0.3;
    ctx.strokeStyle = '#2a4a80';
    ctx.lineWidth = 1.2;
    for (const dx of [-0.22, 0.22]) {
      ctx.beginPath();
      ctx.moveTo(x + dx * len, top);
      ctx.lineTo(x + dx * len, y - h * 0.8);
      ctx.stroke();
    }
    ctx.fillStyle = '#16305c';
    ctx.fillRect(x - len * 0.35, y + h * 0.85, len * 0.7, 2.5);
    ctx.fillRect(x - len * 0.3, y + h * 0.5, 2, h * 0.4);
    ctx.fillRect(x + len * 0.3 - 2, y + h * 0.5, 2, h * 0.4);
    const body = () => {
      ctx.beginPath();
      ctx.ellipse(x, y, len / 2, h, 0, 0, Math.PI * 2);
      ctx.rect(x - len * 0.08, y - h * 1.55, len * 0.18, h * 0.8);
      ctx.moveTo(x - len * 0.45, y);
      ctx.lineTo(x - len * 0.62, y - h * 0.9);
      ctx.lineTo(x - len * 0.6, y + h * 0.9);
      ctx.closePath();
    };
    body();
    ctx.fillStyle = '#0e2452';
    ctx.fill();
    ctx.save();
    body();
    ctx.clip();
    const rg = ctx.createLinearGradient(0, y - h * 1.5, 0, y + h);
    rg.addColorStop(0, 'rgba(140,200,255,0.45)');
    rg.addColorStop(0.35, 'rgba(140,200,255,0)');
    ctx.fillStyle = rg;
    ctx.fillRect(x - len, y - h * 2, len * 2, h * 3);
    ctx.restore();
    ctx.fillStyle = 'rgba(120,180,240,0.4)';
    for (const dx of [-0.15, 0.05, 0.25]) {
      ctx.beginPath();
      ctx.arc(x + dx * len, y - h * 0.05, Math.max(1, h * 0.12), 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.save();
    ctx.shadowColor = 'rgba(255,190,80,0.9)';
    ctx.shadowBlur = 6;
    ctx.fillStyle = '#ffc45a';
    const ls = Math.max(3, h * 0.35);
    ctx.fillRect(x - ls / 2, y - ls * 0.2, ls, ls * 0.8);
    ctx.strokeStyle = '#ffc45a';
    ctx.lineWidth = Math.max(1, ls * 0.18);
    ctx.beginPath();
    ctx.arc(x, y - ls * 0.2, ls * 0.32, Math.PI, 0);
    ctx.stroke();
    ctx.restore();
  }

  // ---------------------------------------------------------------- 对外

  /** 第 st 台此刻在屏幕上的 x 偏移（画布像素）。pan：以「台」为单位的朝向 */
  stationX(st: number, pan: number) {
    const W = this.L.W;
    let d = (((st - pan) % N_ST) + N_ST) % N_ST;
    if (d > N_ST - 1.5) d -= N_ST;
    return d * W;
  }

  /** 主圆窗在屏幕上的圆心和半径（CSS 像素，相对舰桥画布左上角） */
  window(pan: number) {
    const { win } = this.L;
    return { x: (this.stationX(0, pan) + win.cx) * this.a, y: win.cy * this.a, r: win.R * this.a };
  }

  windowVisible(pan: number) {
    const w = this.window(pan);
    return w.x + w.r > 0 && w.x - w.r < this.vw;
  }

  /** 每帧：按朝向把操作台拼到画布上，再画闪烁的小灯和显像管扫描线 */
  draw(pan: number, t: number) {
    const ctx = this.ctx, { W, H } = this.L;
    ctx.clearRect(0, 0, W, H);
    for (let s = 0; s < N_ST; s++) {
      const x = Math.round(this.stationX(s, pan));
      if (x > -W && x < W) ctx.drawImage(this.st[s], x, 0);
    }
    for (let s = 0; s < N_ST; s++) {
      const x = Math.round(this.stationX(s, pan) * FG_K);
      if (x > -W * FG_K && x < W) ctx.drawImage(this.fg[s], x, 0);
    }
    for (const l of this.leds) {
      const x = Math.round(this.stationX(l.st, pan) + l.x);
      if (x < -4 || x > W + 4) continue;
      const on = ((t / l.period + l.phase) % 1) < 0.55;
      ctx.fillStyle = l.c;
      if (on) {
        ctx.globalAlpha = 0.3;
        ctx.fillRect(x - 1, Math.round(l.y) - 1, 4, 3.5);
      }
      ctx.globalAlpha = on ? 1 : 0.25;
      ctx.fillRect(x, Math.round(l.y), 2, 1.5);
      ctx.globalAlpha = 1;
    }
    const s = this.L.upScreen, sx = this.stationX(1, pan) + s.x;
    if (sx < W && sx + s.w > 0) {
      const y = s.y + 3 + ((t * 0.35) % 1) * (s.h - 6);
      ctx.fillStyle = 'rgba(140,255,190,0.16)';
      ctx.fillRect(Math.round(sx) + 3, Math.round(y), s.w - 6, 2);
    }
  }
}
