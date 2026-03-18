/**
 * Message handler — receives encrypted messages, processes with LLM, sends encrypted responses.
 *
 * Supports streaming: if the LLM provider implements `chatStream`, Ghost sends
 * every chunk as a regular `chat_message` envelope with the same messageId.
 * The client deduplicates — first creates, subsequent update in-place.
 */

import { decryptMessage, encryptMessage, uuid, type GhostIdentity } from '../crypto.js';
import type { RelayClient } from '../relay.js';
import type { ContextStore, StoredFriend } from '../context/store.js';
import type { LLMProvider, ChatMessage } from '../llm/provider.js';
import { getSystemPrompt } from '../llm/system-prompts.js';
import { parseReminder } from './reminder.js';
import { detectAndExecuteWispCommand, handleSwarmCommand } from './wisp-commands.js';
import type { CallHandler } from './call.js';
import type { Logger } from '../config.js';

export interface IncomingMessage {
  messageId: string;
  conversationId: string;
  senderDid: string;
  contentEncrypted: string;
  nonce: string;
  timestamp: number;
  threadId?: string;
}

// Regex patterns for tutor score tags
const TUTOR_TAG_REGEX = /\[TUTOR-\w+-([\d.]+)\]/;
const TUTOR_TAG_FALLBACK = /TUTOR[- ]\w+[- ]([\d.]+)/i;
const TUTOR_TAG_STRIP = /\[TUTOR-\w+-[\d.]+\]\s*/g;
const THERAPY_TAG_STRIP = /\[THERAPY-SESSION\]\s*/g;

