import { Renderer } from './renderer';
import { Camera } from './camera';
import { SubModel, SubRenderer } from './sub';
import { World } from './world';
import { Water } from './water';
import { renderTerrain } from './terrain';
import { Life } from './objects';
import { Particles } from './particles';
import { Input } from './input';
import { Game, Mode, MODE_NAMES, MAST_A, MAST_BASE, MAST_LEN } from './game';
import { Periscope } from './periscope';
import { SURFACE_H } from './world';
import { Menu } from './menu';
import { smoothstep } from './noise';

const canvas = document.getElementById('view') as HTMLCanvasElement;
const stage = document.getElementById('stage') as HTMLDivElement;
const $ = (id: string) => document.getElementById(id) as HTMLElement;
const q = new URLSearchParams(location.search);

const r = new Renderer(canvas);
let bias = 0;
function fit() {
  r.resize(stage.clientWidth, stage.clientHeight, bias);
}
fit();
addEventListener('resize', fit);

const world = new World(+(q.get('seed') ?? 7));
const water = new Water();
const life = new Life(world);
const parts = new Particles();
const subR = new SubRenderer(new SubModel());
const cam = new Camera();
const game = new Game(world, parts);
const periscope = new Periscope();
// ?view=periscope 直接进潜望镜（旧的 ?view=cockpit 也认）
if (q.get('view') === 'periscope' || q.get('view') === 'cockpit') game.setView(Mode.Periscope);

const input = new Input(stage, (cx, cy) => {
  const rc = canvas.getBoundingClientRect();
  return [((cx - rc.left) / rc.width) * r.W, ((cy - rc.top) / rc.height) * r.H];
});

// ---- 界面 ----
const viewBtn = $('btn-view');
viewBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  input.queueView();
});
$('btn-nitro').addEventListener('pointerdown', (e) => {
  e.preventDefault();
  e.stopPropagation();
  input.queueNitro();
});
input.bindHold($('btn-boost'), () => input.setTouchBoost(true), () => input.setTouchBoost(false));
input.bindHold($('btn-up'), () => input.setTouchRise(1), () => input.setTouchRise(0));
input.bindHold($('btn-down'), () => input.setTouchRise(-1), () => input.setTouchRise(0));
const coarse = matchMedia('(pointer: coarse)').matches;
document.body.classList.toggle('touch', coarse || q.has('touch'));

// ---- 开始界面 ----
// menu：开始界面（圆窗里潜艇自己慢慢游）；dive：镜头推进圆窗进入游戏；play：游戏中。
// 开始界面上点「操作指导」：镜头推向左边第一台电脑，屏幕上显示操作说明；Esc / 点一下返回。
type State = 'menu' | 'dive' | 'play';
let state: State = 'menu';
const scene = $('scene'), monitorEl = $('monitor');
const menuCv = $('menu-cv') as HTMLCanvasElement;
const menu = new Menu(menuCv, () => {});
let diveT = 0;
const DIVE_DUR = 0.9;
/** 推向电脑屏幕的进度 0..1，和目标 */
let guideT = 0, guideOn = false;
const GUIDE_DUR = 0.7;
let started = false;

function setState(s: State) {
  state = s;
  document.body.classList.toggle('menu', s !== 'play');
  document.body.classList.toggle('diving', s === 'dive');
  input.frozen = s !== 'play' || paused;
  // 丢掉按下的那个键，免得回车 / 空格同时被当成游戏操作
  input.clear();
}
function startDive() {
  if (state !== 'menu') return;
  if (guideOn || guideT > 0) { setGuide(false); return; }
  state = 'dive';
  diveT = 0;
  document.body.classList.add('diving');
  ($('btn-start') as HTMLElement).blur();
}
function setGuide(on: boolean) {
  if (state !== 'menu') return;
  guideOn = on;
  if (on) ($('btn-guide') as HTMLElement).blur();
}
$('btn-start').addEventListener('click', (e) => { e.stopPropagation(); startDive(); });
$('btn-guide').addEventListener('click', (e) => { e.stopPropagation(); setGuide(true); });
monitorEl.addEventListener('click', (e) => { e.stopPropagation(); setGuide(false); });
stage.addEventListener('pointerdown', () => { if (state === 'menu' && guideOn && guideT > 0.9) setGuide(false); });

