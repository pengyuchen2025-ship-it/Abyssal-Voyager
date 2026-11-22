// 开始界面：潜艇舱室的一张像素画（AI 生成后处理过：去掉了图上原来的标题和按钮、圆窗挖空）。
// 运行时按屏幕大小把它缩到和游戏画面完全一样的像素网格（同样的画布尺寸和放大倍数），
// 再做和游戏画面一样的 4×4 有序抖动量化，所以背景和窗里的游戏是同一种像素颗粒。
// 圆窗是透明的，下面的游戏画布透出来（main.ts 把镜头对准圆窗，潜艇就在窗里）。

import bgUrl from './assets/menu-bg.webp?inline';

/** 原图（1280×760）上的位置 */
export const ART = {
  W: 1280, H: 760,
  win: { cx: 822.5, cy: 316, r: 248 },
  /** 左边第一台电脑的屏幕（操作指导显示在这里） */
  monitor: { x: 180, y: 388, w: 99, h: 69 },
  title: { x: 58, y: 172, w: 230 },
  buttons: { x: 60, y: 584, w: 288 },
};

const BAYER4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
const LEVELS = 22;

export class Menu {
  private img = new Image();
  private ready = false;
  private ctx: CanvasRenderingContext2D;
  private key = '';
  /** 原图 → 屏幕（CSS 像素）：x' = ox + x·s */
  s = 1;
  ox = 0;
  oy = 0;

  constructor(public cv: HTMLCanvasElement, private onReady: () => void) {
    this.ctx = cv.getContext('2d')!;
    this.img.onload = () => {
      this.ready = true;
      this.key = '';
      this.onReady();
    };
    this.img.src = bgUrl;
  }

  /** 按游戏画布的位置和像素大小重画背景（尺寸没变就什么都不做） */
  layout(vw: number, vh: number, fbW: number, fbH: number, scale: number, left: number, top: number) {
    // 铺满屏幕（cover），左右多出来时以圆窗和左边桌子之间为中心
    const s = Math.max(vw / ART.W, vh / ART.H);
    this.s = s;
    this.ox = (vw - ART.W * s) * 0.55;
    this.oy = (vh - ART.H * s) * 0.5;
    const key = [vw, vh, fbW, fbH, scale, left, top, this.ready].join();
    if (key === this.key) return;
    this.key = key;
    const cv = this.cv;
    cv.width = fbW;
    cv.height = fbH;
    cv.style.width = fbW * scale + 'px';
    cv.style.height = fbH * scale + 'px';
    cv.style.left = left + 'px';
    cv.style.top = top + 'px';
    if (!this.ready) return;
    const ctx = this.ctx;
    ctx.clearRect(0, 0, fbW, fbH);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    // 屏幕坐标 → 帧缓冲坐标：(x − left) / scale
    ctx.drawImage(this.img, (this.ox - left) / scale, (this.oy - top) / scale, (ART.W * s) / scale, (ART.H * s) / scale);
    // 和游戏画面一样的有序抖动量化；圆窗边缘透明度二值化，保持像素硬边
    const id = ctx.getImageData(0, 0, fbW, fbH), d = id.data;
    const step = 255 / (LEVELS - 1);
    for (let y = 0; y < fbH; y++)
      for (let x = 0; x < fbW; x++) {
        const i = (y * fbW + x) * 4;
        const off = (BAYER4[((y & 3) << 2) | (x & 3)] / 16 - 0.5) * step;
        for (let c = 0; c < 3; c++) {
          const v = Math.round((d[i + c] + off) / step) * step;
          d[i + c] = v < 0 ? 0 : v > 255 ? 255 : v;
        }
        d[i + 3] = d[i + 3] > 128 ? 255 : 0;
      }
    ctx.putImageData(id, 0, 0);
  }

  /** 原图坐标 → 屏幕坐标 */
  map(x: number, y: number) {
    return { x: this.ox + x * this.s, y: this.oy + y * this.s };
  }

  /** 圆窗在屏幕上的圆心和半径 */
  window() {
    const c = this.map(ART.win.cx, ART.win.cy);
    return { x: c.x, y: c.y, r: ART.win.r * this.s };
  }

  /** 操作指导那台电脑屏幕在屏幕上的位置 */
  monitor() {
    const m = ART.monitor, p = this.map(m.x, m.y);
    return { x: p.x, y: p.y, w: m.w * this.s, h: m.h * this.s };
  }
}
