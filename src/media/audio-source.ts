/**
 * AudioSource — decodes audio files (MP3/FLAC/WAV) to raw PCM
 * and feeds samples into a WebRTC audio track via wrtc's nonstandard API.
 *
 * Uses FFmpeg (via ffmpeg-static) to decode any format to s16le PCM at 48kHz mono.
 * Feeds 10ms frames (480 samples) to RTCAudioSource at regular intervals.
 *
 * Supports:
 * - Pre-buffering for smooth playback start
 * - Ring buffer to eliminate GC pressure from Buffer.concat
 * - Looping playback with optional crossfade
 * - Track switching mid-playback
 * - Pause/resume
 * - Diagnostics (buffer level, underrun count, frames delivered)
 */

import { spawn, execSync, type ChildProcess } from 'child_process';
import { createRequire } from 'module';
import type { Logger } from '../config.js';

// ── Types ─────────────────────────────────────────────────────────────────────

/** wrtc nonstandard RTCAudioSource interface */
interface RTCAudioSource {
  createTrack(): MediaStreamTrack;
  onData(data: RTCAudioData): void;
}

interface RTCAudioData {
  samples: Int16Array;
  sampleRate: number;
  bitsPerSample: number;
  channelCount: number;
  numberOfFrames: number;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const SAMPLE_RATE = 48000;       // 48kHz — standard for Opus/WebRTC
const CHANNELS = 1;              // Mono
const BITS_PER_SAMPLE = 16;
const FRAME_DURATION_MS = 10;    // 10ms frames
const SAMPLES_PER_FRAME = (SAMPLE_RATE * FRAME_DURATION_MS) / 1000; // 480
const BYTES_PER_FRAME = SAMPLES_PER_FRAME * (BITS_PER_SAMPLE / 8) * CHANNELS; // 960
const CROSSFADE_MS = 500;
const CROSSFADE_FRAMES = CROSSFADE_MS / FRAME_DURATION_MS; // 50 frames

// Pre-buffer 500ms of audio before starting feed (same pattern as VideoSource)
const PRE_BUFFER_FRAMES = 50;
const PRE_BUFFER_BYTES = PRE_BUFFER_FRAMES * BYTES_PER_FRAME; // 48,000 bytes

// Ring buffer: 5 seconds of audio at 48kHz mono 16-bit
const RING_BUFFER_SECONDS = 5;
const RING_BUFFER_SIZE = SAMPLE_RATE * (BITS_PER_SAMPLE / 8) * CHANNELS * RING_BUFFER_SECONDS; // 480,000 bytes

// ── Ring Buffer ───────────────────────────────────────────────────────────────

class AudioRingBuffer {
  private buffer: Buffer;
  private writePos = 0;
  private readPos = 0;
  private available = 0;

  constructor(size: number) {
    this.buffer = Buffer.alloc(size);
  }

  /** Number of bytes available to read. */
  get length(): number {
    return this.available;
  }

  /** Write data into the ring buffer. Returns number of bytes written. */
  write(data: Buffer): number {
    const toWrite = Math.min(data.length, this.buffer.length - this.available);
    if (toWrite === 0) return 0;

    let written = 0;
    while (written < toWrite) {
      const chunk = Math.min(toWrite - written, this.buffer.length - this.writePos);
      data.copy(this.buffer, this.writePos, written, written + chunk);
      this.writePos = (this.writePos + chunk) % this.buffer.length;
      written += chunk;
    }

    this.available += written;
    return written;
  }

  /** Read exactly `count` bytes from the ring buffer into a new Buffer. */
  read(count: number): Buffer | null {
    if (this.available < count) return null;

    const result = Buffer.alloc(count);
    let read = 0;
    while (read < count) {
      const chunk = Math.min(count - read, this.buffer.length - this.readPos);
      this.buffer.copy(result, read, this.readPos, this.readPos + chunk);
      this.readPos = (this.readPos + chunk) % this.buffer.length;
      read += chunk;
    }

    this.available -= count;
    return result;
  }

  /** Reset the ring buffer. */
  clear(): void {
    this.writePos = 0;
    this.readPos = 0;
    this.available = 0;
  }

  /** Diagnostic snapshot of ring buffer internal state. */
  get state(): { readPos: number; writePos: number; available: number; capacity: number } {
    return {
      readPos: this.readPos,
      writePos: this.writePos,
      available: this.available,
      capacity: this.buffer.length,
    };
  }
}

// ── AudioSource ───────────────────────────────────────────────────────────────

export class AudioSource {
  private source: RTCAudioSource;
  private log: Logger;
  private ffmpegPath: string;

  private currentFilePath: string | null = null;
  private ffmpegProcess: ChildProcess | null = null;
  private feedTimeout: ReturnType<typeof setTimeout> | null = null;
  private paused = false;
  private stopped = false;
  private preBuffering = false;

