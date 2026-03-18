/**
 * DegradationDetector — monitors audio/video quality metrics and triggers
 * automatic state capture when thresholds are crossed.
 *
 * Capabilities:
 * - 100ms resolution time-series for the first 60 seconds of a call
 * - Threshold-triggered snapshots (audio: underruns, RMS spike; video: frame drift, buffer)
 * - Raw media ring buffer: keeps last N seconds of PCM/I420 for "capture on degradation"
 * - Exports diagnostics via callback for data channel relay
 */

import type { Logger } from '../config.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface AudioMetrics {
  timestamp: number;
  intervalMs: number;
  ringBufferAvailable: number;
  ringBufferCapacity: number;
  underrunCount: number;
  rmsEnergy: number;
}

export interface VideoMetrics {
  timestamp: number;
  intervalMs: number;
  bufferHealth: number;
  bufferedFrames: number;
  droppedFrames: number;
  framesDelivered: number;
}

export interface DegradationEvent {
  type: 'audio' | 'video';
  reason: string;
  timestamp: number;
  metrics: AudioMetrics | VideoMetrics;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const SAMPLE_INTERVAL_MS = 100;       // Record metrics every 100ms
const RECORDING_DURATION_MS = 60_000; // Record time-series for first 60s
const MAX_TIME_SERIES = RECORDING_DURATION_MS / SAMPLE_INTERVAL_MS; // 600 entries

// Audio thresholds
const AUDIO_RMS_SPIKE_FACTOR = 3.0;  // RMS energy > 3x running average
const AUDIO_UNDERRUN_TRIGGER = 1;     // Any underrun triggers event

// Video thresholds
const VIDEO_INTERVAL_DRIFT_FACTOR = 2.0; // Frame interval > 2x target
const VIDEO_BUFFER_LOW_PCT = 0.2;        // Buffer health < 20%

// Raw PCM rewind buffer: 5 seconds at 48kHz mono 16-bit
const PCM_REWIND_SECONDS = 5;
const PCM_REWIND_SIZE = 48000 * 2 * PCM_REWIND_SECONDS; // 480,000 bytes

// ── DegradationDetector ───────────────────────────────────────────────────────

export class DegradationDetector {
  private log: Logger;
  private enabled = false;

  // Time-series buffers
  private audioTimeSeries: AudioMetrics[] = [];
  private videoTimeSeries: VideoMetrics[] = [];

  // Running averages for threshold comparison
  private audioRmsSum = 0;
  private audioRmsCount = 0;
  private prevAudioUnderruns = 0;

  // Video target interval for drift detection
  private videoTargetIntervalMs = 33.3; // ~30fps default

  // Degradation event log
  private events: DegradationEvent[] = [];

  // Raw PCM ring buffer for rewind capture
  private pcmRewindBuffer: Buffer = Buffer.alloc(PCM_REWIND_SIZE);
  private pcmRewindWritePos = 0;
  private pcmRewindFilled = false;

  // Callback for degradation events
  private onDegradation: ((event: DegradationEvent) => void) | null = null;

  // Sampling timer
  private sampleTimeout: ReturnType<typeof setTimeout> | null = null;
  private startedAt = 0;

  constructor(log: Logger) {
    this.log = log;
  }

  /**
   * Start monitoring. Call this when a call begins.
   */
  start(options?: {
    videoTargetIntervalMs?: number;
    onDegradation?: (event: DegradationEvent) => void;
  }): void {
    this.enabled = true;
    this.startedAt = Date.now();
    this.audioTimeSeries = [];
    this.videoTimeSeries = [];
    this.events = [];
    this.audioRmsSum = 0;
    this.audioRmsCount = 0;
    this.prevAudioUnderruns = 0;
    this.pcmRewindWritePos = 0;
    this.pcmRewindFilled = false;

    if (options?.videoTargetIntervalMs) {
      this.videoTargetIntervalMs = options.videoTargetIntervalMs;
    }
    if (options?.onDegradation) {
      this.onDegradation = options.onDegradation;
    }

    this.log.debug('[DEGRADE] Degradation detector started');
  }

  /**
   * Stop monitoring.
   */
  stop(): void {
    this.enabled = false;
    if (this.sampleTimeout) {
      clearTimeout(this.sampleTimeout);
      this.sampleTimeout = null;
    }
    this.onDegradation = null;
    this.log.debug(`[DEGRADE] Stopped. ${this.events.length} degradation events logged.`);
  }

