/**
 * VideoSource — decodes video files (MP4/MKV/MOV) to raw I420 frames
 * and feeds them into a WebRTC video track via wrtc's nonstandard API.
 *
 * Uses FFmpeg to decode video to raw YUV420P frames at the source's native
 * resolution and frame rate, then feeds them to RTCVideoSource.
 *
 * Supports:
 * - Seamless looping via FFmpeg's -stream_loop
 * - GPU-accelerated decoding via NVDEC (h264_cuvid)
 * - Large frame buffer with pre-buffering for smooth playback
 * - Track switching
 * - Pause/resume (sends last frame repeatedly when paused)
 */

import { spawn, execSync, type ChildProcess } from 'child_process';
import type { Logger } from '../config.js';

// ── Types ─────────────────────────────────────────────────────────────────────

/** wrtc nonstandard RTCVideoSource interface */
interface RTCVideoSource {
  createTrack(): MediaStreamTrack;
  onFrame(frame: RTCVideoFrame): void;
}

interface RTCVideoFrame {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const DEFAULT_WIDTH = 1280;
const DEFAULT_HEIGHT = 720;
const DEFAULT_FPS = 24;

// Buffer 2 seconds of video to absorb decode/network hiccups
// (smaller buffer = lower memory, faster startup)
const DEFAULT_MAX_BUFFERED_FRAMES = 60;
// Wait for ~500ms of frames before starting feed (faster startup)
const PRE_BUFFER_FRAMES = 15;

// ── VideoSource ───────────────────────────────────────────────────────────────

export class VideoSource {
  private source: RTCVideoSource;
  private log: Logger;
  private ffmpegPath: string;

  private currentFilePath: string | null = null;
  private ffmpegProcess: ChildProcess | null = null;
  private feedTimeout: ReturnType<typeof setTimeout> | null = null;
  private paused = false;
  private stopped = false;
  private preBuffering = false;

  // Frame buffer — stores decoded I420 frames
  private frameBuffer: Buffer[] = [];
  private maxBufferedFrames = DEFAULT_MAX_BUFFERED_FRAMES;
  private lastFrame: Buffer | null = null;

  // Diagnostics
  private _droppedFrames = 0;
  private _framesDelivered = 0;

  // Frame timing diagnostics
  private _timingAlerts = 0;
  private _lastFeedTime: bigint | null = null;
  private _intervalSum = 0;
  private _intervalCount = 0;

  // Drift-compensating timer state
  private _feedStartTime: bigint = BigInt(0);
  private _feedTickCount = 0;

  // Video dimensions and timing
  private width = DEFAULT_WIDTH;
  private height = DEFAULT_HEIGHT;
  private fps = DEFAULT_FPS;
  private frameIntervalMs = 1000 / DEFAULT_FPS;

  // Loop tracking
  private looping = true;
  private onTrackEnded: (() => void) | null = null;

  // GPU decode availability (cached)
  private static gpuAvailable: boolean | null = null;

  // Frame size in bytes for I420 (Y plane + U plane + V plane)
  private get frameSize(): number {
    return this.width * this.height * 3 / 2;
  }

  constructor(videoSource: RTCVideoSource, ffmpegPath: string, log: Logger) {
    this.source = videoSource;
    this.ffmpegPath = ffmpegPath;
    this.log = log;
  }

  /**
   * Start playing a video file. Decodes via FFmpeg to raw I420 frames
   * and feeds them at the video's frame rate.
   */
  start(
    filePath: string,
    options?: {
      width?: number;
      height?: number;
      fps?: number;
      loop?: boolean;
      onTrackEnded?: () => void;
    },
  ): void {
    this.stop();

    this.currentFilePath = filePath;
    this.width = options?.width ?? DEFAULT_WIDTH;
    this.height = options?.height ?? DEFAULT_HEIGHT;
    this.fps = options?.fps ?? DEFAULT_FPS;
    this.frameIntervalMs = 1000 / this.fps;
    this.looping = options?.loop ?? true;
    this.onTrackEnded = options?.onTrackEnded ?? null;
    this.stopped = false;
    this.paused = false;
    this.frameBuffer = [];
    this.lastFrame = null;
    this.preBuffering = true;
    this._droppedFrames = 0;
    this._framesDelivered = 0;

    this.startDecoding(filePath);
    // Don't start feeding yet — wait for pre-buffer to fill
    // The decode handler will call startFeeding() once we have enough frames

    this.log.info(`[VIDEO] Started playback: ${filePath} (${this.width}x${this.height} @ ${this.fps}fps, loop=${this.looping})`);
  }

