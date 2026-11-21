// 游戏状态：潜艇运动、镜头两种视角之间的插值。

import { Camera } from './camera';
import { Input } from './input';
import { World, SURFACE_H } from './world';
import { SubPose, modelToWorld } from './sub';
import { Trails } from './trails';
import { Particles } from './particles';
import { smoothstep } from './noise';
import { scopeLayout } from './periscope';

const TAU = Math.PI * 2;
const D2R = Math.PI / 180;

function angDiff(a: number, b: number) {
  let d = (b - a) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d < -Math.PI) d += TAU;
  return d;
}

export const enum Mode { Chase, Periscope }
export const MODE_NAMES = ['尾随', '潜望镜'];

/** 一个视角的全部镜头参数；切换视角时逐项插值 */
export interface ViewParams {
  pitch: number; persp: number; dist: number; zoom: number; ground: number; lift: number; fy: number;
  heading: number;
  ahead: number; // 支点在潜艇前方多远（潜望镜：眼睛在镜头顶端）
  hOff: number; // 支点相对潜艇的高度
  fog: number; caus: number; shafts: number; objFar: number; terFar: number;
  chase: number; // 1 = 镜头在艇身后方或艇内（尾随式操控、近处物件半透明）
  scope: number; // 潜望镜程度（目镜圆框收拢、隐藏潜艇本体）
  camRate: number; // 镜头高度跟随潜艇的快慢
}
const VP_KEYS: (keyof ViewParams)[] = ['pitch', 'persp', 'dist', 'zoom', 'ground', 'lift', 'fy', 'ahead', 'hOff', 'fog', 'caus', 'shafts', 'objFar', 'terFar', 'chase', 'scope', 'camRate'];
const CHASE_PITCH = 13 * D2R;
const CHASE_DIST = 84;

export const SPEED = 32;
export const BOOST = 1.7; // 按住加速
export const NITRO = 2.8; // 氮气加速
const NITRO_DRAIN = 0.42; // 每秒消耗（满格约 2.4 秒）
const NITRO_FILL = 0.11; // 每秒回复（约 9 秒回满）
const TURN = 1.55; // 最大转向速度（弧度/秒）
const CLIMB = 22; // 最大升降速度
const CLEARANCE = 9; // 离海床最近距离
/** 潜望镜：指挥塔顶（模型坐标）、升到顶时的长度、升降用时 */
export const MAST_A = 1.2, MAST_BASE = 7.5, MAST_LEN = 9;
const MAST_UP = 0.75, MAST_DOWN = 0.6;
const SCOPE_DELAY = 0.45; // 先升潜望镜、镜头转向前方，再把视角送上去（占 viewDur 的比例）

export class Game {
  sub: SubPose = { x: 0, y: 0, h: 60, heading: 0, roll: 0, pitch: 0, prop: 0 };
  speed = SPEED;
  vh = 0;
  bank = 0;
  barrel = 0; // 翻滚进度：0 表示没在翻滚，>0 表示进行中（0..1）
  barrelDir = 1;
  boosting = false;
  /** 氮气：能量 0..1，是否在喷，以及给镜头和特效用的平滑强度 */
  nitro = 1;
  nitroOn = false;
  nitroFx = 0;
  vx = 0;
  vy = 0;
  trails = new Trails();
  private tmpP = { x: 0, y: 0, h: 0 };
  /** 目标视角 */
  viewTarget: Mode = Mode.Chase;
  private viewFrom: ViewParams | null = null;
  private viewT = 1;
  viewDur = 1.4;
  private fromMode: Mode = Mode.Chase;
  /** 潜望镜升起程度 0..1（尾随视角里看得到） */
  mast = 0;
  /** 潜望镜镜头相对艇首的朝向：升起时先对着尾随镜头（看得到镜片），快到顶时转向前方 */
  mastYaw = 0;
  /** 上一帧实际用的镜头参数 */
  vp!: ViewParams;
  private chaseHeading = 0;
  /** 镜头高度：平滑地跟着潜艇，潜艇贴着海床起伏时画面不跟着抖 */
  camH = 0;
  private camLift = 0; // 尾随时为避开岩壁额外抬高的俯仰角
  region = 0;
  time = 0;

  constructor(private world: World, private parts: Particles) {
    const [x, y] = world.findStart();
    this.sub.x = x;
    this.sub.y = y;
    this.sub.h = world.heightSmooth(x, y) + 24;
    this.sub.heading = 0.4;
    this.chaseHeading = this.sub.heading;
    this.region = world.regionAt(x, y);
  }