  /**
   * Feed an audio metrics sample. Call this from the audio feed loop.
   */
  recordAudioMetrics(metrics: AudioMetrics): void {
    if (!this.enabled) return;

    // Time-series recording (first 60 seconds)
    const elapsed = Date.now() - this.startedAt;
    if (elapsed < RECORDING_DURATION_MS && this.audioTimeSeries.length < MAX_TIME_SERIES) {
      this.audioTimeSeries.push({ ...metrics });
    }

    // Running RMS average
    this.audioRmsSum += metrics.rmsEnergy;
    this.audioRmsCount++;
    const avgRms = this.audioRmsSum / this.audioRmsCount;

    // Check thresholds
    if (metrics.underrunCount > this.prevAudioUnderruns) {
      const event: DegradationEvent = {
        type: 'audio',
        reason: `Buffer underrun (count: ${metrics.underrunCount})`,
        timestamp: Date.now(),
        metrics: { ...metrics },
      };
      this.events.push(event);
      this.onDegradation?.(event);
      this.log.warn(`[DEGRADE] Audio underrun detected at ${elapsed}ms`);
    }
    this.prevAudioUnderruns = metrics.underrunCount;

    if (this.audioRmsCount > 10 && metrics.rmsEnergy > avgRms * AUDIO_RMS_SPIKE_FACTOR) {
      const event: DegradationEvent = {
        type: 'audio',
        reason: `RMS energy spike (${metrics.rmsEnergy.toFixed(0)} vs avg ${avgRms.toFixed(0)})`,
        timestamp: Date.now(),
        metrics: { ...metrics },
      };
      this.events.push(event);
      this.onDegradation?.(event);
      this.log.warn(`[DEGRADE] Audio RMS spike at ${elapsed}ms`);
    }
  }

  /**
   * Feed a video metrics sample. Call this from the video feed loop.
   */
  recordVideoMetrics(metrics: VideoMetrics): void {
    if (!this.enabled) return;

    const elapsed = Date.now() - this.startedAt;
    if (elapsed < RECORDING_DURATION_MS && this.videoTimeSeries.length < MAX_TIME_SERIES) {
      this.videoTimeSeries.push({ ...metrics });
    }

    // Check thresholds
    if (metrics.intervalMs > this.videoTargetIntervalMs * VIDEO_INTERVAL_DRIFT_FACTOR) {
      const event: DegradationEvent = {
        type: 'video',
        reason: `Frame interval drift (${metrics.intervalMs.toFixed(1)}ms vs target ${this.videoTargetIntervalMs.toFixed(1)}ms)`,
        timestamp: Date.now(),
        metrics: { ...metrics },
      };
      this.events.push(event);
      this.onDegradation?.(event);
    }

    if (metrics.bufferHealth < VIDEO_BUFFER_LOW_PCT && metrics.bufferHealth >= 0) {
      const event: DegradationEvent = {
        type: 'video',
        reason: `Low buffer health (${(metrics.bufferHealth * 100).toFixed(0)}%)`,
        timestamp: Date.now(),
        metrics: { ...metrics },
      };
      this.events.push(event);
      this.onDegradation?.(event);
    }
  }

  /**
   * Write raw PCM audio into the rewind ring buffer.
   * On degradation trigger, the last N seconds can be flushed to disk.
   */
  writeRewindAudio(samples: Int16Array): void {
    if (!this.enabled) return;

    const buf = Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength);
    let written = 0;
    while (written < buf.length) {
      const chunk = Math.min(buf.length - written, this.pcmRewindBuffer.length - this.pcmRewindWritePos);
      buf.copy(this.pcmRewindBuffer, this.pcmRewindWritePos, written, written + chunk);
      this.pcmRewindWritePos = (this.pcmRewindWritePos + chunk) % this.pcmRewindBuffer.length;
      written += chunk;
    }
    if (written > 0) this.pcmRewindFilled = true;
  }

  /**
   * Get the PCM rewind buffer contents (last N seconds of audio).
   * Returns a Buffer in ring order (oldest first).
   */
  getRewindAudio(): Buffer {
    if (!this.pcmRewindFilled) {
      return this.pcmRewindBuffer.subarray(0, this.pcmRewindWritePos);
    }
    // Concatenate: from writePos to end, then 0 to writePos
    return Buffer.concat([
      this.pcmRewindBuffer.subarray(this.pcmRewindWritePos),
      this.pcmRewindBuffer.subarray(0, this.pcmRewindWritePos),
    ]);
  }

  /**
   * Calculate RMS energy of a PCM frame (useful for detecting garble/distortion).
   */
  static calculateRms(samples: Int16Array): number {
    let sum = 0;
    for (let i = 0; i < samples.length; i++) {
      sum += samples[i] * samples[i];
    }
    return Math.sqrt(sum / samples.length);
  }

  // ── Diagnostics export ───────────────────────────────────────────────────

  get diagnostics(): {
    events: DegradationEvent[];
    audioTimeSeriesLength: number;
    videoTimeSeriesLength: number;
    elapsedMs: number;
  } {
    return {
      events: [...this.events],
      audioTimeSeriesLength: this.audioTimeSeries.length,
      videoTimeSeriesLength: this.videoTimeSeries.length,
      elapsedMs: Date.now() - this.startedAt,
    };
  }

  get degradationCount(): number {
    return this.events.length;
  }
}
