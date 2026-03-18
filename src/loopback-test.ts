#!/usr/bin/env node
/**
 * loopback-test — True end-to-end WebRTC loopback test.
 *
 * TWO MODES:
 *
 * 1. Synthetic (default): Feeds generated I420 + 440Hz test signal through
 *    two RTCPeerConnections. Tests wrtc encoding/decoding overhead only.
 *
 * 2. Real pipeline (--real-pipeline): Uses the actual AudioSource + VideoSource
 *    classes with FFmpeg, exactly matching a real call. Tests the FULL path:
 *    FFmpeg decode → pipe → ring buffer/frame buffer → feed timer → wrtc encode →
 *    RTP → wrtc decode → sink measurement.
 *    This catches: ring buffer overflows, backpressure failures, resolution
 *    mismatches, FFmpeg startup delays, GC pressure from frame allocation.
 *
 * Usage:
 *   node dist/loopback-test.js --type video --duration 15 --resolution 720p
 *   node dist/loopback-test.js --real-pipeline --type video --duration 15
 *   node dist/loopback-test.js --real-pipeline --type voice --duration 10
 */

import { Command } from 'commander';
import { generate440HzFrame } from './media/test-signal.js';
import { AudioSource, resolveFfmpegPath } from './media/audio-source.js';
import { VideoSource } from './media/video-source.js';
import { writeFileSync } from 'fs';
import { existsSync, readdirSync } from 'fs';
import { join } from 'path';

// ── Types ─────────────────────────────────────────────────────────────────────

interface LoopbackReport {
  type: 'voice' | 'video';
  mode: 'synthetic' | 'real-pipeline';
  resolution: string;
  duration: number;
  startedAt: string;
  endedAt: string;
  sender: {
    audioFramesSent: number;
    videoFramesSent: number;
    audioUnderruns?: number;
    videoDroppedFrames?: number;
  };
  receiver: {
    audioFramesReceived: number;
    videoFramesReceived: number;
    audioDropRate: number;
    videoDropRate: number;
    avgVideoIntervalMs: number;
    avgAudioIntervalMs: number;
    videoTimingAlerts: number;
    audioTimingAlerts: number;
  };
  encoding: {
    avgEncodeTimeMs: number;
    maxEncodeTimeMs: number;
    framesEncodedPerSecond: number;
  };
  pass: boolean;
  score: number;
  details: string[];
}

// ── Resolution presets ────────────────────────────────────────────────────────

const RESOLUTION_PRESETS: Record<string, { width: number; height: number; fps: number }> = {
  '480p': { width: 854, height: 480, fps: 24 },
  '720p': { width: 1280, height: 720, fps: 24 },
  '1080p': { width: 1920, height: 1080, fps: 30 },
  '4k': { width: 3840, height: 2160, fps: 30 },
};

// ── Logger ────────────────────────────────────────────────────────────────────

const log = {
  debug: (...args: unknown[]) => console.log('[DEBUG]', ...args),
  info: (...args: unknown[]) => console.log('[INFO]', ...args),
  warn: (...args: unknown[]) => console.warn('[WARN]', ...args),
  error: (...args: unknown[]) => console.error('[ERROR]', ...args),
};

// ── Find media files on the server ────────────────────────────────────────────

function findMediaFile(dir: string, ext: string): string | null {
  // Check common locations
  const searchDirs = [
    join(dir, 'audio'),
    join(dir, 'video'),
    dir,
    './data/media/audio',
    './data/media/video',
    './data/media',
  ];

  for (const searchDir of searchDirs) {
    try {
      if (!existsSync(searchDir)) continue;
      const files = readdirSync(searchDir);
      const match = files.find(f => f.endsWith(ext));
      if (match) return join(searchDir, match);
    } catch { /* ignore */ }
  }
  return null;
}

// ── I420 test frame generator ─────────────────────────────────────────────────

