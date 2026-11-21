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
import { Bridge, Rect, STATIONS, N_ST } from './bridge';
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

// ---- 舰桥（开始界面 / 菜单） ----
// bridge：在舰桥上（背后潜艇自己慢慢游）；dive：镜头穿过主圆窗进入游戏；play：游戏中；surface：从游戏退回舰桥
type State = 'bridge' | 'dive' | 'play' | 'surface';
let state: State = 'bridge';
const bridgeCv = $('bridge-cv') as HTMLCanvasElement;
const bridge = new Bridge(bridgeCv);
const bridgeUI = $('bridge-ui');
const stEls = Array.from(bridgeUI.querySelectorAll<HTMLElement>('.st'));
/** 舰桥朝向：以「操作台」为单位，可以一直加减（绕圈），显示时取模 */
let stIdx = +(q.get('station') ?? 0) || 0;
let pan = stIdx; // 当前（动画中）的朝向
let panFrom = pan, panT = 1;
const PAN_DUR = 0.5;
/** 进出游戏的过渡进度 0..1 */
let diveT = 0;
const DIVE_DUR = +(q.get('divedur') ?? 0) || 0.8; // 调试：?divedur=4 放慢穿窗过渡
let started = false;
let guideOpen = false;
const mod = (a: number, n: number) => ((a % n) + n) % n;

function setState(s: State) {
  state = s;
  document.body.classList.toggle('bridge', s === 'bridge');
  input.frozen = s !== 'play';
  // 丢掉按下的那个键，免得回车 / 空格同时被当成游戏操作
  input.clear();
}
function go(d: number) {
  if (state !== 'bridge' || guideOpen) return;
  panFrom = pan;
  panT = 0;
  stIdx += d;
}
function startDive() {
  if (state !== 'bridge' || guideOpen) return;
  // 不在主操作台就先转回来
  if (mod(stIdx, N_ST) !== 0) {
    go(-mod(stIdx, N_ST) <= -N_ST / 2 ? N_ST - mod(stIdx, N_ST) : -mod(stIdx, N_ST));
    return;
  }
  state = 'dive';
  diveT = 0;
  document.body.classList.remove('bridge');
  input.frozen = true;
  ($('btn-start') as HTMLElement).blur();
}
function surface(instant = false) {
  if (state !== 'play') return;
  state = 'surface';
  diveT = instant ? 0 : 1;
  input.frozen = true;
  input.clear();
}
function setGuide(open: boolean) {
  guideOpen = open;
  $('guide').classList.toggle('hide', !open);
  if (open) ($('guide-close') as HTMLElement).focus({ preventScroll: true });
}
$('btn-start').addEventListener('click', (e) => { e.stopPropagation(); startDive(); });
$('btn-guide').addEventListener('click', (e) => { e.stopPropagation(); setGuide(true); });
$('guide-close').addEventListener('click', (e) => { e.stopPropagation(); setGuide(false); });
$('guide').addEventListener('click', (e) => { if (e.target === $('guide')) setGuide(false); });
$('nav-l').addEventListener('click', (e) => { e.stopPropagation(); go(-1); });
$('nav-r').addEventListener('click', (e) => { e.stopPropagation(); go(1); });
$('btn-pause').addEventListener('click', (e) => { e.stopPropagation(); surface(); });
addEventListener('keydown', (e) => {
  if (e.repeat) return;
  if (guideOpen) {
    if (e.code === 'Escape' || e.code === 'KeyH' || e.code === 'Enter') { e.preventDefault(); setGuide(false); }
    return;
  }
  if (state === 'play') {
    if (e.code === 'Escape') surface();
    else if (e.code === 'KeyH') setGuide(true);
    return;
  }
  if (state !== 'bridge') return;
  if (e.code === 'ArrowLeft' || e.code === 'KeyA') go(-1);
  else if (e.code === 'ArrowRight' || e.code === 'KeyD') go(1);
  else if (e.code === 'Enter' || e.code === 'NumpadEnter' || e.code === 'Space') { e.preventDefault(); startDive(); }
  else if (e.code === 'KeyH') setGuide(true);
});
// 舰桥上左右滑动切换操作台
{
  let sx = 0, sy = 0, down = false;
  stage.addEventListener('pointerdown', (e) => { down = true; sx = e.clientX; sy = e.clientY; });
  stage.addEventListener('pointerup', (e) => {
    if (!down) return;
    down = false;
    const dx = e.clientX - sx, dy = e.clientY - sy;
    if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy) * 1.3) go(dx < 0 ? 1 : -1);
  });
}
// 切到别的标签页：回到舰桥
document.addEventListener('visibilitychange', () => {
  if (document.hidden) surface(true);
});

