/**
 * GhostBot — the main orchestrator that ties everything together.
 *
 * Creates identity, connects to relay, processes messages with LLM,
 * and manages the entire lifecycle of the Ghost AI agent.
 */

import { createServer } from 'http';
import Database from 'better-sqlite3';
import { join } from 'path';
import { existsSync, mkdirSync } from 'fs';
import type { GhostConfig, Logger } from './config.js';
import { createLogger } from './config.js';
import { computeConversationId, decryptGroupKey, decryptGroupMessage, type GhostIdentity } from './crypto.js';
import { loadOrCreateIdentity } from './identity.js';
import { RelayClient, type ServerMessage } from './relay.js';
import { OllamaProvider } from './llm/ollama.js';
import { ContextStore } from './context/store.js';
import { CodebaseIndexer } from './knowledge/indexer.js';
import { handleFriendRequest, type IncomingFriendRequest } from './handlers/friend-request.js';
import { handleMessage, type IncomingMessage } from './handlers/message.js';
import { checkReminders } from './handlers/reminder.js';
import { CallHandler } from './handlers/call.js';
import { MediaManager } from './media/manager.js';
import { CommunityBridge } from './community-bridge.js';

const BOT_NAMES: Record<string, string> = {
  en: 'Ghost',
  ko: '고스트',
};

export class GhostBot {
  private config: GhostConfig;
  private log: Logger;
  private identity!: GhostIdentity;
  private relay!: RelayClient;
  private llm!: OllamaProvider;
  private store!: ContextStore;
  private indexer!: CodebaseIndexer;
  private knowledgeDb!: Database.Database;
  private callHandler: CallHandler | null = null;
  private mediaManager: MediaManager | null = null;
  private reminderInterval: ReturnType<typeof setInterval> | null = null;
  private httpServer: ReturnType<typeof createServer> | null = null;
  private running = false;
  private wispOrchestrator: any = null;
  private communityBridge: CommunityBridge | null = null;

  constructor(config: GhostConfig) {
    this.config = config;
    this.log = createLogger(config);
  }

