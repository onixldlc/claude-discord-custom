/** Shared on-disk state for the broker and the host-only ctl tool. */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

// Every window can host the broker, so this folder is reachable by every agent.
export const SHARED_DIR = process.env.DISCORD_SHARED_DIR ?? join(homedir(), '.claude', 'channels', 'discord-rooms')
export const STATE_DIR = process.env.DISCORD_STATE_DIR ?? join(SHARED_DIR, 'state')
export const ACCESS_FILE = join(STATE_DIR, 'access.json')
export const BINDINGS_FILE = join(STATE_DIR, 'bindings.json')
export const ROOM_SESSIONS_FILE = join(STATE_DIR, 'room-sessions.json')
export const APPROVED_DIR = join(STATE_DIR, 'approved')
export const INBOX_DIR = join(STATE_DIR, 'inbox')
export const ENV_FILE = join(STATE_DIR, '.env')

export const BUS_DIR = join(SHARED_DIR, 'bus')
export const BUSY_DIR = join(SHARED_DIR, 'busy')
export const SESSIONS_DIR = join(SHARED_DIR, 'sessions')
export const FAILED_DIR = join(SHARED_DIR, 'failed')

export const AGENT_NAME_RE = /^[a-z0-9][a-z0-9-]{0,31}$/

export type PendingEntry = {
  senderId: string
  chatId: string
  createdAt: number
  expiresAt: number
  replies: number
}

export type Access = {
  dmPolicy: 'pairing' | 'allowlist' | 'disabled'
  allowFrom: string[]
  pending: Record<string, PendingEntry>
  ackReaction?: string
  replyToMode?: 'off' | 'first' | 'all'
  textChunkLimit?: number
  chunkMode?: 'length' | 'newline'
}

/** Agent name -> Discord channel, thread, or DM channel ID. */
export type Bindings = Record<string, string>

/** Discord room ID -> the Claude session that room continues. */
export type RoomSessions = Record<string, string>

function writeJson(file: string, value: unknown): void {
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 })
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 })
  renameSync(tmp, file)
}

function readJson<T>(file: string, fallback: () => T): T {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return fallback()
    try { renameSync(file, `${file}.corrupt-${Date.now()}`) } catch {}
    process.stderr.write(`discord-rooms: ${file} is corrupt, moved aside\n`)
    return fallback()
  }
}

export function loadAccess(): Access {
  const a = readJson<Partial<Access>>(ACCESS_FILE, () => ({}))
  return {
    ...a,
    dmPolicy: a.dmPolicy ?? 'pairing',
    allowFrom: a.allowFrom ?? [],
    pending: a.pending ?? {},
  }
}

export function saveAccess(a: Access): void {
  writeJson(ACCESS_FILE, a)
}

export function loadBindings(): Bindings {
  return readJson<Bindings>(BINDINGS_FILE, () => ({}))
}

export function saveBindings(b: Bindings): void {
  writeJson(BINDINGS_FILE, b)
}

export function loadRoomSessions(): RoomSessions {
  return readJson<RoomSessions>(ROOM_SESSIONS_FILE, () => ({}))
}

export function saveRoomSessions(r: RoomSessions): void {
  writeJson(ROOM_SESSIONS_FILE, r)
}
