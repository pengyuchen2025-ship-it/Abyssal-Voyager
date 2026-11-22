// 战斗：敌方潜艇、鱼雷、掉落物（修理包 / 氮气罐）、爆炸。
//
// 敌艇在玩家周围巡逻，进入 300 以内就追过来、绕着打，对准了就发射带轻微追踪的鱼雷（翻滚、冲刺、急转能甩掉）。
// 玩家只能在潜望镜视角开火：敌艇进到十字线中心附近就锁定（红框），这时发射的鱼雷强追踪，基本必中；
// 没锁定也能打，鱼雷直线飞。游戏时间越长越难：敌人更多、更快、开火更勤、鱼雷更快更狠。
// 击沉的敌艇冒着泡沉下去，可能掉修理包（回艇壳）或氮气罐（补满氮气）。

import { Camera, Projected, WORLD } from './camera';
import { Renderer } from './renderer';
import { Water } from './water';
import { World, SURFACE_H } from './world';
import { Particles } from './particles';
import { SubPose, SubRenderer, modelToWorld } from './sub';
import { blendEllipse, fillEllipse } from './draw';
import { pack } from './color';

const TAU = Math.PI * 2;
const wrap = (d: number) => d - Math.round(d / WORLD) * WORLD;
const angDiff = (a: number, b: number) => {
  let d = (b - a) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d < -Math.PI) d += TAU;
  return d;
};
const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

export interface Enemy extends SubPose {
  speed: number;
  hp: number;
  fireCd: number;
  wander: number;
  wanderT: number;
  vh: number;
  bank: number;
  flash: number; // 被打中时闪一下
  dying: number; // >0：正在下沉（秒）
}

interface Torpedo {
  x: number; y: number; h: number;
  heading: number;
  speed: number;
  mine: boolean;
  target: Enemy | null; // 玩家的鱼雷：锁定的敌艇；敌人的鱼雷追玩家
  turn: number;
  life: number;
  max: number;
  damage: number;
}

export interface Pickup { x: number; y: number; h: number; kind: 'repair' | 'nitro'; t: number }

interface Blast { x: number; y: number; h: number; t: number; size: number }

export const HULL_MAX = 100;
export const RELOAD = 1.1; // 玩家鱼雷装填时间（秒）
const LOCK_RANGE = 280; // 锁定 / 有效射程

export interface CombatEvents {
  hit(damage: number): void;
  kill(): void;
  pickup(kind: Pickup['kind']): void;
  dead(): void;
}

export class Combat {
  enemies: Enemy[] = [];
  torps: Torpedo[] = [];
  pickups: Pickup[] = [];
  blasts: Blast[] = [];
  hull = HULL_MAX;
  kills = 0;
  /** 本局游戏时间（秒），决定难度 */
  time = 0;
  reload = 0;
  dead = false;
  /** 当前锁定的敌艇（潜望镜里由 main.ts 算） */
  lock: Enemy | null = null;
  private spawnCd = 5;
  private tmp = { x: 0, y: 0, h: 0 };
  private pj: Projected = { x: 0, y: 0, depth: 0, k: 0 };
  private pj2: Projected = { x: 0, y: 0, depth: 0, k: 0 };

  constructor(private world: World, private parts: Particles, private ev: CombatEvents) {}

  /** 开新一局 */
  reset() {
    this.enemies = [];
    this.torps = [];
    this.pickups = [];
    this.blasts = [];
    this.hull = HULL_MAX;
    this.kills = 0;
    this.time = 0;
    this.reload = 0;
    this.dead = false;
    this.lock = null;
    this.spawnCd = 5; // 开局给几秒喘息
  }

  /** 难度 0..1：大约 4 分钟到顶 */
  get level() {
    return Math.min(1, this.time / 240);
  }

  private spawn(p: SubPose) {
    const d = this.level;
    const a = Math.random() * TAU, dist = 260 + Math.random() * 90;
    const x = p.x + Math.sin(a) * dist, y = p.y + Math.cos(a) * dist;
    const floor = this.world.heightSmooth(x, y) + 16;
    const h = clamp(p.h + (Math.random() - 0.5) * 40, floor, SURFACE_H - 20);
    this.enemies.push({
      x, y, h, heading: Math.random() * TAU, roll: 0, pitch: 0, prop: 0,
      speed: lerp(17, 28, d) * (0.85 + Math.random() * 0.3),
      hp: d > 0.5 && Math.random() < 0.35 ? 2 : 1,
      fireCd: 3 + Math.random() * 3, wander: Math.random() * TAU, wanderT: 0, vh: 0, bank: 0, flash: 0, dying: 0,
    });
  }

