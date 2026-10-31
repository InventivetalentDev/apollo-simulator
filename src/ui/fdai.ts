// The FDAI (flight director attitude indicator), the LM's attitude ball.  The
// ball is the stable member, which holds still in space, seen from inside the
// LM looking forward (+Z) with +X up, so its centre shows where the front of
// the LM points.  Around it: the roll scale, the attitude-error needles the
// computer drives through the CDU error counters, and the body-rate needles.

import { DEG, matVec, type Mat3, type Vec3 } from '../sim/attitude.ts';

/**
 * Error-counter counts that pin a needle.  NEEDLER (DAPIDLER_PROGRAM.agc):
 * 384 counts are 42 3/16 degrees, full scale is 5 1/16 degrees, and
 * "46 bits effectively pin the needles".
 */
export const ERROR_FULL_SCALE = 46;
/** Body rate at full deflection of a rate needle, rad/s. */
export const RATE_FULL_SCALE = 5 * DEG;

/**
 * The point of the ball that sits in the centre when the LM is at this FDAI
 * pitch and yaw, as a stable-member unit vector.  The FDAI turns the ball in
 * the order roll (about the line of sight), yaw, pitch.
 */
export function ballPoint(pitch: number, yaw: number): Vec3 {
  return [Math.sin(pitch) * Math.cos(yaw), -Math.sin(yaw), Math.cos(pitch) * Math.cos(yaw)];
}

/**
 * Where a stable-member direction appears on the ball's face, given the matrix
 * that turns stable-member coordinates into navigation-base coordinates:
 * [right, up, depth], with right and up in ball radii.  Depth is positive on
 * the visible side.
 */
export function onFace(m: Mat3, v: Vec3): Vec3 {
  const [x, y, z] = matVec(m, v);
  return [y, x, z];
}

/** The FDAI's pitch, yaw and roll, radians, from the stable-member-to-navigation-base matrix. */
export function fdaiAngles(m: Mat3): { pitch: number; yaw: number; roll: number } {
  return {
    pitch: Math.atan2(m[6], m[8]),
    yaw: Math.asin(Math.max(-1, Math.min(1, -m[7]))),
    roll: Math.atan2(m[1], m[4]),
  };
}

const clamp1 = (v: number) => Math.max(-1, Math.min(1, v));

// Colours: a light and a dark half, split along pitch 0 and 180.
const LIGHT: Vec3 = [222, 217, 204];
const DARK: Vec3 = [46, 51, 58];
const INK_ON_LIGHT = '#1d2126';
const INK_ON_DARK = '#c9cdd1';
const NEEDLE = '#e8a33d';
const CASE_INK = '#8d98a1';
const FONT = "'IBM Plex Mono', ui-monospace, Menlo, monospace";

