/**
 * SQLite-backed context store for Ghost.
 *
 * Stores conversation history, friend data, and reminders.
 */

import Database from 'better-sqlite3';
import { join } from 'path';
import { existsSync, mkdirSync } from 'fs';
import type { Logger } from '../config.js';

export interface StoredMessage {
  id: string;
  conversationId: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
}

export interface StoredFriend {
  did: string;
  displayName: string;
  encryptionKey: string;
  signingKey: string;
  conversationId: string;
  addedAt: number;
}

export interface StoredReminder {
  id: string;
  userDid: string;
  conversationId: string;
  message: string;
  fireAt: number;
  fired: number;
}

export interface StoredTutorState {
  userDid: string;
  language: string;
  score: number;
  updatedAt: number;
}

export interface StoredGroup {
  groupId: string;
  groupName: string;
  groupKey: string;
  conversationId: string;
  membersJson: string;
  joinedAt: number;
}

export interface StoredTherapyState {
  userDid: string;
  active: boolean;
  sessionCount: number;
  updatedAt: number;
}

export class ContextStore {
  private db: Database.Database;
  private log: Logger;

  constructor(dataDir: string, log: Logger) {
    this.log = log;

    if (!existsSync(dataDir)) {
      mkdirSync(dataDir, { recursive: true });
    }

    const dbPath = join(dataDir, 'ghost.db');
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.initSchema();

    log.info(`Database opened: ${dbPath}`);
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS friends (
        did TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        encryption_key TEXT NOT NULL,
        signing_key TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        added_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
        content TEXT NOT NULL,
        timestamp INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, timestamp DESC);

      CREATE TABLE IF NOT EXISTS reminders (
        id TEXT PRIMARY KEY,
        user_did TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        message TEXT NOT NULL,
        fire_at INTEGER NOT NULL,
        fired INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_reminders_fire ON reminders(fired, fire_at);

      CREATE TABLE IF NOT EXISTS user_tutor_state (
        user_did TEXT PRIMARY KEY,
        language TEXT NOT NULL,
        score REAL NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS user_therapy_state (
        user_did TEXT PRIMARY KEY,
        active INTEGER NOT NULL DEFAULT 0,
        session_count INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS groups (
        group_id TEXT PRIMARY KEY,
        group_name TEXT NOT NULL,
        group_key TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        members_json TEXT NOT NULL DEFAULT '[]',
        joined_at INTEGER NOT NULL
      );
    `);
  }

  // ─── Friends ───────────────────────────────────────────────────────────

  saveFriend(friend: StoredFriend): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO friends (did, display_name, encryption_key, signing_key, conversation_id, added_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(friend.did, friend.displayName, friend.encryptionKey, friend.signingKey, friend.conversationId, friend.addedAt);
  }

  getFriend(did: string): StoredFriend | null {
    const row = this.db.prepare('SELECT * FROM friends WHERE did = ?').get(did) as any;
    if (!row) return null;
    return {
      did: row.did,
      displayName: row.display_name,
      encryptionKey: row.encryption_key,
      signingKey: row.signing_key,
      conversationId: row.conversation_id,
      addedAt: row.added_at,
    };
  }

  getFriendByConversation(conversationId: string): StoredFriend | null {
    const row = this.db.prepare('SELECT * FROM friends WHERE conversation_id = ?').get(conversationId) as any;
    if (!row) return null;
    return {
      did: row.did,
      displayName: row.display_name,
      encryptionKey: row.encryption_key,
      signingKey: row.signing_key,
      conversationId: row.conversation_id,
      addedAt: row.added_at,
    };
  }

  getAllFriends(): StoredFriend[] {
    const rows = this.db.prepare('SELECT * FROM friends ORDER BY added_at DESC').all() as any[];
    return rows.map((row) => ({
      did: row.did,
      displayName: row.display_name,
      encryptionKey: row.encryption_key,
      signingKey: row.signing_key,
      conversationId: row.conversation_id,
      addedAt: row.added_at,
    }));
  }

  // ─── Messages ──────────────────────────────────────────────────────────

  saveMessage(msg: StoredMessage): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO messages (id, conversation_id, role, content, timestamp)
      VALUES (?, ?, ?, ?, ?)
    `).run(msg.id, msg.conversationId, msg.role, msg.content, msg.timestamp);
  }

  getRecentMessages(conversationId: string, limit: number = 20): StoredMessage[] {
    const rows = this.db.prepare(
      'SELECT * FROM messages WHERE conversation_id = ? ORDER BY timestamp DESC LIMIT ?'
    ).all(conversationId, limit) as any[];

    return rows.reverse().map((row) => ({
      id: row.id,
      conversationId: row.conversation_id,
      role: row.role,
      content: row.content,
      timestamp: row.timestamp,
    }));
  }

  // ─── Reminders ─────────────────────────────────────────────────────────

  saveReminder(reminder: StoredReminder): void {
    this.db.prepare(`
      INSERT INTO reminders (id, user_did, conversation_id, message, fire_at, fired)
      VALUES (?, ?, ?, ?, ?, 0)
    `).run(reminder.id, reminder.userDid, reminder.conversationId, reminder.message, reminder.fireAt);
  }

  getDueReminders(): StoredReminder[] {
    const now = Date.now();
    const rows = this.db.prepare(
      'SELECT * FROM reminders WHERE fired = 0 AND fire_at <= ?'
    ).all(now) as any[];

    return rows.map((row) => ({
      id: row.id,
      userDid: row.user_did,
      conversationId: row.conversation_id,
      message: row.message,
      fireAt: row.fire_at,
      fired: row.fired,
    }));
  }

  markReminderFired(id: string): void {
    this.db.prepare('UPDATE reminders SET fired = 1 WHERE id = ?').run(id);
  }

  // ─── Tutor State ─────────────────────────────────────────────────────

  setUserTutorState(state: StoredTutorState): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO user_tutor_state (user_did, language, score, updated_at)
      VALUES (?, ?, ?, ?)
    `).run(state.userDid, state.language, state.score, state.updatedAt);
  }

  getUserTutorState(userDid: string): StoredTutorState | null {
    const row = this.db.prepare('SELECT * FROM user_tutor_state WHERE user_did = ?').get(userDid) as any;
    if (!row) return null;
    return {
      userDid: row.user_did,
      language: row.language,
      score: row.score,
      updatedAt: row.updated_at,
    };
  }

  clearUserTutorState(userDid: string): void {
    this.db.prepare('DELETE FROM user_tutor_state WHERE user_did = ?').run(userDid);
  }

  // ─── Therapy State ──────────────────────────────────────────────────

  setUserTherapyState(state: StoredTherapyState): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO user_therapy_state (user_did, active, session_count, updated_at)
      VALUES (?, ?, ?, ?)
    `).run(state.userDid, state.active ? 1 : 0, state.sessionCount, state.updatedAt);
  }