  /** 在尾随和潜望镜之间切换 */
  toggleView() {
    this.selectView(this.viewTarget === Mode.Chase ? Mode.Periscope : Mode.Chase);
  }

  selectView(m: Mode) {
    if (m === this.viewTarget) return;
    if (this.vp) this.viewFrom = { ...this.vp };
    this.fromMode = this.viewTarget;
    this.viewTarget = m;
    // 进潜望镜：潜望镜还没升起来时，镜头先等它升起
    this.viewT = !this.vp ? 1 : m === Mode.Periscope ? -SCOPE_DELAY * (1 - this.mast) : 0;
  }

  setView(m: Mode) {
    this.viewTarget = m;
    this.viewT = 1;
    this.mast = m === Mode.Periscope ? 1 : 0;
    this.chaseHeading = this.sub.heading;
  }

  /** 视角过渡进度（缓动后），没在切换时为 1 */
  eased() {
    return smoothstep(0, 1, Math.max(0, this.viewT));
  }

  /** subScreen：潜艇上一帧在屏幕上的位置（给指针转向用） */
  update(dt: number, inp: Input, cam: Camera, subScreen: { x: number; y: number; k: number; visible: boolean }) {
    this.time += dt;
    const s = this.sub;
    inp.poll();
    if (inp.takeView()) this.toggleView();
    const pick = inp.takeSelect();
    if (pick === 0 || pick === 1) this.selectView(pick as Mode);

    // 视角过渡
    if (this.viewT < 1) this.viewT = Math.min(1, this.viewT + dt / this.viewDur);
    // 潜望镜升降：进潜望镜时先升；回尾随时等镜头退回来再降
    if (this.viewTarget === Mode.Periscope) {
      this.mast = Math.min(1, this.mast + dt / MAST_UP);
      // 镜片先对着尾随镜头升起（玩家正好看到镜片），快到顶时转向艇首
      // 镜头朝向（世界）= 艇首航向 + yaw；对着镜头 = 镜头朝向 + π
      const face = angDiff(0, this.chaseHeading + Math.PI - s.heading);
      this.mastYaw = face * (1 - smoothstep(0.5, 1, this.mast));
    } else {
      if (this.viewT > 0.8) this.mast = Math.max(0, this.mast - dt / MAST_DOWN);
      this.mastYaw *= Math.max(0, 1 - dt * 6);
    }

    // ---- 转向 ----
    let turn = inp.turn * TURN;
    let climb = inp.rise;
    // 潜望镜里以十字线（画面中心）为参照，尾随时以潜艇为参照
    const ref = this.viewTarget === Mode.Periscope ? { x: cam.cx, y: cam.cy, k: 1, visible: true } : subScreen;
    if (inp.px !== null && inp.py !== null && ref.visible) {
      const dx = inp.px - ref.x, dy = inp.py - ref.y;
      // 指针在参照点左右决定转向，上下决定升降（往上指 = 上浮）
      const nx = dx / (cam.cx * 0.55);
      turn += Math.max(-1, Math.min(1, nx)) * TURN * (Math.abs(nx) < 0.06 ? 0 : 1);
      const ny = -dy / (cam.cy * 0.5);
      if (Math.abs(ny) > 0.12 && inp.rise === 0) climb = Math.max(-1, Math.min(1, ny * 1.2));
    }
    turn = Math.max(-TURN, Math.min(TURN, turn));
    s.heading += turn * dt;

    // 滚轮：一格给一次升降冲量
    const wh = inp.takeWheel();
    if (wh) this.vh += wh * 9;

    // ---- 速度：巡航 / 按住加速 / 氮气 ----
    this.boosting = inp.boost;
    if (inp.takeNitro() && !this.nitroOn && this.nitro >= 0.25) {
      this.nitroOn = true;
      // 一下子喷出一大团气泡
      this.emitWake(60, 2.2);
    }
    if (this.nitroOn) {
      this.nitro -= NITRO_DRAIN * dt;
      if (this.nitro <= 0) {
        this.nitro = 0;
        this.nitroOn = false;
      }
    } else this.nitro = Math.min(1, this.nitro + NITRO_FILL * dt);
    this.nitroFx += ((this.nitroOn ? 1 : 0) - this.nitroFx) * Math.min(1, dt * (this.nitroOn ? 5 : 1.8));
    const want = SPEED * (this.nitroOn ? NITRO : this.boosting ? BOOST : 1);
    this.speed += (want - this.speed) * Math.min(1, dt * (this.nitroOn ? 4 : 2.2));
    this.vx = Math.sin(s.heading) * this.speed;
    this.vy = Math.cos(s.heading) * this.speed;
    s.x += this.vx * dt;
    s.y += this.vy * dt;

    // ---- 升降 + 避开海床 ----
    this.vh += (climb * CLIMB - this.vh) * Math.min(1, dt * 3);
    s.h += this.vh * dt;
    const look = 16 + this.speed * 0.35; // 越快看得越远，提前抬升避开海床
    const fx = s.x + Math.sin(s.heading) * look, fy = s.y + Math.cos(s.heading) * look;
    const floor = Math.max(this.world.heightSmooth(s.x, s.y), this.world.heightSmooth(fx, fy) - 2) + CLEARANCE;
    if (s.h < floor) {
      s.h += (floor - s.h) * Math.min(1, dt * 7);
      if (this.vh < 0) this.vh *= 0.5;
    }
    const ceil = SURFACE_H - 12;
    if (s.h > ceil) {
      s.h += (ceil - s.h) * Math.min(1, dt * 5);
      if (this.vh > 0) this.vh *= 0.5;
    }
    s.pitch += (Math.max(-0.2, Math.min(0.2, this.vh / 80)) - s.pitch) * Math.min(1, dt * 4);

    // ---- 侧倾 + 翻滚 ----
    this.bank += (-turn * 0.28 - this.bank) * Math.min(1, dt * 4);
    if (inp.takeRoll() && this.barrel === 0) {
      this.barrel = 0.0001;
      this.barrelDir = turn > 0.05 ? -1 : turn < -0.05 ? 1 : this.barrelDir;
      this.emitWake(26, 3);
    }
    let rollExtra = 0;
    if (this.barrel > 0) {
      this.barrel += dt / 0.85;
      if (this.barrel >= 1) this.barrel = 0;
      else {
        const e = smoothstep(0, 1, this.barrel);
        rollExtra = e * TAU * this.barrelDir;
      }
    }
    s.roll = this.bank + rollExtra;
    s.prop += dt * (9 + (this.speed / SPEED) * 9);

    // ---- 螺旋桨尾流：连续的旋转气泡流，越快越密 ----
    const rate = this.nitroOn ? 120 : this.boosting ? 60 : 24;
    const n = Math.floor(rate * dt + Math.random());
    if (n > 0) this.emitWake(Math.min(8, n), 0);
    this.parts.update(dt);

    // ---- 翼尖水流线 ----
    this.trails.push(s, this.time);
    const sp = this.speed / SPEED;
    this.trails.strength = Math.min(0.95, 0.22 + (sp - 1) * 0.55 + this.nitroFx * 0.35);
    this.trails.life = 0.35 + Math.min(0.6, (sp - 1) * 0.45) + this.nitroFx * 0.25;

    // ---- 区域（青绿 ↔ 紫雾）慢慢过渡 ----
    this.region += (this.world.regionAt(s.x, s.y) - this.region) * Math.min(1, dt * 0.6);

    // ---- 尾随镜头的朝向滞后于潜艇 ----
    this.chaseHeading += angDiff(this.chaseHeading, s.heading) * Math.min(1, dt * 2.6);
  }