  /** Switch to a different video file. */
  switchVideo(filePath: string, options?: { width?: number; height?: number; fps?: number }): void {
    if (this.stopped) {
      this.start(filePath, options);
      return;
    }

    this.killFfmpeg();
    this.frameBuffer = [];
    this.currentFilePath = filePath;

    // Clear lastFrame — it holds data from the OLD resolution.
    // Without this, feedFrame() falls back to lastFrame during pre-buffering
    // and wrtc rejects it because the byteLength doesn't match the new dimensions.
    this.lastFrame = null;

    if (options?.width) this.width = options.width;
    if (options?.height) this.height = options.height;
    if (options?.fps) {
      this.fps = options.fps;
      this.frameIntervalMs = 1000 / this.fps;
    }

    this.log.debug(`[VIDEO] Switching to: ${filePath} (${this.width}x${this.height}@${this.fps}fps, frameSize=${this.frameSize})`);

    // Restart with pre-buffering
    this.preBuffering = true;
    this.startDecoding(filePath);
  }

  /** Pause video (sends last frame repeatedly). */
  pause(): void {
    this.paused = true;
    this.log.debug('[VIDEO] Paused');
  }

  /** Resume video playback. */
  resume(): void {
    this.paused = false;
    this.log.debug('[VIDEO] Resumed');
  }

  /** Stop playback and clean up. */
  stop(): void {
    this.stopped = true;
    this.killFfmpeg();

    if (this.feedTimeout) {
      clearTimeout(this.feedTimeout);
      this.feedTimeout = null;
    }

    this.frameBuffer = [];
    this.lastFrame = null;
    this.currentFilePath = null;

    this.log.debug('[VIDEO] Stopped');
  }

  get isPlaying(): boolean {
    return !this.stopped && !this.paused;
  }

  get currentFile(): string | null {
    return this.currentFilePath;
  }

  // ── Diagnostics ─────────────────────────────────────────────────────────

  /** Number of frames currently in the buffer. */
  get bufferedFrames(): number {
    return this.frameBuffer.length;
  }

  /** Number of frames dropped due to buffer overflow. */
  get droppedFrames(): number {
    return this._droppedFrames;
  }

  /** Total frames delivered to WebRTC. */
  get framesDelivered(): number {
    return this._framesDelivered;
  }

  /** Buffer health ratio (0 = empty, 1 = full). */
  get bufferHealth(): number {
    return this.frameBuffer.length / this.maxBufferedFrames;
  }

  /** Current video dimensions. */
  get resolution(): { width: number; height: number } {
    return { width: this.width, height: this.height };
  }

  /** Current target FPS. */
  get targetFps(): number {
    return this.fps;
  }

  /** Number of times frame interval drifted >5ms from target. */
  get timingAlerts(): number {
    return this._timingAlerts;
  }

  /** Most recent frame interval in ms (0 if no data yet). */
  get lastIntervalMs(): number {
    return this._intervalCount > 0
      ? this._intervalSum / this._intervalCount
      : 0;
  }

  /** Average frame interval in ms across all measured frames. */
  get avgIntervalMs(): number {
    return this._intervalCount > 0
      ? this._intervalSum / this._intervalCount
      : 0;
  }

  // ── GPU detection ─────────────────────────────────────────────────────────

  private checkGpuAvailable(): boolean {
    if (VideoSource.gpuAvailable !== null) return VideoSource.gpuAvailable;

    try {
      // Use 256x256 — NVENC requires minimum ~144x144 (64x64 causes "Frame Dimension" error)
      execSync(`${this.ffmpegPath} -hwaccel cuda -f lavfi -i nullsrc=s=256x256:d=0.1 -c:v h264_nvenc -f null - 2>/dev/null`, {
        timeout: 5000,
        stdio: 'pipe',
      });
      VideoSource.gpuAvailable = true;
      this.log.info('[VIDEO] NVIDIA GPU acceleration available (NVDEC + NVENC)');
    } catch {
      VideoSource.gpuAvailable = false;
      this.log.info('[VIDEO] GPU acceleration not available, using CPU decode');
    }
    return VideoSource.gpuAvailable;
  }

  // ── Decoding ────────────────────────────────────────────────────────────