// ---- 暂停 / 操作说明 ----
// 开局在左侧显示操作说明，10 秒后淡出；之后按 Esc（触屏：右上角「暂停」）暂停并显示操作说明，再按一次继续
let paused = false;
function setPaused(p: boolean) {
  if (state !== 'play') return;
  paused = p;
  document.body.classList.toggle('paused', p);
  $('guide').classList.toggle('hide', !p);
  // 继续时丢掉按下的键，免得被当成游戏操作
  input.clear();
  input.frozen = p;
  if (p) ($('guide-close') as HTMLElement).focus({ preventScroll: true });
  else ($('guide-close') as HTMLElement).blur();
}
$('guide-close').addEventListener('click', (e) => { e.stopPropagation(); setPaused(false); });
$('guide').addEventListener('click', (e) => { if (e.target === $('guide')) setPaused(false); });
$('btn-pause').addEventListener('click', (e) => { e.stopPropagation(); setPaused(!paused); });
addEventListener('keydown', (e) => {
  if (e.repeat) return;
  if (state === 'menu') {
    if (e.code === 'Enter' || e.code === 'NumpadEnter' || e.code === 'Space') { e.preventDefault(); startDive(); }
    else if (e.code === 'KeyH') setGuide(!guideOn);
    else if (e.code === 'Escape') setGuide(false);
    return;
  }
  if (state !== 'play') return;
  if (e.code === 'Escape') setPaused(!paused);
  else if (paused && (e.code === 'Enter' || e.code === 'Space')) {
    e.preventDefault();
    setPaused(false);
  }
});
// 切到别的标签页时自动暂停
document.addEventListener('visibilitychange', () => {
  if (document.hidden && state === 'play' && !paused) setPaused(true);
});
/** 第一次进入游戏：左侧显示操作说明，10 秒后淡出 */
function showStartHint() {
  if (q.has('nohint')) return;
  document.body.classList.add('hint-on');
  setTimeout(() => $('start-hint').classList.add('hide'), 10000);
}

// 调试参数直接进游戏
if (q.has('play') || q.has('view')) {
  setState('play');
  started = true;
  showStartHint();
} else setState('menu');

/**
 * 开始界面：游戏镜头挪到圆窗中间、并缩小（1/qEnd），潜艇就在圆窗正中。
 * 推进圆窗：背景画布（CSS 缩放）和游戏镜头（缩放 + 支点位置）绕同一个不动点 F、按同一个倍数 q 放大，
 * q 从 1 到 qEnd；后半段背景淡出，到底时游戏镜头正好回到正常的尾随镜头——中间没有跳变。
 * 操作指导：整个场景（游戏画布 + 背景 + 屏幕上的字）一起绕不动点放大到电脑屏幕占满画面中间。
 */
let lastXf = '', lastScene = '';
function placeMenu(dt: number) {
  if (state === 'play') {
    if (cam.fx !== 0.5) {
      cam.fx = 0.5;
      cam.update(r.W, r.H);
    }
    if (lastXf) { menuCv.style.transform = ''; menuCv.style.opacity = ''; lastXf = ''; }
    if (lastScene) { scene.style.transform = ''; lastScene = ''; }
    return;
  }
  const vw = stage.clientWidth, vh = stage.clientHeight;
  const L0 = parseFloat(canvas.style.left) || 0, T0 = parseFloat(canvas.style.top) || 0;
  const cw = parseFloat(canvas.style.width), ch = parseFloat(canvas.style.height);
  menu.layout(vw, vh, r.W, r.H, r.scale, L0, T0);
  layoutMenuUI(vw, vh);

  // ---- 推进圆窗 ----
  if (state === 'dive') {
    diveT = Math.min(1, diveT + dt / DIVE_DUR);
    if (diveT >= 1) {
      setState('play');
      if (!started) {
        started = true;
        showStartHint();
      }
      placeMenu(0);
      return;
    }
  }
  const w = menu.window();
  const far = Math.max(Math.hypot(w.x, w.y), Math.hypot(vw - w.x, w.y), Math.hypot(w.x, vh - w.y), Math.hypot(vw - w.x, vh - w.y));
  const qEnd = Math.max(1.4, (far / w.r) * 0.62);
  const Nx = L0 + cw * 0.5, Ny = T0 + ch * cam.fy;
  const Fx = (qEnd * w.x - Nx) / (qEnd - 1), Fy = (qEnd * w.y - Ny) / (qEnd - 1);
  const e = state === 'dive' ? smoothstep(0, 1, diveT) : 0;
  const q = Math.pow(qEnd, e);
  const Px = Fx + q * (w.x - Fx), Py = Fy + q * (w.y - Fy);
  cam.fx = (Px - L0) / cw;
  cam.fy = (Py - T0) / ch;
  cam.zoom *= q / qEnd;
  cam.update(r.W, r.H);
  // 背景画布：p → F + q (p − F)（画布左上角在 L0, T0，变换原点在它自己的左上角）
  const bt = q === 1 ? '' : `translate(${(Fx - L0) * (1 - q)}px, ${(Fy - T0) * (1 - q)}px) scale(${q})`;
  const op = String(1 - smoothstep(0.55, 1, e));
  if (bt + op !== lastXf) {
    menuCv.style.transform = bt;
    menuCv.style.opacity = op;
    lastXf = bt + op;
  }

  // ---- 推向电脑屏幕（操作指导） ----
  guideT = Math.max(0, Math.min(1, guideT + (guideOn ? 1 : -1) * dt / GUIDE_DUR));
  const m = menu.monitor();
  const Z = Math.min((vw * 0.66) / m.w, (vh * 0.62) / m.h);
  const cx = m.x + m.w / 2, cy = m.y + m.h / 2;
  const GFx = (Z * cx - vw / 2) / (Z - 1), GFy = (Z * cy - vh / 2) / (Z - 1);
  const gq = Math.pow(Z, smoothstep(0, 1, guideT));
  const st = gq === 1 ? '' : `translate(${GFx * (1 - gq)}px, ${GFy * (1 - gq)}px) scale(${gq})`;
  if (st !== lastScene) {
    scene.style.transform = st;
    lastScene = st;
  }
  // 屏幕上的字：按放大后的大小排版，再缩回去
  const ms = monitorEl.style;
  ms.left = m.x + 'px';
  ms.top = m.y + 'px';
  ms.width = m.w * Z + 'px';
  ms.height = m.h * Z + 'px';
  ms.transform = `scale(${1 / Z})`;
  ms.setProperty('--mh', m.h * Z + 'px');
  document.body.classList.toggle('guide', guideOn || guideT > 0);
  document.body.classList.toggle('guide-on', guideOn && guideT > 0.85);
}