export class Fdai {
  private readonly ctx: CanvasRenderingContext2D;
  private width = 0;
  private height = 0;
  private scale = 1;
  private image: ImageData | null = null;

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d')!;
  }

  /**
   * Draw the ball for `m` (stable member to navigation base), the error
   * needles for `errors` (error-counter counts about X, Y, Z) and the rate
   * needles for `rates` (rad/s about X, Y, Z).
   */
  draw(m: Mat3, errors: Vec3, rates: Vec3): void {
    const { clientWidth: w, clientHeight: h } = this.canvas;
    if (!w || !h) return;
    const scale = Math.min(devicePixelRatio || 1, 2);
    if (w !== this.width || h !== this.height || scale !== this.scale) {
      [this.width, this.height, this.scale] = [w, h, scale];
      this.canvas.width = Math.round(w * scale);
      this.canvas.height = Math.round(h * scale);
      this.image = null;
    }
    // Everything is drawn in the largest square that fits, centred.
    const size = Math.min(w, h);
    const [ox, oy] = [(w - size) / 2, (h - size) / 2];
    const ctx = this.ctx;
    const c = size / 2;
    const r = size * 0.3;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.paintBall(m, (ox + c) * scale, (oy + c) * scale, r * scale);
    ctx.setTransform(scale, 0, 0, scale, ox * scale, oy * scale);
    this.drawGrid(m, c, r);
    this.drawCase(m, c, r);
    this.drawNeedles(errors, rates, c, r);
  }

  /** The two halves, shaded so the ball looks round; centre and radius in device pixels. */
  private paintBall(m: Mat3, cx: number, cy: number, rp: number): void {
    const n = Math.ceil(2 * rp) + 4;
    if (!this.image || this.image.width !== n) this.image = this.ctx.createImageData(n, n);
    const data = this.image.data;
    const x0 = Math.floor(cx - rp) - 1;
    const y0 = Math.floor(cy - rp) - 1;
    const [centreX, centreY] = [cx - x0, cy - y0];
    // A pixel's stable-member X component decides its half: the light half is +X.
    const [ax, ay, az] = [m[0], m[3], m[6]];
    const edge = 1.2 / rp;
    for (let j = 0; j < n; j++) {
      const up = (centreY - j - 0.5) / rp;
      for (let i = 0; i < n; i++) {
        const right = (i + 0.5 - centreX) / rp;
        const d2 = right * right + up * up;
        const o = (j * n + i) * 4;
        if (d2 >= 1 + 2 * edge) {
          data[o + 3] = 0;
          continue;
        }
        const depth = Math.sqrt(Math.max(0, 1 - d2));
        const side = ax * up + ay * right + az * depth;
        const t = Math.max(0, Math.min(1, 0.5 + side / (2 * edge * Math.max(depth, 0.15))));
        const light = 0.62 + 0.38 * depth;
        for (let k = 0; k < 3; k++) data[o + k] = (DARK[k] + (LIGHT[k] - DARK[k]) * t) * light;
        data[o + 3] = 255 * Math.max(0, Math.min(1, (1 - Math.sqrt(d2)) / edge + 0.5));
      }
    }
    this.ctx.putImageData(this.image, x0, y0);
  }

  /** Pitch lines every 10 degrees, yaw lines every 30, and their numbers. */
  private drawGrid(m: Mat3, c: number, r: number): void {
    const ctx = this.ctx;
    const ink = { light: new Path2D(), dark: new Path2D() };
    const bold = { light: new Path2D(), dark: new Path2D() };
    const segment = (a: Vec3, b: Vec3, half: 'light' | 'dark', strong: boolean) => {
      if (a[2] < 0 || b[2] < 0) return;
      const path = (strong ? bold : ink)[half];
      path.moveTo(c + a[0] * r, c - a[1] * r);
      path.lineTo(c + b[0] * r, c - b[1] * r);
    };
    const halfOf = (pitch: number) => (Math.sin(pitch) >= 0 ? 'light' : 'dark');
    const STEP = 5 * DEG;
    // Pitch lines run between the poles, at constant pitch.
    for (let p = 0; p < 360; p += 10) {
      const pitch = p * DEG;
      if (p === 0 || p === 180) continue; // the halves' own edge shows these
      let prev = onFace(m, ballPoint(pitch, -85 * DEG));
      for (let y = -85 + 5; y <= 85; y += 5) {
        const next = onFace(m, ballPoint(pitch, y * DEG));
        segment(prev, next, halfOf(pitch), p % 30 === 0);
        prev = next;
      }
    }
    // Yaw lines circle the poles, at constant yaw.
    for (const y of [-60, -30, 0, 30, 60]) {
      let prev = onFace(m, ballPoint(0, y * DEG));
      for (let a = STEP; a <= 2 * Math.PI + 1e-9; a += STEP) {
        const next = onFace(m, ballPoint(a, y * DEG));
        segment(prev, next, halfOf(a - STEP / 2), y === 0);
        prev = next;
      }
    }
    ctx.lineCap = 'round';
    for (const half of ['light', 'dark'] as const) {
      ctx.strokeStyle = half === 'light' ? INK_ON_LIGHT : INK_ON_DARK;
      ctx.globalAlpha = 0.35;
      ctx.lineWidth = 0.7;
      ctx.stroke(ink[half]);
      ctx.globalAlpha = 0.75;
      ctx.lineWidth = 1.1;
      ctx.stroke(bold[half]);
    }
    ctx.globalAlpha = 1;

    // Numbers, printed on the ball: pitch along the yaw-0 line, yaw along pitch 0 and 180.
    ctx.font = `600 ${Math.max(8, r * 0.13)}px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const label = (pitch: number, yaw: number, text: string, align: 'center' | 'left') => {
      const at = onFace(m, ballPoint(pitch, yaw));
      if (at[2] < 0.5) return;
      // Along the direction of increasing pitch, as if printed on the ball,
      // but turned the right way up when the ball is upside down.
      const ahead = onFace(m, ballPoint(pitch + 0.02, yaw));
      let angle = Math.atan2(ahead[0] - at[0], ahead[1] - at[1]);
      const flip = Math.abs(angle) > Math.PI / 2;
      if (flip) angle += Math.PI;
      ctx.save();
      ctx.globalAlpha = Math.min(1, (at[2] - 0.5) / 0.3);
      ctx.translate(c + at[0] * r, c - at[1] * r);
      ctx.rotate(angle);
      ctx.scale(1, Math.max(0.35, at[2]));
      ctx.textAlign = align === 'center' ? 'center' : flip ? 'right' : 'left';
      ctx.fillStyle = halfOf(pitch + 1e-6) === 'light' ? INK_ON_LIGHT : INK_ON_DARK;
      ctx.fillText(text, 0, 0);
      ctx.restore();
    };
    // Pitch numbers just right of the yaw-0 line, clear of the needles that cross the centre.
    for (let p = 30; p < 360; p += 30) if (p !== 180) label(p * DEG, -4 * DEG, String(p), 'left');
    for (const y of [30, 60]) {
      for (const p of [10, 190]) {
        label(p * DEG, y * DEG, String(y), 'center');
        label(p * DEG, -y * DEG, String(360 - y), 'center');
      }
    }
  }

  /** The rim, the fixed roll scale, the roll index that turns with the ball, and the LM symbol. */
  private drawCase(m: Mat3, c: number, r: number): void {
    const ctx = this.ctx;
    ctx.strokeStyle = '#0b0d0f';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(c, c, r + 1, 0, 2 * Math.PI);
    ctx.stroke();

    // Roll v is read at the angle where the index stands when roll is v: counterclockwise from the top.
    const at = (v: number, radius: number): [number, number] => [c - Math.sin(v) * radius, c - Math.cos(v) * radius];
    ctx.strokeStyle = CASE_INK;
    ctx.fillStyle = CASE_INK;
    ctx.font = `500 ${Math.max(8, r * 0.12)}px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (let v = 0; v < 360; v += 10) {
      const major = v % 30 === 0;
      const [x1, y1] = at(v * DEG, r + 3);
      const [x2, y2] = at(v * DEG, r + (major ? 9 : 6));
      ctx.lineWidth = major ? 1.2 : 0.8;
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
      if (major && v % 90 !== 0) {
        const [x, y] = at(v * DEG, r * 1.25);
        ctx.fillText(String(v), x, y);
      }
    }

    // The roll index: a triangle on the rim that turns with the ball.
    const roll = fdaiAngles(m).roll;
    ctx.save();
    ctx.translate(c, c);
    ctx.rotate(-roll);
    ctx.fillStyle = NEEDLE;
    ctx.beginPath();
    ctx.moveTo(0, -r + 1);
    ctx.lineTo(-5, -r - 8);
    ctx.lineTo(5, -r - 8);
    ctx.closePath();
    ctx.fill();
    ctx.restore();

    // The LM symbol, fixed in the centre.
    ctx.strokeStyle = '#0b0d0f';
    ctx.lineWidth = 3.5;
    this.symbol(c, r);
    ctx.strokeStyle = NEEDLE;
    ctx.lineWidth = 1.6;
    this.symbol(c, r);
  }

  private symbol(c: number, r: number): void {
    const ctx = this.ctx;
    const w = r * 0.28;
    ctx.beginPath();
    ctx.moveTo(c - w, c);
    ctx.lineTo(c - w * 0.35, c);
    ctx.lineTo(c, c + w * 0.3);
    ctx.lineTo(c + w * 0.35, c);
    ctx.lineTo(c + w, c);
    ctx.stroke();
  }

  /**
   * Error needles across the face, rate needles on scales outside it: roll at
   * the top, pitch on the right, yaw at the bottom.  Each points the way the LM
   * should turn (errors) or is turning (rates): right for roll right, up for
   * nose up, left for yaw left.
   */
  private drawNeedles(errors: Vec3, rates: Vec3, c: number, r: number): void {
    const ctx = this.ctx;
    const reach = r * 0.62;
    // The counts are present minus wanted attitude: the needle shows the opposite, the way to turn.
    const turn = errors.map((n) => clamp1(-n / ERROR_FULL_SCALE) * reach) as Vec3;
    const needles: [number, number, number, number][] = [
      [c + turn[2], c - r, c + turn[2], c - r * 0.42], // roll, from the top
      [c + r, c - turn[1], c + r * 0.42, c - turn[1]], // pitch, from the right
      [c - turn[0], c + r, c - turn[0], c + r * 0.42], // yaw, from the bottom
    ];
    ctx.lineCap = 'butt';
    for (const [width, colour] of [[4, '#0b0d0f'], [2, NEEDLE]] as const) {
      ctx.lineWidth = width;
      ctx.strokeStyle = colour;
      for (const [x1, y1, x2, y2] of needles) {
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.stroke();
      }
    }

    // Rate scales: ticks at full scale, half scale and zero, and a pointer.
    const gap = r * 1.42;
    const half = r * 0.62;
    const rate = rates.map((w) => clamp1(w / RATE_FULL_SCALE) * half) as Vec3;
    ctx.strokeStyle = CASE_INK;
    ctx.fillStyle = CASE_INK;
    ctx.lineWidth = 1;
    ctx.font = `600 ${Math.max(8, r * 0.11)}px ${FONT}`;
    const scale = (horizontal: boolean, x: number, y: number) => {
      ctx.beginPath();
      for (const f of [-1, -0.5, 0, 0.5, 1]) {
        const len = f === 0 ? 5 : 3;
        if (horizontal) {
          ctx.moveTo(x + f * half, y - len);
          ctx.lineTo(x + f * half, y + len);
        } else {
          ctx.moveTo(x - len, y + f * half);
          ctx.lineTo(x + len, y + f * half);
        }
      }
      if (horizontal) {
        ctx.moveTo(x - half, y);
        ctx.lineTo(x + half, y);
      } else {
        ctx.moveTo(x, y - half);
        ctx.lineTo(x, y + half);
      }
      ctx.stroke();
    };
    const pointer = (x: number, y: number, towards: 'down' | 'up' | 'left') => {
      const [dx, dy] = towards === 'down' ? [0, 1] : towards === 'up' ? [0, -1] : [-1, 0];
      ctx.beginPath();
      ctx.moveTo(x + dx * 2, y + dy * 2);
      ctx.lineTo(x - dx * 7 - dy * 4, y - dy * 7 - dx * 4);
      ctx.lineTo(x - dx * 7 + dy * 4, y - dy * 7 + dx * 4);
      ctx.closePath();
      ctx.fill();
    };
    scale(true, c, c - gap);
    scale(false, c + gap, c);
    scale(true, c, c + gap);
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'right';
    ctx.fillText('ROLL', c - half - 6, c - gap);
    ctx.fillText('YAW', c - half - 6, c + gap);
    ctx.textAlign = 'center';
    ctx.fillText('PITCH', c + gap, c - half - 10);
    ctx.fillStyle = NEEDLE;
    pointer(c + rate[2], c - gap, 'down');
    pointer(c + gap, c - rate[1], 'left');
    pointer(c - rate[0], c + gap, 'up');
  }
}