/**
 * 舰桥上：游戏镜头挪到主圆窗中间、并缩小（fit = 1/qEnd），潜艇就在圆窗正中。
 * 穿过圆窗：舰桥画布（CSS 缩放）和游戏镜头（缩放 + 支点位置）绕同一个不动点 F、按同一个倍数 q 放大，
 * q 从 1 到 qEnd（圆窗正好盖满整个屏幕）。到 qEnd 时游戏镜头正好回到正常的尾随镜头——
 * 两边一直对齐，中间没有任何跳变，就像镜头推进窗口。
 */
let lastXf = '';
function placeCanvases() {
  bridge.ensure(stage.clientWidth, stage.clientHeight);
  if (state === 'play') {
    if (cam.fx !== 0.5) {
      cam.fx = 0.5;
      cam.update(r.W, r.H);
    }
    if (lastXf !== 'none') {
      bridgeCv.style.display = 'none';
      bridgeCv.style.transform = '';
      lastXf = 'none';
    }
    return;
  }
  bridgeCv.style.display = '';
  const L0 = parseFloat(canvas.style.left) || 0, T0 = parseFloat(canvas.style.top) || 0;
  const cw = parseFloat(canvas.style.width), ch = parseFloat(canvas.style.height);
  const vw = stage.clientWidth, vh = stage.clientHeight;
  const w = bridge.window(pan);
  // 圆窗要放大多少倍才能盖满整个屏幕
  const far = Math.max(Math.hypot(w.x, w.y), Math.hypot(vw - w.x, w.y), Math.hypot(w.x, vh - w.y), Math.hypot(vw - w.x, vh - w.y));
  // 不必放大到盖满四个角：后半段舰桥淡出，露出的就是同一个游戏画面。这样舰桥上潜艇在窗里也不会太小
  const qEnd = Math.max(1.4, (far / w.r) * 0.62);
  // 正常尾随镜头里潜艇（镜头支点）在屏幕上的位置
  const Nx = L0 + cw * 0.5, Ny = T0 + ch * cam.fy;
  const Fx = (qEnd * w.x - Nx) / (qEnd - 1), Fy = (qEnd * w.y - Ny) / (qEnd - 1);
  const e = state === 'bridge' ? 0 : smoothstep(0, 1, diveT);
  const q = Math.pow(qEnd, e);
  // 游戏镜头：支点跟着放大走，缩放 = q / qEnd
  const Px = Fx + q * (w.x - Fx), Py = Fy + q * (w.y - Fy);
  cam.fx = (Px - L0) / cw;
  cam.fy = (Py - T0) / ch;
  cam.zoom *= q / qEnd;
  cam.update(r.W, r.H);
  // 舰桥画布（左上角在 0,0）：p → F + q (p − F)
  const bt = q === 1 ? '' : `translate(${Fx * (1 - q)}px, ${Fy * (1 - q)}px) scale(${q})`;
  const op = String(1 - smoothstep(0.55, 1, e));
  if (bt + op !== lastXf) {
    bridgeCv.style.transform = bt;
    bridgeCv.style.opacity = op;
    lastXf = bt + op;
  }
}