  private startDecoding(filePath: string): void {
    const useGpu = this.checkGpuAvailable();

    const args: string[] = [];

    // Low-latency decode flags: minimize probing and analysis time
    args.push(
      '-probesize', '1000000',       // 1MB probe (faster startup)
      '-analyzeduration', '500000',  // 500ms analysis (faster startup)
    );

    // GPU-accelerated decoding with NVDEC
    // Use -hwaccel cuda WITHOUT -hwaccel_output_format cuda, because we need
    // frames back on CPU for rawvideo pipe output. NVDEC still handles the
    // decode; FFmpeg auto-transfers frames to system memory for the output stage.
    if (useGpu) {
      args.push('-hwaccel', 'cuda');
    }

    // Limit CPU threads for decoding — leave headroom for wrtc's software
    // VP8/H264 encoder which runs on the same CPU. Using 2 threads for
    // decode leaves 4 cores available for encoding on a 6-core system.
    if (!useGpu) {
      args.push('-threads', '2');
    } else {
      // Even with GPU decode, scaling still uses CPU — limit threads
      args.push('-threads', '2');
    }

    // Seamless looping: let FFmpeg loop the file infinitely
    // This avoids the gap from restarting FFmpeg on each loop
    if (this.looping) {
      args.push('-stream_loop', '-1');
    }

    args.push(
      '-i', filePath,
      '-f', 'rawvideo',
      '-pix_fmt', 'yuv420p',       // I420 format — required by wrtc
      '-s', `${this.width}x${this.height}`,
      '-r', String(this.fps),
      '-sws_flags', 'fast_bilinear', // Fastest scaling (vs bicubic/bilinear)
      '-v', 'error',
      'pipe:1',
    );

    this.ffmpegProcess = spawn(this.ffmpegPath, args);
    this.attachFfmpegHandlers(filePath);
  }

  /**
   * Start playing from an FFmpeg filter source (e.g., testsrc2, smptebars).
   * No input file needed — FFmpeg generates synthetic video.
   */
  startFromFilter(
    filterSpec: string,
    options?: {
      width?: number;
      height?: number;
      fps?: number;
      loop?: boolean;
      onTrackEnded?: () => void;
    },
  ): void {
    this.stop();

    this.currentFilePath = `filter:${filterSpec}`;
    this.width = options?.width ?? DEFAULT_WIDTH;
    this.height = options?.height ?? DEFAULT_HEIGHT;
    this.fps = options?.fps ?? DEFAULT_FPS;
    this.frameIntervalMs = 1000 / this.fps;
    this.looping = options?.loop ?? true;
    this.onTrackEnded = options?.onTrackEnded ?? null;
    this.stopped = false;
    this.paused = false;
    this.frameBuffer = [];
    this.lastFrame = null;
    this.preBuffering = true;
    this._droppedFrames = 0;
    this._framesDelivered = 0;

    this.startFilterDecoding(filterSpec);

    this.log.info(`[VIDEO] Started filter source: ${filterSpec} (${this.width}x${this.height} @ ${this.fps}fps)`);
  }

  private startFilterDecoding(filterSpec: string): void {
    // No GPU needed for filter sources — they're CPU-generated
    const args: string[] = [
      '-f', 'lavfi',
      '-i', filterSpec,
      '-f', 'rawvideo',
      '-pix_fmt', 'yuv420p',
      '-s', `${this.width}x${this.height}`,
      '-r', String(this.fps),
      '-v', 'error',
      'pipe:1',
    ];

    this.ffmpegProcess = spawn(this.ffmpegPath, args);
    this.attachFfmpegHandlers(`filter:${filterSpec}`);
  }

  /**
   * Shared stdout/stderr/close/error handler for FFmpeg processes.
   * Used by both startDecoding() (file-based) and startFilterDecoding() (filter-based).
   */
  private attachFfmpegHandlers(sourceLabel: string): void {
    let partialBuffer = Buffer.alloc(0);

    this.ffmpegProcess!.stdout?.on('data', (chunk: Buffer) => {
      partialBuffer = Buffer.concat([partialBuffer, chunk]);

      while (partialBuffer.length >= this.frameSize) {
        const frame = partialBuffer.subarray(0, this.frameSize);
        partialBuffer = partialBuffer.subarray(this.frameSize);

        if (this.frameBuffer.length < this.maxBufferedFrames) {
          this.frameBuffer.push(Buffer.from(frame));
        } else {
          // Buffer full — drop oldest frame
          this.frameBuffer.shift();
          this.frameBuffer.push(Buffer.from(frame));
          this._droppedFrames++;
        }
      }

      // BACKPRESSURE: pause FFmpeg when frame buffer is >80% full.
      // FFmpeg decodes much faster than real-time, so without this the
      // frame buffer constantly overflows (dropping frames) and wastes
      // CPU/memory on decoding frames we'll never display.
      if (this.ffmpegProcess?.stdout && this.frameBuffer.length > this.maxBufferedFrames * 0.8) {
        this.ffmpegProcess.stdout.pause();
      }

      // Start feeding once we have enough frames pre-buffered
      if (this.preBuffering && this.frameBuffer.length >= PRE_BUFFER_FRAMES) {
        this.preBuffering = false;
        this.startFeeding();
        this.log.debug(`[VIDEO] Pre-buffer filled (${this.frameBuffer.length} frames), starting feed`);
      }
    });

    this.ffmpegProcess!.stderr?.on('data', (data: Buffer) => {
      const msg = data.toString().trim();
      if (msg) this.log.debug(`[FFMPEG-VIDEO] ${msg}`);
    });

    this.ffmpegProcess!.on('close', (code) => {
      if (this.stopped) return;

      if (code === 0 || code === null) {
        this.log.debug(`[VIDEO] FFmpeg finished decoding: ${sourceLabel}`);
      } else {
        this.log.error(`[VIDEO] FFmpeg exited with code ${code}`);
      }
    });

    this.ffmpegProcess!.on('error', (err) => {
      this.log.error('[VIDEO] FFmpeg spawn error:', err);
    });
  }