  // Ring buffer for decoded PCM audio
  private ringBuffer = new AudioRingBuffer(RING_BUFFER_SIZE);
  private silenceFrame: Int16Array;

  // Crossfade state
  private fadeOutBuffer: Int16Array[] = [];
  private fadeInActive = false;
  private fadeFrameIndex = 0;

  // Loop tracking
  private looping = true;
  private onTrackEnded: (() => void) | null = null;

  // Diagnostics
  private _underrunCount = 0;
  private _framesDelivered = 0;

  // Frame timing diagnostics
  private _timingAlerts = 0;
  private _lastFeedTime: bigint | null = null;
  private _intervalSum = 0;
  private _intervalCount = 0;

  // Drift-compensating timer state
  private _feedStartTime: bigint = BigInt(0);
  private _feedTickCount = 0;

  constructor(audioSource: RTCAudioSource, ffmpegPath: string, log: Logger) {
    this.source = audioSource;
    this.ffmpegPath = ffmpegPath;
    this.log = log;
    this.silenceFrame = new Int16Array(SAMPLES_PER_FRAME);
  }

  /**
   * Start playing an audio file. Decodes via FFmpeg to raw PCM
   * and feeds frames at 10ms intervals after pre-buffering.
   */
  start(filePath: string, options?: { loop?: boolean; onTrackEnded?: () => void }): void {
    this.stop();

    this.currentFilePath = filePath;
    this.looping = options?.loop ?? true;
    this.onTrackEnded = options?.onTrackEnded ?? null;
    this.stopped = false;
    this.paused = false;
    this.preBuffering = true;
    this.ringBuffer.clear();
    this._underrunCount = 0;
    this._framesDelivered = 0;
    this._timingAlerts = 0;
    this._lastFeedTime = null;
    this._intervalSum = 0;
    this._intervalCount = 0;

    this.startDecoding(filePath);
    // Don't start feeding yet — wait for pre-buffer to fill.
    // The decode data handler will call startFeeding() once we have enough.

    this.log.debug(`[AUDIO] Started playback: ${filePath} (pre-buffering ${PRE_BUFFER_FRAMES} frames...)`);
  }

  /** Switch to a different audio file with crossfade. */
  switchTrack(filePath: string): void {
    if (this.stopped) {
      this.start(filePath);
      return;
    }

    // Capture current audio for crossfade
    this.captureForCrossfade();

    this.killFfmpeg();
    this.ringBuffer.clear();
    this.currentFilePath = filePath;

    // Pre-buffer the new track before resuming feed
    this.preBuffering = true;
    this.startDecoding(filePath);

    this.fadeInActive = true;
    this.fadeFrameIndex = 0;

    this.log.debug(`[AUDIO] Switching track with crossfade: ${filePath}`);
  }

  /** Pause audio playback (sends silence). */
  pause(): void {
    this.paused = true;
    this.log.debug('[AUDIO] Paused');
  }

  /** Resume audio playback. */
  resume(): void {
    this.paused = false;
    this.log.debug('[AUDIO] Resumed');
  }

  /** Stop playback and clean up. */
  stop(): void {
    this.stopped = true;
    this.killFfmpeg();

    if (this.feedTimeout) {
      clearTimeout(this.feedTimeout);
      this.feedTimeout = null;
    }

    this.ringBuffer.clear();
    this.fadeOutBuffer = [];
    this.fadeInActive = false;
    this.currentFilePath = null;

    this.log.debug('[AUDIO] Stopped');
  }

  get isPlaying(): boolean {
    return !this.stopped && !this.paused;
  }

  get currentFile(): string | null {
    return this.currentFilePath;
  }

  // ── Diagnostics ─────────────────────────────────────────────────────────

  /** Current buffered audio in milliseconds. */
  get bufferMs(): number {
    return Math.floor((this.ringBuffer.length / BYTES_PER_FRAME) * FRAME_DURATION_MS);
  }

  /** Number of buffer underruns since last start/switch. */
  get underrunCount(): number {
    return this._underrunCount;
  }

  /** Total frames delivered to WebRTC since last start. */
  get framesDelivered(): number {
    return this._framesDelivered;
  }

  /** Number of times frame interval drifted >2ms from target 10ms. */
  get timingAlerts(): number {
    return this._timingAlerts;
  }

  /** Average frame interval in ms across all measured frames. */
  get avgIntervalMs(): number {
    return this._intervalCount > 0
      ? this._intervalSum / this._intervalCount
      : 0;
  }

  /** Diagnostic snapshot of the ring buffer internal state. */
  get ringBufferState(): { readPos: number; writePos: number; available: number; capacity: number } {
    return this.ringBuffer.state;
  }