export async function handleMessage(
  msg: IncomingMessage,
  identity: GhostIdentity,
  relay: RelayClient,
  store: ContextStore,
  llm: LLMProvider,
  language: 'en' | 'ko',
  codebaseContext: string | null,
  log: Logger,
  callHandler?: CallHandler | null,
): Promise<void> {
  // Look up the friend
  const friend = store.getFriend(msg.senderDid);
  if (!friend) {
    log.warn(`Received message from unknown DID: ${msg.senderDid.slice(0, 24)}...`);
    return;
  }

  // Decrypt the message
  let plaintext: string;
  try {
    plaintext = decryptMessage(
      msg.contentEncrypted,
      msg.nonce,
      identity.encryptionPrivateKey,
      friend.encryptionKey,
      msg.senderDid,
      identity.did,
      msg.timestamp,
      msg.conversationId,
    );
  } catch (err) {
    log.error(`Failed to decrypt message from ${friend.displayName}:`, err);
    return;
  }

  log.info(`Message from ${friend.displayName}: "${plaintext.slice(0, 100)}${plaintext.length > 100 ? '...' : ''}"`);

  // Save user message to context
  store.saveMessage({
    id: msg.messageId,
    conversationId: msg.conversationId,
    role: 'user',
    content: plaintext,
    timestamp: msg.timestamp,
  });

  // Send typing indicator
  sendTypingIndicator(identity, relay, friend);

  // Detect /tutor commands (sent by the Language Tutor plugin)
  const tutorCmdMatch = plaintext.match(/^\/tutor\s+(.+)$/i);
  if (tutorCmdMatch) {
    const tutorArg = tutorCmdMatch[1].trim().toLowerCase();

    if (tutorArg === 'stop' || tutorArg === 'off') {
      store.clearUserTutorState(msg.senderDid);
      log.info(`Tutor mode deactivated for ${friend.displayName}`);
      const confirmText = `Language tutor mode deactivated. Back to normal chatting! 👋`;
      await sendResponse(confirmText, identity, relay, store, friend, log);
      return;
    }

    // Treat the argument as a language name
    const existingState = store.getUserTutorState(msg.senderDid);
    const prevScore = existingState?.score ?? 0;
    store.setUserTutorState({
      userDid: msg.senderDid,
      language: tutorArg,
      score: prevScore,
      updatedAt: Date.now(),
    });
    log.info(`Tutor mode activated for ${friend.displayName}: ${tutorArg} (score: ${prevScore})`);
    // Replace the raw /tutor command with a natural prompt for the LLM
    plaintext = `I'd like to practice ${tutorArg}. Let's start chatting!`;
  }

  // Detect /therapy commands (sent by the Questionable Therapy plugin)
  const therapyCmdMatch = plaintext.match(/^\/therapy\s*(.*)$/i);
  if (therapyCmdMatch) {
    const therapyArg = (therapyCmdMatch[1] || '').trim().toLowerCase();

    if (therapyArg === 'stop' || therapyArg === 'end') {
      store.clearUserTherapyState(msg.senderDid);
      log.info(`Therapy mode deactivated for ${friend.displayName}`);
      const goodbyeText = `[THERAPY-SESSION] Our session is wrapping up. Remember, whatever you're carrying, you don't have to carry it alone. Take care of yourself, and I'm here whenever you want to talk again.`;
      await sendResponse(goodbyeText, identity, relay, store, friend, log);
      return;
    }

    // Activate therapy mode (default for /therapy or /therapy start)
    const existing = store.getUserTherapyState(msg.senderDid);
    const sessionCount = existing ? existing.sessionCount + 1 : 0;
    store.setUserTherapyState({
      userDid: msg.senderDid,
      active: true,
      sessionCount,
      updatedAt: Date.now(),
    });
    log.info(`Therapy mode activated for ${friend.displayName} (session #${sessionCount + 1})`);
    plaintext = `I'd like to start a therapy session. How are we doing today?`;
  }

  // Detect /ghost commands (call control, file sending, etc.)
  const ghostCmdMatch = plaintext.match(/^\/ghost\s+(.+)$/i);
  if (ghostCmdMatch && callHandler) {
    const parts = ghostCmdMatch[1].trim().split(/\s+/);
    const command = parts[0];
    const args = parts.slice(1);
    const result = await callHandler.handleCommand(command, args, msg.senderDid);
    await sendResponse(result, identity, relay, store, friend, log);
    return;
  }

  // Detect /swarm commands (explicit slash commands for wisp control)
  if (/^\/swarm\s/i.test(plaintext)) {
    const swarmResult = await handleSwarmCommand(plaintext, msg.senderDid, log);
    if (swarmResult.detected && swarmResult.response) {
      await sendResponse(swarmResult.response, identity, relay, store, friend, log);
      return;
    }
  }

  // Check for wisp-related intents (before LLM to avoid wasted GPU cycles)
  const wispResult = await detectAndExecuteWispCommand(plaintext, msg.senderDid, log);
  if (wispResult.detected && wispResult.response) {
    await sendResponse(wispResult.response, identity, relay, store, friend, log);
    return;
  }

  // Check for reminder intent
  const reminder = parseReminder(plaintext, msg.senderDid, msg.conversationId, language);
  if (reminder) {
    store.saveReminder(reminder);
    const confirmText = language === 'ko'
      ? `알겠어요! ⏰ "${reminder.message}" — 알려드릴게요!`
      : `Got it! ⏰ I'll remind you: "${reminder.message}"`;
    await sendResponse(confirmText, identity, relay, store, friend, log);
    return;
  }

  // Build LLM context
  const history = store.getRecentMessages(msg.conversationId, 20);
  const messages: ChatMessage[] = [];

  // System prompt — pass tutor/therapy config so the language section is replaced
  const tutorState = store.getUserTutorState(msg.senderDid);
  const therapyState = store.getUserTherapyState(msg.senderDid);
  let systemContent = getSystemPrompt(
    language,
    tutorState ? { language: tutorState.language, score: tutorState.score } : null,
    therapyState?.active ? { sessionCount: therapyState.sessionCount } : null,
  );
  if (codebaseContext) {
    systemContent += '\n\n## Relevant Codebase Context\n' + codebaseContext;
  }

  messages.push({ role: 'system', content: systemContent });

  // Conversation history
  for (const h of history) {
    messages.push({ role: h.role, content: h.content });
  }

  // Current message (already in history from saveMessage above, but just in case)
  if (!history.find((h) => h.id === msg.messageId)) {
    messages.push({ role: 'user', content: plaintext });
  }

  // ── Generate response (streaming or non-streaming) ──────────────────────

  let responseText: string;

  if (llm.chatStream) {
    // Streaming mode: send first chunk as chat_message (creates the message),
    // subsequent chunks as chat_message_update (updates content in-place).
    const messageId = uuid();
    let lastSentText = '';
    let chunkCount = 0;

    responseText = await llm.chatStream(messages, (accumulated: string) => {
      if (accumulated !== lastSentText) {
        chunkCount++;
        if (chunkCount === 1) {
          // First chunk: create the message via chat_message envelope
          sendEncryptedMessage(messageId, accumulated, identity, relay, friend);
        } else {
          // Subsequent chunks: update via chat_message_update envelope
          sendEncryptedUpdate(messageId, accumulated, identity, relay, friend);
        }
        lastSentText = accumulated;
        log.debug(`[STREAM] chunk #${chunkCount} sent (${accumulated.length} chars)`);
      }
    });

    // Ensure the final complete response is sent as an update
    if (responseText && responseText !== lastSentText) {
      sendEncryptedUpdate(messageId, responseText, identity, relay, friend);
    }

    // Parse and strip tutor score from the final response
    if (tutorState) {
      parseTutorScore(responseText, tutorState, store, friend, log);
    }
    let cleanedResponse = responseText;
    if (tutorState) cleanedResponse = cleanedResponse.replace(TUTOR_TAG_STRIP, '');
    if (therapyState?.active) cleanedResponse = cleanedResponse.replace(THERAPY_TAG_STRIP, '');

    // Save the stripped version to context store (clean LLM history)
    store.saveMessage({
      id: messageId,
      conversationId: friend.conversationId,
      role: 'assistant',
      content: cleanedResponse,
      timestamp: Date.now(),
    });

    log.info(`Replied (streamed) to ${friend.displayName}: "${cleanedResponse.slice(0, 100)}${cleanedResponse.length > 100 ? '...' : ''}"`);
  } else {
    // Non-streaming mode: generate complete response then send
    responseText = await llm.chat(messages);

    // Parse and strip tutor score
    if (tutorState) {
      parseTutorScore(responseText, tutorState, store, friend, log);
    }
    let cleanedResponse = responseText;
    if (tutorState) cleanedResponse = cleanedResponse.replace(TUTOR_TAG_STRIP, '');
    if (therapyState?.active) cleanedResponse = cleanedResponse.replace(THERAPY_TAG_STRIP, '');

    // Send with tags intact (client plugin parses them), store stripped
    const messageId = uuid();
    const timestamp = Date.now();
    sendEncryptedMessage(messageId, responseText, identity, relay, friend);

    store.saveMessage({
      id: messageId,
      conversationId: friend.conversationId,
      role: 'assistant',
      content: cleanedResponse,
      timestamp,
    });

    log.info(`Replied to ${friend.displayName}: "${cleanedResponse.slice(0, 100)}${cleanedResponse.length > 100 ? '...' : ''}"`);
  }

  // Always clear typing indicator when done
  sendStopTypingIndicator(identity, relay, friend);
}

