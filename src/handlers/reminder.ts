/**
 * Reminder system — parses natural language reminders and fires them when due.
 */

import { encryptMessage, uuid, type GhostIdentity } from '../crypto.js';
import type { RelayClient } from '../relay.js';
import type { ContextStore, StoredReminder } from '../context/store.js';
import type { Logger } from '../config.js';

/**
 * Parse a message for reminder intent. Returns a StoredReminder if found, null otherwise.
 */
export function parseReminder(
  text: string,
  userDid: string,
  conversationId: string,
  language: string,
): StoredReminder | null {
  const lower = text.toLowerCase();

  // English patterns
  const enPatterns = [
    /remind me in (\d+)\s*(second|minute|hour|day)s?\s+(?:to\s+)?(.+)/i,
    /remind me in (\d+)\s*(sec|min|hr|h|d)s?\s+(?:to\s+)?(.+)/i,
    /set (?:a )?reminder (?:for )?(\d+)\s*(second|minute|hour|day|sec|min|hr|h|d)s?\s*:?\s*(.+)/i,
  ];

  // Korean patterns
  const koPatterns = [
    /(\d+)\s*(초|분|시간|일)\s*(?:후에?|뒤에?)\s*(.+?)(?:\s*알려줘|\s*리마인드)/i,
    /(\d+)\s*(초|분|시간|일)\s*(?:후에?|뒤에?)\s*(.+)/i,
  ];

  // Spanish patterns
  const esPatterns = [
    /recuérdame en (\d+)\s*(segundo|minuto|hora|día)s?\s+(?:que\s+)?(.+)/i,
    /recordar(?:me)? en (\d+)\s*(segundo|minuto|hora|día|seg|min|h)s?\s+(?:que\s+)?(.+)/i,
  ];

  // Try all patterns (multilingual — detect from user's input)
  const patterns = [...enPatterns, ...koPatterns, ...esPatterns];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      const amount = parseInt(match[1], 10);
      const unitRaw = match[2].toLowerCase();
      const message = match[3].trim();

      if (isNaN(amount) || amount <= 0 || !message) continue;

      // Normalize unit to milliseconds
      const unitMap: Record<string, number> = {
        'second': 1000, 'sec': 1000, '초': 1000, 'segundo': 1000, 'seg': 1000,
        'minute': 60000, 'min': 60000, '분': 60000, 'minuto': 60000,
        'hour': 3600000, 'hr': 3600000, 'h': 3600000, '시간': 3600000, 'hora': 3600000,
        'day': 86400000, 'd': 86400000, '일': 86400000, 'día': 86400000,
      };

      const multiplier = unitMap[unitRaw];
      if (!multiplier) continue;

      const fireAt = Date.now() + amount * multiplier;

      return {
        id: uuid(),
        userDid,
        conversationId,
        message,
        fireAt,
        fired: 0,
      };
    }
  }

  return null;
}

/**
 * Check for due reminders and send them.
 */
export function checkReminders(
  identity: GhostIdentity,
  relay: RelayClient,
  store: ContextStore,
  language: string,
  log: Logger,
): void {
  const due = store.getDueReminders();

  for (const reminder of due) {
    const friend = store.getFriendByConversation(reminder.conversationId);
    if (!friend) {
      store.markReminderFired(reminder.id);
      continue;
    }

    const reminderText = `⏰ Reminder: ${reminder.message}`;

    const timestamp = Date.now();
    const messageId = uuid();

    const { ciphertext, nonce } = encryptMessage(
      reminderText,
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

    store.saveMessage({
      id: messageId,
      conversationId: friend.conversationId,
      role: 'assistant',
      content: reminderText,
      timestamp,
    });

    store.markReminderFired(reminder.id);
    log.info(`Fired reminder for ${friend.displayName}: ${reminder.message}`);
  }
}