  // ── Decoding ────────────────────────────────────────────────────────────

  private startDecoding(filePath: string, loop = false): void {
    // FFmpeg: decode any audio format → raw s16le PCM at 48kHz mono
    const args: string[] = [];

    // Seamless looping via FFmpeg (avoids restart gap)
    if (loop || this.looping) {
      args.push('-stream_loop', '-1');
    }

    args.push(
      '-i', filePath,
      '-f', 's16le',           // Raw signed 16-bit little-endian
      '-acodec', 'pcm_s16le',
      '-ar', String(SAMPLE_RATE),
      '-ac', String(CHANNELS),
      '-v', 'error',           // Suppress non-error output
      'pipe:1',                // Output to stdout
    );

    this.ffmpegProcess = spawn(this.ffmpegPath, args);

    this.ffmpegProcess.stdout?.on('data', (chunk: Buffer) => {
      const written = this.ringBuffer.write(chunk);

      // BACKPRESSURE: if ring buffer is >80% full, pause FFmpeg's stdout.
      // Without this, FFmpeg decodes orders of magnitude faster than real-time,
      // the ring buffer fills to capacity, and subsequent audio data is silently
      // dropped — causing garbled audio after the buffer drains (~5 seconds).
      if (this.ffmpegProcess?.stdout && this.ringBuffer.length > RING_BUFFER_SIZE * 0.8) {
        this.ffmpegProcess.stdout.pause();
      }

      if (written < chunk.length && written === 0) {
        // Ring buffer completely full — data was lost
        this.log.warn(`[AUDIO] Ring buffer overflow: dropped ${chunk.length} bytes`);
      }

      // Start feeding once we have enough audio pre-buffered
      if (this.preBuffering && this.ringBuffer.length >= PRE_BUFFER_BYTES) {
        this.preBuffering = false;
        if (!this.feedTimeout) {
          this.startFeeding();
        }
        this.log.debug(`[AUDIO] Pre-buffer filled (${this.bufferMs}ms), starting feed`);
      }
    });

    this.ffmpegProcess.stderr?.on('data', (data: Buffer) => {
      const msg = data.toString().trim();
      if (msg) this.log.debug(`[FFMPEG] ${msg}`);
    });

    this.ffmpegProcess.on('close', (code) => {
      if (this.stopped) return;

      if (code === 0 || code === null) {
        this.log.debug(`[AUDIO] FFmpeg finished decoding: ${filePath}`);
      } else {
        this.log.error(`[AUDIO] FFmpeg exited with code ${code}`);
      }
    });

    this.ffmpegProcess.on('error', (err) => {
      this.log.error('[AUDIO] FFmpeg spawn error:', err);
    });
  }

  // ── Feeding ─────────────────────────────────────────────────────────────

  /**
   * Start frame feeding with drift-compensating setTimeout.
   *
   * Unlike setInterval which drifts and can fire in bursts when the event loop
   * is busy, this calculates absolute wall-clock targets for each frame delivery.
   * If the event loop delays a callback, the next timeout is shortened to catch up,
   * but we never deliver more than one frame per callback — preventing burst
   * delivery that causes audio garbling.
   */
  private startFeeding(): void {
    if (this.feedTimeout) clearTimeout(this.feedTimeout);

    this._feedStartTime = process.hrtime.bigint();
    this._feedTickCount = 0;
    const intervalNs = BigInt(Math.round(FRAME_DURATION_MS * 1_000_000));

    const tick = () => {
      if (this.stopped) return;
      this.feedFrame();
      this._feedTickCount++;

      // Calculate absolute target time for next frame
      const nextTargetNs = this._feedStartTime + BigInt(this._feedTickCount) * intervalNs;
      const nowNs = process.hrtime.bigint();
      const delayNs = Number(nextTargetNs - nowNs);

      // If we're very far behind (>2 frame intervals), reset timeline
      const maxBehindNs = Number(intervalNs) * 2;
      if (delayNs < -maxBehindNs) {
        this._feedStartTime = nowNs;
        this._feedTickCount = 0;
        this.feedTimeout = setTimeout(tick, FRAME_DURATION_MS);
      } else {
        const delayMs = Math.max(1, delayNs / 1_000_000);
        this.feedTimeout = setTimeout(tick, delayMs);
      }
    };

    this.feedTimeout = setTimeout(tick, FRAME_DURATION_MS);
  }