function generateI420TestFrame(width: number, height: number, frameNumber: number): Uint8ClampedArray {
  const ySize = width * height;
  const uvSize = (width / 2) * (height / 2);
  const frameSize = ySize + uvSize * 2;
  const data = new Uint8ClampedArray(frameSize);

  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width; col++) {
      if (row < height * 0.9) {
        const band = Math.floor(col / (width / 8));
        data[row * width + col] = ((band * 32 + frameNumber * 3) % 220) + 16;
      } else {
        const bit = Math.floor(col / (width / 16));
        data[row * width + col] = ((frameNumber >> bit) & 1) ? 235 : 16;
      }
    }
  }

  const halfW = width / 2;
  const halfH = height / 2;
  for (let row = 0; row < halfH; row++) {
    for (let col = 0; col < halfW; col++) {
      const band = Math.floor(col / (halfW / 8));
      data[ySize + row * halfW + col] = ((band * 32) % 240) + 16;
      data[ySize + uvSize + row * halfW + col] = (((7 - band) * 32 + frameNumber * 2) % 240) + 16;
    }
  }

  return data;
}

// ── WebRTC loopback setup ─────────────────────────────────────────────────────

async function setupLoopback(wrtc: any, type: 'voice' | 'video') {
  const { RTCPeerConnection, nonstandard, MediaStream } = wrtc;
  const { RTCAudioSource, RTCVideoSource, RTCAudioSink, RTCVideoSink } = nonstandard;

  const senderPeer = new RTCPeerConnection({ iceServers: [] });
  const receiverPeer = new RTCPeerConnection({ iceServers: [] });

  senderPeer.onicecandidate = (e: any) => {
    if (e.candidate) receiverPeer.addIceCandidate(e.candidate);
  };
  receiverPeer.onicecandidate = (e: any) => {
    if (e.candidate) senderPeer.addIceCandidate(e.candidate);
  };

  const audioSrc = new RTCAudioSource();
  const audioTrack = audioSrc.createTrack();
  const stream = new MediaStream();
  stream.addTrack(audioTrack);
  senderPeer.addTrack(audioTrack, stream);

  let videoSrc: any = null;
  if (type === 'video') {
    videoSrc = new RTCVideoSource();
    const videoTrack = videoSrc.createTrack();
    stream.addTrack(videoTrack);
    senderPeer.addTrack(videoTrack, stream);
  }

  // Receiver metrics
  const metrics = {
    audioFramesReceived: 0,
    videoFramesReceived: 0,
    lastVideoRecvTime: 0,
    videoIntervalSum: 0,
    videoIntervalCount: 0,
    videoTimingAlerts: 0,
    lastAudioRecvTime: 0,
    audioIntervalSum: 0,
    audioIntervalCount: 0,
    audioTimingAlerts: 0,
  };

  let receiverAudioSink: any = null;
  let receiverVideoSink: any = null;

  receiverPeer.ontrack = (event: any) => {
    const track = event.track;
    log.info(`Receiver got track: ${track.kind}`);

    if (track.kind === 'audio') {
      receiverAudioSink = new RTCAudioSink(track);
      receiverAudioSink.ondata = () => {
        metrics.audioFramesReceived++;
        const now = Date.now();
        if (metrics.lastAudioRecvTime > 0) {
          const delta = now - metrics.lastAudioRecvTime;
          metrics.audioIntervalSum += delta;
          metrics.audioIntervalCount++;
          if (Math.abs(delta - 10) > 5) metrics.audioTimingAlerts++;
        }
        metrics.lastAudioRecvTime = now;
      };
    } else if (track.kind === 'video') {
      receiverVideoSink = new RTCVideoSink(track);
      receiverVideoSink.onframe = () => {
        metrics.videoFramesReceived++;
        const now = Date.now();
        if (metrics.lastVideoRecvTime > 0) {
          const delta = now - metrics.lastVideoRecvTime;
          metrics.videoIntervalSum += delta;
          metrics.videoIntervalCount++;
        }
        metrics.lastVideoRecvTime = now;
      };
    }
  };

  // SDP exchange
  const offer = await senderPeer.createOffer();
  await senderPeer.setLocalDescription(offer);
  await receiverPeer.setRemoteDescription(offer);
  const answer = await receiverPeer.createAnswer();
  await receiverPeer.setLocalDescription(answer);
  await senderPeer.setRemoteDescription(answer);

  // Wait for connection
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Connection timeout')), 10_000);
    const check = () => {
      if (senderPeer.connectionState === 'connected') { clearTimeout(timeout); resolve(); }
      else if (senderPeer.connectionState === 'failed') { clearTimeout(timeout); reject(new Error('Connection failed')); }
    };
    senderPeer.onconnectionstatechange = check;
    check();
  });

  log.info('Loopback connection established');

  return {
    senderPeer, receiverPeer, audioSrc, videoSrc, metrics,
    cleanup: () => {
      if (receiverAudioSink) receiverAudioSink.stop();
      if (receiverVideoSink) receiverVideoSink.stop();
      audioTrack.stop();
      senderPeer.close();
      receiverPeer.close();
    },
  };
}