/** 标题和按钮：跟着背景图上的位置走（原图左上的标题、左下的按钮），但不出屏幕 */
let uiKey = '';
function layoutMenuUI(vw: number, vh: number) {
  const key = [vw, vh, menu.s, menu.ox, menu.oy].join();
  if (key === uiKey) return;
  uiKey = key;
  const s = menu.s;
  const t = $('menu-title'), b = $('menu-btns');
  const tp = menu.map(58, 172), bp = menu.map(60, 584);
  const pad = 14;
  t.style.left = Math.max(pad, tp.x) + 'px';
  t.style.top = Math.max(pad, tp.y) + 'px';
  t.style.setProperty('--fs', Math.max(28, 46 * s) + 'px');
  b.style.left = Math.max(pad, bp.x) + 'px';
  b.style.width = Math.max(200, 288 * s) + 'px';
  b.style.setProperty('--bs', Math.max(14, 19 * s) + 'px');
  const bh = b.offsetHeight;
  b.style.top = Math.min(bp.y, vh - bh - pad) + 'px';
}

// ---- HUD ----
const depthEl = $('depth'), speedEl = $('speed'), zoneEl = $('zone'), toast = $('toast'), viewName = $('view-name');
const spdCells = $('spd-cells'), n2Cells = $('n2-cells');
const SPD_N = 12, N2_N = 8;
spdCells.innerHTML = '<i></i>'.repeat(SPD_N);
n2Cells.innerHTML = '<i></i>'.repeat(N2_N);
const spdIs = Array.from(spdCells.children) as HTMLElement[], n2Is = Array.from(n2Cells.children) as HTMLElement[];
let spdLit = -1, n2Lit = -1;
function lightCells(cells: HTMLElement[], n: number) {
  cells.forEach((c, i) => c.classList.toggle('on', i < n));
}
let zone = game.region > 0.5 ? 1 : 0;
// 进入新海域：画面上方淡入一行地名，停一会儿再淡出
let toastTimer = 0;
function showToast(name: string, en: string) {
  toast.querySelector('b')!.textContent = name;
  toast.querySelector('small')!.textContent = en;
  toast.classList.remove('show');
  void toast.offsetWidth; // 重新触发动画
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toast.classList.remove('show'), 3200);
}

// ---- 主循环 ----
let last = performance.now();
let slowAcc = 0, slowN = 0;
const stats = { frames: 0, work: 0 };
(window as any).__game = game;
(window as any).__cam = cam;
(window as any).__dbg = { r, water, cam };
let preCopy: Uint32Array | null = null;
(window as any).__buf = () => (q.has('pre') && preCopy ? preCopy.slice() : r.buf.slice());