  /** 玩家开火（潜望镜里）。target：锁定的敌艇，没有就直线飞 */
  fire(p: SubPose, pitch: number, target: Enemy | null) {
    if (this.reload > 0 || this.dead) return false;
    this.reload = RELOAD;
    modelToWorld(p, 15, 0, -1.5, this.tmp);
    this.torps.push({
      x: this.tmp.x, y: this.tmp.y, h: this.tmp.h, heading: p.heading, speed: 85, mine: true,
      target, turn: target ? 4 : 0, life: 0, max: 4, damage: 1,
    });
    void pitch;
    this.parts.emit(this.tmp.x, this.tmp.y, this.tmp.h, 18, Math.sin(p.heading) * 20, Math.cos(p.heading) * 20, 3);
    return true;
  }

  update(dt: number, p: SubPose, nitroFill: () => void) {
    if (this.dead) {
      this.updateBlasts(dt);
      return;
    }
    this.time += dt;
    this.reload = Math.max(0, this.reload - dt);
    const d = this.level;

    // ---- 刷怪：数量随难度从 2 涨到 6 ----
    const alive = this.enemies.filter((e) => !e.dying).length;
    const maxN = 2 + Math.floor(d * 4.99);
    this.spawnCd -= dt;
    if (alive < maxN && this.spawnCd <= 0) {
      this.spawn(p);
      this.spawnCd = lerp(9, 3.5, d);
    }

    // ---- 敌艇 ----
    for (let i = this.enemies.length - 1; i >= 0; i--) {
      const e = this.enemies[i];
      e.prop += dt * 14;
      e.flash = Math.max(0, e.flash - dt * 4);
      if (e.dying > 0) {
        // 下沉：慢慢翻过去，一路冒泡，沉到海底就消失
        e.dying += dt;
        e.h -= dt * (6 + e.dying * 4);
        e.roll += dt * 0.9;
        e.pitch = Math.max(-0.5, e.pitch - dt * 0.15);
        if (Math.random() < 0.5) this.parts.emit(e.x, e.y, e.h + 4, 2, 0, 0, 6);
        if (e.dying > 4 || e.h < this.world.heightSmooth(e.x, e.y) + 2) this.enemies.splice(i, 1);
        continue;
      }
      const dx = wrap(p.x - e.x), dy = wrap(p.y - e.y);
      const dist = Math.hypot(dx, dy);
      // 离太远就收掉，之后在附近重新刷
      if (dist > 460) {
        this.enemies.splice(i, 1);
        continue;
      }
      const toP = Math.atan2(dx, dy);
      let want: number, wantH: number;
      if (dist < 300) {
        // 追击：远了就冲过来，近了就绕圈（保持在 90~140 的距离），对准了就开火
        const side = i % 2 ? 1 : -1;
        const circle = clamp((140 - dist) / 60, -1, 1); // 太近 → 侧着拉开
        want = toP + side * (Math.PI / 2) * clamp(circle + 0.35, 0, 1);
        wantH = p.h + Math.sin(this.time * 0.4 + i) * 10;
        e.fireCd -= dt;
        const aim = Math.abs(angDiff(e.heading, toP));
        if (e.fireCd <= 0 && dist < 240 && aim < 0.55) {
          modelToWorld(e, 15, 0, -1.5, this.tmp);
          this.torps.push({
            x: this.tmp.x, y: this.tmp.y, h: this.tmp.h, heading: e.heading, speed: lerp(34, 52, d), mine: false,
            target: null, turn: lerp(0.45, 0.85, d), life: 0, max: 7, damage: Math.round(lerp(14, 22, d)),
          });
          this.parts.emit(this.tmp.x, this.tmp.y, this.tmp.h, 10, 0, 0, 3);
          e.fireCd = lerp(7, 2.8, d) * (0.8 + Math.random() * 0.4);
        }
      } else {
        // 巡逻：慢慢换方向，大体往玩家这边靠
        e.wanderT -= dt;
        if (e.wanderT <= 0) {
          e.wander = toP + (Math.random() - 0.5) * 2;
          e.wanderT = 3 + Math.random() * 4;
        }
        want = e.wander;
        wantH = e.h;
      }
      const turn = clamp(angDiff(e.heading, want), -1, 1) * 0.9;
      e.heading += turn * dt;
      e.bank += (-turn * 0.35 - e.bank) * Math.min(1, dt * 3);
      e.roll = e.bank;
      // 避开海床、别冒出水面
      const look = 20;
      const fx = e.x + Math.sin(e.heading) * look, fy = e.y + Math.cos(e.heading) * look;
      const floor = Math.max(this.world.heightSmooth(e.x, e.y), this.world.heightSmooth(fx, fy)) + 12;
      wantH = clamp(wantH, floor, SURFACE_H - 16);
      e.vh += (clamp((wantH - e.h) * 0.6, -16, 16) - e.vh) * Math.min(1, dt * 2);
      e.h += e.vh * dt;
      if (e.h < floor) e.h += (floor - e.h) * Math.min(1, dt * 5);
      e.pitch += (clamp(e.vh / 80, -0.2, 0.2) - e.pitch) * Math.min(1, dt * 3);
      e.x += Math.sin(e.heading) * e.speed * dt;
      e.y += Math.cos(e.heading) * e.speed * dt;
      // 螺旋桨尾流
      if (Math.random() < dt * 14) {
        modelToWorld(e, -15.5, 0, -1.5, this.tmp);
        this.parts.emit(this.tmp.x, this.tmp.y, this.tmp.h, 1, -Math.sin(e.heading) * 8, -Math.cos(e.heading) * 8, 1.5);
      }
    }

    // ---- 鱼雷 ----
    for (let i = this.torps.length - 1; i >= 0; i--) {
      const t = this.torps[i];
      t.life += dt;
      let tx: number | null = null, ty = 0, th = 0;
      if (t.mine && t.target && !t.target.dying && this.enemies.includes(t.target)) {
        tx = t.target.x; ty = t.target.y; th = t.target.h;
      } else if (!t.mine && !this.dead) {
        tx = p.x; ty = p.y; th = p.h;
      }
      if (tx !== null) {
        const dx = wrap(tx - t.x), dy = wrap(ty - t.y);
        t.heading += clamp(angDiff(t.heading, Math.atan2(dx, dy)), -t.turn * dt, t.turn * dt);
        t.h += clamp(th - t.h, -t.speed * 0.5 * dt, t.speed * 0.5 * dt) * (t.mine ? 1 : 0.6);
      }
      t.x += Math.sin(t.heading) * t.speed * dt;
      t.y += Math.cos(t.heading) * t.speed * dt;
      if (Math.random() < 0.7) this.parts.emit(t.x - Math.sin(t.heading) * 3, t.y - Math.cos(t.heading) * 3, t.h, 1, 0, 0, 1);
      let boom = t.life > t.max || t.h < this.world.heightAt(t.x, t.y) + 1 || t.h > SURFACE_H - 2;
      if (t.mine) {
        for (const e of this.enemies) {
          if (e.dying) continue;
          if (Math.hypot(wrap(e.x - t.x), wrap(e.y - t.y), e.h - t.h) < 8) {
            boom = true;
            e.hp -= t.damage;
            e.flash = 1;
            if (e.hp <= 0) this.sink(e);
            break;
          }
        }
      } else if (!this.dead && Math.hypot(wrap(p.x - t.x), wrap(p.y - t.y), p.h - t.h) < 6.5) {
        boom = true;
        this.hull = Math.max(0, this.hull - t.damage);
        this.ev.hit(t.damage);
        if (this.hull <= 0) {
          this.dead = true;
          this.blast(p.x, p.y, p.h, 2.2);
          this.ev.dead();
        }
      }
      if (boom) {
        this.blast(t.x, t.y, t.h, t.mine ? 1.2 : 1);
        this.torps.splice(i, 1);
      }
    }

    // ---- 掉落物：原地上下浮动，40 秒后消失；碰到就捡 ----
    for (let i = this.pickups.length - 1; i >= 0; i--) {
      const k = this.pickups[i];
      k.t += dt;
      if (k.t > 40) {
        this.pickups.splice(i, 1);
        continue;
      }
      if (Math.hypot(wrap(p.x - k.x), wrap(p.y - k.y), p.h - k.h) < 13) {
        if (k.kind === 'repair') this.hull = Math.min(HULL_MAX, this.hull + 35);
        else nitroFill();
        this.ev.pickup(k.kind);
        this.parts.emit(k.x, k.y, k.h, 14, 0, 0, 5);
        this.pickups.splice(i, 1);
      }
    }
    this.updateBlasts(dt);
  }

