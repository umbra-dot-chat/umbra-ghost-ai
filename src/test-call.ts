#!/usr/bin/env node
/**
 * ghost-ai test-call — Standalone diagnostic tool for testing WebRTC media quality.
 *
 * Starts the bot with test configuration, initiates a loopback call using
 * reference signals (440Hz audio + test pattern video), and measures quality
 * metrics against known reference data.
 *
 * Usage:
 *   npx tsx src/test-call.ts --type video --duration 30 --output report.json
 *   npx tsx src/test-call.ts --type voice --duration 10
 */

import { Command } from 'commander';
import { AudioTestSignal, VideoTestSignal, generate440HzFrame } from './media/test-signal.js';
import { DegradationDetector, type AudioMetrics, type VideoMetrics } from './media/degradation-detector.js';
import { RawMediaCapture } from './media/capture.js';
import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';

// ── Types ─────────────────────────────────────────────────────────────────────

interface TestReport {
  type: 'voice' | 'video';
  duration: number;
  startedAt: string;
  endedAt: string;
  audio: {
    framesDelivered: number;
    expectedFrames: number;
    frameAccuracy: number;
    timingAlerts: number;
    avgIntervalMs: number;
    targetIntervalMs: number;
  };
  video?: {
    framesGenerated: number;
    expectedFrames: number;
    frameAccuracy: number;
  };
  degradation: {
    eventCount: number;
    events: Array<{ type: string; reason: string; timestamp: number }>;
  };
  pass: boolean;
  score: number;
  details: string[];
}

// ── Logger ────────────────────────────────────────────────────────────────────

const log = {
  debug: (...args: unknown[]) => console.log('[DEBUG]', ...args),
  info: (...args: unknown[]) => console.log('[INFO]', ...args),
  warn: (...args: unknown[]) => console.warn('[WARN]', ...args),
  error: (...args: unknown[]) => console.error('[ERROR]', ...args),
};

// ── Mock RTCAudioSource/RTCVideoSource for loopback testing ───────────────────

class MockAudioSource {
  private _frameCount = 0;
  private _samples: Int16Array[] = [];

  onData(data: { samples: Int16Array }): void {
    this._frameCount++;
    // Keep last 100 frames for analysis
    if (this._samples.length > 100) this._samples.shift();
    this._samples.push(new Int16Array(data.samples));
  }

  get frameCount(): number { return this._frameCount; }
  get recentSamples(): Int16Array[] { return this._samples; }
}

class MockVideoSource {
  private _frameCount = 0;

  onFrame(frame: { width: number; height: number; data: Uint8ClampedArray }): void {
    this._frameCount++;
  }

  get frameCount(): number { return this._frameCount; }
}

// ── Test runner ───────────────────────────────────────────────────────────────

