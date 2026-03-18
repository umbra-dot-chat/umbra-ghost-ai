/**
 * Reference signal generators for audio/video diagnostic testing.
 *
 * Audio: generates a 440Hz sine wave (A4 concert pitch) as raw PCM s16le.
 * Video: generates a simple test pattern with frame counter.
 *
 * These bypass FFmpeg entirely and feed directly to RTCAudioSource/RTCVideoSource,
 * isolating the WebRTC pipeline from decode timing issues.
 */

// ── Constants ─────────────────────────────────────────────────────────────────

const SAMPLE_RATE = 48000;
const BITS_PER_SAMPLE = 16;
const CHANNELS = 1;
const FRAME_DURATION_MS = 10;
const SAMPLES_PER_FRAME = (SAMPLE_RATE * FRAME_DURATION_MS) / 1000; // 480

// ── Audio: 440Hz sine wave ────────────────────────────────────────────────────

/**
 * Generate a single 10ms audio frame of a 440Hz sine wave.
 * Phase is tracked via the sampleOffset parameter to maintain continuity
 * across calls.
 */
export function generate440HzFrame(sampleOffset: number, amplitude = 0.8): {
  samples: Int16Array;
  nextOffset: number;
} {
  const samples = new Int16Array(SAMPLES_PER_FRAME);
  const freq = 440;
  const maxVal = 32767 * amplitude;

  for (let i = 0; i < SAMPLES_PER_FRAME; i++) {
    const t = (sampleOffset + i) / SAMPLE_RATE;
    samples[i] = Math.round(Math.sin(2 * Math.PI * freq * t) * maxVal);
  }

  return {
    samples,
    nextOffset: sampleOffset + SAMPLES_PER_FRAME,
  };
}

/**
 * AudioTestSignal — continuous 440Hz tone generator that feeds directly
 * to RTCAudioSource, bypassing FFmpeg decode entirely.
 */
export class AudioTestSignal {
  private source: { onData(data: any): void };
  private stopped = false;
  private feedTimeout: ReturnType<typeof setTimeout> | null = null;
  private sampleOffset = 0;
  private _framesDelivered = 0;

  // Drift-compensating timer state
  private feedStartTime: bigint = BigInt(0);
  private feedTickCount = 0;

  constructor(audioSource: { onData(data: any): void }) {
    this.source = audioSource;
  }

  start(): void {
    this.stopped = false;
    this.sampleOffset = 0;
    this._framesDelivered = 0;
    this.feedStartTime = process.hrtime.bigint();
    this.feedTickCount = 0;

    const intervalNs = BigInt(FRAME_DURATION_MS * 1_000_000);

    const tick = () => {
      if (this.stopped) return;

      const { samples, nextOffset } = generate440HzFrame(this.sampleOffset);
      this.sampleOffset = nextOffset;
      this._framesDelivered++;

      this.source.onData({
        samples,
        sampleRate: SAMPLE_RATE,
        bitsPerSample: BITS_PER_SAMPLE,
        channelCount: CHANNELS,
        numberOfFrames: SAMPLES_PER_FRAME,
      });

      this.feedTickCount++;
      const nextTargetNs = this.feedStartTime + BigInt(this.feedTickCount) * intervalNs;
      const nowNs = process.hrtime.bigint();
      const delayNs = Number(nextTargetNs - nowNs);

      const maxBehindNs = Number(intervalNs) * 2;
      if (delayNs < -maxBehindNs) {
        this.feedStartTime = nowNs;
        this.feedTickCount = 0;
        this.feedTimeout = setTimeout(tick, FRAME_DURATION_MS);
      } else {
        this.feedTimeout = setTimeout(tick, Math.max(1, delayNs / 1_000_000));
      }
    };

    this.feedTimeout = setTimeout(tick, FRAME_DURATION_MS);
  }

  stop(): void {
    this.stopped = true;
    if (this.feedTimeout) {
      clearTimeout(this.feedTimeout);
      this.feedTimeout = null;
    }
  }

  get framesDelivered(): number {
    return this._framesDelivered;
  }
}

// ── Video: test pattern with frame counter ────────────────────────────────────