// ── Tutor score parsing ───────────────────────────────────────────────────────

function parseTutorScore(
  responseText: string,
  tutorState: { userDid: string; language: string; score: number; updatedAt: number },
  store: ContextStore,
  friend: StoredFriend,
  log: Logger,
): void {
  let scoreMatch = responseText.match(TUTOR_TAG_REGEX);
  // Fallback: try a looser pattern if the LLM didn't format perfectly
  if (!scoreMatch) {
    scoreMatch = responseText.match(TUTOR_TAG_FALLBACK);
  }

  if (scoreMatch) {
    const newScore = parseFloat(scoreMatch[1]);
    if (!isNaN(newScore) && newScore !== tutorState.score) {
      const clampedScore = Math.min(100, Math.max(0, newScore));
      store.setUserTutorState({
        ...tutorState,
        score: clampedScore,
        updatedAt: Date.now(),
      });
      log.info(`Tutor score updated for ${friend.displayName}: ${tutorState.score} → ${clampedScore}`);
    }
  }
}

// ── Message sending helpers ───────────────────────────────────────────────────

/**
 * Send an encrypted chat_message (initial message).
 */
function sendEncryptedMessage(
  messageId: string,
  text: string,
  identity: GhostIdentity,
  relay: RelayClient,
  friend: StoredFriend,
): void {
  const timestamp = Date.now();
  const { ciphertext, nonce } = encryptMessage(
    text,
    identity.encryptionPrivateKey,
    friend.encryptionKey,
    identity.did,
    friend.did,
    timestamp,
    friend.conversationId,
  );

  relay.sendEnvelope(friend.did, {
    envelope: 'chat_message',
    version: 1,
    payload: {
      messageId,
      conversationId: friend.conversationId,
      senderDid: identity.did,
      contentEncrypted: ciphertext,
      nonce,
      timestamp,
    },
  });
}

