import Database from "better-sqlite3";
import { randomInt } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { ROOM_ALPHABET, ROOM_CODE_LENGTH, type ChatMessage } from "../src/lib/sync/protocol";

export const RETENTION_MS = 3 * 24 * 60 * 60 * 1000;

export interface RoomRow {
  code: string;
  itemId: string;
  title: string;
  position: number;
  createdAt: number;
  lastUsedAt: number;
}

export function generateCode(): string {
  let out = "";
  for (let i = 0; i < ROOM_CODE_LENGTH; i++) out += ROOM_ALPHABET[randomInt(ROOM_ALPHABET.length)];
  return out;
}

export class Store {
  private db: Database.Database;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS rooms (
        code TEXT PRIMARY KEY,
        item_id TEXT NOT NULL,
        title TEXT NOT NULL,
        position REAL NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        last_used_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS chat (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        code TEXT NOT NULL REFERENCES rooms(code) ON DELETE CASCADE,
        name TEXT NOT NULL,
        text TEXT NOT NULL,
        ts INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS chat_code ON chat(code, id);
    `);
    this.db.pragma("foreign_keys = ON");
  }

  createRoom(itemId: string, title: string, now = Date.now()): RoomRow {
    const insert = this.db.prepare(
      "INSERT INTO rooms (code, item_id, title, position, created_at, last_used_at) VALUES (?, ?, ?, 0, ?, ?)",
    );
    for (let attempt = 0; attempt < 10; attempt++) {
      const code = generateCode();
      try {
        insert.run(code, itemId, title, now, now);
        return { code, itemId, title, position: 0, createdAt: now, lastUsedAt: now };
      } catch (e) {
        if (!String(e).includes("UNIQUE")) throw e;
      }
    }
    throw new Error("could not allocate a room code");
  }

  /** The room moves on to another title (next episode): back to the start. */
  setItem(code: string, itemId: string, title: string, now = Date.now()): void {
    this.db.prepare("UPDATE rooms SET item_id = ?, title = ?, position = 0, last_used_at = ? WHERE code = ?").run(itemId, title, now, code);
  }

  getRoom(code: string, now = Date.now()): RoomRow | null {
    const row = this.db
      .prepare(
        "SELECT code, item_id AS itemId, title, position, created_at AS createdAt, last_used_at AS lastUsedAt FROM rooms WHERE code = ?",
      )
      .get(code) as RoomRow | undefined;
    if (!row) return null;
    if (now - row.lastUsedAt > RETENTION_MS) return null; // expired, cleanup will remove it
    return row;
  }

  touch(code: string, position: number | null, now = Date.now()): void {
    if (position === null) {
      this.db.prepare("UPDATE rooms SET last_used_at = ? WHERE code = ?").run(now, code);
    } else {
      this.db.prepare("UPDATE rooms SET last_used_at = ?, position = ? WHERE code = ?").run(now, position, code);
    }
  }

  addChat(code: string, name: string, text: string, ts: number): ChatMessage {
    const info = this.db.prepare("INSERT INTO chat (code, name, text, ts) VALUES (?, ?, ?, ?)").run(code, name, text, ts);
    this.touch(code, null, ts);
    return { id: Number(info.lastInsertRowid), name, text, ts };
  }

  getChat(code: string, limit = 200): ChatMessage[] {
    const rows = this.db
      .prepare("SELECT id, name, text, ts FROM chat WHERE code = ? ORDER BY id DESC LIMIT ?")
      .all(code, limit) as ChatMessage[];
    return rows.reverse();
  }

  /** Delete rooms (and their chat) unused for 3 days. Returns the number removed. */
  cleanup(now = Date.now()): number {
    return this.db.prepare("DELETE FROM rooms WHERE last_used_at < ?").run(now - RETENTION_MS).changes;
  }

  close(): void {
    this.db.close();
  }
}
