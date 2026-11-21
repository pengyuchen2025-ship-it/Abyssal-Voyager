// 操控：鼠标位置决定航向；单击翻滚；按住加速；F / E / 右键氮气加速；W/S、滚轮或触屏按钮上浮下潜；空格切换视角。
// 触屏：手指按住拖动 = 指向（在潜艇左右转向、上下升降）；轻点 = 翻滚；右下角按钮加速 / 上浮 / 下潜，右上角切换视角。

export class Input {
  /** 指针在帧缓冲区里的坐标；没有指针时为 null */
  px: number | null = null;
  py: number | null = null;
  boost = false;
  rise = 0; // -1 下潜 … 1 上浮
  turn = 0; // 键盘转向 -1 左 … 1 右
  wheel = 0; // 累积的滚轮量
  private keys = new Set<string>();
  private rollQueued = false;
  private viewQueued = false;
  private nitroQueued = false;
  private selectQueued = -1;
  private downAt = 0;
  private downX = 0;
  private downY = 0;
  private pointerDown = false;
  private pointerType = 'mouse';
  private holdBoost = false;
  private touchBoost = false;
  private touchRise = 0;
  touchUI = false;
  /** 开始界面 / 暂停时：不接受操作，潜艇按 demoTurn 自己慢慢游 */
  frozen = false;
  demoTurn = 0;

  constructor(stage: HTMLElement, private toFrame: (cx: number, cy: number) => [number, number]) {
    const st = stage;
    st.addEventListener('pointermove', (e) => this.move(e));
    st.addEventListener('pointerdown', (e) => {
      if ((e.target as HTMLElement).closest('[data-ui]')) return;
      // 右键：氮气加速
      if (e.button === 2) {
        this.nitroQueued = true;
        return;
      }
      st.setPointerCapture?.(e.pointerId);
      this.move(e);
      this.pointerDown = true;
      this.pointerType = e.pointerType;
      this.downAt = performance.now();
      this.downX = e.clientX;
      this.downY = e.clientY;
      if (e.pointerType === 'touch') this.touchUI = true;
    });
    const up = (e: PointerEvent) => {
      if (!this.pointerDown) return;
      this.pointerDown = false;
      const dt = performance.now() - this.downAt;
      const moved = Math.hypot(e.clientX - this.downX, e.clientY - this.downY);
      if (dt < 230 && moved < 14) this.rollQueued = true;
      this.holdBoost = false;
      if (e.pointerType === 'touch') {
        // 手指离开后保持当前航向
        this.px = this.py = null;
      }
    };
    st.addEventListener('pointerup', up);
    st.addEventListener('pointercancel', up);
    st.addEventListener('pointerleave', (e) => {
      if (e.pointerType === 'mouse') this.px = this.py = null;
    });
    st.addEventListener('contextmenu', (e) => e.preventDefault());
    st.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.wheel += Math.sign(e.deltaY) * -1;
    }, { passive: false });
    addEventListener('keydown', (e) => {
      if (e.code === 'Space') {
        e.preventDefault();
        if (!e.repeat) this.viewQueued = true;
      }
      if ((e.code === 'KeyF' || e.code === 'KeyE') && !e.repeat) this.nitroQueued = true;
      // 1 / 2 直接选视角
      if (e.code === 'Digit1' || e.code === 'Digit2') this.selectQueued = +e.code.slice(5) - 1;
      this.keys.add(e.code);
    });
    addEventListener('keyup', (e) => this.keys.delete(e.code));
    addEventListener('blur', () => {
      this.keys.clear();
      this.pointerDown = false;
      this.holdBoost = false;
    });
  }

  private move(e: PointerEvent) {
    const [x, y] = this.toFrame(e.clientX, e.clientY);
    this.px = x;
    this.py = y;
  }

  /** 绑定触屏按钮（按住生效） */
  bindHold(el: HTMLElement, on: () => void, off: () => void) {
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      el.setPointerCapture?.(e.pointerId);
      el.classList.add('on');
      on();
    });
    const end = () => {
      el.classList.remove('on');
      off();
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
  }

  setTouchBoost(v: boolean) { this.touchBoost = v; }
  setTouchRise(v: number) { this.touchRise = v; }
  queueView() { this.viewQueued = true; }
  queueNitro() { this.nitroQueued = true; }

  takeSelect(): number {
    const v = this.selectQueued;
    this.selectQueued = -1;
    return v;
  }

  takeNitro(): boolean {
    const n = this.nitroQueued;
    this.nitroQueued = false;
    return n;
  }

  /** 丢掉所有排队的操作和按住的状态（开始 / 继续游戏时调用，免得按下的那个键被当成操作） */
  clear() {
    this.rollQueued = this.viewQueued = this.nitroQueued = false;
    this.selectQueued = -1;
    this.wheel = 0;
    this.pointerDown = this.holdBoost = this.touchBoost = false;
    this.touchRise = 0;
    this.px = this.py = null;
  }

  /** 每帧调用：整理成本帧的操作 */
  poll() {
    if (this.frozen) {
      this.clear();
      this.boost = false;
      this.rise = 0;
      this.turn = this.demoTurn;
      return;
    }
    const k = this.keys;
    // 鼠标按住超过一小会儿算加速（短按是翻滚）
    if (this.pointerDown && this.pointerType === 'mouse' && performance.now() - this.downAt > 170) this.holdBoost = true;
    this.boost = this.holdBoost || this.touchBoost || k.has('ShiftLeft') || k.has('ShiftRight');
    this.turn = (k.has('KeyD') || k.has('ArrowRight') ? 1 : 0) - (k.has('KeyA') || k.has('ArrowLeft') ? 1 : 0);
    this.rise = (k.has('KeyW') || k.has('ArrowUp') ? 1 : 0) - (k.has('KeyS') || k.has('ArrowDown') ? 1 : 0) + this.touchRise;
    if (k.has('KeyR')) this.rollQueued = true;
  }

  takeRoll(): boolean {
    const r = this.rollQueued;
    this.rollQueued = false;
    return r;
  }

  takeView(): boolean {
    const v = this.viewQueued;
    this.viewQueued = false;
    return v;
  }

  takeWheel(): number {
    const w = this.wheel;
    this.wheel = 0;
    return w;
  }

  /** 触屏拖动时指针一直按着 */
  get held() {
    return this.pointerDown;
  }
}