async function sendResponse(
  text: string,
  identity: GhostIdentity,
  relay: RelayClient,
  store: ContextStore,
  friend: StoredFriend,
  log: Logger,
): Promise<void> {
  const timestamp = Date.now();
  const messageId = uuid();

  const { ciphertext, nonce } = encryptMessage(
    text,
    identity.encryptionPrivateKey,
    friend.encryptionKey,
    identity.did,
    friend.did,
    timestamp,
    friend.conversationId,
  );

  const envelope = {
    envelope: 'chat_message',
    version: 1,
    payload: {
      messageId,
      conversationId: friend.conversationId,
      senderDid: identity.did,
      contentEncrypted: ciphertext,
      nonce,
      timestamp,
    },
  };

  relay.sendEnvelope(friend.did, envelope);

  // Save assistant response
  store.saveMessage({
    id: messageId,
    conversationId: friend.conversationId,
    role: 'assistant',
    content: text,
    timestamp,
  });

  log.info(`Replied to ${friend.displayName}: "${text.slice(0, 100)}${text.length > 100 ? '...' : ''}"`);
}

/**
 * Send a chat_message_update envelope (progressive streaming update).
 */
function sendEncryptedUpdate(
  messageId: string,
  text: string,
  identity: GhostIdentity,
  relay: RelayClient,
  friend: StoredFriend,
): void {
  const timestamp = Date.now();
  const { ciphertext, nonce } = encryptMessage(
    text,
    identity.encryptionPrivateKey,
    friend.encryptionKey,
    identity.did,
    friend.did,
    timestamp,
    friend.conversationId,
  );

  relay.sendEnvelope(friend.did, {
    envelope: 'chat_message_update',
    version: 1,
    payload: {
      messageId,
      conversationId: friend.conversationId,
      senderDid: identity.did,
      contentEncrypted: ciphertext,
      nonce,
      timestamp,
    },
  });
}

function sendTypingIndicator(identity: GhostIdentity, relay: RelayClient, friend: StoredFriend): void {
  relay.sendEnvelope(friend.did, {
    envelope: 'typing_indicator',
    version: 1,
    payload: {
      conversationId: friend.conversationId,
      senderDid: identity.did,
      senderName: identity.displayName ?? 'Ghost',
      isTyping: true,
      timestamp: Date.now(),
    },
  });
}

function sendStopTypingIndicator(identity: GhostIdentity, relay: RelayClient, friend: StoredFriend): void {
  relay.sendEnvelope(friend.did, {
    envelope: 'typing_indicator',
    version: 1,
    payload: {
      conversationId: friend.conversationId,
      senderDid: identity.did,
      senderName: identity.displayName ?? 'Ghost',
      isTyping: false,
      timestamp: Date.now(),
    },
  });
}