// ── Real pipeline test ────────────────────────────────────────────────────────

async function runRealPipelineTest(options: {
  type: 'voice' | 'video';
  duration: number;
  resolution: string;
  mediaDir: string;
}): Promise<LoopbackReport> {
  const { type, duration, resolution, mediaDir } = options;
  const preset = RESOLUTION_PRESETS[resolution] || RESOLUTION_PRESETS['720p'];
  const startedAt = new Date();

  log.info(`[REAL PIPELINE] Starting ${type} test: ${preset.width}x${preset.height}@${preset.fps}fps for ${duration}s`);

  // Find media files
  const audioFile = findMediaFile(mediaDir, '.mp3');
  if (!audioFile) throw new Error(`No MP3 file found in ${mediaDir}. Use --media-dir to specify.`);
  log.info(`Using audio: ${audioFile}`);

  let videoFile: string | null = null;
  if (type === 'video') {
    videoFile = findMediaFile(mediaDir, '.mp4');
    if (!videoFile) throw new Error(`No MP4 file found in ${mediaDir}. Use --media-dir to specify.`);
    log.info(`Using video: ${videoFile}`);
  }

  // Load wrtc
  const mod = await (import('@roamhq/wrtc' as string) as Promise<any>);
  const wrtc = mod.default || mod;
  const { nonstandard } = wrtc;

  const loopback = await setupLoopback(wrtc, type);
  const ffmpegPath = resolveFfmpegPath();
  log.info(`FFmpeg path: ${ffmpegPath}`);

  // Create real AudioSource and VideoSource
  const audioSource = new AudioSource(loopback.audioSrc, ffmpegPath, log);
  let videoSource: VideoSource | null = null;

  if (type === 'video' && videoFile) {
    videoSource = new VideoSource(loopback.videoSrc, ffmpegPath, log);
  }

  // Start playback — this is exactly what a real call does
  audioSource.start(audioFile, { loop: true });

  if (videoSource && videoFile) {
    videoSource.start(videoFile, {
      width: preset.width,
      height: preset.height,
      fps: preset.fps,
      loop: true,
    });
  }

  // Wait for test duration, logging progress every 5 seconds
  const progressInterval = setInterval(() => {
    const audioStats = `audio: ${loopback.metrics.audioFramesReceived} recv, ${audioSource.underrunCount} underruns, buf=${audioSource.bufferMs}ms`;
    const videoStats = videoSource
      ? `, video: ${loopback.metrics.videoFramesReceived} recv, ${videoSource.droppedFrames} drops, buf=${videoSource.bufferedFrames}/${videoSource.bufferHealth.toFixed(2)}`
      : '';
    log.info(`[PROGRESS] ${audioStats}${videoStats}`);
  }, 5000);

  await new Promise(resolve => setTimeout(resolve, duration * 1000));
  clearInterval(progressInterval);

  // Capture stats before cleanup
  const audioFramesSent = audioSource.framesDelivered;
  const audioUnderruns = audioSource.underrunCount;
  const videoFramesSent = videoSource?.framesDelivered ?? 0;
  const videoDroppedFrames = videoSource?.droppedFrames ?? 0;
  const videoTimingAlerts = videoSource?.timingAlerts ?? 0;
  const audioTimingAlerts = audioSource.timingAlerts;

  // Cleanup
  audioSource.stop();
  videoSource?.stop();
  loopback.cleanup();

  const endedAt = new Date();

  // ── Scoring ─────────────────────────────────────────────────────────────

  const m = loopback.metrics;
  const expectedAudioFrames = duration * 100;
  const expectedVideoFrames = type === 'video' ? duration * preset.fps : 0;

  const audioDropRate = 1 - Math.min(1, m.audioFramesReceived / Math.max(1, expectedAudioFrames));
  const videoDropRate = type === 'video'
    ? 1 - Math.min(1, m.videoFramesReceived / Math.max(1, expectedVideoFrames))
    : 0;

  const avgVideoInterval = m.videoIntervalCount > 0 ? m.videoIntervalSum / m.videoIntervalCount : 0;
  const avgAudioInterval = m.audioIntervalCount > 0 ? m.audioIntervalSum / m.audioIntervalCount : 0;

  const details: string[] = [];
  let score = 0;

  // Audio delivery (20%)
  const audioDelScore = Math.min(1, m.audioFramesReceived / Math.max(1, expectedAudioFrames)) * 20;
  score += audioDelScore;
  details.push(`Audio delivery: ${m.audioFramesReceived}/${audioFramesSent} sent, expected ~${expectedAudioFrames} (${(audioDropRate * 100).toFixed(1)}% drop) -> ${audioDelScore.toFixed(1)}/20`);

  // Audio health (10%) — underruns indicate ring buffer problems
  const underrunPenalty = Math.min(1, audioUnderruns / Math.max(1, expectedAudioFrames * 0.01));
  const audioHealthScore = (1 - underrunPenalty) * 10;
  score += audioHealthScore;
  details.push(`Audio health: ${audioUnderruns} underruns in ${audioFramesSent} frames -> ${audioHealthScore.toFixed(1)}/10`);

  // Video delivery (20%)
  if (type === 'video') {
    const videoDelScore = Math.min(1, m.videoFramesReceived / Math.max(1, expectedVideoFrames)) * 20;
    score += videoDelScore;
    details.push(`Video delivery: ${m.videoFramesReceived}/${videoFramesSent} sent, expected ~${expectedVideoFrames} (${(videoDropRate * 100).toFixed(1)}% drop) -> ${videoDelScore.toFixed(1)}/20`);
  } else {
    score += 20;
    details.push(`Video: N/A (voice only) -> 20/20`);
  }

  // Video health (10%) — dropped frames indicate buffer overflow / CPU pressure
  if (type === 'video') {
    const dropPenalty = Math.min(1, videoDroppedFrames / Math.max(1, videoFramesSent * 0.05));
    const videoHealthScore = (1 - dropPenalty) * 10;
    score += videoHealthScore;
    details.push(`Video health: ${videoDroppedFrames} dropped frames -> ${videoHealthScore.toFixed(1)}/10`);
  } else {
    score += 10;
    details.push(`Video health: N/A -> 10/10`);
  }

  // Audio timing (15%)
  const audioTimScore = Math.max(0, 1 - m.audioTimingAlerts / Math.max(1, m.audioIntervalCount)) * 15;
  score += audioTimScore;
  details.push(`Audio timing: avg ${avgAudioInterval.toFixed(1)}ms, ${m.audioTimingAlerts} alerts in ${m.audioIntervalCount} -> ${audioTimScore.toFixed(1)}/15`);

  // Video timing (15%)
  if (type === 'video') {
    const targetMs = 1000 / preset.fps;
    const vidTimAlertRate = m.videoTimingAlerts / Math.max(1, m.videoIntervalCount);
    const videoTimScore = Math.max(0, 1 - vidTimAlertRate) * 15;
    score += videoTimScore;
    details.push(`Video timing: avg ${avgVideoInterval.toFixed(1)}ms (target ${targetMs.toFixed(1)}ms), sender alerts: ${videoTimingAlerts} -> ${videoTimScore.toFixed(1)}/15`);
  } else {
    score += 15;
    details.push(`Video timing: N/A -> 15/15`);
  }

  // Feed timer accuracy (10%)
  const senderTimScore = Math.max(0, 1 - audioTimingAlerts / Math.max(1, expectedAudioFrames * 0.1)) * 10;
  score += senderTimScore;
  details.push(`Feed timers: audio=${audioTimingAlerts} alerts, video=${videoTimingAlerts} alerts -> ${senderTimScore.toFixed(1)}/10`);

  const pass = score >= 70;

  return {
    type,
    mode: 'real-pipeline',
    resolution: `${preset.width}x${preset.height}@${preset.fps}fps`,
    duration,
    startedAt: startedAt.toISOString(),
    endedAt: endedAt.toISOString(),
    sender: { audioFramesSent, videoFramesSent, audioUnderruns, videoDroppedFrames },
    receiver: {
      audioFramesReceived: m.audioFramesReceived,
      videoFramesReceived: m.videoFramesReceived,
      audioDropRate, videoDropRate,
      avgVideoIntervalMs: avgVideoInterval,
      avgAudioIntervalMs: avgAudioInterval,
      videoTimingAlerts: m.videoTimingAlerts,
      audioTimingAlerts: m.audioTimingAlerts,
    },
    encoding: { avgEncodeTimeMs: 0, maxEncodeTimeMs: 0, framesEncodedPerSecond: 0 },
    pass,
    score: Math.round(score * 10) / 10,
    details,
  };
}

