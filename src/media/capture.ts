/**
 * Raw media capture — tees PCM audio and I420 video frames to disk
 * for offline analysis and debugging.
 *
 * Audio: writes raw s16le PCM at 48kHz mono, then wraps in .wav on finalize
 * Video: writes raw I420 (YUV420P) frames as .yuv sequence
 *
 * Gated by config.diagRawCapture (heavy I/O — disabled by default).
 */

import { createWriteStream, mkdirSync, writeFileSync, type WriteStream } from 'fs';
import { join } from 'path';
import type { Logger } from '../config.js';

// WAV header constants
const SAMPLE_RATE = 48000;
const CHANNELS = 1;
const BITS_PER_SAMPLE = 16;

export class RawMediaCapture {
  private log: Logger;
  private outputDir: string;
  private callId: string;

  private audioStream: WriteStream | null = null;
  private videoStream: WriteStream | null = null;
  private audioByteCount = 0;
  private videoFrameCount = 0;
  private videoWidth = 0;
  private videoHeight = 0;
  private startedAt = 0;

  constructor(outputDir: string, callId: string, log: Logger) {
    this.outputDir = outputDir;
    this.callId = callId;
    this.log = log;
  }

  /** Start capturing. Creates output directory and opens file streams. */
  start(videoWidth?: number, videoHeight?: number): void {
    const dir = join(this.outputDir, `capture-${this.callId}-${Date.now()}`);
    mkdirSync(dir, { recursive: true });

    this.audioStream = createWriteStream(join(dir, 'audio-raw.pcm'));
    this.audioStream.on('error', (err) => this.log.error('[CAPTURE] Audio write error:', err));
    this.audioByteCount = 0;
    this.startedAt = Date.now();

    if (videoWidth && videoHeight) {
      this.videoWidth = videoWidth;
      this.videoHeight = videoHeight;
      this.videoStream = createWriteStream(join(dir, `video-${videoWidth}x${videoHeight}.yuv`));
      this.videoStream.on('error', (err) => this.log.error('[CAPTURE] Video write error:', err));
      this.videoFrameCount = 0;
    }

    this.log.info(`[CAPTURE] Started raw media capture in ${dir}`);
  }

  /** Write a raw PCM audio frame (Int16Array) to disk. */
  writeAudioFrame(samples: Int16Array): void {
    if (!this.audioStream) return;
    const buf = Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength);
    this.audioStream.write(buf);
    this.audioByteCount += buf.length;
  }

  /** Write a raw I420 video frame (Buffer) to disk. */
  writeVideoFrame(frameData: Buffer): void {
    if (!this.videoStream) return;
    this.videoStream.write(frameData);
    this.videoFrameCount++;
  }

  /** Stop capture and finalize files. Converts raw PCM to WAV. */
  finalize(): { audioPath: string | null; videoPath: string | null; durationMs: number } {
    const durationMs = Date.now() - this.startedAt;
    let audioPath: string | null = null;
    let videoPath: string | null = null;

    if (this.audioStream) {
      const pcmPath = this.audioStream.path as string;
      const stream = this.audioStream;
      this.audioStream = null;

      // End the stream and convert to WAV after close
      const wavPath = pcmPath.replace('.pcm', '.wav');
      stream.end(() => {
        try {
          this.writePcmToWav(pcmPath, wavPath);
          this.log.info(`[CAPTURE] Audio saved: ${wavPath} (${this.audioByteCount} bytes, ${(durationMs / 1000).toFixed(1)}s)`);
        } catch (err) {
          this.log.error('[CAPTURE] Failed to finalize WAV:', err);
        }
      });
      audioPath = wavPath;
    }

    if (this.videoStream) {
      videoPath = this.videoStream.path as string;
      const stream = this.videoStream;
      this.videoStream = null;
      stream.end(() => {
        this.log.info(`[CAPTURE] Video saved: ${videoPath} (${this.videoFrameCount} frames, ${this.videoWidth}x${this.videoHeight})`);
      });
    }

    return { audioPath, videoPath, durationMs };
  }

  get isCapturing(): boolean {
    return this.audioStream !== null || this.videoStream !== null;
  }

  get stats(): { audioBytes: number; videoFrames: number; durationMs: number } {
    return {
      audioBytes: this.audioByteCount,
      videoFrames: this.videoFrameCount,
      durationMs: Date.now() - this.startedAt,
    };
  }

  // ── WAV file writer ──────────────────────────────────────────────────────

  private writePcmToWav(pcmPath: string, wavPath: string): void {
    // Read the raw PCM data
    const { readFileSync } = require('fs') as typeof import('fs');
    const pcmData = readFileSync(pcmPath);

    const header = Buffer.alloc(44);
    const dataSize = pcmData.length;
    const byteRate = SAMPLE_RATE * CHANNELS * (BITS_PER_SAMPLE / 8);
    const blockAlign = CHANNELS * (BITS_PER_SAMPLE / 8);

    // RIFF header
    header.write('RIFF', 0);
    header.writeUInt32LE(36 + dataSize, 4);
    header.write('WAVE', 8);

    // fmt sub-chunk
    header.write('fmt ', 12);
    header.writeUInt32LE(16, 16);        // Sub-chunk size
    header.writeUInt16LE(1, 20);         // PCM format
    header.writeUInt16LE(CHANNELS, 22);
    header.writeUInt32LE(SAMPLE_RATE, 24);
    header.writeUInt32LE(byteRate, 28);
    header.writeUInt16LE(blockAlign, 32);
    header.writeUInt16LE(BITS_PER_SAMPLE, 34);

    // data sub-chunk
    header.write('data', 36);
    header.writeUInt32LE(dataSize, 40);

    writeFileSync(wavPath, Buffer.concat([header, pcmData]));
  }
}
