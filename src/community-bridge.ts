/**
 * CommunityBridge — allows Ghost AI bots to interact with Umbra communities
 * without WASM access, purely through relay WebSocket envelopes.
 *
 * Community messages travel as `community_event` relay envelopes, sent
 * individually to each community member via the relay's `Send` protocol.
 */

import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';
import WebSocket from 'ws';
import type { Logger } from './config.js';

// ── Interfaces ───────────────────────────────────────────────────────────────

/** Community state as synced from the user's app */
export interface CommunityState {
  communityId: string;
  name: string;
  channels: CommunityChannel[];
  members: CommunityMember[];
}

export interface CommunityChannel {
  id: string;
  name: string;
  type: 'text' | 'voice' | 'announcement';
  categoryName?: string;
}

export interface CommunityMember {
  did: string;
  displayName: string;
  avatarUrl?: string;
}

export interface CommunityMessage {
  messageId: string;
  channelId: string;
  channelName?: string;
  senderDid: string;
  senderDisplayName: string;
  content: string;
  timestamp: number;
}

export interface CommunityReaction {
  communityId: string;
  channelId: string;
  messageId: string;
  memberDid: string;
  emoji: string;
  added: boolean;
}

/** Shape of the community_event relay envelope */
interface CommunityEnvelope {
  envelope: 'community_event';
  version: 1;
  payload: {
    communityId: string;
    event: Record<string, unknown>;
    senderDid: string;
    timestamp: number;
  };
}

// ── CommunityBridge ──────────────────────────────────────────────────────────

/**
 * Bridge allowing Ghost AI bots to interact with Umbra communities
 * without WASM access, purely through relay WebSocket envelopes.
 *
 * Events emitted:
 *   'community:message'       → CommunityMessage
 *   'community:reaction'      → CommunityReaction
 *   'community:member_joined' → { communityId, member: CommunityMember }
 *   'community:member_left'   → { communityId, memberDid: string }
 *   'community:sync'          → CommunityState
 */
export class CommunityBridge extends EventEmitter {
  private communities: Map<string, CommunityState> = new Map();
  private log: Logger;

  constructor(logger: Logger) {
    super();
    this.log = logger;
  }

  // ── Community registry ───────────────────────────────────────────────

  /** Register a community (called when user syncs community data to Ghost) */
  addCommunity(state: CommunityState): void {
    this.communities.set(state.communityId, state);
    this.log.info(
      `Community added: ${state.name} (${state.communityId}) — ` +
      `${state.channels.length} channels, ${state.members.length} members`,
    );
  }

  /** Remove a community */
  removeCommunity(communityId: string): void {
    const existing = this.communities.get(communityId);
    this.communities.delete(communityId);
    if (existing) {
      this.log.info(`Community removed: ${existing.name} (${communityId})`);
    }
  }

  /** Update member list (called on join/leave events) */
  updateMembers(communityId: string, members: CommunityMember[]): void {
    const community = this.communities.get(communityId);
    if (!community) {
      this.log.warn(`updateMembers: unknown community ${communityId}`);
      return;
    }
    community.members = members;
  }

  /** Get all registered communities */
  getCommunities(): CommunityState[] {
    return Array.from(this.communities.values());
  }

  /** Get channels for a community */
  getChannels(communityId: string): CommunityChannel[] {
    return this.communities.get(communityId)?.channels ?? [];
  }

  /** Get text channels only */
  getTextChannels(communityId: string): CommunityChannel[] {
    return this.getChannels(communityId).filter((c) => c.type === 'text');
  }

  /** Get voice channels only */
  getVoiceChannels(communityId: string): CommunityChannel[] {
    return this.getChannels(communityId).filter((c) => c.type === 'voice');
  }

  /** Get members of a community, optionally excluding a given DID */
  getMembers(communityId: string, excludeDid?: string): CommunityMember[] {
    const members = this.communities.get(communityId)?.members ?? [];
    if (!excludeDid) return members;
    return members.filter((m) => m.did !== excludeDid);
  }

  // ── Sending ──────────────────────────────────────────────────────────

  /**
   * Build a community_event envelope for sending a channel message.
   * Returns the stringified envelope JSON.
   */
  buildMessageEnvelope(
    communityId: string,
    channelId: string,
    senderDid: string,
    senderDisplayName: string,
    content: string,
    options?: { replyToId?: string; metadata?: Record<string, unknown> },
  ): string {
    const channel = this.getChannels(communityId).find((c) => c.id === channelId);
    const messageId = this.generateMessageId();

    const envelope: CommunityEnvelope = {
      envelope: 'community_event',
      version: 1,
      payload: {
        communityId,
        event: {
          type: 'communityMessageSent',
          channelId,
          channelName: channel?.name ?? null,
          messageId,
          senderDid,
          content,
          senderDisplayName,
          senderAvatarUrl: null,
          metadata: options?.metadata ?? null,
          ...(options?.replyToId ? { replyToId: options.replyToId } : {}),
        },
        senderDid,
        timestamp: Date.now(),
      },
    };

    return JSON.stringify(envelope);
  }

  /**
   * Broadcast a channel message to all community members via relay.
   * Returns the generated message ID.
   */
  sendChannelMessage(
    ws: WebSocket,
    communityId: string,
    channelId: string,
    senderDid: string,
    senderDisplayName: string,
    content: string,
    options?: { replyToId?: string; metadata?: Record<string, unknown> },
  ): string {
    const envelopeStr = this.buildMessageEnvelope(
      communityId, channelId, senderDid, senderDisplayName, content, options,
    );

    // Extract messageId from the built envelope
    const envelope = JSON.parse(envelopeStr) as CommunityEnvelope;
    const messageId = envelope.payload.event['messageId'] as string;

    this.broadcastToMembers(ws, communityId, senderDid, envelopeStr);

    this.log.debug(
      `Sent message ${messageId} to channel ${channelId} in ${communityId}`,
    );

    return messageId;
  }

