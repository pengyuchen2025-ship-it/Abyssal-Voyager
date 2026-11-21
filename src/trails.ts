// 水流线：尾部水平舵和指挥塔水平舵的四个翼尖各拖出一条白色细线，速度越快越长越亮。

import { Camera, Projected } from './camera';
import { Renderer } from './renderer';
import { Water } from './water';
import { SubPose, modelToWorld } from './sub';
import { blendPixel } from './draw';

const N = 64; // 每条线保存的历史点数
// 翼尖位置（模型坐标：前后、左右、上下）
const TIPS: [number, number, number][] = [
  [-10.5, 8.3, -1.5], [-10.5, -8.3, -1.5], // 尾部水平舵
  [2.4, 5.3, 4.5], [2.4, -5.3, 4.5], // 指挥塔水平舵
];

export class Trails {
  private px = new Float32Array(TIPS.length * N);
  private py = new Float32Array(TIPS.length * N);
  private ph = new Float32Array(TIPS.length * N);
  private pt = new Float64Array(TIPS.length * N).fill(-99); // 双精度：单精度会让最新一点的「年龄」变成极小的负数
  private head = 0;
  private tmp = { x: 0, y: 0, h: 0 };
  private a: Projected = { x: 0, y: 0, depth: 0, k: 0 };
  private b: Projected = { x: 0, y: 0, depth: 0, k: 0 };
  life = 0.5;
  strength = 0.4;

  push(p: SubPose, time: number) {
    this.head = (this.head + 1) % N;
    for (let i = 0; i < TIPS.length; i++) {
      const [a, c, h] = TIPS[i];
      modelToWorld(p, a, c, h, this.tmp);
      const j = i * N + this.head;
      this.px[j] = this.tmp.x;
      this.py[j] = this.tmp.y;
      this.ph[j] = this.tmp.h;
      this.pt[j] = time;
    }
  }

  draw(r: Renderer, cam: Camera, water: Water, time: number) {
    const A = this.a, B = this.b;
    const life = this.life;
    const col = water.up;
    const cr = Math.min(255, col[0] * 0.4 + 160), cg = Math.min(255, col[1] * 0.4 + 160), cb = Math.min(255, col[2] * 0.4 + 160);
    for (let i = 0; i < TIPS.length; i++) {
      // 指挥塔上的两条稍弱
      const tipK = i < 2 ? 1 : 0.6;
      let prevOk = false;
      for (let s = 0; s < N; s++) {
        const j = i * N + ((this.head - s + N) % N);
        const age = time - this.pt[j];
        if (age > life || age < 0) break;
        const ok = cam.project(this.px[j], this.py[j], this.ph[j], B);
        if (ok && prevOk) {
          const f = 1 - age / life;
          const alpha = this.strength * tipK * f * f;
          const steps = Math.max(1, Math.ceil(Math.max(Math.abs(B.x - A.x), Math.abs(B.y - A.y))));
          for (let q = 0; q < steps; q++) {
            const t = q / steps;
            blendPixel(r, A.x + (B.x - A.x) * t, A.y + (B.y - A.y) * t, cr, cg, cb, alpha, A.depth + (B.depth - A.depth) * t);
          }
        }
        prevOk = ok;
        A.x = B.x; A.y = B.y; A.depth = B.depth;
      }
    }
  }
}