/**
 * Generate a simple I420 test frame with a visible frame counter.
 * Uses color bars in the top portion and embeds the frame number
 * as a binary pattern in the bottom-left corner for automated analysis.
 */
export function generateTestFrame(
  width: number,
  height: number,
  frameNumber: number,
): Buffer {
  const ySize = width * height;
  const uvSize = (width / 2) * (height / 2);
  const frame = Buffer.alloc(ySize + uvSize * 2);

  // Y plane — draw horizontal bars with varying luma
  const barCount = 8;
  const barHeight = Math.floor(height / barCount);
  const lumaValues = [16, 82, 145, 210, 235, 170, 106, 41]; // Standard color bar Y values

  for (let y = 0; y < height; y++) {
    const barIndex = Math.min(Math.floor(y / barHeight), barCount - 1);
    const luma = lumaValues[barIndex];
    for (let x = 0; x < width; x++) {
      frame[y * width + x] = luma;
    }
  }

  // Embed frame number as binary pattern in bottom-left (32 pixels wide, 16 tall)
  const patternY = height - 20;
  const patternX = 4;
  for (let bit = 0; bit < 24; bit++) {
    const isSet = (frameNumber >> bit) & 1;
    const luma = isSet ? 235 : 16;
    const px = patternX + bit * 2;
    if (px + 1 < width && patternY + 3 < height) {
      for (let dy = 0; dy < 4; dy++) {
        for (let dx = 0; dx < 2; dx++) {
          frame[(patternY + dy) * width + px + dx] = luma;
        }
      }
    }
  }

  // U plane — neutral chroma (128 = no color)
  const uOffset = ySize;
  frame.fill(128, uOffset, uOffset + uvSize);

  // V plane — neutral chroma
  const vOffset = ySize + uvSize;
  frame.fill(128, vOffset, vOffset + uvSize);

  return frame;
}

/**
 * VideoTestSignal — generates I420 test pattern frames with embedded frame counter.
 */
export class VideoTestSignal {
  private source: { onFrame(frame: any): void };
  private stopped = false;
  private feedTimeout: ReturnType<typeof setTimeout> | null = null;
  private frameNumber = 0;
  private width: number;
  private height: number;
  private fps: number;

  // Drift-compensating timer
  private feedStartTime: bigint = BigInt(0);
  private feedTickCount = 0;

  constructor(
    videoSource: { onFrame(frame: any): void },
    width = 640,
    height = 480,
    fps = 30,
  ) {
    this.source = videoSource;
    this.width = width;
    this.height = height;
    this.fps = fps;
  }

  start(): void {
    this.stopped = false;
    this.frameNumber = 0;
    this.feedStartTime = process.hrtime.bigint();
    this.feedTickCount = 0;

    const intervalMs = 1000 / this.fps;
    const intervalNs = BigInt(Math.round(intervalMs * 1_000_000));

    const tick = () => {
      if (this.stopped) return;

      const frameData = generateTestFrame(this.width, this.height, this.frameNumber);
      this.frameNumber++;

      this.source.onFrame({
        width: this.width,
        height: this.height,
        data: new Uint8ClampedArray(frameData.buffer, frameData.byteOffset, frameData.byteLength),
      });

      this.feedTickCount++;
      const nextTargetNs = this.feedStartTime + BigInt(this.feedTickCount) * intervalNs;
      const nowNs = process.hrtime.bigint();
      const delayNs = Number(nextTargetNs - nowNs);

      const maxBehindNs = Number(intervalNs) * 2;
      if (delayNs < -maxBehindNs) {
        this.feedStartTime = nowNs;
        this.feedTickCount = 0;
        this.feedTimeout = setTimeout(tick, intervalMs);
      } else {
        this.feedTimeout = setTimeout(tick, Math.max(1, delayNs / 1_000_000));
      }
    };

    this.feedTimeout = setTimeout(tick, intervalMs);
  }

  stop(): void {
    this.stopped = true;
    if (this.feedTimeout) {
      clearTimeout(this.feedTimeout);
      this.feedTimeout = null;
    }
  }

  get framesGenerated(): number {
    return this.frameNumber;
  }
}
