// 水色、远景雾和焦散光。
// 雾的颜色按视线仰角变化：往上看偏亮青（水面方向），平视是中间蓝，往下看是深色。
// 区域因子 region（0 青绿，1 紫雾）让整片水的颜色跟着潜艇所在的区域慢慢过渡。

import { Camera } from './camera';
import { Renderer } from './renderer';
import { SURFACE_H } from './world';
import { fbmMap } from './noise';
import { hex, mixRGB, RGB } from './color';

const TEAL = { up: hex('#8EF4F3'), mid: hex('#3F8FA2'), low: hex('#2B4B5A'), deep: hex('#1A2230') };
const VIOLET = { up: hex('#BECFDF'), mid: hex('#768597'), low: hex('#423D4B'), deep: hex('#261D2A') };

const CAUSTIC = 128;

export class Water {
  region = 0;
  /** 远景雾强度 0..1 */
  fogAmount = 0;
  fogStart = 70;
  fogDist = 340;
  up: RGB = TEAL.up;
  mid: RGB = TEAL.mid;
  low: RGB = TEAL.low;
  deep: RGB = TEAL.deep;

  // 每行的雾色
  rowR = new Float32Array(0);
  rowG = new Float32Array(0);
  rowB = new Float32Array(0);
  rowPacked = new Uint32Array(0);
  /** 每行视线的仰角（弧度，正为向上） */
  rowElev = new Float32Array(0);
  // 深度 → 雾浓度 查找表（每 2 个单位一格）
  fogLut = new Float32Array(2048);

  private caustic = new Float32Array(CAUSTIC * CAUSTIC);
  private waveA = new Float32Array(CAUSTIC * CAUSTIC);
  private waveB = new Float32Array(CAUSTIC * CAUSTIC);
  private causticB = new Float32Array(CAUSTIC * CAUSTIC);
  time = 0;

  constructor() {
    // 焦散：噪声的等值线做成网状亮纹，两层朝不同方向流动
    const a = fbmMap(CAUSTIC, 8, 2, 501);
    const b = fbmMap(CAUSTIC, 8, 2, 733);
    for (let i = 0; i < a.length; i++) {
      const la = Math.abs(((a[i] * 7) % 1) - 0.5) * 2;
      const lb = Math.abs(((b[i] * 6) % 1) - 0.5) * 2;
      this.caustic[i] = Math.pow(Math.max(0, 1 - la * 4), 2);
      this.causticB[i] = Math.pow(Math.max(0, 1 - lb * 4), 2);
      // 水面波纹：更宽、更柔和的亮线
      this.waveA[i] = Math.pow(Math.max(0, 1 - la * 2.2), 1.5);
      this.waveB[i] = Math.pow(Math.max(0, 1 - lb * 2.2), 1.5);
    }
  }

  update(cam: Camera, H: number, region: number, time: number) {
    this.region = region;
    this.time = time;
    this.up = mixRGB(TEAL.up, VIOLET.up, region);
    this.mid = mixRGB(TEAL.mid, VIOLET.mid, region);
    this.low = mixRGB(TEAL.low, VIOLET.low, region);
    this.deep = mixRGB(TEAL.deep, VIOLET.deep, region);
    if (this.rowR.length !== H) {
      this.rowR = new Float32Array(H);
      this.rowG = new Float32Array(H);
      this.rowB = new Float32Array(H);
      this.rowPacked = new Uint32Array(H);
      this.rowElev = new Float32Array(H);
    }
    // 每行视线仰角：针孔焦距 f = zoom·dist（透视强度低时视线近似平行）
    const f = cam.zoom * cam.dist;
    for (let y = 0; y < H; y++) {
      const e = Math.atan((cam.cy - y) / f) * cam.persp - cam.pitch;
      this.rowElev[y] = e;
      let c: RGB;
      if (e > 0) {
        const t = Math.min(1, e / 0.55);
        c = mixRGB(this.mid, this.up, t * t * (3 - 2 * t));
      } else {
        const t = Math.min(1, -e / 0.5);
        c = mixRGB(this.mid, this.low, Math.sqrt(t));
        if (-e > 0.5) c = mixRGB(c, this.deep, Math.min(1, (-e - 0.5) / 0.8));
      }
      this.rowR[y] = c[0];
      this.rowG[y] = c[1];
      this.rowB[y] = c[2];
      this.rowPacked[y] = (0xff000000 | (Math.round(c[2]) << 16) | (Math.round(c[1]) << 8) | Math.round(c[0])) >>> 0;
    }
    const lut = this.fogLut;
    const amt = this.fogAmount;
    for (let i = 0; i < lut.length; i++) {
      const d = i * 2 - this.fogStart;
      lut[i] = d <= 0 ? 0 : amt * (1 - Math.exp(-d / this.fogDist));
    }
  }

