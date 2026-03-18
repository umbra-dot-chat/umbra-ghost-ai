/**
 * CallHandler — manages WebRTC voice/video calls for Ghost AI.
 *
 * Ghost answers incoming calls, streams audio/video media on loop,
 * supports upgrade/downgrade, data channel metadata, and chat commands.
 */

import { readFileSync } from 'fs';
import { AudioSource, resolveFfmpegPath } from '../media/audio-source.js';
import { VideoSource, parseResolution } from '../media/video-source.js';
import { MediaManager, type MediaFile } from '../media/manager.js';
import { RawMediaCapture } from '../media/capture.js';
import { DegradationDetector } from '../media/degradation-detector.js';
import { AudioTestSignal, VideoTestSignal } from '../media/test-signal.js';
import { decryptMessage, encryptMessage, uuid, type GhostIdentity } from '../crypto.js';
import type { RelayClient } from '../relay.js';
import type { ContextStore, StoredFriend } from '../context/store.js';
import type { GhostConfig, IceServer, Logger } from '../config.js';

// ── Call signaling types ─────────────────────────────────────────────────────

interface CallOfferPayload {
  callId: string;
  sdp: string;
  sdpType: 'offer';
  callType: 'voice' | 'video';
  senderDid: string;
  senderDisplayName?: string;
  conversationId: string;
}

interface CallAnswerPayload {
  callId: string;
  sdp: string;
  type: 'answer';
}

interface CallIceCandidatePayload {
  callId: string;
  candidate: string;
  sdpMid: string | null;
  sdpMLineIndex: number | null;
}

interface CallEndPayload {
  callId: string;
  reason: string;
}

interface CallStatePayload {
  callId: string;
  state: string;
}

// ── Active call state ────────────────────────────────────────────────────────

interface ActiveCall {
  callId: string;
  peerDid: string;
  conversationId: string;
  callType: 'voice' | 'video';
  peer: any; // RTCPeerConnection
  dataChannel: any; // RTCDataChannel
  audioSource: AudioSource | null;
  videoSource: VideoSource | null;
  videoSender: any | null; // RTCRtpSender
  startedAt: number;
  lastActivityAt: number; // Updated on stats/metadata activity for watchdog
  statsInterval: ReturnType<typeof setInterval> | null;
  metadataInterval: ReturnType<typeof setInterval> | null;
  disconnectTimer: ReturnType<typeof setTimeout> | null;
  cleanedUp: boolean; // Guard against double-cleanup
  stats: CallStats;
  // Per-call video quality (initialized from config, changeable via commands)
  videoWidth: number;
  videoHeight: number;
  videoFps: number;
  // Screen share (second video source for test pattern)
  screenVideoSource: VideoSource | null;
  screenVideoSender: any | null; // RTCRtpSender for screen track
  isScreenSharing: boolean;
  // Diagnostic tools
  capture: RawMediaCapture | null;
  degradation: DegradationDetector | null;
  audioTestSignal: AudioTestSignal | null;
  videoTestSignal: VideoTestSignal | null;
}

interface CallStats {
  audioBitrate: number;
  videoBitrate: number;
  packetLoss: number;
  jitter: number;
  roundTripTime: number;
  bytesSent: number;
  bytesReceived: number;
  lastStatsAt: number;
  prevBytesSent: number;
}

export interface ActiveCallInfo {
  callId: string;
  peerDid: string;
  callType: 'voice' | 'video';
  duration: number;
  audioTrack: string | null;
  videoTrack: string | null;
  stats: CallStats;
}

const MAX_CONCURRENT_CALLS = 3;
const STALE_CALL_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes without activity
const WATCHDOG_INTERVAL_MS = 30_000; // Check every 30s
const PENDING_ICE_TIMEOUT_MS = 60_000; // Drop orphan ICE candidates after 60s

// ── CallHandler ──────────────────────────────────────────────────────────────

export class CallHandler {
  private config: GhostConfig;
  private identity: GhostIdentity;
  private relay: RelayClient;
  private store: ContextStore;
  private log: Logger;
  private mediaManager: MediaManager;

  private wrtc: any = null;
  private ffmpegPath: string;
  private activeCalls = new Map<string, ActiveCall>();
  private pendingIceCandidates = new Map<string, { candidates: any[]; createdAt: number }>();
  private watchdogInterval: ReturnType<typeof setInterval> | null = null;

  constructor(
    config: GhostConfig,
    identity: GhostIdentity,
    relay: RelayClient,
    store: ContextStore,
    mediaManager: MediaManager,
    log: Logger,
  ) {
    this.config = config;
    this.identity = identity;
    this.relay = relay;
    this.store = store;
    this.mediaManager = mediaManager;
    this.log = log;
    this.ffmpegPath = resolveFfmpegPath();
  }

  /** Load the wrtc module. Returns false if unavailable. */
  async initialize(): Promise<boolean> {
    try {
      const mod = await (import('@roamhq/wrtc' as string) as Promise<any>);
      // ESM dynamic import of CJS module puts exports under .default
      this.wrtc = mod.default || mod;
      this.log.info('[CALL] WebRTC module loaded (@roamhq/wrtc)');
      this.startWatchdog();
      return true;
    } catch (err) {
      this.log.error('[CALL] Failed to load @roamhq/wrtc — calls disabled:', err);
      return false;
    }
  }

  get enabled(): boolean {
    return this.wrtc !== null;
  }

  /**
   * Decrypt an encrypted call signal payload.
   * The client encrypts signals using the same X25519+HKDF+AES-GCM protocol
   * as chat messages, but uses callId as the HKDF salt instead of conversationId.
   */
  private decryptSignalPayload(payload: any): any {
    if (!payload.encrypted || !payload.nonce || !payload.senderDid) {
      this.log.debug(`[CALL] Signal not encrypted (keys: ${Object.keys(payload).join(', ')})`);
      return payload; // Not encrypted
    }
    this.log.debug(`[CALL] Decrypting encrypted signal from ${payload.senderDid?.slice(0, 24)}...`);

    const friend = this.store.getFriend(payload.senderDid);
    if (!friend) {
      this.log.warn(`[CALL] Cannot decrypt signal — unknown sender: ${payload.senderDid?.slice(0, 24)}...`);
      return payload;
    }

    try {
      const plaintext = decryptMessage(
        payload.encrypted,
        payload.nonce,
        this.identity.encryptionPrivateKey,
        friend.encryptionKey,
        payload.senderDid,
        this.identity.did,
        payload.timestamp,
        payload.callId || '', // callId used as HKDF salt (same as context in WASM)
      );
      const decrypted = JSON.parse(plaintext);
      this.log.debug(`[CALL] Decrypted signal from ${friend.displayName}`);
      return decrypted;
    } catch (err) {
      this.log.error(`[CALL] Failed to decrypt signal:`, err);
      return payload; // Fall through with original (will likely fail later)
    }
  }

  // ── Signaling handlers ────────────────────────────────────────────────────