  /** 从螺旋桨后面放气泡：绕艇身轴线旋转（跟着螺旋桨转），带向后的初速度 */
  private emitWake(n: number, spread: number) {
    const s = this.sub;
    const back = -(4 + this.speed * 0.35);
    for (let i = 0; i < n; i++) {
      const a = s.prop * 1.3 + (i / Math.max(1, n)) * Math.PI * 2 + Math.random() * 0.6;
      const rad = 1.4 + Math.random() * 2.2;
      modelToWorld(s, -15.5 - Math.random() * 2, Math.cos(a) * rad, -1.5 + Math.sin(a) * rad, this.tmpP);
      this.parts.emit(this.tmpP.x, this.tmpP.y, this.tmpP.h, 1, Math.sin(s.heading) * back, Math.cos(s.heading) * back, 0.6 + spread);
    }
  }

  /** 某个视角此刻的镜头参数 */
  private params(m: Mode, W: number, H: number, cam: Camera): ViewParams {
    const s = this.sub;
    if (m === Mode.Chase) {
      const zoom = Math.max(Math.min(W, H * 1.6) / 164, Math.min(H, W * 2.2) / 205) * (1 - 0.1 * this.nitroFx);
      const cp = CHASE_PITCH + this.camLift;
      return {
        pitch: cp, persp: 1, dist: CHASE_DIST, zoom, ground: Math.sin(cp), lift: Math.cos(cp), fy: 0.66, heading: this.chaseHeading,
        ahead: 0, hOff: 3, fog: 1, caus: 0.55, shafts: 1, objFar: 430, terFar: 850, chase: 1, scope: 0, camRate: 3,
      };
    }
    // 潜望镜：眼睛在升起的镜头顶端，比艇身高出一截；镜头自带稳定，只跟一点艇身俯仰
    // （横滚在绘制后整幅旋转）。有放大倍率，视野比尾随窄。
    const dist = 60;
    const p = Math.max(0, Math.min(14 * D2R, 6 * D2R - s.pitch * 0.4));
    const L = scopeLayout(W, H); // 画面中心对准观察窗圆心
    const zoom = ((1.75 * L.R) / dist) * (1 - 0.06 * this.nitroFx);
    // 眼睛高度：不能伸出水面
    const up = Math.min(MAST_BASE + MAST_LEN - 1, SURFACE_H - 2.5 - (this.camH || s.h));
    void cam;
    return {
      pitch: p, persp: 1, dist, zoom, ground: Math.sin(p), lift: Math.cos(p), fy: L.cy / H, heading: s.heading,
      ahead: dist * Math.cos(p) + MAST_A, hOff: up - dist * Math.sin(p), fog: 1, caus: 0.55, shafts: 1, objFar: 430, terFar: 850,
      chase: 1, scope: 1, camRate: 10,
    };
  }