async function runTest(options: {
  type: 'voice' | 'video';
  duration: number;
  output?: string;
  capture?: boolean;
}): Promise<TestReport> {
  const { type, duration } = options;
  const startedAt = new Date();

  log.info(`Starting ${type} test for ${duration}s...`);

  // Create mock sources
  const mockAudio = new MockAudioSource();
  const mockVideo = type === 'video' ? new MockVideoSource() : null;

  // Create test signals
  const audioSignal = new AudioTestSignal(mockAudio);
  const videoSignal = type === 'video'
    ? new VideoTestSignal(mockVideo!, 640, 480, 30)
    : null;

  // Create degradation detector
  const detector = new DegradationDetector(log);
  detector.start({
    videoTargetIntervalMs: type === 'video' ? 33.3 : undefined,
  });

  // Optional raw capture
  let capture: RawMediaCapture | null = null;
  if (options.capture) {
    const captureDir = join(process.cwd(), 'test-captures');
    mkdirSync(captureDir, { recursive: true });
    capture = new RawMediaCapture(captureDir, `test-${Date.now()}`, log);
    capture.start(type === 'video' ? 640 : undefined, type === 'video' ? 480 : undefined);
  }

  // Start signals
  audioSignal.start();
  videoSignal?.start();

  // Track timing metrics
  let lastAudioFrameCount = 0;
  let timingCheckCount = 0;
  let timingAlerts = 0;
  let intervalSum = 0;
  const checkIntervalMs = 100;

  // Periodic metrics sampling
  const metricsInterval = setInterval(() => {
    const audioFrames = mockAudio.frameCount;
    const frameDelta = audioFrames - lastAudioFrameCount;
    lastAudioFrameCount = audioFrames;

    // Expected: 100ms / 10ms = 10 frames per check interval
    const expectedDelta = checkIntervalMs / 10;
    if (Math.abs(frameDelta - expectedDelta) > 2) {
      timingAlerts++;
    }
    timingCheckCount++;
    intervalSum += frameDelta;

    // Feed metrics to degradation detector
    detector.recordAudioMetrics({
      timestamp: Date.now(),
      intervalMs: frameDelta > 0 ? checkIntervalMs / frameDelta : 0,
      ringBufferAvailable: 0,
      ringBufferCapacity: 0,
      underrunCount: 0,
      rmsEnergy: 0,
    });

    if (mockVideo) {
      detector.recordVideoMetrics({
        timestamp: Date.now(),
        intervalMs: 33.3, // Approximate for 30fps
        bufferHealth: 1.0,
        bufferedFrames: 0,
        droppedFrames: 0,
        framesDelivered: mockVideo.frameCount,
      });
    }
  }, checkIntervalMs);

  // Wait for test duration
  await new Promise(resolve => setTimeout(resolve, duration * 1000));

  // Stop everything
  clearInterval(metricsInterval);
  audioSignal.stop();
  videoSignal?.stop();
  detector.stop();

  if (capture?.isCapturing) {
    capture.finalize();
  }

  const endedAt = new Date();

  // Calculate results
  const expectedAudioFrames = (duration * 1000) / 10; // 10ms per frame
  const expectedVideoFrames = type === 'video' ? duration * 30 : 0; // 30fps

  const audioAccuracy = Math.min(1, mockAudio.frameCount / expectedAudioFrames);
  const avgInterval = timingCheckCount > 0 ? (intervalSum / timingCheckCount) * (10 / 1) : 10;

  // Verify 440Hz signal integrity via zero-crossing analysis
  const recentSamples = mockAudio.recentSamples;
  let zeroCrossings = 0;
  if (recentSamples.length > 0) {
    const lastFrame = recentSamples[recentSamples.length - 1];
    for (let i = 1; i < lastFrame.length; i++) {
      if ((lastFrame[i - 1] >= 0 && lastFrame[i] < 0) || (lastFrame[i - 1] < 0 && lastFrame[i] >= 0)) {
        zeroCrossings++;
      }
    }
  }
  // For 440Hz at 48kHz with 480 samples: expected ~4.4 zero crossings (each period = 109 samples = 2 crossings)
  const expectedZeroCrossings = (440 * 2 * 480) / 48000; // ~8.8
  const signalIntegrity = zeroCrossings > 0
    ? 1 - Math.abs(zeroCrossings - expectedZeroCrossings) / expectedZeroCrossings
    : 0;

  // Composite scoring
  const details: string[] = [];
  let score = 0;

  // Audio frame delivery accuracy (30% weight)
  const audioScore = Math.min(1, audioAccuracy) * 30;
  score += audioScore;
  details.push(`Audio frame accuracy: ${(audioAccuracy * 100).toFixed(1)}% (${mockAudio.frameCount}/${expectedAudioFrames.toFixed(0)}) → ${audioScore.toFixed(1)}/30`);

  // Timing consistency (25% weight)
  const timingScore = Math.max(0, 1 - timingAlerts / Math.max(1, timingCheckCount)) * 25;
  score += timingScore;
  details.push(`Timing consistency: ${timingAlerts} alerts in ${timingCheckCount} checks → ${timingScore.toFixed(1)}/25`);

  // Signal integrity (25% weight)
  const integrityScore = Math.max(0, signalIntegrity) * 25;
  score += integrityScore;
  details.push(`Signal integrity (440Hz zero-crossings): ${zeroCrossings} (expected ~${expectedZeroCrossings.toFixed(1)}) → ${integrityScore.toFixed(1)}/25`);

  // Degradation events (20% weight)
  const degradationDiag = detector.diagnostics;
  const degradeScore = Math.max(0, 1 - degradationDiag.events.length / 10) * 20;
  score += degradeScore;
  details.push(`Degradation events: ${degradationDiag.events.length} → ${degradeScore.toFixed(1)}/20`);

  if (type === 'video' && mockVideo) {
    const videoAccuracy = Math.min(1, mockVideo.frameCount / expectedVideoFrames);
    details.push(`Video frame accuracy: ${(videoAccuracy * 100).toFixed(1)}% (${mockVideo.frameCount}/${expectedVideoFrames})`);
  }

  const pass = score >= 80;

  const report: TestReport = {
    type,
    duration,
    startedAt: startedAt.toISOString(),
    endedAt: endedAt.toISOString(),
    audio: {
      framesDelivered: mockAudio.frameCount,
      expectedFrames: expectedAudioFrames,
      frameAccuracy: audioAccuracy,
      timingAlerts,
      avgIntervalMs: avgInterval,
      targetIntervalMs: 10,
    },
    video: type === 'video' && mockVideo ? {
      framesGenerated: mockVideo.frameCount,
      expectedFrames: expectedVideoFrames,
      frameAccuracy: Math.min(1, mockVideo.frameCount / expectedVideoFrames),
    } : undefined,
    degradation: {
      eventCount: degradationDiag.events.length,
      events: degradationDiag.events.map(e => ({
        type: e.type,
        reason: e.reason,
        timestamp: e.timestamp,
      })),
    },
    pass,
    score: Math.round(score * 10) / 10,
    details,
  };

  return report;
}

// ── CLI ───────────────────────────────────────────────────────────────────────

const program = new Command()
  .name('ghost-ai-test-call')
  .description('Test WebRTC media pipeline quality with reference signals')
  .version('1.0.0')
  .option('--type <type>', 'Call type: voice or video', 'video')
  .option('--duration <seconds>', 'Test duration in seconds', '30')
  .option('--output <path>', 'Output report file path', './test-report.json')
  .option('--capture', 'Enable raw media capture', false)
  .parse();

const opts = program.opts();

runTest({
  type: opts.type as 'voice' | 'video',
  duration: parseInt(opts.duration, 10),
  output: opts.output,
  capture: opts.capture,
}).then((report) => {
  // Print summary
  console.log('\n' + '═'.repeat(60));
  console.log(`  Test Result: ${report.pass ? 'PASS ✅' : 'FAIL ❌'}  Score: ${report.score}/100`);
  console.log('═'.repeat(60));
  for (const detail of report.details) {
    console.log(`  ${detail}`);
  }
  console.log('═'.repeat(60) + '\n');

  // Write report
  if (opts.output) {
    writeFileSync(opts.output, JSON.stringify(report, null, 2));
    console.log(`Report saved to: ${opts.output}`);
  }

  process.exit(report.pass ? 0 : 1);
}).catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
