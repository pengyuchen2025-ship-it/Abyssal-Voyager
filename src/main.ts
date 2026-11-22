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
// menu：开始界面（圆窗里潜艇自己慢慢游）；dive：镜头推进圆窗进入游戏；play：游戏中；
// surface：游戏中按 Esc，镜头从圆窗里拉回开始界面（dive 反过来）。
// 开始界面上点「操作指导」：镜头推向左边第一台电脑，屏幕上显示操作说明；Esc / 点一下返回。
type State = 'menu' | 'dive' | 'play' | 'surface';
let state: State = 'menu';
const scene = $('scene'), monitorEl = $('monitor');
const menuCv = $('menu-cv') as HTMLCanvasElement;
const menu = new Menu(menuCv, () => {});
let diveT = 0;
const DIVE_DUR = 0.9;
/** 推向电脑屏幕的进度 0..1，和目标 */
let guideT = 0, guideOn = false;
const GUIDE_DUR = 0.7;

function setState(s: State) {
  state = s;
  document.body.classList.toggle('menu', s !== 'play');
  document.body.classList.toggle('diving', s === 'dive' || s === 'surface');
  input.frozen = s !== 'play';
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

/** 游戏中按 Esc（触屏：右上角「返回」）：镜头拉回开始界面；instant：切到别的标签页时直接回去，不播动画 */
function surface(instant = false) {
  if (state !== 'play') return;
  if (game.viewTarget !== Mode.Chase) game.setView(Mode.Chase); // 在潜望镜里的话先直接切回尾随视角，再往回拉
  setState('surface');
  diveT = instant ? 0 : 1;
}
$('btn-pause').addEventListener('click', (e) => { e.stopPropagation(); surface(); });
addEventListener('keydown', (e) => {
  if (e.repeat) return;
  if (state === 'menu') {
    if (e.code === 'Enter' || e.code === 'NumpadEnter' || e.code === 'Space') { e.preventDefault(); startDive(); }
    else if (e.code === 'KeyH') setGuide(!guideOn);
    else if (e.code === 'Escape') setGuide(false);
    return;
  }
  if (state === 'play' && e.code === 'Escape') surface();
});
// 切到别的标签页：回到开始界面
document.addEventListener('visibilitychange', () => {
  if (document.hidden) surface(true);
});

// 调试参数直接进游戏
setState(q.has('play') || q.has('view') ? 'play' : 'menu');

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

  // ---- 推进圆窗 / 拉回开始界面 ----
  if (state === 'dive') {
    diveT = Math.min(1, diveT + dt / DIVE_DUR);
    if (diveT >= 1) {
      setState('play');
      placeMenu(0);
      return;
    }
  } else if (state === 'surface') {
    diveT = Math.max(0, diveT - dt / DIVE_DUR);
    if (diveT <= 0) setState('menu');
  }
  const w = menu.window();
  const far = Math.max(Math.hypot(w.x, w.y), Math.hypot(vw - w.x, w.y), Math.hypot(w.x, vh - w.y), Math.hypot(vw - w.x, vh - w.y));
  const qEnd = Math.max(1.4, (far / w.r) * 0.62);
  const Nx = L0 + cw * 0.5, Ny = T0 + ch * cam.fy;
  const Fx = (qEnd * w.x - Nx) / (qEnd - 1), Fy = (qEnd * w.y - Ny) / (qEnd - 1);
  const e = state === 'dive' || state === 'surface' ? smoothstep(0, 1, diveT) : 0;
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

  // ---- 推向电脑屏幕（操作指导）：推到屏幕铺满整个画面 ----
  guideT = Math.max(0, Math.min(1, guideT + (guideOn ? 1 : -1) * dt / GUIDE_DUR));
  const m = menu.screen();
  // 斜着的屏幕里能放下的最大正矩形（左边取靠里的那条、右边取靠里的那条……），放大到盖满画面
  const [qa, qb, qc, qd] = m.q;
  const ix0 = Math.max(qa.x, qd.x), ix1 = Math.min(qb.x, qc.x), iy0 = Math.max(qa.y, qb.y), iy1 = Math.min(qc.y, qd.y);
  const Z = Math.max(vw / (ix1 - ix0), vh / (iy1 - iy0)) * 1.04;
  const cx = (ix0 + ix1) / 2, cy = (iy0 + iy1) / 2;
  const GFx = (Z * cx - vw / 2) / (Z - 1), GFy = (Z * cy - vh / 2) / (Z - 1);
  const gq = Math.pow(Z, smoothstep(0, 1, guideT));
  const st = gq === 1 ? '' : `translate(${GFx * (1 - gq)}px, ${GFy * (1 - gq)}px) scale(${gq})`;
  if (st !== lastScene) {
    scene.style.transform = st;
    lastScene = st;
  }
  // 显示屏界面（900×600）：平时用仿射变换贴到倾斜的屏幕上（左上、右上、左下三个角对齐，往外多铺 2 像素免得露缝）；
  // 推近的后半段慢慢摆正，推到底时正着铺满整个画面（那时电脑边框已经在画面外了）
  {
    const [tl, tr, , bl] = m.q;
    const pad = 2 * menu.s;
    const k = 1 + (2 * pad) / Math.hypot(tr.x - tl.x, tr.y - tl.y);
    const A0 = [((tr.x - tl.x) / 900) * k, ((tr.y - tl.y) / 900) * k, ((bl.x - tl.x) / 600) * k, ((bl.y - tl.y) / 600) * k, tl.x - pad, tl.y - pad];
    // 推到底时：正着盖满画面（屏幕坐标），换算回场景坐标（场景之后会被放大 Z 倍）
    const sc = Math.max(vw / 900, vh / 600);
    const offx = (vw - 900 * sc) / 2, offy = (vh - 600 * sc) / 2;
    const A1 = [sc / Z, 0, 0, sc / Z, (offx - GFx * (1 - Z)) / Z, (offy - GFy * (1 - Z)) / Z];
    const f = smoothstep(0.45, 1, guideT);
    const M = A0.map((v, i) => v + (A1[i] - v) * f);
    const mt = `matrix(${M.join(',')})`;
    if (monitorEl.style.transform !== mt) monitorEl.style.transform = mt;
    // 推到底时看得到的范围（显示屏坐标）：文字只排在里面
    const L = Math.max(0, -offx / sc), T = Math.max(0, -offy / sc);
    const R = Math.min(900, (vw - offx) / sc), B = Math.min(600, (vh - offy) / sc);
    const key = [L, T, R, B].join();
    if (monitorEl.dataset.v !== key) {
      monitorEl.dataset.v = key;
      const ms = monitorEl.style;
      ms.setProperty('--vl', L + 'px');
      ms.setProperty('--vr', 900 - R + 'px');
      ms.setProperty('--vt', T + 'px');
      ms.setProperty('--vb', 600 - B + 'px');
      ms.setProperty('--vz', String(Math.min(1, (B - T) / 560, (R - L) / 820)));
    }
    drawIdle(Math.max(8, Math.round(m.w / r.scale)), Math.max(6, Math.round(m.h / r.scale)));
  }
  document.body.classList.toggle('guide', guideOn || guideT > 0);
  document.body.classList.toggle('guide-on', guideOn && guideT > 0.85);
}