function frame(now: number) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  const w0 = performance.now();

  input.demoTurn = state === 'play' ? 0 : Math.sin(game.time * 0.23) * 0.3; // 开始界面上潜艇自己慢慢转弯
  if (!paused) game.update(dt, input, cam, subR.screen);
  game.applyCamera(cam, r.W, r.H, paused ? 0 : dt);
  placeMenu(dt);
  const vp = game.vp;
  water.fogAmount = vp.fog;
  water.update(cam, r.H, game.region, game.time);

  const s = game.sub;
  {
    renderTerrain(r, cam, world, water, { far: vp.terFar, caustics: vp.caus });
    water.renderSurface(r, cam);
    const inside = vp.scope > 0.75; // 从潜望镜里看：不画潜艇本体、影子和翼尖水流线
    if (!inside) life.drawShadow(r, cam, s.x, s.y, s.h, s.heading);
    const pj = { x: 0, y: 0, depth: 0, k: 0 };
    cam.project(s.x, s.y, s.h, pj);
    if (inside) subR.screen.visible = false;
    life.draw(r, cam, water, game.time, vp.objFar, inside ? 0 : pj.depth, () => {
      if (!inside) {
        const tint = (c: number, d: number, y: number) => water.fog(c, d, y);
        subR.draw(r, cam, s, tint);
        subR.drawMast(r, cam, s, MAST_A, MAST_BASE, game.mast * MAST_LEN, game.mastYaw, tint);
      }
    }, vp.chase, pj.x, pj.y, inside);
    if (!inside) game.trails.draw(r, cam, water, game.time);
    const sp = game.speed / 32;
    parts.draw(r, cam, water, game.time, -game.vx, -game.vy, Math.max(0, sp - 1.15) * 0.07 + game.nitroFx * 0.05);
    water.lightShafts(r, cam, vp.shafts);
    // 潜望镜：镜里的世界随艇身横滚旋转，然后画目镜圆框和分划线
    if (vp.scope > 0.01) {
      r.rotate(s.roll * vp.scope, cam.cx, cam.cy, water.rowPacked);
      periscope.draw(r, {
        t: game.time, heading: s.heading, depth: (SURFACE_H - s.h) * 0.6, speedKn: game.speed * 0.5,
        nitro: game.nitro, nitroOn: game.nitroOn, clearance: s.h - world.heightSmooth(s.x, s.y),
        subX: s.x, subY: s.y, subH: s.h,
      }, world, vp.scope);
    }
  }
  if (q.has('pre')) preCopy = r.buf.slice();
  r.present();

  // ---- HUD ----
  const depth = Math.round((SURFACE_H - s.h) * 0.6);
  depthEl.textContent = String(depth).padStart(3, '0');
  speedEl.textContent = String(Math.round(game.speed * 0.5)).padStart(2, '0');
  viewName.textContent = MODE_NAMES[game.viewTarget];
  document.body.classList.toggle('scope', game.viewTarget === Mode.Periscope);
  // 航速格：满格 = 氮气最高速
  const sl = Math.max(1, Math.round((game.speed / (32 * 2.8)) * SPD_N));
  if (sl !== spdLit) lightCells(spdIs, (spdLit = sl));
  spdCells.classList.toggle('boost', game.boosting && !game.nitroOn);
  spdCells.classList.toggle('nitro', game.nitroOn);
  const nl = Math.ceil(game.nitro * N2_N - 0.01);
  if (nl !== n2Lit) lightCells(n2Is, (n2Lit = nl));
  n2Cells.classList.toggle('fire', game.nitroOn);
  n2Cells.classList.toggle('ready', !game.nitroOn && game.nitro >= 0.25);
  const z = game.region > 0.6 ? 1 : game.region < 0.4 ? 0 : zone;
  if (z !== zone) {
    zone = z;
    showToast(z ? '紫雾海域' : '青绿海域', z ? 'VIOLET MIST' : 'TEAL SHALLOWS');
  }
  zoneEl.textContent = zone ? '紫雾海域' : '青绿海域';
  zoneEl.classList.toggle('violet', zone === 1);

  // 太慢就自动降一档分辨率
  const work = performance.now() - w0;
  stats.frames++;
  stats.work += work;
  // 开头几秒浏览器还在预热代码，不算
  if (game.time > 3) {
    slowAcc += work;
    slowN++;
  }
  if (slowN >= 90) {
    if (slowAcc / slowN > 30 && bias < 2 && !q.has('noauto')) {
      bias++;
      fit();
    }
    slowAcc = slowN = 0;
  }
  (window as any).__fps = { avgMs: +(stats.work / stats.frames).toFixed(2), frames: stats.frames, W: r.W, H: r.H, scale: r.scale };
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