  private feedFrame(): void {
    if (this.stopped) return;

    // Frame timing measurement (nanosecond precision)
    const now = process.hrtime.bigint();
    if (this._lastFeedTime !== null) {
      const deltaMs = Number(now - this._lastFeedTime) / 1_000_000;
      this._intervalSum += deltaMs;
      this._intervalCount++;
      if (Math.abs(deltaMs - FRAME_DURATION_MS) > 2) {
        this._timingAlerts++;
      }
    }
    this._lastFeedTime = now;

    // BACKPRESSURE RESUME: if ring buffer drained below 50%, resume FFmpeg.
    // This keeps FFmpeg producing just enough to maintain the buffer level
    // without overflowing and losing data.
    if (this.ffmpegProcess?.stdout?.isPaused?.() && this.ringBuffer.length < RING_BUFFER_SIZE * 0.5) {
      this.ffmpegProcess.stdout.resume();
    }

    let frame: Int16Array;

    if (this.paused) {
      frame = this.silenceFrame;
    } else if (this.preBuffering) {
      // Still pre-buffering — send silence until ready
      frame = this.silenceFrame;
    } else if (this.ringBuffer.length >= BYTES_PER_FRAME) {
      const rawFrame = this.ringBuffer.read(BYTES_PER_FRAME)!;
      // Copy into own ArrayBuffer because wrtc checks samples.buffer.byteLength
      frame = new Int16Array(SAMPLES_PER_FRAME);
      const srcView = new Int16Array(
        rawFrame.buffer,
        rawFrame.byteOffset,
        SAMPLES_PER_FRAME,
      );
      frame.set(srcView);

      // Apply crossfade if active
      if (this.fadeInActive && this.fadeFrameIndex < CROSSFADE_FRAMES) {
        frame = this.applyCrossfade(frame);
        this.fadeFrameIndex++;
        if (this.fadeFrameIndex >= CROSSFADE_FRAMES) {
          this.fadeInActive = false;
          this.fadeOutBuffer = [];
        }
      }
    } else if (this.ffmpegProcess === null || this.ffmpegProcess.exitCode !== null) {
      // FFmpeg done and buffer empty — track ended
      if (this.looping && this.currentFilePath) {
        this.log.debug('[AUDIO] Track ended, looping...');
        this.captureForCrossfade();
        this.startDecoding(this.currentFilePath);
        this.fadeInActive = true;
        this.fadeFrameIndex = 0;
      } else {
        this.onTrackEnded?.();
      }
      frame = this.silenceFrame;
    } else {
      // Buffer underrun — send silence
      this._underrunCount++;
      frame = this.silenceFrame;
    }

    this._framesDelivered++;

    this.source.onData({
      samples: frame,
      sampleRate: SAMPLE_RATE,
      bitsPerSample: BITS_PER_SAMPLE,
      channelCount: CHANNELS,
      numberOfFrames: SAMPLES_PER_FRAME,
    });
  }

  // ── Crossfade ───────────────────────────────────────────────────────────

  private captureForCrossfade(): void {
    this.fadeOutBuffer = [];
    // Read up to CROSSFADE_FRAMES from the ring buffer for fade-out
    for (let i = 0; i < CROSSFADE_FRAMES; i++) {
      const raw = this.ringBuffer.read(BYTES_PER_FRAME);
      if (raw) {
        const frame = new Int16Array(SAMPLES_PER_FRAME);
        frame.set(new Int16Array(raw.buffer, raw.byteOffset, SAMPLES_PER_FRAME));
        this.fadeOutBuffer.push(frame);
      } else {
        this.fadeOutBuffer.push(new Int16Array(SAMPLES_PER_FRAME));
      }
    }
  }

  private applyCrossfade(fadeInFrame: Int16Array): Int16Array {
    const fadeOutFrame = this.fadeOutBuffer[this.fadeFrameIndex];
    if (!fadeOutFrame) return fadeInFrame;

    const progress = this.fadeFrameIndex / CROSSFADE_FRAMES;
    const result = new Int16Array(SAMPLES_PER_FRAME);

    for (let i = 0; i < SAMPLES_PER_FRAME; i++) {
      const fadeOut = fadeOutFrame[i] * (1 - progress);
      const fadeIn = fadeInFrame[i] * progress;
      result[i] = Math.max(-32768, Math.min(32767, Math.round(fadeOut + fadeIn)));
    }

    return result;
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
 * Resolve the FFmpeg binary path.
 *
 * Prefers the system ffmpeg (which may have GPU/NVDEC support) over
 * ffmpeg-static (which is statically compiled without CUDA libraries).
 * Falls back to ffmpeg-static if system ffmpeg is not found.
 */
export function resolveFfmpegPath(): string {
  try {
    // Check if system ffmpeg exists and works
    execSync('ffmpeg -version', { stdio: 'pipe', timeout: 3000 });
    return 'ffmpeg'; // System ffmpeg found — may have GPU support
  } catch {
    // System ffmpeg not available, try ffmpeg-static
    try {
      const req = createRequire(import.meta.url);
      const ffmpegStatic = req('ffmpeg-static') as string;
      return ffmpegStatic;
    } catch {
      return 'ffmpeg';
    }
  }
}