  async start(): Promise<void> {
    const displayName = BOT_NAMES[this.config.language] || BOT_NAMES.en;

    this.log.info('═══════════════════════════════════════════');
    this.log.info(`  Ghost AI Agent — ${displayName}`);
    this.log.info('═══════════════════════════════════════════');

    // 1. Load or create identity
    this.identity = loadOrCreateIdentity(this.config.dataDir, displayName, this.log);
    this.log.info(`DID: ${this.identity.did}`);
    this.log.info(`Encryption key: ${this.identity.encryptionPublicKey}`);

    // 2. Initialize stores
    this.store = new ContextStore(this.config.dataDir, this.log);

    // 3. Initialize LLM
    this.llm = new OllamaProvider(
      this.config.ollamaUrl,
      this.config.model,
      this.config.embedModel,
      this.log,
    );

    // Check Ollama health
    const ollamaOk = await this.llm.healthCheck();
    if (!ollamaOk) {
      this.log.warn('Ollama is not reachable or model not found. Bot will start but LLM responses will fail.');
      this.log.warn(`Make sure Ollama is running at ${this.config.ollamaUrl} with model '${this.config.model}'`);
    } else {
      this.log.info(`Ollama connected (model: ${this.config.model})`);
    }

    // 4. Initialize codebase knowledge
    if (!existsSync(this.config.dataDir)) {
      mkdirSync(this.config.dataDir, { recursive: true });
    }
    const knowledgeDbPath = join(this.config.dataDir, 'knowledge.db');
    this.knowledgeDb = new Database(knowledgeDbPath);
    this.knowledgeDb.pragma('journal_mode = WAL');
    this.indexer = new CodebaseIndexer(this.knowledgeDb, this.llm, this.config.codebasePath, this.log);

    // Index codebase in background if not already done
    if (!this.indexer.isIndexed()) {
      this.log.info('Codebase not indexed yet — starting background indexing...');
      this.indexCodebaseBackground();
    } else {
      this.log.info('Codebase index loaded');
    }

    // 5. Connect to relay
    this.relay = new RelayClient(this.config.relayUrl, this.identity.did, this.log);
    this.relay.onReconnected = () => {
      this.log.info('Reconnected — fetching offline messages...');
    };

    this.log.info(`Connecting to relay: ${this.config.relayUrl}`);
    try {
      await this.relay.connect();
      this.log.info('Registered with relay ✓');
    } catch (err) {
      this.log.error('Failed to connect to relay:', err);
      this.log.info('Will retry connection...');
      // The relay client will auto-reconnect
    }

    // 6. Set up message handling
    this.relay.onMessage((msg) => this.handleRelayMessage(msg));

    // 7. Fetch offline messages
    this.relay.fetchOffline();

    // 8. Start reminder checker (every 30 seconds)
    this.reminderInterval = setInterval(() => {
      checkReminders(this.identity, this.relay, this.store, this.config.language, this.log);
    }, 30000);

    // 9. Initialize call handling
    if (this.config.callEnabled) {
      await this.initializeCallHandler();
    }

    // 10. Start HTTP health endpoint
    this.startHealthServer();

    // 11. Start wisp swarm (if enabled)
    if (this.config.wispsEnabled) {
      await this.startWisps();

      // Wire community bridge — routes community events from relay to wisps
      if (this.wispOrchestrator) {
        this.communityBridge = new CommunityBridge(this.log);

        // Enable presence scheduling so wisps rotate on/off in shifts
        this.wispOrchestrator.enablePresenceScheduling();
      }
    }

    this.running = true;
    this.log.info(`Ghost is running! 👻`);
    this.log.info(`Language: ${this.config.language}`);
    this.log.info(`Relay: ${this.config.relayUrl}`);
    this.log.info(`Model: ${this.config.model}`);
    this.log.info(`Calls: ${this.callHandler ? 'enabled' : 'disabled'}`);
    this.log.info(`Wisps: ${this.wispOrchestrator ? `${this.config.wispCount} active` : 'disabled'}`);
    this.log.info('Waiting for messages...\n');
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.reminderInterval) {
      clearInterval(this.reminderInterval);
      this.reminderInterval = null;
    }
    this.callHandler?.endAllCalls();
    this.relay?.disconnect();
    this.store?.close();
    this.knowledgeDb?.close();
    this.httpServer?.close();
    if (this.communityBridge) {
      this.communityBridge.removeAllListeners();
      this.communityBridge = null;
    }
    if (this.wispOrchestrator) {
      await this.wispOrchestrator.stop();
      this.wispOrchestrator = null;
    }
    this.log.info('Ghost stopped');
  }

  /** Expose the call handler for message.ts to route /ghost commands. */
  getCallHandler(): CallHandler | null {
    return this.callHandler;
  }

  // ─── Message Routing ─────────────────────────────────────────────────

  private handleRelayMessage(msg: ServerMessage): void {
    if (msg.type === 'message') {
      // Route community events to the bridge before normal envelope handling
      if (this.communityBridge) {
        this.communityBridge.handleRelayMessage(msg.from_did, msg.payload);
      }
      this.handleIncomingEnvelope(msg.from_did, msg.payload);
    } else if (msg.type === 'offline_messages') {
      this.log.info(`Processing ${msg.messages.length} offline message(s)`);
      for (const m of msg.messages) {
        if (this.communityBridge) {
          this.communityBridge.handleRelayMessage(m.from_did, m.payload);
        }
        this.handleIncomingEnvelope(m.from_did, m.payload);
      }
    }
  }

  private handleIncomingEnvelope(fromDid: string, payloadStr: string): void {
    let envelope: any;
    try {
      envelope = JSON.parse(payloadStr);
    } catch {
      this.log.warn('Failed to parse envelope');
      return;
    }

    const type = envelope.envelope || envelope.type;
    const payload = envelope.payload || envelope;

    switch (type) {
      case 'friend_request':
        this.handleFriendRequestEnvelope(payload);
        break;

      case 'friend_response':
        this.handleFriendResponseEnvelope(payload);
        break;

      case 'chat_message':
      case 'encrypted_message':
        this.handleChatMessageEnvelope(payload, fromDid);
        break;

      // ── Call signaling ──────────────────────────────────────────────
      // Client double-stringifies call payloads, so payload may be a JSON string
      case 'call_offer': {
        const parsed = typeof payload === 'string' ? JSON.parse(payload) : payload;
        this.callHandler?.handleCallOffer(parsed);
        break;
      }

      case 'call_answer':
        // Ghost doesn't initiate calls, but handle for completeness
        break;

      case 'call_reoffer': {
        const parsed = typeof payload === 'string' ? JSON.parse(payload) : payload;
        this.callHandler?.handleCallReoffer(parsed);
        break;
      }

      case 'call_reanswer': {
        const parsed = typeof payload === 'string' ? JSON.parse(payload) : payload;
        this.callHandler?.handleCallReanswer(parsed);
        break;
      }

      case 'call_ice_candidate': {
        const parsed = typeof payload === 'string' ? JSON.parse(payload) : payload;
        this.callHandler?.handleCallIceCandidate(parsed);
        break;
      }

      case 'call_end': {
        const parsed = typeof payload === 'string' ? JSON.parse(payload) : payload;
        this.callHandler?.handleCallEnd(parsed);
        break;
      }

      case 'call_state': {
        const parsed = typeof payload === 'string' ? JSON.parse(payload) : payload;
        this.callHandler?.handleCallState(parsed);
        break;
      }

      case 'group_invite':
        this.handleGroupInviteEnvelope(payload);
        break;

      case 'group_message':
        void this.handleGroupMessageEnvelope(payload);
        break;

      case 'group_invite_response':
      case 'group_key_rotation':
      case 'group_member_removed':
        // Acknowledge but don't process
        break;

      case 'typing_indicator':
      case 'message_status':
      case 'reaction_add':
      case 'reaction_remove':
        // Acknowledge but don't process
        break;

      default:
        this.log.debug(`Unhandled envelope type: ${type}`);
    }
  }

  private handleFriendRequestEnvelope(payload: any): void {
    const request: IncomingFriendRequest = {
      id: payload.id,
      fromDid: payload.fromDid,
      fromDisplayName: payload.fromDisplayName,
      fromSigningKey: payload.fromSigningKey,
      fromEncryptionKey: payload.fromEncryptionKey,
      message: payload.message,
    };
    handleFriendRequest(request, this.identity, this.relay, this.store, this.config.language, this.log);
  }

  private handleFriendResponseEnvelope(payload: any): void {
    if (payload.accepted) {
      this.log.info(`Friend response: ${payload.fromDisplayName} accepted our request`);
      const conversationId = computeConversationId(this.identity.did, payload.fromDid);
      this.store.saveFriend({
        did: payload.fromDid,
        displayName: payload.fromDisplayName,
        encryptionKey: payload.fromEncryptionKey,
        signingKey: payload.fromSigningKey,
        conversationId,
        addedAt: Date.now(),
      });
    } else {
      this.log.info(`Friend response: ${payload.fromDisplayName} rejected our request`);
    }
  }

  private async handleChatMessageEnvelope(payload: any, fromDid: string): Promise<void> {
    const msg: IncomingMessage = {
      messageId: payload.messageId,
      conversationId: payload.conversationId,
      senderDid: payload.senderDid || fromDid,
      contentEncrypted: payload.contentEncrypted,
      nonce: payload.nonce,
      timestamp: payload.timestamp,
      threadId: payload.threadId,
    };

    // Search codebase for relevant context
    let codebaseContext: string | null = null;
    if (this.indexer.isIndexed()) {
      // We need the decrypted text to search — but we decrypt inside handleMessage
      // So we'll do a lightweight check: search after decryption
      // For now, pass null and let handleMessage do the search if needed
    }

    await handleMessage(
      msg,
      this.identity,
      this.relay,
      this.store,
      this.llm,
      this.config.language,
      codebaseContext,
      this.log,
      this.callHandler,
    );
  }

  // ─── Group Handling ─────────────────────────────────────────────────────

  private handleGroupInviteEnvelope(payload: any): void {
    try {
      const inviter = this.store.getFriend(payload.inviterDid);
      if (!inviter) {
        this.log.warn(`Group invite from unknown DID: ${payload.inviterDid?.slice(0, 24)}...`);
        return;
      }

      const groupKey = decryptGroupKey(
        payload.encryptedGroupKey,
        payload.nonce,
        this.identity.encryptionPrivateKey,
        inviter.encryptionKey,
        payload.groupId,
      );

      this.store.saveGroup({
        groupId: payload.groupId,
        groupName: payload.groupName,
        groupKey,
        conversationId: `group-${payload.groupId}`,
        membersJson: payload.membersJson || '[]',
        joinedAt: Date.now(),
      });

      // Send acceptance back to inviter
      this.relay.sendEnvelope(payload.inviterDid, {
        envelope: 'group_invite_response',
        version: 1,
        payload: {
          inviteId: payload.inviteId,
          groupId: payload.groupId,
          accepted: true,
          fromDid: this.identity.did,
          fromDisplayName: this.identity.displayName,
          timestamp: Date.now(),
        },
      });

      this.log.info(`Joined group "${payload.groupName}"`);
    } catch (err) {
      this.log.warn('Failed to handle group invite:', err);
    }
  }

  private async handleGroupMessageEnvelope(payload: any): Promise<void> {
    const group = this.store.getGroup(payload.groupId);
    if (!group) return;

    try {
      const plaintext = decryptGroupMessage(
        payload.ciphertext,
        payload.nonce,
        group.groupKey,
        payload.groupId,
        payload.senderDid,
        payload.timestamp,
      );

      this.store.saveMessage({
        id: payload.messageId,
        conversationId: group.conversationId,
        role: 'user',
        content: `${payload.senderName}: ${plaintext}`,
        timestamp: payload.timestamp,
      });

      this.log.info(`Group "${group.groupName}" from ${payload.senderName}: "${plaintext.slice(0, 80)}${plaintext.length > 80 ? '...' : ''}"`);

      // Forward to wisp orchestrator so wisps can respond to real users
      if (this.wispOrchestrator && payload.senderDid !== this.identity.did) {
        const wisps = this.wispOrchestrator.getWisps();
        const isFromWisp = wisps.some((w: any) => w.did === payload.senderDid);
        if (!isFromWisp) {
          this.wispOrchestrator.triggerGroupResponse(
            payload.senderDid,
            payload.senderName || 'Unknown',
            plaintext,
            payload.groupId,
          );
        }
      }
    } catch (err) {
      this.log.warn(`Failed to decrypt group message in "${group.groupName}":`, err);
    }
  }

  // ─── Call Handler ──────────────────────────────────────────────────────

  private async initializeCallHandler(): Promise<void> {
    const cacheDir = this.config.mediaCacheDir || join(this.config.dataDir, 'media');
    this.mediaManager = new MediaManager(this.config.mediaConfigPath, cacheDir, this.log);
    await this.mediaManager.initialize();

    // Download media in background
    this.mediaManager.downloadAll().catch((err) => {
      this.log.error('Media download failed:', err);
    });

    this.callHandler = new CallHandler(
      this.config,
      this.identity,
      this.relay,
      this.store,
      this.mediaManager,
      this.log,
    );

    const loaded = await this.callHandler.initialize();
    if (loaded) {
      this.log.info('Call handler ready — accepting calls');
    } else {
      this.log.warn('Call handler disabled — @roamhq/wrtc not available');
    }
  }

  // ─── Knowledge Indexing ──────────────────────────────────────────────

  private async indexCodebaseBackground(): Promise<void> {
    try {
      await this.indexer.indexCodebase();
    } catch (err) {
      this.log.error('Background indexing failed:', err);
    }
  }

  async reindexCodebase(): Promise<void> {
    this.log.info('Re-indexing codebase...');
    await this.indexer.indexCodebase();
  }

  // ─── Health Server ───────────────────────────────────────────────────

  private startHealthServer(): void {
    this.httpServer = createServer((req, res) => {
      const url = req.url || '';

      if (url === '/health' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          status: 'ok',
          did: this.identity.did,
          displayName: this.identity.displayName,
          language: this.config.language,
          relay: this.config.relayUrl,
          relayConnected: this.relay?.connected ?? false,
          model: this.config.model,
          friends: this.store?.getAllFriends().length ?? 0,
          callsEnabled: !!this.callHandler,
          activeCalls: this.callHandler?.getActiveCalls().length ?? 0,
          uptime: process.uptime(),
        }));
      } else if (url === '/calls' && req.method === 'GET') {
        // ── Call status endpoint ──────────────────────────────────────
        if (!this.callHandler) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ enabled: false, calls: [] }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          enabled: true,
          calls: this.callHandler.getActiveCalls(),
        }));
      } else if (url === '/media' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(this.mediaManager?.getAllMedia() ?? { audio: [], video: [], files: [] }));
      } else if (url === '/webhook/git' && req.method === 'POST') {
        // Git webhook — trigger codebase re-indexing
        this.log.info('Git webhook received — re-indexing codebase...');
        this.reindexCodebase();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'reindexing' }));
      } else {
        res.writeHead(404);
        res.end('Not found');
      }
    });

    this.httpServer.listen(this.config.httpPort, '0.0.0.0', () => {
      this.log.info(`Health server listening on port ${this.config.httpPort}`);
    });
  }

  // ─── Wisp Swarm ────────────────────────────────────────────────────

  private async startWisps(): Promise<void> {
    try {
      const { WispOrchestrator } = await import('@umbra/wisps');
      this.wispOrchestrator = new WispOrchestrator({
        relayUrl: this.config.relayUrl,
        ollamaUrl: this.config.ollamaUrl,
        model: this.config.wispModel,
        count: this.config.wispCount,
        dataDir: this.config.wispDataDir,
        httpPort: this.config.wispHttpPort,
      });
      await this.wispOrchestrator.start();
      await this.wispOrchestrator.befriendAll();
      this.log.info(`Wisp swarm started (${this.config.wispCount} wisps on port ${this.config.wispHttpPort})`);
    } catch (err) {
      this.log.warn('Failed to start wisp swarm:', err);
    }
  }
}
