// 镜头：尾随和座舱用同一套投影（最早还有俯视，投影本身仍然支持）。
// 参数：俯仰角 pitch（90° = 正俯视）、透视强度 persp（0 = 正交，1 = 针孔透视）、缩放 zoom、
// 朝向 heading、镜头到支点的距离 dist。切换视角时只是在两组参数之间插值。
//
// 世界坐标：x 向东，y 向北，h 向上。heading = 0 表示镜头朝北。
// 设点相对支点的横向 u、前向 v、高差 dh：
//   depth = dist + v·cosP − dh·sinP            （真实俯仰角，决定远近）
//   k     = zoom · ((1 − s) + s · dist / depth)
//   屏幕 x = cx + u·k，屏幕 y = cy − (v·ground + dh·lift)·k
// ground / lift 是地面压缩和高度抬升：尾随时等于 sinP / cosP（真实透视），
// 俯视时是斜投影（ground = 1，每升高一层向上偏移约 1 像素），切换时一起插值。

export const WORLD = 512; // 地图边长（循环）

export interface Projected {
  x: number;
  y: number;
  depth: number;
  k: number;
}

export class Camera {
  // 支点（镜头看向的点，通常就是潜艇）
  x = 0;
  y = 0;
  h = 0;
  heading = 0;
  pitch = (68 * Math.PI) / 180;
  persp = 0.15;
  ground = 1;
  lift = 0.66;
  zoom = 1;
  dist = 300;
  /** 支点在屏幕上的位置（占屏幕比例） */
  fx = 0.5;
  fy = 0.55;

  // 每帧派生量
  cx = 0;
  cy = 0;
  sinH = 0;
  cosH = 1;
  sinP = 1;
  cosP = 0;
  near = 4;

  update(W: number, H: number) {
    this.cx = W * this.fx;
    this.cy = H * this.fy;
    this.sinH = Math.sin(this.heading);
    this.cosH = Math.cos(this.heading);
    this.sinP = Math.sin(this.pitch);
    this.cosP = Math.cos(this.pitch);
  }

  /** 世界水平偏移 → 镜头系 (u 右, v 前)，考虑地图循环 */
  toCam(wx: number, wy: number, out: { u: number; v: number }) {
    let dx = wx - this.x;
    let dy = wy - this.y;
    dx -= Math.round(dx / WORLD) * WORLD;
    dy -= Math.round(dy / WORLD) * WORLD;
    out.u = dx * this.cosH - dy * this.sinH;
    out.v = dx * this.sinH + dy * this.cosH;
  }

  /** 镜头系 (u, v) → 世界坐标（不取模） */
  fromCam(u: number, v: number, out: { x: number; y: number }) {
    out.x = this.x + u * this.cosH + v * this.sinH;
    out.y = this.y - u * this.sinH + v * this.cosH;
  }

  /** 已知镜头系 (u, v, dh)，算屏幕位置 */
  projectCam(u: number, v: number, dh: number, out: Projected): boolean {
    const depth = this.dist + v * this.cosP - dh * this.sinP;
    if (depth < this.near) return false;
    const k = this.zoom * (1 - this.persp + (this.persp * this.dist) / depth);
    out.depth = depth;
    out.k = k;
    out.x = this.cx + u * k;
    out.y = this.cy - (v * this.ground + dh * this.lift) * k;
    return true;
  }

  private tmp = { u: 0, v: 0 };
  project(wx: number, wy: number, wh: number, out: Projected): boolean {
    this.toCam(wx, wy, this.tmp);
    return this.projectCam(this.tmp.u, this.tmp.v, wh - this.h, out);
  }

  /**
   * 屏幕行 sy 与水平面（高差 dh）的交点的前向距离 v。
   * 由投影公式整理成关于 v 的二次方程；取深度为正且最近的根。无解返回 NaN。
   */
  rowToPlane(sy: number, dh: number): number {
    const s = this.persp, D = this.dist;
    const A = (this.cy - sy) / this.zoom;
    const a = this.ground, b = dh * this.lift, c = this.cosP, e = D - dh * this.sinP;
    const qa = (1 - s) * a * c;
    const qb = (1 - s) * (a * e + b * c) + s * D * a - A * c;
    const qc = (1 - s) * b * e + s * D * b - A * e;
    let best = NaN, bestDepth = Infinity;
    const consider = (v: number) => {
      const depth = c * v + e;
      if (depth > this.near && depth < bestDepth) {
        bestDepth = depth;
        best = v;
      }
    };
    if (Math.abs(qa) < 1e-9) {
      if (Math.abs(qb) > 1e-9) consider(-qc / qb);
    } else {
      const disc = qb * qb - 4 * qa * qc;
      if (disc >= 0) {
        const sq = Math.sqrt(disc);
        consider((-qb + sq) / (2 * qa));
        consider((-qb - sq) / (2 * qa));
      }
    }
    return best;
  }

  /** 镜头世界坐标的高度（用于判断水面是否在头顶） */
  eyeHeight(): number {
    return this.h + this.dist * this.sinP;
  }
}