  /**
   * Build and send a reaction event to all community members.
   */
  sendReaction(
    ws: WebSocket,
    communityId: string,
    channelId: string,
    messageId: string,
    memberDid: string,
    emoji: string,
  ): void {
    const envelope: CommunityEnvelope = {
      envelope: 'community_event',
      version: 1,
      payload: {
        communityId,
        event: {
          type: 'communityReactionAdded',
          channelId,
          messageId,
          memberDid,
          emoji,
          isCustom: false,
        },
        senderDid: memberDid,
        timestamp: Date.now(),
      },
    };

    const envelopeStr = JSON.stringify(envelope);
    this.broadcastToMembers(ws, communityId, memberDid, envelopeStr);

    this.log.debug(
      `Sent reaction ${emoji} on ${messageId} in ${communityId}`,
    );
  }

  // ── Receiving ────────────────────────────────────────────────────────

  /**
   * Handle an incoming relay message that may be a community_event envelope.
   * Parses the payload and emits typed events.
   */
  handleRelayMessage(fromDid: string, payload: string): void {
    let parsed: CommunityEnvelope;
    try {
      parsed = JSON.parse(payload);
    } catch {
      return; // Not JSON — not our concern
    }

    if (parsed.envelope !== 'community_event' || parsed.version !== 1) {
      return; // Not a community envelope
    }

    const { communityId, event, timestamp } = parsed.payload;
    const eventType = event['type'] as string | undefined;

    if (!eventType) {
      this.log.warn('Community event missing type field');
      return;
    }

    this.log.debug(
      `Community event: ${eventType} from ${fromDid} in ${communityId}`,
    );

    switch (eventType) {
      case 'communityMessageSent':
        this.emit('community:message', {
          messageId: event['messageId'] as string,
          channelId: event['channelId'] as string,
          channelName: (event['channelName'] as string) ?? undefined,
          senderDid: event['senderDid'] as string,
          senderDisplayName: (event['senderDisplayName'] as string) ?? 'Unknown',
          content: (event['content'] as string) ?? '',
          timestamp,
        } satisfies CommunityMessage);
        break;

      case 'communityReactionAdded':
        this.emit('community:reaction', {
          communityId,
          channelId: event['channelId'] as string,
          messageId: event['messageId'] as string,
          memberDid: event['memberDid'] as string,
          emoji: event['emoji'] as string,
          added: true,
        } satisfies CommunityReaction);
        break;

      case 'communityReactionRemoved':
        this.emit('community:reaction', {
          communityId,
          channelId: event['channelId'] as string,
          messageId: event['messageId'] as string,
          memberDid: event['memberDid'] as string,
          emoji: event['emoji'] as string,
          added: false,
        } satisfies CommunityReaction);
        break;

      case 'memberJoined': {
        const member: CommunityMember = {
          did: event['memberDid'] as string,
          displayName: (event['memberNickname'] as string) ?? 'Unknown',
          avatarUrl: (event['memberAvatar'] as string) ?? undefined,
        };
        // Update local state
        const communityJoin = this.communities.get(communityId);
        if (communityJoin) {
          const exists = communityJoin.members.some((m) => m.did === member.did);
          if (!exists) communityJoin.members.push(member);
        }
        this.emit('community:member_joined', { communityId, member });
        break;
      }

      case 'memberLeft': {
        const leftDid = event['memberDid'] as string;
        // Update local state
        const communityLeave = this.communities.get(communityId);
        if (communityLeave) {
          communityLeave.members = communityLeave.members.filter(
            (m) => m.did !== leftDid,
          );
        }
        this.emit('community:member_left', { communityId, memberDid: leftDid });
        break;
      }

      case 'community_sync': {
        // Special sync event: user's app sends full CommunityState to Ghost
        const syncState: CommunityState = {
          communityId,
          name: (event['name'] as string) ?? '',
          channels: (event['channels'] as CommunityChannel[]) ?? [],
          members: (event['members'] as CommunityMember[]) ?? [],
        };
        this.addCommunity(syncState);
        this.emit('community:sync', syncState);
        break;
      }

      case 'communityMessageEdited':
        this.emit('community:message_edited', {
          communityId,
          channelId: event['channelId'] as string,
          messageId: event['messageId'] as string,
          content: (event['content'] as string) ?? undefined,
          editedAt: (event['editedAt'] as number) ?? timestamp,
        });
        break;

      case 'communityMessageDeleted':
        this.emit('community:message_deleted', {
          communityId,
          channelId: event['channelId'] as string,
          messageId: event['messageId'] as string,
        });
        break;

      default:
        this.log.debug(`Unhandled community event type: ${eventType}`);
    }
  }

  // ── Private helpers ──────────────────────────────────────────────────

  /** Generate a unique message ID */
  private generateMessageId(): string {
    return `msg-${randomUUID()}`;
  }

  /** Send a relay envelope to all members of a community, excluding the sender */
  private broadcastToMembers(
    ws: WebSocket,
    communityId: string,
    senderDid: string,
    envelopeStr: string,
  ): void {
    const members = this.getMembers(communityId, senderDid);

    if (members.length === 0) {
      this.log.warn(
        `broadcastToMembers: no recipients for community ${communityId}`,
      );
      return;
    }

    for (const member of members) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: 'send',
          to_did: member.did,
          payload: envelopeStr,
        }));
      }
    }

    this.log.debug(
      `Broadcast to ${members.length} members in ${communityId}`,
    );
  }
}