  private updateBlasts(dt: number) {
    for (let i = this.blasts.length - 1; i >= 0; i--) {
      this.blasts[i].t += dt;
      if (this.blasts[i].t > 0.9) this.blasts.splice(i, 1);
    }
  }

  private sink(e: Enemy) {
    e.dying = 0.001;
    this.kills++;
    this.ev.kill();
    this.blast(e.x, e.y, e.h, 1.8);
    // 掉落：65% 掉东西，修理包略多
    if (Math.random() < 0.65) this.pickups.push({ x: e.x, y: e.y, h: e.h + 2, kind: Math.random() < 0.55 ? 'repair' : 'nitro', t: 0 });
  }

  private blast(x: number, y: number, h: number, size: number) {
    this.blasts.push({ x, y, h, t: 0, size });
    this.parts.emit(x, y, h, Math.round(26 * size), 0, 0, 7 * size);
  }

  // ---------------------------------------------------------------- 绘制

  /** 画在世界里（地形和物件之后、粒子之前），都做深度测试 */
  draw(r: Renderer, cam: Camera, water: Water, enemyR: SubRenderer, t: number) {
    const fog = (c: number, d: number, y: number) => water.fog(c, d, y);
    for (const e of this.enemies) {
      const tint = e.flash > 0 ? (c: number, d: number, y: number) => {
        const f = e.flash;
        return water.fog(pack((c & 255) + (255 - (c & 255)) * f, ((c >> 8) & 255) + (255 - ((c >> 8) & 255)) * f, ((c >> 16) & 255) + (255 - ((c >> 16) & 255)) * f), d, y);
      } : fog;
      enemyR.draw(r, cam, e, tint);
    }
    const pj = this.pj, pj2 = this.pj2;
    // 鱼雷：一根细长的深色圆柱，头上一点亮（敌人的是红的）
    for (const tp of this.torps) {
      const sx = Math.sin(tp.heading), sy = Math.cos(tp.heading);
      if (!cam.project(tp.x + sx * 2.5, tp.y + sy * 2.5, tp.h, pj)) continue;
      if (!cam.project(tp.x - sx * 2.5, tp.y - sy * 2.5, tp.h, pj2)) continue;
      const n = Math.max(2, Math.ceil(Math.hypot(pj.x - pj2.x, pj.y - pj2.y)));
      const rad = Math.max(0.6, 0.7 * pj.k);
      for (let i = 0; i <= n; i++) {
        const f = i / n;
        const c = f < 0.15 ? (tp.mine ? pack(255, 240, 200) : pack(255, 80, 60)) : pack(70, 76, 88);
        fillEllipse(r, lerp(pj.x, pj2.x, f), lerp(pj.y, pj2.y, f), rad, rad, water.fog(c, pj.depth, pj.y), lerp(pj.depth, pj2.depth, f) - 0.5);
      }
      if (!tp.mine) blendEllipse(r, pj.x, pj.y, rad * 2.5, rad * 2.5, 255, 80, 60, 0.35, pj.depth - 1);
    }
    // 掉落物：小箱子（修理包：白底红十字；氮气罐：青色罐子），一闪一闪的光晕
    for (const k of this.pickups) {
      const bob = Math.sin(k.t * 2.2) * 1.5;
      if (!cam.project(k.x, k.y, k.h + bob, pj)) continue;
      const s = Math.max(1.5, 2.6 * pj.k);
      const blink = k.t > 32 && Math.sin(k.t * 12) < 0; // 快消失时闪
      if (blink) continue;
      const glowC = k.kind === 'repair' ? [255, 90, 80] : [120, 240, 240];
      blendEllipse(r, pj.x, pj.y, s * 2.4, s * 2.4, glowC[0], glowC[1], glowC[2], 0.22 + 0.12 * Math.sin(t * 5), pj.depth);
      const d0 = pj.depth - 1;
      const px = (x: number, y: number, w: number, h: number, c: number) => {
        for (let yy = Math.floor(y); yy < y + h; yy++) for (let xx = Math.floor(x); xx < x + w; xx++) fillEllipse(r, xx + 0.5, yy + 0.5, 0.5, 0.5, c, d0);
      };
      if (k.kind === 'repair') {
        px(pj.x - s, pj.y - s, s * 2, s * 2, pack(236, 236, 228));
        px(pj.x - s * 0.25, pj.y - s * 0.75, s * 0.5, s * 1.5, pack(220, 50, 40));
        px(pj.x - s * 0.75, pj.y - s * 0.25, s * 1.5, s * 0.5, pack(220, 50, 40));
      } else {
        px(pj.x - s * 0.6, pj.y - s, s * 1.2, s * 2, pack(60, 190, 200));
        px(pj.x - s * 0.6, pj.y - s, s * 0.4, s * 2, pack(150, 250, 250));
        px(pj.x - s * 0.3, pj.y - s * 1.35, s * 0.6, s * 0.4, pack(200, 210, 220));
      }
    }
    // 爆炸：先一团白光，再扩成橙色的圈，慢慢暗下去
    for (const b of this.blasts) {
      if (!cam.project(b.x, b.y, b.h, pj)) continue;
      const f = b.t / 0.9;
      const rad = (3 + f * 12) * b.size * pj.k;
      const a = (1 - f) * 0.85;
      blendEllipse(r, pj.x, pj.y, rad, rad, 255, lerp(230, 120, f), lerp(170, 40, f), a * 0.6, pj.depth - 2);
      blendEllipse(r, pj.x, pj.y, rad * 0.5, rad * 0.5, 255, 250, 230, a, pj.depth - 2);
    }
  }

