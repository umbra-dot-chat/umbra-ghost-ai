/**
 * Relay WebSocket client for Ghost.
 *
 * Handles connection, DID registration, envelope sending/receiving,
 * offline message fetching, and automatic reconnection with exponential backoff.
 */

import WebSocket from 'ws';
import type { Logger } from './config.js';

export type ServerMessage =
  | { type: 'registered'; did: string }
  | { type: 'message'; from_did: string; payload: string; timestamp: number }
  | { type: 'ack'; id: string }
  | { type: 'pong' }
  | { type: 'offline_messages'; messages: { from_did: string; payload: string; timestamp: number }[] }
  | { type: 'error'; message: string }
  | { type: 'session_created'; session_id: string }
  | { type: 'session_joined'; session_id: string; from_did: string; answer_payload: string };

export type MessageHandler = (msg: ServerMessage) => void;

export class RelayClient {
  private ws: WebSocket | null = null;
  private did: string;
  private url: string;
  private log: Logger;
  private handlers: MessageHandler[] = [];
  private _registered = false;
  private pingInterval: ReturnType<typeof setInterval> | null = null;

  // Reconnection — always enabled for Ghost (it's a persistent service)
  private _reconnectAttempts = 0;
  private _maxReconnectAttempts = Infinity; // Never give up
  private _reconnectBaseDelay = 2000;
  private _reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private _intentionalDisconnect = false;
  private _messageQueue: object[] = [];

  // Callbacks
  onReconnected: (() => void) | null = null;
  onDisconnected: (() => void) | null = null;

  constructor(url: string, did: string, log: Logger) {
    this.url = url;
    this.did = did;
    this.log = log;
  }

  get registered(): boolean { return this._registered; }
  get connected(): boolean { return this.ws?.readyState === WebSocket.OPEN; }

  /**
   * Connect to the relay and register our DID.
   */
  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this._intentionalDisconnect = false;
      this.ws = new WebSocket(this.url);

      const timeout = setTimeout(() => {
        this.ws?.close();
        reject(new Error('Connection timeout'));
      }, 15000);

      this.ws.on('open', () => {
        clearTimeout(timeout);
        this.send({ type: 'register', did: this.did });
      });

      this.ws.on('message', (raw) => {
        try {
          const str = typeof raw === 'string' ? raw : raw.toString('utf-8');
          const msg = JSON.parse(str) as ServerMessage;

          if (msg.type === 'registered') {
            this._registered = true;
            this._reconnectAttempts = 0;
            if (this.pingInterval) clearInterval(this.pingInterval);
            this.pingInterval = setInterval(() => {
              if (this.connected) this.send({ type: 'ping' });
            }, 30000);
            resolve();
          }

          for (const h of this.handlers) {
            try { h(msg); } catch { /* ignore handler errors */ }
          }
        } catch {
          // ignore parse errors
        }
      });

      this.ws.on('error', (err) => {
        clearTimeout(timeout);
        if (!this._registered) reject(err);
      });

      this.ws.on('close', () => {
        const wasRegistered = this._registered;
        this._registered = false;
        if (this.pingInterval) {
          clearInterval(this.pingInterval);
          this.pingInterval = null;
        }

        if (wasRegistered && !this._intentionalDisconnect) {
          this.log.warn('Disconnected from relay');
          this.onDisconnected?.();
          this.attemptReconnect();
        }
      });
    });
  }

  /** Subscribe to relay messages. */
  onMessage(handler: MessageHandler): () => void {
    this.handlers.push(handler);
    return () => { this.handlers = this.handlers.filter((h) => h !== handler); };
  }

  /** Send a relay envelope to a recipient DID. */
  sendEnvelope(toDid: string, envelope: object): void {
    this.send({
      type: 'send',
      to_did: toDid,
      payload: JSON.stringify(envelope),
    });
  }

  /** Request offline messages. */
  fetchOffline(): void {
    this.send({ type: 'fetch_offline' });
  }

  /** Send raw JSON to relay. Queues if disconnected. */
  send(msg: object): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    } else {
      this._messageQueue.push(msg);
    }
  }

  /** Disconnect intentionally. */
  disconnect(): void {
    this._intentionalDisconnect = true;
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    if (this.pingInterval) clearInterval(this.pingInterval);
    this.ws?.close();
    this.ws = null;
    this._registered = false;
  }

  // ─── Internal ──────────────────────────────────────────────────────────

  private attemptReconnect(): void {
    const delay = Math.min(
      this._reconnectBaseDelay * Math.pow(2, this._reconnectAttempts),
      60000, // Cap at 60s
    );
    this._reconnectAttempts++;

    this.log.info(`Reconnecting in ${Math.round(delay / 1000)}s (attempt ${this._reconnectAttempts})...`);

    this._reconnectTimer = setTimeout(async () => {
      this._reconnectTimer = null;
      try {
        await this.connect();
        this.fetchOffline();
        this.flushQueue();
        this.log.info('Reconnected to relay');
        this.onReconnected?.();
      } catch {
        // connect() sets up close handler which calls attemptReconnect again
      }
    }, delay);
  }

  private flushQueue(): void {
    const queued = [...this._messageQueue];
    this._messageQueue = [];
    for (const msg of queued) {
      this.send(msg);
    }
  }
}