  getUserTherapyState(userDid: string): StoredTherapyState | null {
    const row = this.db.prepare('SELECT * FROM user_therapy_state WHERE user_did = ?').get(userDid) as any;
    if (!row) return null;
    return {
      userDid: row.user_did,
      active: row.active === 1,
      sessionCount: row.session_count,
      updatedAt: row.updated_at,
    };
  }

  clearUserTherapyState(userDid: string): void {
    this.db.prepare('DELETE FROM user_therapy_state WHERE user_did = ?').run(userDid);
  }

  // ─── Groups ──────────────────────────────────────────────────────────

  saveGroup(group: StoredGroup): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO groups (group_id, group_name, group_key, conversation_id, members_json, joined_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(group.groupId, group.groupName, group.groupKey, group.conversationId, group.membersJson, group.joinedAt);
  }

  getGroup(groupId: string): StoredGroup | null {
    const row = this.db.prepare('SELECT * FROM groups WHERE group_id = ?').get(groupId) as any;
    if (!row) return null;
    return {
      groupId: row.group_id,
      groupName: row.group_name,
      groupKey: row.group_key,
      conversationId: row.conversation_id,
      membersJson: row.members_json,
      joinedAt: row.joined_at,
    };
  }

  getAllGroups(): StoredGroup[] {
    const rows = this.db.prepare('SELECT * FROM groups ORDER BY joined_at DESC').all() as any[];
    return rows.map((row) => ({
      groupId: row.group_id,
      groupName: row.group_name,
      groupKey: row.group_key,
      conversationId: row.conversation_id,
      membersJson: row.members_json,
      joinedAt: row.joined_at,
    }));
  }

  removeGroup(groupId: string): void {
    this.db.prepare('DELETE FROM groups WHERE group_id = ?').run(groupId);
  }

  close(): void {
    this.db.close();
  }
}
