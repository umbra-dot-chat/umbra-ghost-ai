/**
 * Friend request handler — auto-accepts and sends a welcome message.
 */

import { computeConversationId, encryptMessage, uuid, type GhostIdentity } from '../crypto.js';
import type { RelayClient } from '../relay.js';
import type { ContextStore } from '../context/store.js';
import type { Logger } from '../config.js';

const WELCOME_MESSAGE = "Hey! 👋 I'm Ghost, your AI companion on Umbra. I can chat about anything, help with Umbra, set reminders, and I speak every language — just write to me in yours! ✨";

export interface IncomingFriendRequest {
  id: string;
  fromDid: string;
  fromDisplayName: string;
  fromSigningKey: string;
  fromEncryptionKey: string;
  message?: string;
}

export function handleFriendRequest(
  request: IncomingFriendRequest,
  identity: GhostIdentity,
  relay: RelayClient,
  store: ContextStore,
  language: string,
  log: Logger,
): void {
  log.info(`Friend request from ${request.fromDisplayName} (${request.fromDid.slice(0, 24)}...)`);

  // Compute conversation ID
  const conversationId = computeConversationId(identity.did, request.fromDid);

  // Save as friend
  store.saveFriend({
    did: request.fromDid,
    displayName: request.fromDisplayName,
    encryptionKey: request.fromEncryptionKey,
    signingKey: request.fromSigningKey,
    conversationId,
    addedAt: Date.now(),
  });

  // Send acceptance response
  const response = {
    envelope: 'friend_response',
    version: 1,
    payload: {
      requestId: request.id,
      fromDid: identity.did,
      fromDisplayName: identity.displayName,
      fromSigningKey: identity.signingPublicKey,
      fromEncryptionKey: identity.encryptionPublicKey,
      accepted: true,
      timestamp: Date.now(),
    },
  };
  relay.sendEnvelope(request.fromDid, response);

  log.info(`Accepted friend request from ${request.fromDisplayName}`);

  // Send welcome message after a brief delay (feels more natural)
  setTimeout(() => {
    const welcomeText = WELCOME_MESSAGE;
    const timestamp = Date.now();
    const messageId = uuid();

    const { ciphertext, nonce } = encryptMessage(
      welcomeText,
      identity.encryptionPrivateKey,
      request.fromEncryptionKey,
      identity.did,
      request.fromDid,
      timestamp,
      conversationId,
    );

    const messageEnvelope = {
      envelope: 'chat_message',
      version: 1,
      payload: {
        messageId,
        conversationId,
        senderDid: identity.did,
        contentEncrypted: ciphertext,
        nonce,
        timestamp,
      },
    };

    relay.sendEnvelope(request.fromDid, messageEnvelope);

    // Save to context
    store.saveMessage({
      id: messageId,
      conversationId,
      role: 'assistant',
      content: welcomeText,
      timestamp,
    });

    log.info(`Sent welcome message to ${request.fromDisplayName}`);
  }, 1000);
}