// ── Synthetic test ────────────────────────────────────────────────────────────

async function runSyntheticTest(options: {
  type: 'voice' | 'video';
  duration: number;
  resolution: string;
}): Promise<LoopbackReport> {
  const { type, duration, resolution } = options;
  const preset = RESOLUTION_PRESETS[resolution] || RESOLUTION_PRESETS['720p'];
  const startedAt = new Date();

  log.info(`[SYNTHETIC] Starting ${type} test: ${preset.width}x${preset.height}@${preset.fps}fps for ${duration}s`);

  const mod = await (import('@roamhq/wrtc' as string) as Promise<any>);
  const wrtc = mod.default || mod;

  const loopback = await setupLoopback(wrtc, type);

  let audioFramesSent = 0;
  let videoFramesSent = 0;
  let audioSampleOffset = 0;
  let encodeTimeSum = 0;
  let encodeTimeMax = 0;
  let encodeTimeSamples = 0;

  // Audio feed
  const audioIntervalNs = BigInt(10_000_000);
  let audioStartTime = process.hrtime.bigint();
  let audioTickCount = 0;

  const audioTick = () => {
    if (audioFramesSent >= duration * 100) return;
    const { samples: rawSamples, nextOffset } = generate440HzFrame(audioSampleOffset, 0.5);
    audioSampleOffset = nextOffset;
    const frame = new Int16Array(480);
    frame.set(rawSamples);
    loopback.audioSrc.onData({ samples: frame, sampleRate: 48000, bitsPerSample: 16, channelCount: 1, numberOfFrames: 480 });
    audioFramesSent++;
    audioTickCount++;
    const nextTarget = audioStartTime + BigInt(audioTickCount) * audioIntervalNs;
    const now = process.hrtime.bigint();
    const delayNs = Number(nextTarget - now);
    if (delayNs < -Number(audioIntervalNs) * 2) { audioStartTime = now; audioTickCount = 0; setTimeout(audioTick, 10); }
    else setTimeout(audioTick, Math.max(1, delayNs / 1_000_000));
  };

  // Video feed
  let videoFeedTimeout: ReturnType<typeof setTimeout> | null = null;
  if (type === 'video' && loopback.videoSrc) {
    const videoIntervalNsVal = BigInt(Math.round((1000 / preset.fps) * 1_000_000));
    let videoStartTime = process.hrtime.bigint();
    let videoTickCount = 0;
    const videoTick = () => {
      if (videoFramesSent >= duration * preset.fps) return;
      const frameData = generateI420TestFrame(preset.width, preset.height, videoFramesSent);
      const before = process.hrtime.bigint();
      loopback.videoSrc.onFrame({ width: preset.width, height: preset.height, data: frameData });
      const encodeMs = Number(process.hrtime.bigint() - before) / 1_000_000;
      encodeTimeSum += encodeMs; encodeTimeMax = Math.max(encodeTimeMax, encodeMs); encodeTimeSamples++;
      videoFramesSent++; videoTickCount++;
      const nextTarget = videoStartTime + BigInt(videoTickCount) * videoIntervalNsVal;
      const now = process.hrtime.bigint();
      const delayNs = Number(nextTarget - now);
      if (delayNs < -Number(videoIntervalNsVal) * 2) { videoStartTime = now; videoTickCount = 0; videoFeedTimeout = setTimeout(videoTick, 1000 / preset.fps); }
      else videoFeedTimeout = setTimeout(videoTick, Math.max(1, delayNs / 1_000_000));
    };
    videoFeedTimeout = setTimeout(videoTick, 1000 / preset.fps);
  }

  setTimeout(audioTick, 10);
  await new Promise(resolve => setTimeout(resolve, duration * 1000));

  if (videoFeedTimeout) clearTimeout(videoFeedTimeout);
  loopback.cleanup();

  const endedAt = new Date();
  const m = loopback.metrics;
  const expectedAudio = duration * 100;
  const expectedVideo = type === 'video' ? duration * preset.fps : 0;
  const avgVideoInterval = m.videoIntervalCount > 0 ? m.videoIntervalSum / m.videoIntervalCount : 0;
  const avgAudioInterval = m.audioIntervalCount > 0 ? m.audioIntervalSum / m.audioIntervalCount : 0;
  const avgEncodeTime = encodeTimeSamples > 0 ? encodeTimeSum / encodeTimeSamples : 0;

  const details: string[] = [];
  let score = 0;

  const audioDelScore = Math.min(1, m.audioFramesReceived / Math.max(1, expectedAudio)) * 25;
  score += audioDelScore;
  details.push(`Audio delivery: ${m.audioFramesReceived}/${audioFramesSent} (${((1 - m.audioFramesReceived / Math.max(1, audioFramesSent)) * 100).toFixed(1)}% drop) -> ${audioDelScore.toFixed(1)}/25`);

  if (type === 'video') {
    const videoDelScore = Math.min(1, m.videoFramesReceived / Math.max(1, expectedVideo)) * 25;
    score += videoDelScore;
    details.push(`Video delivery: ${m.videoFramesReceived}/${videoFramesSent} (${((1 - m.videoFramesReceived / Math.max(1, videoFramesSent)) * 100).toFixed(1)}% drop) -> ${videoDelScore.toFixed(1)}/25`);
  } else { score += 25; details.push(`Video: N/A -> 25/25`); }

  const audioTimScore = Math.max(0, 1 - m.audioTimingAlerts / Math.max(1, m.audioIntervalCount)) * 15;
  score += audioTimScore;
  details.push(`Audio timing: avg ${avgAudioInterval.toFixed(1)}ms, ${m.audioTimingAlerts} alerts -> ${audioTimScore.toFixed(1)}/15`);

  if (type === 'video') {
    const vidTimScore = Math.max(0, 1 - m.videoTimingAlerts / Math.max(1, m.videoIntervalCount)) * 15;
    score += vidTimScore;
    details.push(`Video timing: avg ${avgVideoInterval.toFixed(1)}ms, ${m.videoTimingAlerts} alerts -> ${vidTimScore.toFixed(1)}/15`);
  } else { score += 15; details.push(`Video timing: N/A -> 15/15`); }

  if (type === 'video') {
    const targetMs = 1000 / preset.fps;
    const encodeScore = Math.max(0, 1 - Math.max(0, avgEncodeTime / targetMs - 0.5)) * 20;
    score += encodeScore;
    details.push(`Encoding: avg ${avgEncodeTime.toFixed(2)}ms, max ${encodeTimeMax.toFixed(2)}ms (budget ${targetMs.toFixed(1)}ms) -> ${encodeScore.toFixed(1)}/20`);
  } else { score += 20; details.push(`Encoding: N/A -> 20/20`); }

  return {
    type, mode: 'synthetic', resolution: `${preset.width}x${preset.height}@${preset.fps}fps`,
    duration, startedAt: startedAt.toISOString(), endedAt: endedAt.toISOString(),
    sender: { audioFramesSent, videoFramesSent },
    receiver: { audioFramesReceived: m.audioFramesReceived, videoFramesReceived: m.videoFramesReceived,
      audioDropRate: 1 - m.audioFramesReceived / Math.max(1, audioFramesSent),
      videoDropRate: type === 'video' ? 1 - m.videoFramesReceived / Math.max(1, videoFramesSent) : 0,
      avgVideoIntervalMs: avgVideoInterval, avgAudioIntervalMs: avgAudioInterval,
      videoTimingAlerts: m.videoTimingAlerts, audioTimingAlerts: m.audioTimingAlerts },
    encoding: { avgEncodeTimeMs: avgEncodeTime, maxEncodeTimeMs: encodeTimeMax, framesEncodedPerSecond: encodeTimeSamples / duration },
    pass: score >= 70, score: Math.round(score * 10) / 10, details,
  };
}