  /** 给一个打包颜色加雾（按深度和屏幕行） */
  fog(c: number, depth: number, sy: number): number {
    let i = (depth * 0.5) | 0;
    if (i < 0) i = 0;
    else if (i > 2047) i = 2047;
    const f = this.fogLut[i];
    if (f <= 0.002) return c;
    let y = sy | 0;
    if (y < 0) y = 0;
    else if (y >= this.rowR.length) y = this.rowR.length - 1;
    const r = c & 255, g = (c >> 8) & 255, b = (c >> 16) & 255;
    const R = r + (this.rowR[y] - r) * f;
    const G = g + (this.rowG[y] - g) * f;
    const B = b + (this.rowB[y] - b) * f;
    return (0xff000000 | ((B | 0) << 16) | ((G | 0) << 8) | (R | 0)) >>> 0;
  }

  /**
   * 头顶的水面：尾随视角往上看时，地形没盖住的像素和 h = SURFACE_H 的水平面求交，
   * 画会动的亮纹（和画云层用同一套投影），越远越融进雾里。
   */
  renderSurface(r: Renderer, cam: Camera) {
    if (cam.eyeHeight() >= SURFACE_H - 2) return;
    const { W, H, buf, z } = r;
    const dh = SURFACE_H - cam.h;
    const t = this.time;
    const bright = mixRGB(this.up, [255, 255, 250], 0.55);
    for (let y = 0; y < H; y++) {
      if (this.rowElev[y] < -0.02) continue;
      const v = cam.rowToPlane(y + 0.5, dh);
      if (Number.isNaN(v)) continue;
      const depth = cam.dist + v * cam.cosP - dh * cam.sinP;
      if (depth < cam.near) continue;
      const k = cam.zoom * (1 - cam.persp + (cam.persp * cam.dist) / depth);
      let fi = (depth * 0.5) | 0;
      if (fi > 2047) fi = 2047;
      // 水面比海底雾得慢一点（光从上面来）
      const f = Math.min(1, this.fogLut[fi] * 1.05);
      const rr = this.rowR[y], rg = this.rowG[y], rb = this.rowB[y];
      // 正上方更亮（斯涅尔窗）
      const win = Math.min(1, Math.max(0, this.rowElev[y] / 0.9));
      const baseR = this.up[0] + (bright[0] - this.up[0]) * win * 0.6;
      const baseG = this.up[1] + (bright[1] - this.up[1]) * win * 0.6;
      const baseB = this.up[2] + (bright[2] - this.up[2]) * win * 0.6;
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        if (z[i] !== Infinity) continue;
        const u = (x + 0.5 - cam.cx) / k;
        const wx = cam.x + u * cam.cosH + v * cam.sinH;
        const wy = cam.y - u * cam.sinH + v * cam.cosH;
        // 双线性取样，近处的波纹是平滑的曲线而不是方块
        const w = Math.min(1, bilin(this.waveA, wx * 0.35 + t * 2.4, wy * 0.35 + t * 1.2) + bilin(this.waveB, wx * 0.35 - t * 1.6, wy * 0.35 + t * 2));
        let R = baseR * (0.82 + 0.18 * w) + (bright[0] - baseR) * w * 0.7;
        let G = baseG * (0.82 + 0.18 * w) + (bright[1] - baseG) * w * 0.7;
        let B = baseB * (0.82 + 0.18 * w) + (bright[2] - baseB) * w * 0.7;
        R += (rr - R) * f;
        G += (rg - G) * f;
        B += (rb - B) * f;
        buf[i] = (0xff000000 | ((B > 255 ? 255 : B | 0) << 16) | ((G > 255 ? 255 : G | 0) << 8) | (R > 255 ? 255 : R | 0)) >>> 0;
        z[i] = depth + 1e5; // 水面在所有东西后面
      }
    }
  }

  /** 光柱：从上方斜照下来的亮带（屏幕空间，随镜头朝向移动），越远越明显 */
  private shaft = new Float32Array(1024);
  private shaftReady = false;
  lightShafts(r: Renderer, cam: Camera, strength: number) {
    if (strength <= 0.01) return;
    if (!this.shaftReady) {
      for (let i = 0; i < 1024; i++) {
        const a = (i / 1024) * Math.PI * 2;
        const v = Math.sin(a * 7) * 0.5 + Math.sin(a * 13 + 1.3) * 0.3 + Math.sin(a * 29 + 0.4) * 0.2;
        this.shaft[i] = Math.max(0, v - 0.25) / 0.75;
      }
      this.shaftReady = true;
    }
    const { W, H, buf, z } = r;
    const t = this.time;
    const col = mixRGB(this.up, [255, 255, 240], 0.3);
    const head = (cam.heading / (Math.PI * 2)) * 1024 * 2;
    for (let y = 0; y < H; y++) {
      const fy = y / H;
      const vfade = Math.pow(1 - fy, 1.3) * strength;
      if (vfade < 0.01) continue;
      const slant = y * 0.9;
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        const d = z[i];
        const dw = d === Infinity || d > 1e4 ? 1 : Math.min(1, Math.max(0, (d - 60) / 260));
        if (dw <= 0) continue;
        const sIdx = ((x * 2.2 + slant - head + t * 6) | 0) & 1023;
        const sv = this.shaft[sIdx];
        if (sv <= 0) continue;
        const a = sv * vfade * dw * 0.38;
        const c = buf[i];
        const R = (c & 255) + (col[0] - (c & 255)) * a;
        const G = ((c >> 8) & 255) + (col[1] - ((c >> 8) & 255)) * a;
        const B = ((c >> 16) & 255) + (col[2] - ((c >> 16) & 255)) * a;
        buf[i] = (0xff000000 | ((B | 0) << 16) | ((G | 0) << 8) | (R | 0)) >>> 0;
      }
    }
  }

  /** 世界坐标处的焦散亮度 0..1 */
  causticAt(wx: number, wy: number): number {
    // 双线性取样：光纹平滑地流动，不会一格一格地跳
    const t = this.time;
    const sc = 1.4; // 世界单位 → 纹理
    const v = bilin(this.caustic, wx * sc + t * 5, wy * sc + t * 2.5) + bilin(this.causticB, wx * sc - t * 3.5, wy * sc + t * 4);
    return v > 1 ? 1 : v;
  }

}

function bilin(tex: Float32Array, x: number, y: number): number {
  const N = CAUSTIC - 1;
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const tx = x - x0, ty = y - y0;
  const a = tex[(y0 & N) * CAUSTIC + (x0 & N)], b = tex[(y0 & N) * CAUSTIC + ((x0 + 1) & N)];
  const c = tex[((y0 + 1) & N) * CAUSTIC + (x0 & N)], d = tex[((y0 + 1) & N) * CAUSTIC + ((x0 + 1) & N)];
  return a + (b - a) * tx + (c - a) * ty + (a - b - c + d) * tx * ty;
}