  /**
   * 潜望镜：找十字线附近、射程内最近的敌艇做锁定。
   * 屏幕已经随艇身横滚旋转了 roll，所以投影点要转到旋转后的位置再比较。返回每艘看得到的敌艇在屏幕上的位置。
   */
  scopeTargets(cam: Camera, roll: number, lockR: number) {
    const out: { e: Enemy; x: number; y: number; size: number; range: number }[] = [];
    const c = Math.cos(roll), s = Math.sin(roll);
    let best: Enemy | null = null, bestD = Infinity;
    for (const e of this.enemies) {
      if (e.dying) continue;
      if (!cam.project(e.x, e.y, e.h, this.pj)) continue;
      const range = this.pj.depth;
      if (range > 430) continue;
      const ox = this.pj.x - cam.cx, oy = this.pj.y - cam.cy;
      const x = cam.cx + c * ox - s * oy, y = cam.cy + s * ox + c * oy;
      out.push({ e, x, y, size: 11 * this.pj.k, range });
      const dd = Math.hypot(x - cam.cx, y - cam.cy);
      // 已经锁定的目标放宽一点，免得在边上抖来抖去
      const rLim = e === this.lock ? lockR * 1.5 : lockR;
      if (range < LOCK_RANGE && dd < rLim && dd < bestD) {
        bestD = dd;
        best = e;
      }
    }
    this.lock = best;
    return out;
  }

  /** 声呐上的点：相对玩家的位置（右、前） */
  contacts(p: SubPose) {
    const sh = Math.sin(p.heading), ch = Math.cos(p.heading);
    const out: { fx: number; fy: number; kind: number }[] = [];
    const add = (x: number, y: number, kind: number) => {
      const dx = wrap(x - p.x), dy = wrap(y - p.y);
      out.push({ fx: dx * ch - dy * sh, fy: dx * sh + dy * ch, kind });
    };
    for (const e of this.enemies) if (!e.dying) add(e.x, e.y, 0);
    for (const t of this.torps) if (!t.mine) add(t.x, t.y, 1);
    for (const k of this.pickups) add(k.x, k.y, 2);
    return out;
  }
}
