// 粒子：一直在飘的浮游光点（速度感的主要来源）和螺旋桨的气泡。

import { Camera, Projected } from './camera';
import { Renderer } from './renderer';
import { Water } from './water';
import { addPixel, blendPixel } from './draw';
import { hash2 } from './noise';

const MOTES = 760;
const BOX = 340; // 光点所在的立方体边长（跟着镜头循环）
const BOX_H = 130;

interface Bubble { x: number; y: number; h: number; vx: number; vy: number; life: number; max: number; size: number; ph: number }

export class Particles {
  private mx = new Float32Array(MOTES);
  private my = new Float32Array(MOTES);
  private mh = new Float32Array(MOTES);
  private bubbles: Bubble[] = [];
  private pj: Projected = { x: 0, y: 0, depth: 0, k: 0 };
  private pe: Projected = { x: 0, y: 0, depth: 0, k: 0 };

  constructor() {
    for (let i = 0; i < MOTES; i++) {
      this.mx[i] = hash2(i, 1, 77) * BOX;
      this.my[i] = hash2(i, 2, 77) * BOX;
      this.mh[i] = hash2(i, 3, 77) * BOX_H;
    }
  }

  emit(x: number, y: number, h: number, n: number, vx = 0, vy = 0, spread = 3) {
    for (let i = 0; i < n; i++) {
      if (this.bubbles.length > 700) this.bubbles.shift();
      this.bubbles.push({
        x: x + (Math.random() - 0.5) * spread, y: y + (Math.random() - 0.5) * spread, h: h + (Math.random() - 0.5) * spread,
        vx: vx * (0.7 + Math.random() * 0.6), vy: vy * (0.7 + Math.random() * 0.6),
        life: 0, max: 1.2 + Math.random() * 1.8, size: Math.random() < 0.22 ? 2 : 1, ph: Math.random() * 6,
      });
    }
  }

  update(dt: number) {
    for (const b of this.bubbles) {
      b.life += dt;
      b.h += dt * (5 + b.size * 3);
      // 螺旋桨推出的初速度很快被水拖住
      const drag = Math.exp(-dt * 2.6);
      b.vx *= drag;
      b.vy *= drag;
      b.x += b.vx * dt + Math.sin(b.life * 5 + b.ph) * dt * 1.5;
      b.y += b.vy * dt;
    }
    this.bubbles = this.bubbles.filter((b) => b.life < b.max);
  }

  /** vel：潜艇速度（世界单位/秒）；streak：高速时光点拉成往后划的短线的长度（秒） */
  draw(r: Renderer, cam: Camera, water: Water, t: number, vx = 0, vy = 0, streak = 0) {
    const pj = this.pj, pe = this.pe;
    const up = water.up;
    // 光点：在镜头支点周围的盒子里循环（往前多放一些），盒子边缘淡入淡出，不会突然冒出来
    const ahead = cam.cosP * 90;
    const ox = cam.x + cam.sinH * ahead - BOX / 2, oy = cam.y + cam.cosH * ahead - BOX / 2, oh = cam.h - BOX_H * 0.55;
    for (let i = 0; i < MOTES; i++) {
      const drift = t * (0.6 + (i % 5) * 0.2);
      const fx = ((((this.mx[i] + drift - ox) % BOX) + BOX) % BOX) / BOX;
      const fy = ((((this.my[i] + drift * 0.4 - oy) % BOX) + BOX) % BOX) / BOX;
      const fh = ((((this.mh[i] + Math.sin(t * 0.3 + i) * 2 - oh) % BOX_H) + BOX_H) % BOX_H) / BOX_H;
      const edge = Math.min(1, fx * 6, (1 - fx) * 6, fy * 6, (1 - fy) * 6, fh * 5, (1 - fh) * 5);
      if (edge <= 0) continue;
      const x = ox + fx * BOX, y = oy + fy * BOX, h = oh + fh * BOX_H;
      if (!cam.project(x, y, h, pj)) continue;
      const near = Math.max(0, 1 - pj.depth / 420);
      const tw = 0.6 + 0.4 * Math.sin(t * 2 + i * 1.7);
      const a = (70 * near * tw + 12) * edge;
      if (streak > 0.002 && cam.project(x + vx * streak, y + vy * streak, h, pe)) {
        // 高速：从光点往潜艇前进方向拉一条渐弱的短线（相对潜艇，水流往后划过）
        const steps = Math.min(40, Math.ceil(Math.max(Math.abs(pe.x - pj.x), Math.abs(pe.y - pj.y))));
        for (let q = 0; q <= steps; q++) {
          const f = 1 - q / (steps + 1);
          addPixel(r, pj.x + ((pe.x - pj.x) * q) / Math.max(1, steps), pj.y + ((pe.y - pj.y) * q) / Math.max(1, steps), a * 0.9 * f, a * f, a * 0.85 * f, pj.depth);
        }
      } else {
        addPixel(r, pj.x, pj.y, a * 0.9, a, a * 0.85, pj.depth);
        if (pj.k > 2.2) addPixel(r, pj.x + 1, pj.y, a * 0.5, a * 0.55, a * 0.5, pj.depth);
      }
    }
    // 气泡
    for (const b of this.bubbles) {
      if (!cam.project(b.x, b.y, b.h, pj)) continue;
      const fade = 1 - b.life / b.max;
      const a = 0.75 * fade;
      const cr = Math.min(255, up[0] + 60), cg = Math.min(255, up[1] + 40), cb = Math.min(255, up[2] + 40);
      const s = Math.max(1, Math.round(b.size * pj.k * 0.4));
      if (s <= 1) blendPixel(r, pj.x, pj.y, cr, cg, cb, a, pj.depth);
      else {
        for (let q = 0; q < s; q++) {
          blendPixel(r, pj.x + q, pj.y, cr, cg, cb, a, pj.depth);
          blendPixel(r, pj.x + q, pj.y + s - 1, cr, cg, cb, a * 0.6, pj.depth);
          blendPixel(r, pj.x, pj.y + q, cr, cg, cb, a, pj.depth);
          blendPixel(r, pj.x + s - 1, pj.y + q, cr, cg, cb, a * 0.6, pj.depth);
        }
      }
    }
  }
}