  async handleCallOffer(payload: any): Promise<void> {
    // Decrypt if encrypted
    const decrypted: CallOfferPayload = this.decryptSignalPayload(payload);
    const { callId, senderDid, callType } = decrypted;
    this.log.info(`[CALL] Incoming ${callType} call: ${callId} from ${senderDid?.slice(0, 24)}... (active: ${this.activeCalls.size}/${MAX_CONCURRENT_CALLS})`);
    this.log.debug(`[CALL] Offer keys: ${Object.keys(decrypted).join(', ')}, sdp length: ${decrypted.sdp?.length}, sdp starts: ${JSON.stringify(decrypted.sdp?.slice(0, 30))}`);

    if (!this.wrtc) {
      this.log.warn(`[CALL] Cannot answer — WebRTC not loaded`);
      return;
    }

    const friend = this.store.getFriend(senderDid);
    if (!friend) {
      this.log.warn(`[CALL] Rejecting call from unknown DID: ${senderDid?.slice(0, 24)}...`);
      this.sendCallEnd(senderDid, callId, 'rejected');
      return;
    }

    // Concurrency cap — reject if already at max
    if (this.activeCalls.size >= MAX_CONCURRENT_CALLS) {
      this.log.warn(`[CALL] Rejecting call — at capacity (${this.activeCalls.size}/${MAX_CONCURRENT_CALLS})`);
      this.sendCallEnd(senderDid, callId, 'busy');
      this.sendChatNotification(
        friend,
        `Sorry, I'm currently at capacity with ${this.activeCalls.size} active calls. Please try again in a few minutes!`,
      );
      return;
    }

    // Send ringing state
    this.sendCallState(senderDid, callId, 'ringing');

    // Fake ring delay
    await new Promise((r) => setTimeout(r, this.config.callRingDelayMs));

    // Create and answer the call
    try {
      await this.createCallFromOffer(decrypted, friend);
    } catch (err) {
      this.log.error(`[CALL] Failed to answer call ${callId}:`, err);
      // Clean up any partially created call to prevent crash from orphaned audio/video sources
      const call = this.activeCalls.get(callId);
      if (call) this.cleanupCall(call);
      this.sendCallEnd(senderDid, callId, 'error');
      this.sendChatNotification(friend, `❌ Failed to connect call.`);
    }
  }

  async handleCallIceCandidate(rawPayload: any): Promise<void> {
    const payload: CallIceCandidatePayload = this.decryptSignalPayload(rawPayload);
    const call = this.activeCalls.get(payload.callId);

    if (!call) {
      // Call not created yet (likely in ring delay) — queue the candidate
      if (!this.pendingIceCandidates.has(payload.callId)) {
        this.pendingIceCandidates.set(payload.callId, { candidates: [], createdAt: Date.now() });
      }
      const pending = this.pendingIceCandidates.get(payload.callId)!;
      pending.candidates.push(payload);
      this.log.debug(`[CALL] Queued ICE candidate for pending call ${payload.callId} (${pending.candidates.length} queued)`);
      return;
    }

    await this.addIceCandidateToCall(call, payload);
  }

  private async addIceCandidateToCall(call: ActiveCall, payload: CallIceCandidatePayload): Promise<void> {
    try {
      await call.peer.addIceCandidate(new this.wrtc.RTCIceCandidate({
        candidate: payload.candidate,
        sdpMid: payload.sdpMid,
        sdpMLineIndex: payload.sdpMLineIndex,
      }));
      this.log.debug(`[CALL] Added ICE candidate for ${call.callId}`);
    } catch (err: any) {
      // Ignore errors from closed peer connections (race with call end)
      if (!err?.message?.includes('closed')) {
        this.log.debug(`[CALL] ICE candidate error:`, err);
      }
    }
  }

  handleCallEnd(rawPayload: any): void {
    const payload: CallEndPayload = this.decryptSignalPayload(rawPayload);
    const call = this.activeCalls.get(payload.callId);
    if (!call) return;

    this.log.info(`[CALL] Call ended: ${payload.callId} (${payload.reason})`);
    this.cleanupCall(call);

    // Call event message is now handled by the client UI inline
  }

  handleCallState(rawPayload: any): void {
    const payload: CallStatePayload = this.decryptSignalPayload(rawPayload);
    this.log.debug(`[CALL] Remote state: ${payload.callId} → ${payload.state}`);
  }

  async handleCallReoffer(rawPayload: any): Promise<void> {
    const payload = this.decryptSignalPayload(rawPayload) as { callId: string; sdp: string; senderDid: string };
    const call = this.activeCalls.get(payload.callId);
    if (!call) {
      this.log.debug(`[CALL] Ignoring reoffer for unknown call: ${payload.callId}`);
      return;
    }

    try {
      // If we have a pending local offer (glare), roll back first
      if (call.peer.signalingState === 'have-local-offer') {
        await call.peer.setLocalDescription({ type: 'rollback' } as RTCSessionDescriptionInit);
      }
      const offer = JSON.parse(payload.sdp);
      await call.peer.setRemoteDescription(
        new this.wrtc.RTCSessionDescription(offer),
      );
      const answer = await call.peer.createAnswer();
      await call.peer.setLocalDescription(answer);

      const friend = this.store.getFriend(call.peerDid);
      if (friend) {
        this.relay.sendEnvelope(friend.did, {
          envelope: 'call_reanswer',
          version: 1,
          payload: {
            callId: call.callId,
            sdp: JSON.stringify({ sdp: answer.sdp, type: answer.type }),
            senderDid: this.identity.did,
          },
        });
      }
      this.log.debug(`[CALL ${call.callId}] Processed reoffer and sent reanswer`);
    } catch (err) {
      this.log.error(`[CALL ${payload.callId}] Failed to handle reoffer:`, err);
    }
  }

  async handleCallReanswer(rawPayload: any): Promise<void> {
    const payload = this.decryptSignalPayload(rawPayload) as { callId: string; sdp: string };
    const call = this.activeCalls.get(payload.callId);
    if (!call) {
      this.log.debug(`[CALL] Ignoring reanswer for unknown call: ${payload.callId}`);
      return;
    }

    try {
      const answer = JSON.parse(payload.sdp);
      await call.peer.setRemoteDescription(
        new this.wrtc.RTCSessionDescription(answer),
      );
      this.log.debug(`[CALL ${call.callId}] Processed renegotiation answer`);
    } catch (err) {
      this.log.error(`[CALL ${payload.callId}] Failed to process reanswer:`, err);
    }
  }

  // ── Call creation ─────────────────────────────────────────────────────────