  /** 把当前视角（或两个视角之间的插值）写进镜头 */
  applyCamera(cam: Camera, W: number, H: number, dt: number) {
    const s = this.sub;
    // 尾随时：如果镜头会钻进岩壁里，就把俯仰角抬高一点
    let need = 0;
    const hd = this.chaseHeading;
    {
      const back = CHASE_DIST * Math.cos(CHASE_PITCH);
      const ex = s.x - Math.sin(hd) * back, ey = s.y - Math.cos(hd) * back;
      const mx = s.x - Math.sin(hd) * back * 0.5, my = s.y - Math.cos(hd) * back * 0.5;
      const g = Math.max(this.world.heightSmooth(ex, ey), this.world.heightSmooth(mx, my) - 6) + 8;
      const eyeH = this.camH + 3 + CHASE_DIST * Math.sin(CHASE_PITCH);
      if (g > eyeH) need = Math.min(50 * D2R, Math.asin(Math.min(1, (g - this.camH - 3) / CHASE_DIST)) - CHASE_PITCH);
    }
    this.camLift += (need - this.camLift) * Math.min(1, dt * (need > this.camLift ? 6 : 1.5));

    const to = this.params(this.viewTarget, W, H, cam);
    let vp = to;
    // 等潜望镜升起的这段时间，镜头还按原视角实时跟着
    if (this.viewT <= 0) vp = this.viewFrom = this.params(this.fromMode, W, H, cam);
    else if (this.viewT < 1 && this.viewFrom) {
      const e = this.eased(), a = this.viewFrom;
      vp = { ...to };
      for (const key of VP_KEYS) vp[key] = a[key] + (to[key] - a[key]) * e;
      vp.zoom = Math.exp(Math.log(a.zoom) + (Math.log(to.zoom) - Math.log(a.zoom)) * e);
      vp.heading = a.heading + angDiff(a.heading, to.heading) * e;
    }
    this.vp = vp;

    if (!this.camH) this.camH = s.h;
    this.camH += (s.h - this.camH) * Math.min(1, dt * vp.camRate);
    cam.heading = vp.heading;
    cam.pitch = vp.pitch;
    cam.persp = vp.persp;
    cam.dist = vp.dist;
    cam.zoom = vp.zoom;
    cam.ground = vp.ground;
    cam.lift = vp.lift;
    cam.fy = vp.fy;
    cam.x = s.x + Math.sin(vp.heading) * vp.ahead;
    cam.y = s.y + Math.cos(vp.heading) * vp.ahead;
    cam.h = this.camH + vp.hOff;
    cam.update(W, H);
  }
}