  // ── Feeding ─────────────────────────────────────────────────────────────

  /**
   * Start frame feeding with drift-compensating setTimeout.
   *
   * Unlike setInterval which drifts and can fire in bursts when the event loop
   * is busy, this calculates absolute wall-clock targets for each frame delivery.
   * If the event loop delays a callback, the next timeout is shortened to catch up,
   * but we never deliver more than one frame per callback — preventing the burst
   * delivery that causes fast-playback on the client side.
   */
  private startFeeding(): void {
    if (this.feedTimeout) {
      clearTimeout(this.feedTimeout);
    }

    this._feedStartTime = process.hrtime.bigint();
    this._feedTickCount = 0;
    const intervalNs = BigInt(Math.round(this.frameIntervalMs * 1_000_000));

    const tick = () => {
      if (this.stopped) return;
      this.feedFrame();
      this._feedTickCount++;

      // Calculate absolute target time for next frame
      const nextTargetNs = this._feedStartTime + BigInt(this._feedTickCount) * intervalNs;
      const nowNs = process.hrtime.bigint();
      const delayNs = Number(nextTargetNs - nowNs);

      // Clamp: never go below 1ms (avoid tight spin), never burst
      // If we're very far behind (>2 frame intervals), skip ahead to avoid
      // perpetual catch-up that would starve the event loop
      const maxBehindNs = Number(intervalNs) * 2;
      if (delayNs < -maxBehindNs) {
        // Too far behind — reset the timeline to now
        this._feedStartTime = nowNs;
        this._feedTickCount = 0;
        this.feedTimeout = setTimeout(tick, this.frameIntervalMs);
      } else {
        const delayMs = Math.max(1, delayNs / 1_000_000);
        this.feedTimeout = setTimeout(tick, delayMs);
      }
    };

    // First frame after the target interval
    this.feedTimeout = setTimeout(tick, this.frameIntervalMs);
  }

  private feedFrame(): void {
    if (this.stopped) return;

    // Frame timing measurement (nanosecond precision)
    const now = process.hrtime.bigint();
    if (this._lastFeedTime !== null) {
      const deltaMs = Number(now - this._lastFeedTime) / 1_000_000;
      this._intervalSum += deltaMs;
      this._intervalCount++;
      if (Math.abs(deltaMs - this.frameIntervalMs) > 5) {
        this._timingAlerts++;
      }
    }
    this._lastFeedTime = now;

    // BACKPRESSURE RESUME: if frame buffer drained below 50%, resume FFmpeg.
    if (this.ffmpegProcess?.stdout?.isPaused?.() && this.frameBuffer.length < this.maxBufferedFrames * 0.5) {
      this.ffmpegProcess.stdout.resume();
    }

    let frameData: Buffer | null = null;

    if (this.paused) {
      frameData = this.lastFrame;
    } else if (this.frameBuffer.length > 0) {
      frameData = this.frameBuffer.shift()!;
      this.lastFrame = frameData;
    } else if (this.ffmpegProcess === null || this.ffmpegProcess.exitCode !== null) {
      // FFmpeg done and buffer empty — video ended (non-looping mode)
      if (!this.looping) {
        this.onTrackEnded?.();
      }
      frameData = this.lastFrame;
    } else {
      // Buffer underrun — send last frame to avoid gap
      frameData = this.lastFrame;
    }

    if (!frameData) return;

    this._framesDelivered++;

    try {
      this.source.onFrame({
        width: this.width,
        height: this.height,
        data: new Uint8ClampedArray(frameData.buffer, frameData.byteOffset, frameData.byteLength),
      });
    } catch (err) {
      this.log.debug('[VIDEO] Frame feed error:', err);
    }
  }

  // ── Cleanup ─────────────────────────────────────────────────────────────

  private killFfmpeg(): void {
    if (this.ffmpegProcess) {
      this.ffmpegProcess.stdout?.removeAllListeners();
      this.ffmpegProcess.stderr?.removeAllListeners();
      this.ffmpegProcess.removeAllListeners();
      this.ffmpegProcess.kill('SIGTERM');
      this.ffmpegProcess = null;
    }
  }
}

/**
 * Parse resolution string like "3840x2160" into { width, height }.
 */
export function parseResolution(resolution: string): { width: number; height: number } | null {
  const match = resolution.match(/^(\d+)x(\d+)$/);
  if (!match) return null;
  return { width: parseInt(match[1], 10), height: parseInt(match[2], 10) };
}