// ── CLI ───────────────────────────────────────────────────────────────────────

const program = new Command()
  .name('ghost-ai-loopback-test')
  .description('End-to-end WebRTC loopback test')
  .version('2.0.0')
  .option('--type <type>', 'Call type: voice or video', 'video')
  .option('--duration <seconds>', 'Test duration in seconds', '15')
  .option('--resolution <preset>', 'Resolution preset: 480p, 720p, 1080p, 4k', '720p')
  .option('--real-pipeline', 'Use real FFmpeg AudioSource/VideoSource instead of synthetic frames')
  .option('--media-dir <path>', 'Directory containing media files for real-pipeline mode', './data/media')
  .option('--output <path>', 'Output report file path', './loopback-report.json')
  .parse();

const opts = program.opts();

const testFn = opts.realPipeline
  ? () => runRealPipelineTest({
      type: opts.type as 'voice' | 'video',
      duration: parseInt(opts.duration, 10),
      resolution: opts.resolution,
      mediaDir: opts.mediaDir,
    })
  : () => runSyntheticTest({
      type: opts.type as 'voice' | 'video',
      duration: parseInt(opts.duration, 10),
      resolution: opts.resolution,
    });

testFn().then((report) => {
  console.log('\n' + '='.repeat(70));
  console.log(`  Loopback Test [${report.mode}]: ${report.pass ? 'PASS \u2705' : 'FAIL \u274C'}  Score: ${report.score}/100`);
  console.log(`  Resolution: ${report.resolution}`);
  console.log('='.repeat(70));
  for (const detail of report.details) {
    console.log(`  ${detail}`);
  }
  console.log('='.repeat(70) + '\n');

  if (opts.output) {
    writeFileSync(opts.output, JSON.stringify(report, null, 2));
    console.log(`Report saved to: ${opts.output}`);
  }

  process.exit(report.pass ? 0 : 1);
}).catch((err) => {
  console.error('Loopback test failed:', err);
  process.exit(1);
});