  private async createCallFromOffer(offer: CallOfferPayload, friend: StoredFriend): Promise<void> {
    const { RTCPeerConnection, nonstandard } = this.wrtc;
    const { RTCAudioSource, RTCVideoSource } = nonstandard;

    // Filter ICE servers: TURN servers require credentials, skip ones without
    const iceServers = this.config.iceServers
      .filter((s: IceServer) => {
        const urls = Array.isArray(s.urls) ? s.urls : [s.urls];
        const hasTurn = urls.some(u => u.startsWith('turn:') || u.startsWith('turns:'));
        if (hasTurn && !s.username) {
          this.log.debug('[CALL] Skipping TURN server without credentials');
          return false;
        }
        return true;
      })
      .map((s: IceServer) => ({
        urls: s.urls,
        ...(s.username ? { username: s.username, credential: s.credential } : {}),
      }));

    const peer = new RTCPeerConnection({ iceServers });

    const now = Date.now();
    const call: ActiveCall = {
      callId: offer.callId,
      peerDid: offer.senderDid,
      conversationId: offer.conversationId,
      callType: offer.callType,
      peer,
      dataChannel: null,
      audioSource: null,
      videoSource: null,
      videoSender: null,
      startedAt: now,
      lastActivityAt: now,
      statsInterval: null,
      metadataInterval: null,
      disconnectTimer: null,
      cleanedUp: false,
      stats: {
        audioBitrate: 0, videoBitrate: 0, packetLoss: 0, jitter: 0,
        roundTripTime: 0, bytesSent: 0, bytesReceived: 0,
        lastStatsAt: now, prevBytesSent: 0,
      },
      videoWidth: this.config.maxVideoWidth,
      videoHeight: this.config.maxVideoHeight,
      videoFps: this.config.maxVideoFps,
      screenVideoSource: null,
      screenVideoSender: null,
      isScreenSharing: false,
      capture: null,
      degradation: null,
      audioTestSignal: null,
      videoTestSignal: null,
    };

    // Initialize diagnostic tools based on config
    if (this.config.diagDegradation) {
      call.degradation = new DegradationDetector(this.log);
      call.degradation.start({
        videoTargetIntervalMs: offer.callType === 'video' ? (1000 / call.videoFps) : undefined,
        onDegradation: (event) => {
          // Send degradation event to client via data channel
          if (call.dataChannel?.readyState === 'open') {
            try {
              call.dataChannel.send(JSON.stringify({
                ...event,
                type: 'degradation-event',
                mediaType: event.type,
              }));
            } catch { /* ignore */ }
          }
        },
      });
    }

    if (this.config.diagRawCapture) {
      call.capture = new RawMediaCapture(this.config.mediaCacheDir, offer.callId, this.log);
      const videoRes = offer.callType === 'video' ? { width: call.videoWidth, height: call.videoHeight } : undefined;
      call.capture.start(videoRes?.width, videoRes?.height);
    }

    this.activeCalls.set(offer.callId, call);

    // ICE candidate forwarding
    peer.onicecandidate = (event: any) => {
      if (event.candidate) {
        this.relay.sendEnvelope(friend.did, {
          envelope: 'call_ice_candidate',
          version: 1,
          payload: {
            callId: offer.callId,
            candidate: event.candidate.candidate,
            sdpMid: event.candidate.sdpMid,
            sdpMLineIndex: event.candidate.sdpMLineIndex,
          },
        });
      }
    };

    peer.onconnectionstatechange = () => {
      const state = peer.connectionState;
      this.log.info(`[CALL] Connection state: ${state} for ${offer.callId}`);

      // Clear any pending disconnect timer on state change
      if (call.disconnectTimer) {
        clearTimeout(call.disconnectTimer);
        call.disconnectTimer = null;
      }

      if (state === 'failed' || state === 'closed') {
        this.log.warn(`[CALL] Connection ${state} for ${offer.callId} — cleaning up`);
        this.cleanupCall(call);
      } else if (state === 'disconnected') {
        // "disconnected" is temporary — give it 30s to recover before cleaning up
        this.log.info(`[CALL] Connection temporarily disconnected for ${offer.callId}, waiting 30s...`);
        call.disconnectTimer = setTimeout(() => {
          if (peer.connectionState !== 'connected') {
            this.log.warn(`[CALL] Connection did not recover for ${offer.callId} (state: ${peer.connectionState}), cleaning up`);
            this.cleanupCall(call);
          }
        }, 30_000);
      } else if (state === 'connected') {
        this.log.info(`[CALL] Connection established for ${offer.callId}`);
        call.lastActivityAt = Date.now();
      }
    };

    peer.oniceconnectionstatechange = () => {
      this.log.info(`[CALL] ICE connection state: ${peer.iceConnectionState} for ${offer.callId}`);
    };

    peer.onicegatheringstatechange = () => {
      this.log.info(`[CALL] ICE gathering state: ${peer.iceGatheringState} for ${offer.callId}`);
    };

    peer.onsignalingstatechange = () => {
      this.log.debug(`[CALL] Signaling state: ${peer.signalingState} for ${offer.callId}`);
    };

    // Handle renegotiation when tracks are added/removed (e.g., screen share)
    peer.onnegotiationneeded = async () => {
      if (peer.signalingState !== 'stable') return;
      try {
        const reoffer = await peer.createOffer();
        await peer.setLocalDescription(reoffer);
        const renegFriend = this.store.getFriend(call.peerDid);
        if (renegFriend) {
          this.relay.sendEnvelope(renegFriend.did, {
            envelope: 'call_reoffer',
            version: 1,
            payload: {
              callId: call.callId,
              sdp: JSON.stringify({ sdp: reoffer.sdp, type: reoffer.type }),
              sdpType: 'offer',
              callType: call.callType,
              senderDid: this.identity.did,
              conversationId: call.conversationId,
            },
          });
          this.log.debug(`[CALL ${call.callId}] Sent renegotiation offer`);
        }
      } catch (err) {
        this.log.error(`[CALL ${call.callId}] Renegotiation failed:`, err);
      }
    };

    // Create a MediaStream so the client's ontrack handler receives
    // event.streams[0] — without this, tracks arrive without a stream
    // and the client ignores them.
    const stream = new this.wrtc.MediaStream();

    // Create audio track (add to peer BEFORE SDP exchange, but don't start playing yet)
    const audioSrc = new RTCAudioSource();
    const audioTrack = audioSrc.createTrack();
    call.audioSource = new AudioSource(audioSrc, this.ffmpegPath, this.log);
    stream.addTrack(audioTrack);
    peer.addTrack(audioTrack, stream);

    // Create video track if video call (add to peer BEFORE SDP exchange)
    if (offer.callType === 'video') {
      this.createVideoTrack(call, stream);
    }

    // Create data channel
    call.dataChannel = peer.createDataChannel('ghost-metadata', { ordered: true });
    call.dataChannel.onopen = () => {
      this.log.debug(`[CALL] Data channel opened for ${offer.callId}`);
    };
    call.dataChannel.onmessage = (event: { data: string }) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'diagnostic-config' && msg.settings) {
          this.log.info(`[CALL] Received diagnostic config:`, msg.settings);
          // Update live config flags
          this.config.diagFrameTiming = msg.settings.frameTimingAlerts ?? this.config.diagFrameTiming;
          this.config.diagRingBufferLog = msg.settings.ringBufferLogging ?? this.config.diagRingBufferLog;
          this.config.diagRawCapture = msg.settings.rawMediaCapture ?? this.config.diagRawCapture;
          this.config.diagCodecLog = msg.settings.codecNegotiationLog ?? this.config.diagCodecLog;
          this.config.diagDegradation = msg.settings.degradationDetection ?? this.config.diagDegradation;
          this.config.diagRefSignal = msg.settings.referenceSignalMode ?? this.config.diagRefSignal;

          // Handle reference signal mode toggle during call
          if (msg.settings.referenceSignalMode === true && !call.audioTestSignal) {
            this.log.info(`[CALL] Enabling reference signal mode (440Hz)`);
            call.audioSource?.pause();
            call.videoSource?.pause();
            // Start 440Hz test signal on the audio source's underlying RTCAudioSource
            // Note: we use the wrtc nonstandard API directly
            const { nonstandard } = this.wrtc;
            const testAudioSrc = new nonstandard.RTCAudioSource();
            const testTrack = testAudioSrc.createTrack();
            call.audioTestSignal = new AudioTestSignal(testAudioSrc);
            call.audioTestSignal.start();
          } else if (msg.settings.referenceSignalMode === false && call.audioTestSignal) {
            this.log.info(`[CALL] Disabling reference signal mode`);
            call.audioTestSignal.stop();
            call.audioTestSignal = null;
            call.audioSource?.resume();
            call.videoSource?.resume();
          }

          // Handle raw capture toggle during call
          if (msg.settings.rawMediaCapture === true && !call.capture) {
            call.capture = new RawMediaCapture(this.config.mediaCacheDir, call.callId, this.log);
            const videoRes = call.callType === 'video' ? call.videoSource?.resolution : undefined;
            call.capture.start(videoRes?.width, videoRes?.height);
          } else if (msg.settings.rawMediaCapture === false && call.capture?.isCapturing) {
            call.capture.finalize();
            call.capture = null;
          }
        }
      } catch {
        // Ignore non-JSON messages
      }
    };

    // The client's CallManager.createOffer() returns JSON.stringify({sdp, type}),
    // so offer.sdp may be a JSON string rather than the raw SDP.
    let rawSdp = offer.sdp;
    if (rawSdp && rawSdp.startsWith('{')) {
      try {
        const parsed = JSON.parse(rawSdp);
        rawSdp = parsed.sdp || rawSdp;
        this.log.debug(`[CALL] Parsed JSON-wrapped SDP, actual length: ${rawSdp.length}`);
      } catch {
        // Not JSON, use as-is
      }
    }

    if (!rawSdp || !rawSdp.startsWith('v=')) {
      this.log.error(`[CALL] Invalid SDP (length=${rawSdp?.length}, starts=${JSON.stringify(rawSdp?.slice(0, 30))})`);
      throw new Error('Invalid SDP: does not start with v=');
    }

    // Set remote offer and create answer
    if (this.config.diagCodecLog) {
      this.log.info(`[CODEC] Remote offer codecs:`, this.parseCodecInfo(rawSdp));
    }
    await peer.setRemoteDescription(new this.wrtc.RTCSessionDescription({
      type: offer.sdpType || 'offer',
      sdp: rawSdp,
    }));

    const answer = await peer.createAnswer();

    // Prefer high quality codecs
    answer.sdp = this.preferHighQualityCodecs(answer.sdp);

    if (this.config.diagCodecLog) {
      this.log.info(`[CODEC] Local answer codecs:`, this.parseCodecInfo(answer.sdp));
    }

    await peer.setLocalDescription(answer);

    // Send answer — sdp must be JSON.stringify({sdp, type}) to match client's
    // completeHandshake() which does JSON.parse(payload.sdp)
    this.relay.sendEnvelope(friend.did, {
      envelope: 'call_answer',
      version: 1,
      payload: {
        callId: offer.callId,
        sdp: JSON.stringify({ sdp: peer.localDescription!.sdp, type: 'answer' }),
        type: 'answer',
      },
    });

    this.sendCallState(friend.did, offer.callId, 'connected');

    // Flush any ICE candidates that arrived during ring delay
    const pending = this.pendingIceCandidates.get(offer.callId);
    if (pending && pending.candidates.length > 0) {
      this.log.info(`[CALL] Flushing ${pending.candidates.length} queued ICE candidates for ${offer.callId}`);
      for (const candidate of pending.candidates) {
        await this.addIceCandidateToCall(call, candidate);
      }
    }
    this.pendingIceCandidates.delete(offer.callId);

    // NOW start audio playback (after successful SDP exchange)
    const firstAudio = this.mediaManager.getAudioTrack();
    if (firstAudio) {
      call.audioSource.start(firstAudio.path, {
        loop: true,
        onTrackEnded: () => {
          const next = this.mediaManager.getNextAudioTrack();
          if (next && call.audioSource) call.audioSource.switchTrack(next.path);
        },
      });
    }

    // Start stats and metadata
    this.startStatsCollection(call);
    this.startMetadataBroadcast(call);

    this.log.info(`[CALL] Answered ${offer.callType} call: ${offer.callId}`);

    // Auto-start screen share after a short delay so users see the feature
    if (offer.callType === 'video') {
      setTimeout(() => {
        if (!call.cleanedUp && !call.isScreenSharing) {
          this.startScreenShare(call).catch(err => {
            this.log.error(`[CALL ${call.callId}] Auto screen-share failed:`, err);
          });
        }
      }, 2000);
    }
  }

  private createVideoTrack(call: ActiveCall, stream?: any): void {
    const { nonstandard } = this.wrtc;
    const { RTCVideoSource } = nonstandard;

    const videoSrc = new RTCVideoSource();
    const videoTrack = videoSrc.createTrack();
    call.videoSource = new VideoSource(videoSrc, this.ffmpegPath, this.log);

    if (stream) {
      stream.addTrack(videoTrack);
      call.videoSender = call.peer.addTrack(videoTrack, stream);
    } else {
      call.videoSender = call.peer.addTrack(videoTrack);
    }

    // Pick a random video to start with
    const firstVideo = this.mediaManager.getRandomVideoFile();
    if (firstVideo) {
      // Cap resolution and FPS to the per-call quality settings (default 720p@24fps).
      // @roamhq/wrtc uses CPU-only VP8/H264 encoding — 720p@24fps keeps raw
      // throughput at ~37MB/s which gives comfortable CPU headroom.
      const res = firstVideo.resolution ? parseResolution(firstVideo.resolution) : null;
      const nativeW = res?.width ?? call.videoWidth;
      const nativeH = res?.height ?? call.videoHeight;
      const { width, height } = fitToBox(nativeW, nativeH, call.videoWidth, call.videoHeight);
      const fps = call.videoFps;

      this.log.info(`[CALL] Starting video: ${firstVideo.name} (${width}x${height}@${fps}fps)`);

      call.videoSource.start(firstVideo.path, {
        width,
        height,
        fps,
        loop: true,
        onTrackEnded: () => {
          // In non-loop mode, switch to next video when current ends
          const next = this.mediaManager.getNextVideoFile();
          if (next && call.videoSource) {
            const nextRes = next.resolution ? parseResolution(next.resolution) : null;
            const nextNW = nextRes?.width ?? call.videoWidth;
            const nextNH = nextRes?.height ?? call.videoHeight;
            const fit = fitToBox(nextNW, nextNH, call.videoWidth, call.videoHeight);
            call.videoSource.switchVideo(next.path, {
              width: fit.width,
              height: fit.height,
              fps: call.videoFps,
            });
          }
        },
      });
    }
  }

  // ── Call upgrade/downgrade ────────────────────────────────────────────────

  private async addVideoToCall(call: ActiveCall): Promise<string> {
    if (call.videoSource) return 'Video is already active.';
    if (!this.wrtc) return 'WebRTC not available.';

    this.createVideoTrack(call);
    call.callType = 'video';

    // Renegotiate
    const offer = await call.peer.createOffer();
    await call.peer.setLocalDescription(offer);

    const friend = this.store.getFriend(call.peerDid);
    if (friend) {
      this.relay.sendEnvelope(friend.did, {
        envelope: 'call_reoffer',
        version: 1,
        payload: {
          callId: call.callId,
          sdp: JSON.stringify({ sdp: offer.sdp, type: offer.type }),
          sdpType: 'offer',
          callType: 'video',
          senderDid: this.identity.did,
          conversationId: call.conversationId,
        },
      });
    }

    return '📹 Video added to call. Streaming video content.';
  }

  private removeVideoFromCall(call: ActiveCall): string {
    if (!call.videoSource) return 'Video is not active.';

    call.videoSource.stop();
    call.videoSource = null;

    if (call.videoSender) {
      try {
        call.peer.removeTrack(call.videoSender);
      } catch {
        // May fail if already removed
      }
      call.videoSender = null;
    }

    call.callType = 'voice';
    return '🔊 Video removed. Audio-only call.';
  }

  // ── Screen share ───────────────────────────────────────────────────────

  private async startScreenShare(call: ActiveCall): Promise<void> {
    if (call.isScreenSharing || !call.peer) return;

    // Pick a video file for screen share — prefer a different one from the main track
    const screenVideo = this.mediaManager.getRandomVideoFile();
    if (!screenVideo) {
      this.log.warn(`[CALL ${call.callId}] No video files available for screen share`);
      return;
    }

    // Create a second RTCVideoSource for screen share
    const { nonstandard } = this.wrtc;
    const screenSource = new nonstandard.RTCVideoSource();
    const screenTrack = screenSource.createTrack();

    // Add the screen track to the peer connection
    call.screenVideoSender = call.peer.addTrack(screenTrack);

    // Create VideoSource and start with a real video file
    call.screenVideoSource = new VideoSource(screenSource, this.ffmpegPath, this.log);

    const res = screenVideo.resolution ? parseResolution(screenVideo.resolution) : null;
    const nativeW = res?.width ?? call.videoWidth;
    const nativeH = res?.height ?? call.videoHeight;
    const { width, height } = fitToBox(nativeW, nativeH, call.videoWidth, call.videoHeight);
    const fps = call.videoFps;

    this.log.info(`[CALL ${call.callId}] Screen share: ${screenVideo.name} (${width}x${height}@${fps}fps)`);

    call.screenVideoSource.start(screenVideo.path, {
      width,
      height,
      fps,
      loop: true,
      onTrackEnded: () => {
        // Switch to next video when current ends (non-loop mode)
        const next = this.mediaManager.getNextVideoFile();
        if (next && call.screenVideoSource) {
          const nextRes = next.resolution ? parseResolution(next.resolution) : null;
          const nextNW = nextRes?.width ?? call.videoWidth;
          const nextNH = nextRes?.height ?? call.videoHeight;
          const fit = fitToBox(nextNW, nextNH, call.videoWidth, call.videoHeight);
          call.screenVideoSource.switchVideo(next.path, {
            width: fit.width,
            height: fit.height,
            fps: call.videoFps,
          });
        }
      },
    });

    call.isScreenSharing = true;

    // Notify client via data channel
    if (call.dataChannel?.readyState === 'open') {
      try {
        call.dataChannel.send(JSON.stringify({
          type: 'screen-share-state',
          isScreenSharing: true,
          source: screenVideo.name,
        }));
      } catch { /* ignore */ }
    }

    this.log.info(`[CALL ${call.callId}] Screen share started: ${screenVideo.name}`);
  }

  private stopScreenShare(call: ActiveCall): void {
    if (!call.isScreenSharing) return;

    if (call.screenVideoSource) {
      call.screenVideoSource.stop();
      call.screenVideoSource = null;
    }

    if (call.screenVideoSender && call.peer) {
      const track = call.screenVideoSender.track;
      if (track) track.stop();
      try {
        call.peer.removeTrack(call.screenVideoSender);
      } catch { /* may fail if already removed */ }
      call.screenVideoSender = null;
    }

    call.isScreenSharing = false;

    // Notify client via data channel
    if (call.dataChannel?.readyState === 'open') {
      try {
        call.dataChannel.send(JSON.stringify({
          type: 'screen-share-state',
          isScreenSharing: false,
        }));
      } catch { /* ignore */ }
    }

    this.log.info(`[CALL ${call.callId}] Screen share stopped`);
  }

  // ── SDP diagnostics ─────────────────────────────────────────────────────

  private parseCodecInfo(sdp: string): { audio: string[]; video: string[] } {
    const audio: string[] = [];
    const video: string[] = [];
    for (const line of sdp.split('\r\n')) {
      if (line.startsWith('a=rtpmap:')) {
        const match = line.match(/a=rtpmap:\d+ (.+)/);
        if (match) {
          const codec = match[1];
          if (codec.includes('/90000')) video.push(codec);
          else audio.push(codec);
        }
      }
    }
    return { audio, video };
  }

  // ── SDP manipulation ──────────────────────────────────────────────────────

  private preferHighQualityCodecs(sdp: string): string {
    // Boost Opus maxaveragebitrate for highest quality audio
    if (sdp.includes('opus/48000')) {
      sdp = sdp.replace(
        /(a=fmtp:\d+ .*?)([\r\n])/g,
        (match, fmtp, nl) => {
          if (fmtp.includes('opus') || !fmtp.includes('maxaveragebitrate')) {
            return `${fmtp};maxaveragebitrate=128000;stereo=1;sprop-stereo=1${nl}`;
          }
          return match;
        },
      );
    }

    // Prefer H264 over VP8 — better hardware acceleration on most devices.
    // Move H264 payload types to the front of the m=video line.
    const lines = sdp.split('\r\n');
    const h264PayloadTypes: string[] = [];
    for (const line of lines) {
      const match = line.match(/^a=rtpmap:(\d+)\s+H264\//i);
      if (match) h264PayloadTypes.push(match[1]);
    }

    if (h264PayloadTypes.length > 0) {
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].startsWith('m=video ')) {
          const parts = lines[i].split(' ');
          // parts: m=video <port> <proto> <payload types...>
          if (parts.length > 3) {
            const header = parts.slice(0, 3);
            const payloads = parts.slice(3);
            // Move H264 payloads to front, keep others in order
            const reordered = [
              ...h264PayloadTypes.filter(pt => payloads.includes(pt)),
              ...payloads.filter(pt => !h264PayloadTypes.includes(pt)),
            ];
            lines[i] = [...header, ...reordered].join(' ');
          }
          break;
        }
      }
      sdp = lines.join('\r\n');
    }

    return sdp;
  }

  // ── Stats collection ──────────────────────────────────────────────────────

  private startStatsCollection(call: ActiveCall): void {
    call.statsInterval = setInterval(async () => {
      try {
        const stats = await call.peer.getStats();
        let totalBytesSent = 0;
        let totalBytesReceived = 0;

        stats.forEach((report: any) => {
          if (report.type === 'outbound-rtp') {
            totalBytesSent += report.bytesSent || 0;
            if (report.kind === 'audio') {
              call.stats.jitter = report.jitter || 0;
            }
          }
          if (report.type === 'inbound-rtp') {
            totalBytesReceived += report.bytesReceived || 0;
            call.stats.packetLoss = report.packetsLost || 0;
          }
          if (report.type === 'candidate-pair' && report.state === 'succeeded') {
            call.stats.roundTripTime = report.currentRoundTripTime || 0;
          }
        });

        const now = Date.now();
        const elapsed = (now - call.stats.lastStatsAt) / 1000;
        if (elapsed > 0) {
          const bitrate = ((totalBytesSent - call.stats.prevBytesSent) * 8) / elapsed;
          call.stats.audioBitrate = Math.round(bitrate);
        }
        call.stats.prevBytesSent = totalBytesSent;
        call.stats.bytesSent = totalBytesSent;
        call.stats.bytesReceived = totalBytesReceived;
        call.stats.lastStatsAt = now;
        call.lastActivityAt = now; // Touch for watchdog
      } catch {
        // Stats may fail during teardown
      }
    }, this.config.callStatsIntervalMs);
  }

  // ── Metadata broadcasting ─────────────────────────────────────────────────

  private startMetadataBroadcast(call: ActiveCall): void {
    call.metadataInterval = setInterval(() => {
      if (!call.dataChannel || call.dataChannel.readyState !== 'open') return;

      try {
        const metadata = {
          type: 'ghost-metadata',
          callId: call.callId,
          callType: call.callType,
          uptime: Math.round((Date.now() - call.startedAt) / 1000),
          audio: call.audioSource ? {
            playing: call.audioSource.isPlaying,
            file: call.audioSource.currentFile,
            bufferMs: call.audioSource.bufferMs,
            underruns: call.audioSource.underrunCount,
            framesDelivered: call.audioSource.framesDelivered,
          } : null,
          video: call.videoSource ? {
            playing: call.videoSource.isPlaying,
            file: call.videoSource.currentFile,
            width: call.videoSource.resolution.width,
            height: call.videoSource.resolution.height,
            fps: call.videoSource.targetFps,
            bufferedFrames: call.videoSource.bufferedFrames,
            bufferHealth: Math.round(call.videoSource.bufferHealth * 100) / 100,
            droppedFrames: call.videoSource.droppedFrames,
            framesDelivered: call.videoSource.framesDelivered,
          } : null,
          screenShare: call.isScreenSharing ? {
            playing: call.screenVideoSource?.isPlaying ?? false,
            source: call.screenVideoSource?.currentFile ?? 'test-pattern',
            bufferedFrames: call.screenVideoSource?.bufferedFrames ?? 0,
            framesDelivered: call.screenVideoSource?.framesDelivered ?? 0,
          } : null,
          stats: {
            bitrate: call.stats.audioBitrate,
            packetLoss: call.stats.packetLoss,
            rtt: call.stats.roundTripTime,
          },
          diagnostics: this.config.diagFrameTiming ? {
            video: call.videoSource ? {
              timingAlerts: call.videoSource.timingAlerts,
              avgIntervalMs: Math.round(call.videoSource.avgIntervalMs * 100) / 100,
            } : null,
            audio: call.audioSource ? {
              timingAlerts: call.audioSource.timingAlerts,
              avgIntervalMs: Math.round(call.audioSource.avgIntervalMs * 100) / 100,
              ringBuffer: this.config.diagRingBufferLog
                ? call.audioSource.ringBufferState
                : undefined,
              underrunCount: call.audioSource.underrunCount,
            } : null,
            degradation: call.degradation ? {
              eventCount: call.degradation.degradationCount,
            } : undefined,
            capture: call.capture?.isCapturing ? call.capture.stats : undefined,
            refSignal: call.audioTestSignal ? {
              framesDelivered: call.audioTestSignal.framesDelivered,
            } : undefined,
          } : undefined,
          // Server timestamp for latency calculation
          serverTime: Date.now(),
        };
        call.dataChannel.send(JSON.stringify(metadata));
      } catch {
        // Ignore send errors
      }
    }, this.config.metadataBroadcastMs);
  }

  // ── Chat commands ─────────────────────────────────────────────────────────

  async handleCommand(command: string, args: string[], senderDid: string): Promise<string> {
    const cmd = command.toLowerCase();

    switch (cmd) {
      case 'status':
        return this.cmdStatus();

      case 'tracks':
        return this.cmdListTracks();

      case 'play': {
        const id = args[0];
        if (!id) return 'Usage: /ghost play <track-id>';
        return this.cmdPlayTrack(id, senderDid);
      }

      case 'next':
        return this.cmdNextTrack(senderDid);

      case 'pause':
        return this.cmdPause(senderDid);

      case 'resume':
        return this.cmdResume(senderDid);

      case 'videos':
        return this.cmdListVideos();

      case 'play-video': {
        const id = args[0];
        if (!id) return 'Usage: /ghost play-video <video-id>';
        return this.cmdPlayVideo(id, senderDid);
      }

      case 'next-video':
        return this.cmdNextVideo(senderDid);

      case 'upgrade':
        return this.cmdUpgrade(senderDid);

      case 'downgrade':
        return this.cmdDowngrade(senderDid);

      case 'end':
        return this.cmdEndCall(senderDid);

      case 'files':
        return this.cmdListFiles(args[0]);

      case 'send': {
        const query = args.join(' ');
        if (!query) return 'Usage: /ghost send <file-id or name>';
        return this.cmdSendFile(query, senderDid);
      }

      case 'quality': {
        const preset = args[0];
        if (!preset) return 'Usage: /ghost quality <preset>\nPresets: 4k, 2160p, 1440p, 1080p, 720p, 480p, auto';
        return this.cmdQuality(preset.toLowerCase(), senderDid);
      }

      case 'resolution': {
        const res = args[0];
        if (!res) return 'Usage: /ghost resolution <WxH> (e.g., /ghost resolution 1920x1080)';
        return this.cmdResolution(res, senderDid);
      }

      case 'fps': {
        const fpsStr = args[0];
        if (!fpsStr) return 'Usage: /ghost fps <number> (e.g., /ghost fps 30)';
        return this.cmdFps(fpsStr, senderDid);
      }

      case 'screen-share':
      case 'screenshare':
      case 'share-screen':
        return this.cmdScreenShare(senderDid);

      case 'help':
        return this.cmdHelp();

      default:
        return `Unknown command: ${cmd}. Use /ghost help for available commands.`;
    }
  }

  private cmdStatus(): string {
    if (this.activeCalls.size === 0) return '📞 No active calls.';

    const lines: string[] = ['📞 Active calls:'];
    for (const [id, call] of this.activeCalls) {
      const duration = Math.round((Date.now() - call.startedAt) / 1000);
      const friend = this.store.getFriend(call.peerDid);
      lines.push(`  ${call.callType.toUpperCase()} with ${friend?.displayName ?? call.peerDid.slice(0, 16)} — ${duration}s`);
      lines.push(`    Audio: ${call.audioSource?.currentFile ?? 'none'} (${call.audioSource?.isPlaying ? 'playing' : 'paused'})`);
      if (call.videoSource) {
        lines.push(`    Video: ${call.videoSource.currentFile ?? 'none'} (${call.videoSource.isPlaying ? 'playing' : 'paused'})`);
        lines.push(`    Quality: ${call.videoWidth}x${call.videoHeight}@${call.videoFps}fps`);
      }
      if (call.isScreenSharing) {
        lines.push(`    Screen Share: active (test pattern)`);
      }
      lines.push(`    Bitrate: ${call.stats.audioBitrate}bps | RTT: ${(call.stats.roundTripTime * 1000).toFixed(0)}ms`);
    }
    return lines.join('\n');
  }

  private cmdListTracks(): string {
    const tracks = this.mediaManager.getAudioTracks();
    if (tracks.length === 0) return '🎵 No audio tracks available.';
    const lines = ['🎵 Available audio tracks:'];
    for (const t of tracks) {
      lines.push(`  ${t.id} — ${t.name} (${t.format})`);
    }
    lines.push('\nUse: /ghost play <track-id>');
    return lines.join('\n');
  }

  private cmdPlayTrack(id: string, senderDid: string): string {
    const track = this.mediaManager.getAudioTrack(id);
    if (!track) return `Track not found: ${id}. Use /ghost tracks to list available.`;

    const call = this.findCallForPeer(senderDid);
    if (!call?.audioSource) return 'No active call with audio.';

    call.audioSource.switchTrack(track.path);
    return `🎵 Now playing: ${track.name}`;
  }

  private cmdNextTrack(senderDid: string): string {
    const next = this.mediaManager.getNextAudioTrack();
    if (!next) return 'No more audio tracks.';

    const call = this.findCallForPeer(senderDid);
    if (!call?.audioSource) return 'No active call with audio.';

    call.audioSource.switchTrack(next.path);
    return `🎵 Now playing: ${next.name}`;
  }

  private cmdPause(senderDid: string): string {
    const call = this.findCallForPeer(senderDid);
    if (!call) return 'No active call.';
    call.audioSource?.pause();
    call.videoSource?.pause();
    return '⏸️ Paused.';
  }

  private cmdResume(senderDid: string): string {
    const call = this.findCallForPeer(senderDid);
    if (!call) return 'No active call.';
    call.audioSource?.resume();
    call.videoSource?.resume();
    return '▶️ Resumed.';
  }

  private cmdListVideos(): string {
    const videos = this.mediaManager.getVideoFiles();
    if (videos.length === 0) return '📹 No video files available.';
    const lines = ['📹 Available videos:'];
    for (const v of videos) {
      lines.push(`  ${v.id} — ${v.name} (${v.resolution ?? '?'})`);
    }
    lines.push('\nUse: /ghost play-video <video-id>');
    return lines.join('\n');
  }

  private cmdPlayVideo(id: string, senderDid: string): string {
    const video = this.mediaManager.getVideoFile(id);
    if (!video) return `Video not found: ${id}. Use /ghost videos to list available.`;

    const call = this.findCallForPeer(senderDid);
    if (!call?.videoSource) return 'No active video call.';

    const res = video.resolution ? parseResolution(video.resolution) : null;
    const nativeW = res?.width ?? call.videoWidth;
    const nativeH = res?.height ?? call.videoHeight;
    const { width, height } = fitToBox(nativeW, nativeH, call.videoWidth, call.videoHeight);
    call.videoSource.switchVideo(video.path, { width, height, fps: call.videoFps });
    return `📹 Now playing: ${video.name} (${width}x${height})`;
  }

  private cmdNextVideo(senderDid: string): string {
    const next = this.mediaManager.getNextVideoFile();
    if (!next) return 'No more video files.';

    const call = this.findCallForPeer(senderDid);
    if (!call?.videoSource) return 'No active video call.';

    const res = next.resolution ? parseResolution(next.resolution) : null;
    const nativeW = res?.width ?? call.videoWidth;
    const nativeH = res?.height ?? call.videoHeight;
    const { width, height } = fitToBox(nativeW, nativeH, call.videoWidth, call.videoHeight);
    call.videoSource.switchVideo(next.path, { width, height, fps: call.videoFps });
    return `📹 Now playing: ${next.name} (${width}x${height})`;
  }

  private async cmdUpgrade(senderDid: string): Promise<string> {
    const call = this.findCallForPeer(senderDid);
    if (!call) return 'No active call.';
    return this.addVideoToCall(call);
  }

  private cmdDowngrade(senderDid: string): string {
    const call = this.findCallForPeer(senderDid);
    if (!call) return 'No active call.';
    return this.removeVideoFromCall(call);
  }

  private async cmdScreenShare(senderDid: string): Promise<string> {
    const call = this.findCallForPeer(senderDid);
    if (!call) return 'No active call.';

    if (call.isScreenSharing) {
      this.stopScreenShare(call);
      return 'Screen share stopped.';
    } else {
      await this.startScreenShare(call);
      return 'Screen share started (test pattern).';
    }
  }

  private cmdEndCall(senderDid: string): string {
    const call = this.findCallForPeer(senderDid);
    if (!call) return 'No active call.';

    this.sendCallEnd(call.peerDid, call.callId, 'ended');
    this.cleanupCall(call);
    return '📞 Call ended.';
  }

  private cmdListFiles(category?: string): string {
    const files = this.mediaManager.listFiles(category);
    if (files.length === 0) return '📁 No files available.';
    const lines = ['📁 Available files:'];
    for (const f of files) {
      lines.push(`  ${f.id} — ${f.name} (${f.format}, ${f.category ?? 'general'})`);
    }
    lines.push('\nUse: /ghost send <file-id>');
    return lines.join('\n');
  }

  private cmdSendFile(query: string, senderDid: string): string {
    const file = this.mediaManager.getFile(query);
    if (!file) return `File not found: ${query}. Use /ghost files to list available.`;

    const friend = this.store.getFriend(senderDid);
    if (!friend) return 'Unknown sender.';

    // Read file and send via relay as base64
    try {
      const data = readFileSync(file.path);
      const base64 = data.toString('base64');

      // Send file via relay envelope
      const messageId = uuid();
      const timestamp = Date.now();

      const filePayload = JSON.stringify({
        type: 'file',
        filename: `${file.id}.${file.format}`,
        mimeType: getMimeType(file.format),
        size: data.length,
        data: base64,
      });

      const { ciphertext, nonce } = encryptMessage(
        filePayload,
        this.identity.encryptionPrivateKey,
        friend.encryptionKey,
        this.identity.did,
        friend.did,
        timestamp,
        friend.conversationId,
      );

      this.relay.sendEnvelope(friend.did, {
        envelope: 'chat_message',
        version: 1,
        payload: {
          messageId,
          conversationId: friend.conversationId,
          senderDid: this.identity.did,
          contentEncrypted: ciphertext,
          nonce,
          timestamp,
          attachments: [{
            filename: `${file.id}.${file.format}`,
            mimeType: getMimeType(file.format),
            size: data.length,
          }],
        },
      });

      this.store.saveMessage({
        id: messageId,
        conversationId: friend.conversationId,
        role: 'assistant',
        content: `[File: ${file.name}]`,
        timestamp,
      });

      return `📎 Sent: ${file.name} (${(data.length / 1024).toFixed(1)}KB)`;
    } catch (err) {
      this.log.error(`[CALL] Failed to send file ${file.id}:`, err);
      return `Failed to send file: ${file.name}`;
    }
  }

  // ── Quality commands ──────────────────────────────────────────────────────

  private cmdQuality(preset: string, senderDid: string): string {
    const call = this.findCallForPeer(senderDid);
    if (!call) return 'No active call.';

    let width: number;
    let height: number;
    let fps: number;
    let label: string;
    let warning = '';

    switch (preset) {
      case '4k':
      case '2160p':
        width = 3840; height = 2160; fps = 24; label = '4K (3840x2160@24fps)';
        warning = '\n⚠️ Warning: 4K requires significant CPU for software encoding. May cause frame drops on weaker hardware.';
        break;
      case '1440p':
        width = 2560; height = 1440; fps = 24; label = '1440p (2560x1440@24fps)';
        warning = '\n⚠️ Warning: 1440p is CPU-intensive for software encoding.';
        break;
      case '1080p':
        width = 1920; height = 1080; fps = 30; label = '1080p (1920x1080@30fps)';
        break;
      case '720p':
        width = 1280; height = 720; fps = 30; label = '720p (1280x720@30fps)';
        break;
      case '480p':
        width = 854; height = 480; fps = 30; label = '480p (854x480@30fps)';
        break;
      case 'auto':
        width = this.config.maxVideoWidth;
        height = this.config.maxVideoHeight;
        fps = this.config.maxVideoFps;
        label = `auto (${width}x${height}@${fps}fps)`;
        break;
      default:
        return `Unknown preset: ${preset}. Available: 4k, 2160p, 1440p, 1080p, 720p, 480p, auto`;
    }

    return this.applyQuality(call, width, height, fps, label, warning);
  }

  private cmdResolution(resStr: string, senderDid: string): string {
    const call = this.findCallForPeer(senderDid);
    if (!call) return 'No active call.';

    const parsed = parseResolution(resStr);
    if (!parsed) return `Invalid resolution format: ${resStr}. Use WxH (e.g., 1920x1080)`;
    if (parsed.width < 160 || parsed.height < 120) return 'Resolution too small. Minimum: 160x120';
    if (parsed.width > 7680 || parsed.height > 4320) return 'Resolution too large. Maximum: 7680x4320';

    let warning = '';
    if (parsed.width > 1920 || parsed.height > 1080) {
      warning = '\n⚠️ Warning: Resolutions above 1080p are CPU-intensive for software encoding.';
    }

    const label = `${parsed.width}x${parsed.height}@${call.videoFps}fps`;
    return this.applyQuality(call, parsed.width, parsed.height, call.videoFps, label, warning);
  }

  private cmdFps(fpsStr: string, senderDid: string): string {
    const call = this.findCallForPeer(senderDid);
    if (!call) return 'No active call.';

    const fps = parseInt(fpsStr, 10);
    if (isNaN(fps) || fps < 1 || fps > 120) return 'Invalid FPS. Must be between 1 and 120.';

    const label = `${call.videoWidth}x${call.videoHeight}@${fps}fps`;
    return this.applyQuality(call, call.videoWidth, call.videoHeight, fps, label, '');
  }

  private applyQuality(call: ActiveCall, width: number, height: number, fps: number, label: string, warning: string): string {
    call.videoWidth = width;
    call.videoHeight = height;
    call.videoFps = fps;

    // If video is currently playing, restart at the new resolution
    if (call.videoSource?.currentFile) {
      const currentFile = call.videoSource.currentFile;
      call.videoSource.switchVideo(currentFile, { width, height, fps });
      this.log.info(`[CALL] Quality changed to ${label} — restarted video: ${currentFile}`);
      return `📺 Quality set to ${label}. Video restarted at new resolution.${warning}`;
    }

    this.log.info(`[CALL] Quality changed to ${label} (no active video to restart)`);
    return `📺 Quality set to ${label}. Will apply to next video.${warning}`;
  }

  private cmdHelp(): string {
    return [
      '🤖 Ghost Call Commands:',
      '',
      '📞 Call Control:',
      '  /ghost status — Show active calls',
      '  /ghost end — End current call',
      '  /ghost upgrade — Add video to voice call',
      '  /ghost downgrade — Remove video from call',
      '',
      '🎵 Audio:',
      '  /ghost tracks — List audio tracks',
      '  /ghost play <id> — Play specific track',
      '  /ghost next — Next audio track',
      '  /ghost pause — Pause playback',
      '  /ghost resume — Resume playback',
      '',
      '📹 Video:',
      '  /ghost videos — List video files',
      '  /ghost play-video <id> — Play specific video',
      '  /ghost next-video — Next video',
      '',
      '🖥️ Screen Share:',
      '  /ghost screen-share — Toggle screen share (test pattern)',
      '',
      '📺 Quality:',
      '  /ghost quality <preset> — Change video quality',
      '    Presets: 4k, 2160p, 1440p, 1080p, 720p, 480p, auto',
      '  /ghost resolution <WxH> — Set custom resolution',
      '  /ghost fps <number> — Change FPS independently',
      '',
      '📁 Files:',
      '  /ghost files [category] — List files',
      '  /ghost send <id|name> — Send a file',
    ].join('\n');
  }

  // ── Utilities ─────────────────────────────────────────────────────────────

  private findCallForPeer(peerDid: string): ActiveCall | undefined {
    for (const call of this.activeCalls.values()) {
      if (call.peerDid === peerDid) return call;
    }
    return undefined;
  }

  private sendCallState(toDid: string, callId: string, state: string): void {
    this.relay.sendEnvelope(toDid, {
      envelope: 'call_state',
      version: 1,
      payload: { callId, state },
    });
  }

  private sendCallEnd(toDid: string, callId: string, reason: string): void {
    this.relay.sendEnvelope(toDid, {
      envelope: 'call_end',
      version: 1,
      payload: { callId, reason },
    });
  }

  private sendChatNotification(friend: StoredFriend, text: string): void {
    const messageId = uuid();
    const timestamp = Date.now();

    const { ciphertext, nonce } = encryptMessage(
      text,
      this.identity.encryptionPrivateKey,
      friend.encryptionKey,
      this.identity.did,
      friend.did,
      timestamp,
      friend.conversationId,
    );

    this.relay.sendEnvelope(friend.did, {
      envelope: 'chat_message',
      version: 1,
      payload: {
        messageId,
        conversationId: friend.conversationId,
        senderDid: this.identity.did,
        contentEncrypted: ciphertext,
        nonce,
        timestamp,
      },
    });

    this.store.saveMessage({
      id: messageId,
      conversationId: friend.conversationId,
      role: 'assistant',
      content: text,
      timestamp,
    });
  }

  private cleanupCall(call: ActiveCall): void {
    // Guard against double-cleanup (e.g., disconnect timer fires after explicit end)
    if (call.cleanedUp) {
      this.log.debug(`[CALL] Skipping duplicate cleanup for ${call.callId}`);
      return;
    }
    call.cleanedUp = true;

    // Clear disconnect timer if pending
    if (call.disconnectTimer) {
      clearTimeout(call.disconnectTimer);
      call.disconnectTimer = null;
    }

    call.audioSource?.stop();
    call.videoSource?.stop();
    call.audioTestSignal?.stop();
    call.videoTestSignal?.stop();

    // Clean up screen share
    if (call.screenVideoSource) {
      call.screenVideoSource.stop();
      call.screenVideoSource = null;
    }
    if (call.screenVideoSender) {
      const track = call.screenVideoSender.track;
      if (track) track.stop();
      call.screenVideoSender = null;
    }

    if (call.statsInterval) { clearInterval(call.statsInterval); call.statsInterval = null; }
    if (call.metadataInterval) { clearInterval(call.metadataInterval); call.metadataInterval = null; }

    // Close data channel
    if (call.dataChannel) {
      try { call.dataChannel.close(); } catch { /* ignore */ }
      call.dataChannel = null;
    }

    // Finalize diagnostic tools
    if (call.capture?.isCapturing) {
      const result = call.capture.finalize();
      this.log.info(`[CALL] Media capture finalized: audio=${result.audioPath}, video=${result.videoPath}, duration=${result.durationMs}ms`);
    }
    if (call.degradation) {
      const diag = call.degradation.diagnostics;
      if (diag.events.length > 0) {
        this.log.info(`[CALL] Degradation summary: ${diag.events.length} events in ${diag.elapsedMs}ms`);
      }
      call.degradation.stop();
    }

    try { call.peer.close(); } catch { /* ignore */ }

    this.activeCalls.delete(call.callId);
    this.pendingIceCandidates.delete(call.callId);
    const duration = Math.round((Date.now() - call.startedAt) / 1000);
    this.log.info(`[CALL] Cleaned up call: ${call.callId} (duration: ${duration}s, remaining: ${this.activeCalls.size})`);
  }

  // ── Watchdog ──────────────────────────────────────────────────────────────

  private startWatchdog(): void {
    this.watchdogInterval = setInterval(() => {
      const now = Date.now();

      // Check for stale calls
      for (const call of this.activeCalls.values()) {
        const idleMs = now - call.lastActivityAt;
        const peerState = call.peer?.connectionState;

        // Force-cleanup calls where the peer is in a terminal state
        if (peerState === 'closed' || peerState === 'failed') {
          this.log.warn(`[WATCHDOG] Call ${call.callId} peer is ${peerState} — forcing cleanup`);
          this.cleanupCall(call);
          continue;
        }

        // Force-cleanup calls with no activity for STALE_CALL_TIMEOUT_MS
        if (idleMs > STALE_CALL_TIMEOUT_MS) {
          this.log.warn(`[WATCHDOG] Call ${call.callId} stale (idle ${Math.round(idleMs / 1000)}s) — forcing cleanup`);
          this.sendCallEnd(call.peerDid, call.callId, 'timeout');
          this.cleanupCall(call);
        }
      }

      // Clean orphaned pending ICE candidates
      for (const [callId, pending] of this.pendingIceCandidates) {
        if (now - pending.createdAt > PENDING_ICE_TIMEOUT_MS) {
          this.log.debug(`[WATCHDOG] Dropping ${pending.candidates.length} orphaned ICE candidates for ${callId}`);
          this.pendingIceCandidates.delete(callId);
        }
      }

      if (this.activeCalls.size > 0) {
        this.log.debug(`[WATCHDOG] Active calls: ${this.activeCalls.size}, pending ICE queues: ${this.pendingIceCandidates.size}`);
      }
    }, WATCHDOG_INTERVAL_MS);
  }

  private stopWatchdog(): void {
    if (this.watchdogInterval) {
      clearInterval(this.watchdogInterval);
      this.watchdogInterval = null;
    }
  }

  // ── Public API ────────────────────────────────────────────────────────────

  endAllCalls(): void {
    for (const call of this.activeCalls.values()) {
      this.sendCallEnd(call.peerDid, call.callId, 'shutdown');
      this.cleanupCall(call);
    }
    this.pendingIceCandidates.clear();
    this.stopWatchdog();
  }

  getActiveCalls(): ActiveCallInfo[] {
    const result: ActiveCallInfo[] = [];
    for (const call of this.activeCalls.values()) {
      result.push({
        callId: call.callId,
        peerDid: call.peerDid,
        callType: call.callType,
        duration: Math.round((Date.now() - call.startedAt) / 1000),
        audioTrack: call.audioSource?.currentFile ?? null,
        videoTrack: call.videoSource?.currentFile ?? null,
        stats: { ...call.stats },
      });
    }
    return result;
  }

  getCallCount(): number {
    return this.activeCalls.size;
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Scale a native resolution to fit within a max bounding box while preserving
 * aspect ratio. Dimensions are rounded to nearest even number (required by
 * most video encoders including H264/VP8).
 */
function fitToBox(
  nativeW: number, nativeH: number,
  maxW: number, maxH: number,
): { width: number; height: number } {
  if (nativeW <= maxW && nativeH <= maxH) {
    return { width: roundEven(nativeW), height: roundEven(nativeH) };
  }
  const scale = Math.min(maxW / nativeW, maxH / nativeH);
  return {
    width: roundEven(Math.round(nativeW * scale)),
    height: roundEven(Math.round(nativeH * scale)),
  };
}

function roundEven(n: number): number {
  return n % 2 === 0 ? n : n + 1;
}

function getMimeType(format: string): string {
  const types: Record<string, string> = {
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    gif: 'image/gif',
    webp: 'image/webp',
    mp3: 'audio/mpeg',
    flac: 'audio/flac',
    wav: 'audio/wav',
    mp4: 'video/mp4',
    mkv: 'video/x-matroska',
    txt: 'text/plain',
    json: 'application/json',
    pdf: 'application/pdf',
    zip: 'application/zip',
  };
  return types[format] ?? 'application/octet-stream';
}
