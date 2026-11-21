// 可平铺的 value noise：格点值按周期取模，所以生成的图首尾相接、可以无限循环。

export function hash2(x: number, y: number, seed: number): number {
  let h = (x * 374761393 + y * 668265263 + seed * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

function smooth(t: number) {
  return t * t * (3 - 2 * t);
}

/** 单层可平铺 value noise：cells 是这一层每个周期的格子数 */
export function valueNoiseTile(x: number, y: number, size: number, cells: number, seed: number): number {
  const fx = (x / size) * cells;
  const fy = (y / size) * cells;
  const x0 = Math.floor(fx), y0 = Math.floor(fy);
  const tx = smooth(fx - x0), ty = smooth(fy - y0);
  const m = (n: number) => ((n % cells) + cells) % cells;
  const a = hash2(m(x0), m(y0), seed);
  const b = hash2(m(x0 + 1), m(y0), seed);
  const c = hash2(m(x0), m(y0 + 1), seed);
  const d = hash2(m(x0 + 1), m(y0 + 1), seed);
  return a + (b - a) * tx + (c - a) * ty + (a - b - c + d) * tx * ty;
}

/** 生成 size×size 的循环分形噪声图（octaves 层，每层格子数翻倍、振幅减半），归一化到 0..1 */
export function fbmMap(size: number, baseCells: number, octaves: number, seed: number, gain = 0.5): Float32Array {
  const out = new Float32Array(size * size);
  let min = Infinity, max = -Infinity;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let v = 0, amp = 1, cells = baseCells;
      for (let o = 0; o < octaves; o++) {
        v += valueNoiseTile(x, y, size, cells, seed + o * 101) * amp;
        amp *= gain;
        cells *= 2;
      }
      out[y * size + x] = v;
      if (v < min) min = v;
      if (v > max) max = v;
    }
  }
  const span = max - min || 1;
  for (let i = 0; i < out.length; i++) out[i] = (out[i] - min) / span;
  return out;
}

export function smoothstep(a: number, b: number, x: number) {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}
