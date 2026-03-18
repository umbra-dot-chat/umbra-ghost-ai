/**
 * Ghost configuration — loaded from CLI args + environment variables.
 */

import { join } from 'path';


export interface IceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}

export const DEFAULT_ICE_SERVERS: IceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  {
    urls: [
      'turn:turn.umbra.chat:3478?transport=udp',
      'turn:turn.umbra.chat:3478?transport=tcp',
    ],
  },
];

export interface GhostConfig {
  /** Relay WebSocket URL */
  relayUrl: string;
  /** Ollama API base URL */
  ollamaUrl: string;
  /** LLM model name for chat */
  model: string;
  /** Embedding model name for RAG */
  embedModel: string;
  /** Bot language */
  language: 'en' | 'ko';
  /** Data directory for identity + DB */
  dataDir: string;
  /** Path to Umbra codebase for RAG */
  codebasePath: string;
  /** HTTP port for health/webhook endpoints */
  httpPort: number;
  /** Log level */
  logLevel: 'debug' | 'info' | 'warn' | 'error';

  // ── Call handling ────────────────────────────────────────────────────
  /** Enable call handling */
  callEnabled: boolean;
  /** Fake ring delay before answering (ms) */
  callRingDelayMs: number;
  /** Path to media config JSON */
  mediaConfigPath: string;
  /** Directory for cached media files */
  mediaCacheDir: string;
  /** ICE servers for WebRTC */
  iceServers: IceServer[];
  /** Interval for WebRTC stats collection (ms) */
  callStatsIntervalMs: number;
  /** Interval for data channel metadata broadcast (ms) */
  metadataBroadcastMs: number;
  /** Max video width for WebRTC encoding (capped to stay within CPU budget) */
  maxVideoWidth: number;
  /** Max video height for WebRTC encoding */
  maxVideoHeight: number;
  /** Max video FPS for WebRTC encoding */
  maxVideoFps: number;

  // ── Wisp swarm ──────────────────────────────────────────────────────
  /** Enable co-located wisp swarm */
  wispsEnabled: boolean;
  /** Number of wisps to spawn */
  wispCount: number;
  /** Ollama model for wisp LLM */
  wispModel: string;
  /** Data directory for wisp identities */
  wispDataDir: string;
  /** HTTP port for wisp control API */
  wispHttpPort: number;

  // ── Diagnostics ──────────────────────────────────────────────────────
  /** Enable frame timing alerts (lightweight) */
  diagFrameTiming: boolean;
  /** Enable audio ring buffer state logging (lightweight) */
  diagRingBufferLog: boolean;
  /** Enable raw PCM/I420 capture to disk (heavy I/O) */
  diagRawCapture: boolean;
  /** Enable codec negotiation logging (lightweight) */
  diagCodecLog: boolean;
  /** Enable degradation detection + auto-capture (lightweight) */
  diagDegradation: boolean;
  /** Enable 440Hz reference signal mode (test mode) */
  diagRefSignal: boolean;
}

const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3 } as const;

export function loadConfig(opts: Record<string, string | undefined>): GhostConfig {
  const dataDir = opts.dataDir || process.env.DATA_DIR || './data';
  return {
    relayUrl: opts.relay || process.env.RELAY_URL || 'wss://relay.umbra.chat/ws',
    ollamaUrl: opts.ollama || process.env.OLLAMA_URL || 'http://localhost:11434',
    model: opts.model || process.env.MODEL || 'llama3.1',
    embedModel: opts.embedModel || process.env.EMBED_MODEL || 'nomic-embed-text',
    language: (opts.language || process.env.LANGUAGE || 'en') as 'en' | 'ko',
    dataDir,
    codebasePath: opts.codebasePath || process.env.CODEBASE_PATH || '../Umbra',
    httpPort: parseInt(opts.httpPort || process.env.HTTP_PORT || '3333', 10),
    logLevel: (opts.logLevel || process.env.LOG_LEVEL || 'info') as GhostConfig['logLevel'],

    // Call defaults
    callEnabled: (opts.callEnabled || process.env.CALL_ENABLED || 'true') === 'true',
    callRingDelayMs: parseInt(opts.callRingDelay || process.env.CALL_RING_DELAY || '2500', 10),
    mediaConfigPath: opts.mediaConfig || process.env.MEDIA_CONFIG || './media.config.json',
    mediaCacheDir: opts.mediaCacheDir || process.env.MEDIA_CACHE_DIR || join(dataDir, 'media'),
    iceServers: DEFAULT_ICE_SERVERS,
    callStatsIntervalMs: 1000,
    metadataBroadcastMs: 1000,
    maxVideoWidth: parseInt(process.env.MAX_VIDEO_WIDTH || '1280', 10),
    maxVideoHeight: parseInt(process.env.MAX_VIDEO_HEIGHT || '720', 10),
    maxVideoFps: parseInt(process.env.MAX_VIDEO_FPS || '24', 10),

    // Wisp swarm defaults
    wispsEnabled: opts.wisps === 'true' || process.env.WISPS_ENABLED === 'true',
    wispCount: parseInt(opts.wispCount || process.env.WISP_COUNT || '12', 10),
    wispModel: opts.wispModel || process.env.WISP_MODEL || 'llama3.2:1b',
    wispDataDir: opts.wispDataDir || process.env.WISP_DATA_DIR || './wisp-data',
    wispHttpPort: parseInt(opts.wispHttpPort || process.env.WISP_HTTP_PORT || '3334', 10),

    // Diagnostic defaults (lightweight ones on by default)
    diagFrameTiming: (process.env.GHOST_DIAG_FRAME_TIMING || 'true') === 'true',
    diagRingBufferLog: (process.env.GHOST_DIAG_RING_BUFFER || 'true') === 'true',
    diagRawCapture: (process.env.GHOST_DIAG_RAW_CAPTURE || 'false') === 'true',
    diagCodecLog: (process.env.GHOST_DIAG_CODEC_LOG || 'true') === 'true',
    diagDegradation: (process.env.GHOST_DIAG_DEGRADATION || 'true') === 'true',
    diagRefSignal: (process.env.GHOST_DIAG_REF_SIGNAL || 'false') === 'true',
  };
}

/** Simple leveled logger */
export function createLogger(config: GhostConfig) {
  const minLevel = LOG_LEVELS[config.logLevel];
  const lang = config.language.toUpperCase();

  return {
    debug: (...args: unknown[]) => {
      if (minLevel <= 0) console.log(`[${lang}] [DEBUG]`, ...args);
    },
    info: (...args: unknown[]) => {
      if (minLevel <= 1) console.log(`[${lang}] [INFO]`, ...args);
    },
    warn: (...args: unknown[]) => {
      if (minLevel <= 2) console.warn(`[${lang}] [WARN]`, ...args);
    },
    error: (...args: unknown[]) => {
      if (minLevel <= 3) console.error(`[${lang}] [ERROR]`, ...args);
    },
  };
}

export type Logger = ReturnType<typeof createLogger>;