/** 舰桥文字层：和舰桥画布同位置同大小，里面每个元素按舰桥布局摆（单位：舰桥画布像素 × 放大倍数） */
let uiW = 0, uiH = 0;
function layoutUI() {
  bridge.ensure(stage.clientWidth, stage.clientHeight);
  if (uiW === bridge.L.W && uiH === bridge.L.H) return;
  uiW = bridge.L.W; uiH = bridge.L.H;
  const L = bridge.L, k = bridge.a;
  const st = bridgeUI.style;
  st.left = '0px';
  st.top = '0px';
  st.width = bridgeCv.style.width;
  st.height = bridgeCv.style.height;
  st.setProperty('--s', String(k));
  const rects: Record<string, Rect> = {
    plate: L.plate, screenL: L.screenL, screenR: L.screenR, upScreen: L.upScreen, hgScreen: L.hgScreen,
    hgHead: { x: L.hgScreen.x, y: L.hgScreen.y + 2, w: L.hgScreen.w, h: 9 },
    hgCard0: L.hgCards[0], hgCard1: L.hgCards[1], hgCard2: L.hgCards[2],
  };
  bridgeUI.querySelectorAll<HTMLElement>('[data-r]').forEach((el) => {
    const rc = rects[el.dataset.r!];
    el.style.left = rc.x * k + 'px';
    el.style.top = rc.y * k + 'px';
    el.style.width = rc.w * k + 'px';
    el.style.height = rc.h * k + 'px';
    el.style.setProperty('--ph', String(L.plate.h));
    el.style.setProperty('--sh', String(rc.h));
    el.style.setProperty('--sw', String(rc.w));
  });
}
let lastNav = -1;
function updateBridgeUI() {
  layoutUI();
  stEls.forEach((el, i) => {
    el.style.transform = `translateX(${Math.round(bridge.stationX(i, pan)) * bridge.a}px)`;
  });
  const cur = mod(stIdx, N_ST);
  if (cur !== lastNav) {
    lastNav = cur;
    $('nav-l-name').textContent = STATIONS[mod(cur - 1, N_ST)];
    $('nav-r-name').textContent = STATIONS[mod(cur + 1, N_ST)];
  }
}

// 调试参数直接进游戏
if (q.has('play') || q.has('view')) {
  setState('play');
  started = true;
} else setState('bridge');

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
let toastTimer = 0;
function showToast(text: string) {
  toast.textContent = text;
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toast.classList.remove('show'), 2600);
}

// ---- 主循环 ----
let last = performance.now();
let slowAcc = 0, slowN = 0;
const stats = { frames: 0, work: 0 };
(window as any).__game = game;
(window as any).__st = () => ({ state, diveT, pan, stIdx });
(window as any).__cam = cam;
(window as any).__dbg = { r, water, cam };
let preCopy: Uint32Array | null = null;
(window as any).__buf = () => (q.has('pre') && preCopy ? preCopy.slice() : r.buf.slice());

function frame(now: number) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  const w0 = performance.now();

  // ---- 舰桥：转向动画、进出游戏的过渡 ----
  if (panT < 1) {
    panT = Math.min(1, panT + dt / PAN_DUR);
    pan = panFrom + (stIdx - panFrom) * smoothstep(0, 1, panT);
  }
  if (state === 'dive') {
    diveT = Math.min(1, diveT + dt / DIVE_DUR);
    if (diveT >= 1) {
      setState('play');
      if (!started) {
        started = true;
        $('btn-start').querySelector('b')!.textContent = '继续潜航';
      }
    }
  } else if (state === 'surface') {
    diveT = Math.max(0, diveT - dt / DIVE_DUR);
    if (diveT <= 0) setState('bridge');
  }
  const paused = state === 'play' && guideOpen;
  if (!paused) {
    input.demoTurn = Math.sin(game.time * 0.23) * 0.3;
    game.update(dt, input, cam, subR.screen);
  }
  game.applyCamera(cam, r.W, r.H, paused ? 0 : dt);
  const onBridge = state !== 'play';
  placeCanvases();
  // 圆窗不在屏幕上时不用画海底
  const drawWorld = !onBridge || state !== 'bridge' || bridge.windowVisible(pan);
  const vp = game.vp;
  water.fogAmount = vp.fog;
  water.update(cam, r.H, game.region, game.time);

  const s = game.sub;
  if (drawWorld) {
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
  if (onBridge) bridge.draw(pan, game.time);
  updateBridgeUI();
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
    showToast(z ? '进入紫雾海域' : '回到青绿海域');
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
