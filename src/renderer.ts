// 渲染器：约 300×250 的 Uint32Array 帧缓冲区，putImageData 输出，CSS 整数倍放大 + pixelated。

const BAYER4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];

export class Renderer {
  W = 0;
  H = 0;
  scale = 1;
  buf = new Uint32Array(0);
  /** 每个像素的深度（离镜头的距离），用于物体和地形之间的遮挡 */
  z = new Float32Array(0);
  private img!: ImageData;
  private ctx: CanvasRenderingContext2D;
  private vignette = new Float32Array(0);
  /** 后期：每通道量化级数（越小越复古），0 表示关闭 */
  levels = 28;
  vignetteStrength = 0.35;

  constructor(private canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('canvas 2d 不可用');
    this.ctx = ctx;
  }

  /** 按容器大小选整数放大倍数，让短边约 230 个像素 */
  resize(cw: number, ch: number, bias = 0): boolean {
    let s = Math.max(1, Math.round(Math.min(cw, ch) / 230)) + bias;
    while (Math.ceil(cw / s) > 440 || Math.ceil(ch / s) > 440) s++;
    const W = Math.ceil(cw / s);
    const H = Math.ceil(ch / s);
    if (W === this.W && H === this.H && s === this.scale) return false;
    this.W = W;
    this.H = H;
    this.scale = s;
    this.canvas.width = W;
    this.canvas.height = H;
    const st = this.canvas.style;
    st.width = W * s + 'px';
    st.height = H * s + 'px';
    st.left = Math.floor((cw - W * s) / 2) + 'px';
    st.top = Math.floor((ch - H * s) / 2) + 'px';
    this.img = this.ctx.createImageData(W, H);
    this.buf = new Uint32Array(this.img.data.buffer);
    this.z = new Float32Array(W * H);
    this.buildVignette();
    return true;
  }

  private buildVignette() {
    const { W, H } = this;
    this.vignette = new Float32Array(W * H);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const dx = (x / (W - 1)) * 2 - 1;
        const dy = (y / (H - 1)) * 2 - 1;
        const d = Math.max(0, Math.sqrt(dx * dx * 0.8 + dy * dy) - 0.55);
        this.vignette[y * W + x] = 1 - Math.min(1, d * d * 1.6) * this.vignetteStrength;
      }
    }
  }

  private qLut = new Uint8Array(16 * 256);
  private qLevels = -1;

  private rotBuf = new Uint32Array(0);
  /** 把整幅画面绕 (cx, cy) 旋转 angle（座舱里随艇身横滚），出界的像素用该行的雾色 */
  rotate(angle: number, cx: number, cy: number, rowFill: Uint32Array) {
    if (Math.abs(angle) < 0.004) return;
    const { W, H, buf } = this;
    if (this.rotBuf.length !== buf.length) this.rotBuf = new Uint32Array(buf.length);
    const src = this.rotBuf;
    src.set(buf);
    const c = Math.cos(angle), s = Math.sin(angle);
    for (let y = 0; y < H; y++) {
      const dy = y + 0.5 - cy;
      let sx = c * (0.5 - cx) + s * dy + cx;
      let sy = -s * (0.5 - cx) + c * dy + cy;
      let i = y * W;
      for (let x = 0; x < W; x++, i++, sx += c, sy -= s) {
        const ix = Math.floor(sx), iy = Math.floor(sy);
        if (ix < 0 || iy < 0 || ix >= W || iy >= H) {
          buf[i] = rowFill[iy < 0 ? 0 : iy >= H ? H - 1 : iy];
        } else buf[i] = src[iy * W + ix];
      }
    }
  }

  /** 后期：暗角 + 4×4 有序抖动量化（查表），然后输出到画布 */
  present(ox = 0, oy = 0) {
    const { buf, W, H, vignette } = this;
    const L = this.levels;
    if (L > 0) {
      if (this.qLevels !== L) {
        const step = 255 / (L - 1);
        for (let d = 0; d < 16; d++) {
          const off = (BAYER4[d] / 16 - 0.5) * step;
          for (let v = 0; v < 256; v++) {
            const q = Math.round((v + off) / step) * step;
            this.qLut[(d << 8) | v] = q < 0 ? 0 : q > 255 ? 255 : q;
          }
        }
        this.qLevels = L;
      }
      const lut = this.qLut;
      for (let y = 0; y < H; y++) {
        const row = y * W;
        const by = ((y + oy) & 3) << 2;
        for (let x = 0; x < W; x++) {
          const i = row + x;
          const c = buf[i];
          const v = vignette[i];
          const d = (by | ((x + ox) & 3)) << 8;
          const r = lut[d | (((c & 255) * v) | 0)];
          const g = lut[d | ((((c >> 8) & 255) * v) | 0)];
          const b = lut[d | ((((c >> 16) & 255) * v) | 0)];
          buf[i] = (0xff000000 | (b << 16) | (g << 8) | r) >>> 0;
        }
      }
    }
    this.ctx.putImageData(this.img, 0, 0);
  }
}