/** 电脑屏幕的待机画面：声呐波形慢慢滚动，像素大小和游戏画面一样 */
const idleCv = monitorEl.querySelector('canvas') as HTMLCanvasElement;
const idleCtx = idleCv.getContext('2d')!;
function drawIdle(w: number, h: number) {
  if (idleCv.width !== w || idleCv.height !== h) {
    idleCv.width = w;
    idleCv.height = h;
  }
  if (document.body.classList.contains('guide-on')) return;
  const t = game.time, c = idleCtx;
  c.fillStyle = '#0d3a3c';
  c.fillRect(0, 0, w, h);
  // 顶上一条状态栏
  c.fillStyle = '#2c8a86';
  c.fillRect(1, 1, w - 2, 1);
  c.fillStyle = '#6fd8cc';
  for (let i = 0; i < 3; i++) c.fillRect(2 + i * 3, 3, 2, 1);
  if (Math.sin(t * 3) > 0) c.fillRect(w - 4, 3, 2, 1);
  // 滚动的海床波形
  const base = h - 2;
  for (let x = 1; x < w - 1; x++) {
    const u = x + t * 4;
    const yv = Math.round(base - (h * 0.22 + Math.sin(u * 0.21) * h * 0.13 + Math.sin(u * 0.53 + 1.3) * h * 0.07 + Math.max(0, Math.sin(u * 0.09)) * h * 0.2));
    c.fillStyle = '#6fd8cc';
    c.fillRect(x, yv, 1, 1);
    c.fillStyle = '#1f6a68';
    c.fillRect(x, yv + 1, 1, base - yv);
  }
  // 中间闪烁的目标点
  if ((t * 1.3) % 1 < 0.6) {
    c.fillStyle = '#e8fff8';
    c.fillRect(Math.round(w * 0.5), Math.round(h * 0.38), 1, 1);
  }
  // 扫描线（一条亮线从上往下走）
  const sy = Math.floor(((t * 0.5) % 1) * h);
  c.fillStyle = 'rgba(150,255,230,0.25)';
  c.fillRect(0, sy, w, 1);
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
  game.update(dt, input, cam, subR.screen);
  game.applyCamera(cam, r.W, r.H, dt);
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
