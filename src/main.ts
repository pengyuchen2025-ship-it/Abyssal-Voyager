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
const help = $('help');
let helpHidden = false;
function hideHelp() {
  if (helpHidden) return;
  helpHidden = true;
  help.classList.add('hide');
}
setTimeout(hideHelp, 12000);
addEventListener('keydown', (e) => {
  if (e.code === 'KeyH') {
    helpHidden = !helpHidden;
    help.classList.toggle('hide', helpHidden);
  }
});
const depthEl = $('depth'), speedEl = $('speed'), zoneEl = $('zone'), toast = $('toast');
const nitroBar = $('nitro-fill'), nitroBox = $('nitro');
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
(window as any).__cam = cam;
(window as any).__dbg = { r, water, cam };
let preCopy: Uint32Array | null = null;
(window as any).__buf = () => (q.has('pre') && preCopy ? preCopy.slice() : r.buf.slice());

function frame(now: number) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  const w0 = performance.now();

  game.update(dt, input, cam, subR.screen);
  game.applyCamera(cam, r.W, r.H, dt);
  const vp = game.vp;
  water.fogAmount = vp.fog;
  water.update(cam, r.H, game.region, game.time);

  renderTerrain(r, cam, world, water, { far: vp.terFar, caustics: vp.caus });
  water.renderSurface(r, cam);
  const s = game.sub;
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
  if (q.has('pre')) preCopy = r.buf.slice();
  r.present();

  // ---- HUD ----
  const depth = Math.round((SURFACE_H - s.h) * 0.6);
  depthEl.textContent = String(depth).padStart(3, '0');
  speedEl.textContent = String(Math.round(game.speed * 0.5)).padStart(2, '0');
  viewBtn.textContent = MODE_NAMES[game.viewTarget];
  document.body.classList.toggle('scope', game.viewTarget === Mode.Periscope);
  nitroBar.style.width = (game.nitro * 100).toFixed(1) + '%';
  nitroBox.classList.toggle('on', game.nitroOn);
  nitroBox.classList.toggle('ready', !game.nitroOn && game.nitro >= 0.25);
  const z = game.region > 0.6 ? 1 : game.region < 0.4 ? 0 : zone;
  if (z !== zone) {
    zone = z;
    showToast(z ? '进入紫雾海域' : '回到青绿海域');
  }
  zoneEl.textContent = zone ? '紫雾海域' : '青绿海域';
  if (!helpHidden && game.time > 1.5 && (input.px !== null || input.boost)) setTimeout(hideHelp, 5000);

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
