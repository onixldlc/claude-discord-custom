#!/usr/bin/env bun
/**
 * Single Discord connection shared by every Claude Code agent.
 *
 * Owns the bot token, global pairing, room bindings, and slash commands.
 * Agents connect through the per-session shim in server.ts over a Unix socket.
 * Conversation memory lives only in each Claude session.
 */

import {
  ActionRowBuilder,
  ApplicationCommandOptionType,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Client,
  GatewayIntentBits,
  MessageType,
  Partials,
  type ChatInputApplicationCommandData,
  type Attachment,
  type AutocompleteInteraction,
  type ChatInputCommandInteraction,
  type Emoji,
  type Interaction,
  type Message,
} from 'discord.js'
import { randomBytes } from 'crypto'
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join, sep } from 'path'
import { brokerRunning, serveBus, type BusSocket } from './bus.ts'
import {
  AGENT_NAME_RE,
  APPROVED_DIR,
  BUS_DIR,
  BUSY_DIR,
  ENV_FILE,
  FAILED_DIR,
  INBOX_DIR,
  SESSIONS_DIR,
  STATE_DIR,
  loadAccess,
  loadBindings,
  loadRoomSessions,
  saveAccess,
  saveBindings,
  saveRoomSessions,
  type Access,
} from './state.ts'

mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 })
try {
  chmodSync(ENV_FILE, 0o600)
  for (const line of readFileSync(ENV_FILE, 'utf8').split('\n')) {
    const m = line.match(/^(\w+)=(.*)$/)
    if (m && process.env[m[1]!] === undefined) process.env[m[1]!] = m[2]!
  }
} catch {}

const TOKEN = process.env.DISCORD_BOT_TOKEN
if (!TOKEN) {
  process.stderr.write(`broker: DISCORD_BOT_TOKEN required, set it in ${ENV_FILE}\n`)
  process.exit(1)
}

process.on('unhandledRejection', err => process.stderr.write(`broker: unhandled rejection: ${err}\n`))
process.on('uncaughtException', err => process.stderr.write(`broker: uncaught exception: ${err}\n`))

const PERMISSION_REPLY_RE = /^\s*(y|yes|n|no)\s+([a-km-z]{5})\s*$/i
const PERMISSION_BUTTON_RE = /^perm:(allow|deny|more):([a-z0-9-]{1,32}):([a-km-z]{5})$/
const IDLE_SETTLE_MS = 1000
const COMMAND_SETTLE_MS = 1500
const MAX_CHUNK_LIMIT = 2000
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024
const MAX_EMOJIS_LISTED = 200
const SWITCH_TIMEOUT_MS = 20000
const STATUS_AFTER_MS = Number(process.env.DISCORD_STATUS_AFTER_MS ?? 30000)
const STATUS_STUCK_MS = STATUS_AFTER_MS * 6
const STATUS_EDIT_MS = 15000
const MAX_TRANSCRIPT_SCAN = 4 * 1024 * 1024
const CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude')

type Agent = { name: string; cwd: string; pid: number; sock: BusSocket; control: boolean }
type PermissionDetails = { tool_name: string; description: string; input_preview: string; createdAt: number }
type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean }

const agents = new Map<string, Agent>()
const bindings = loadBindings()
const roomSessions = loadRoomSessions()
const pendingPermissions = new Map<string, PermissionDetails>()

const client = new Client({
  intents: [
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel],
})

// Channels cannot run slash commands, so these only work for agents started inside tmux.
const TMUX_COMMANDS: ChatInputApplicationCommandData[] = process.env.DISCORD_TMUX_COMMANDS === '1'
  ? [
      { name: 'new', description: 'Start a new conversation in this room' },
      { name: 'compact', description: "Compact this room's agent conversation" },
    ]
  : []

const COMMANDS: ChatInputApplicationCommandData[] = [
  {
    name: 'use-agent',
    description: 'List running agents, or lock one to this room',
    options: [
      { type: ApplicationCommandOptionType.String, name: 'agent', description: 'Agent name', autocomplete: true },
    ],
  },
  { name: 'rem-agent', description: "Unlock this room's agent, leaving it running" },
  ...TMUX_COMMANDS,
]

function send(sock: BusSocket, frame: unknown): void {
  if (!sock.destroyed) sock.write(JSON.stringify(frame) + '\n')
}

function agentForRoom(room: string): string | undefined {
  return Object.entries(bindings).find(([, id]) => id === room)?.[0]
}

function unbindRoom(room: string): void {
  const name = agentForRoom(room)
  if (!name) return
  delete bindings[name]
  saveBindings(bindings)
}

type SessionCommand = '/clear' | '/compact' | `/resume ${string}`
type QueuedCommand = {
  command: SessionCommand
  next?: SessionCommand
  room: string
  held: unknown[]
  idleAt: number
  running: boolean
  lastPaneCheck?: number
  interruptedHits?: number
}

/** Session commands wait for the current turn, so they never interrupt running work. */
const queuedCommands = new Map<string, QueuedCommand>()

function busyFile(name: string): string {
  return join(BUSY_DIR, name)
}

function isBusy(name: string): boolean {
  return existsSync(busyFile(name))
}

function markBusy(name: string): void {
  mkdirSync(BUSY_DIR, { recursive: true, mode: 0o700 })
  writeFileSync(busyFile(name), '', { mode: 0o600 })
}

type PaneCall = { resolve: (stdout: string) => void; reject: (err: Error) => void; timer: Timer }
const paneCalls = new Map<number, PaneCall>()
let nextPaneCall = 1

/** tmux runs inside each agent's container, so its shim performs pane operations. */
function paneRequest(name: string, op: 'send' | 'capture', text?: string): Promise<string> {
  const agent = agents.get(name)
  if (!agent) return Promise.reject(new Error(`${name} is offline`))
  const id = nextPaneCall++
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      paneCalls.delete(id)
      reject(new Error('pane request timed out'))
    }, 5000)
    paneCalls.set(id, { resolve, reject, timer })
    send(agent.sock, { t: 'tmux', id, op, text })
  })
}

async function sendToPane(name: string, command: SessionCommand): Promise<void> {
  await paneRequest(name, 'send', command)
}

function queueCommand(name: string, command: SessionCommand, room: string): void {
  const queued = queuedCommands.get(name)
  if (!queued) {
    queuedCommands.set(name, { command, room, held: [], idleAt: 0, running: false })
    return
  }
  queued.room = room
  if (queued.running) {
    if (command !== '/compact' || !queued.next) queued.next = command
  } else if (command !== '/compact') {
    queued.command = command
  }
}

async function notifyRoom(room: string, content: string): Promise<void> {
  const channel = await client.channels.fetch(room).catch(() => null)
  if (channel?.isTextBased() && 'send' in channel) await channel.send(content).catch(() => {})
}

function currentSession(name: string): string | undefined {
  try {
    return readFileSync(join(SESSIONS_DIR, name), 'utf8').trim() || undefined
  } catch {
    return undefined
  }
}

function transcriptDir(cwd: string): string {
  return join(CONFIG_DIR, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'))
}

function transcriptPath(agent: Agent, session: string): string {
  return join(transcriptDir(agent.cwd), `${session}.jsonl`)
}

const sessionChatCache = new Map<string, { mtimeMs: number; hasChat: boolean }>()

function userText(entry: any): string | undefined {
  if (entry.type !== 'user' || entry.isCompactSummary) return undefined
  const content = entry.message?.content
  const value = typeof content === 'string'
    ? content
    : Array.isArray(content) ? content.find((part: any) => part.type === 'text')?.text : undefined
  if (typeof value !== 'string') return undefined
  if (entry.origin?.kind === 'channel') return value.replace(/<\/?channel\b[^>]*>/g, '').trim()
  if (entry.isMeta || /^\s*<(command-|local-command)/.test(value)) return undefined
  return value.trim()
}

/** A transcript counts as a conversation only once it holds a real user message. */
function sessionHasChat(agent: Agent, session: string): boolean {
  const path = transcriptPath(agent, session)
  let mtimeMs: number
  try { mtimeMs = statSync(path).mtimeMs } catch { return false }
  const cached = sessionChatCache.get(path)
  if (cached?.mtimeMs === mtimeMs) return cached.hasChat
  const fd = openSync(path, 'r')
  const buf = Buffer.alloc(Math.min(statSync(path).size, MAX_TRANSCRIPT_SCAN))
  try { readSync(fd, buf, 0, buf.length, 0) } finally { closeSync(fd) }
  let hasChat = false
  for (const line of buf.toString('utf8').split('\n')) {
    try {
      if (userText(JSON.parse(line))) {
        hasChat = true
        break
      }
    } catch {}
  }
  sessionChatCache.set(path, { mtimeMs, hasChat })
  return hasChat
}

function rememberRoomSession(room: string, session: string): void {
  for (const [other, id] of Object.entries(roomSessions)) {
    if (id === session && other !== room) delete roomSessions[other]
  }
  roomSessions[room] = session
  saveRoomSessions(roomSessions)
}

function forgetRoomSession(room: string): void {
  if (!(room in roomSessions)) return
  delete roomSessions[room]
  saveRoomSessions(roomSessions)
}

function agentHolding(session: string, except: string): string | undefined {
  return [...agents.keys()].find(name => name !== except && currentSession(name) === session)
}

/** Keeps the room's saved session current, and restores it into an agent that started empty. */
function syncRoomSession(name: string): void {
  const room = bindings[name]
  const agent = agents.get(name)
  if (!room || !agent || queuedCommands.has(name)) return
  const current = currentSession(name)
  const saved = roomSessions[room]
  // No session yet means startup hooks have not run, and a manual --resume may still be loading.
  if (!current || current === saved) return
  if (!agent.control) {
    // Plugin sessions have no pane to type /resume into, so the room follows the window.
    if (sessionHasChat(agent, current)) rememberRoomSession(room, current)
    return
  }
  if (sessionHasChat(agent, current)) {
    rememberRoomSession(room, current)
  } else if (saved && existsSync(transcriptPath(agent, saved))) {
    queueCommand(name, `/resume ${saved}`, room)
  } else if (saved) {
    forgetRoomSession(room)
    void notifyRoom(room, `The saved conversation for this room is not in \`${agent.cwd}\`, so \`${name}\` starts fresh.`)
  }
}
setInterval(() => { for (const name of agents.keys()) syncRoomSession(name) }, 1000).unref()

async function paneReady(name: string): Promise<boolean> {
  try {
    const stdout = await paneRequest(name, 'capture')
    return !stdout.includes('I am using this for local development')
  } catch {
    return false
  }
}

async function waitForSwitch(name: string, command: SessionCommand, before: string | undefined): Promise<boolean> {
  if (command === '/compact') return true
  const target = command === '/clear' ? undefined : command.slice('/resume '.length)
  const end = Date.now() + SWITCH_TIMEOUT_MS
  while (Date.now() < end) {
    const current = currentSession(name)
    if (target ? current === target : current !== before) return true
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  return false
}

type StatusWatch = {
  room: string
  lastProgress: number
  transcriptMtime?: number
  message?: Message
  text?: string
  lastEdit: number
  updating: boolean
}

/** One self-updating status message per running turn. Discord only allows ephemeral replies to interactions. */
const statusWatches = new Map<string, StatusWatch>()
const failureNotices = new Map<string, Message>()

function watchTurn(name: string, room: string): void {
  if (!statusWatches.has(name)) statusWatches.set(name, { room, lastProgress: Date.now(), lastEdit: 0, updating: false })
  const notice = failureNotices.get(name)
  if (notice) {
    failureNotices.delete(name)
    void notice.delete().catch(() => {})
  }
}

function deliver(name: string, agent: Agent, frame: unknown, room: string): void {
  watchTurn(name, room)
  markBusy(name)
  send(agent.sock, frame)
}

async function clearStatus(watch: StatusWatch): Promise<void> {
  const message = watch.message
  watch.message = undefined
  watch.text = undefined
  if (message) await message.delete().catch(() => {})
}

async function showStatus(watch: StatusWatch, content: string, force: boolean): Promise<void> {
  if (watch.updating || watch.text === content) return
  if (watch.message && !force && Date.now() - watch.lastEdit < STATUS_EDIT_MS) return
  watch.updating = true
  try {
    if (watch.message) {
      await watch.message.edit({ content, allowedMentions: { parse: [] } })
    } else {
      const channel = await client.channels.fetch(watch.room)
      if (channel?.isTextBased() && 'send' in channel) {
        watch.message = await channel.send({ content, allowedMentions: { parse: [] } }) as Message
      }
    }
    watch.text = content
    watch.lastEdit = Date.now()
  } catch (err) {
    process.stderr.write(`broker: status update failed: ${err}\n`)
  } finally {
    watch.updating = false
  }
}

function lastApiError(agent: Agent): string | undefined {
  const session = currentSession(agent.name)
  if (!session) return undefined
  try {
    const path = transcriptPath(agent, session)
    const size = statSync(path).size
    const length = Math.min(size, 256 * 1024)
    const buf = Buffer.alloc(length)
    const fd = openSync(path, 'r')
    try { readSync(fd, buf, 0, length, size - length) } finally { closeSync(fd) }
    for (const line of buf.toString('utf8').split('\n').reverse()) {
      if (!line.includes('isApiErrorMessage')) continue
      try {
        const entry = JSON.parse(line)
        const content = entry.message?.content
        const value = Array.isArray(content) ? content.find((part: any) => part.type === 'text')?.text : content
        if (entry.isApiErrorMessage && typeof value === 'string') return value.replace(/\s+/g, ' ').slice(0, 300)
      } catch {}
    }
  } catch {}
  return undefined
}

function formatWait(ms: number): string {
  const seconds = Math.round(ms / 1000)
  return seconds < 90 ? `${seconds}s` : `${Math.round(seconds / 60)}m`
}

async function reportFailure(name: string, agent: Agent): Promise<void> {
  rmSync(join(FAILED_DIR, name), { force: true })
  const watch = statusWatches.get(name)
  statusWatches.delete(name)
  if (watch) await clearStatus(watch)
  const room = watch?.room ?? bindings[name]
  if (!room) return
  const reason = lastApiError(agent) ?? 'Claude stopped with an API error.'
  const channel = await client.channels.fetch(room).catch(() => null)
  if (!channel?.isTextBased() || !('send' in channel)) return
  const notice = await channel.send({
    content: `❌ \`${name}\` stopped: ${reason}\nSend your message again to retry.`,
    allowedMentions: { parse: [] },
  }).catch(() => null)
  if (notice) failureNotices.set(name, notice as Message)
}

function updateStatuses(): void {
  const now = Date.now()
  for (const [name, agent] of agents) {
    if (existsSync(join(FAILED_DIR, name))) void reportFailure(name, agent)
  }
  for (const [name, watch] of statusWatches) {
    const agent = agents.get(name)
    if (!agent || !isBusy(name)) {
      statusWatches.delete(name)
      void clearStatus(watch)
      continue
    }
    const session = currentSession(name)
    let mtime: number | undefined
    if (session) {
      try { mtime = statSync(transcriptPath(agent, session)).mtimeMs } catch {}
    }
    if (mtime !== watch.transcriptMtime) {
      const firstReading = watch.transcriptMtime === undefined
      watch.transcriptMtime = mtime
      if (!firstReading) {
        watch.lastProgress = now
        if (watch.text?.startsWith('⏳') || watch.text?.startsWith('⚠️')) void clearStatus(watch)
      }
    }
    const waitingOnUser = [...pendingPermissions.keys()].some(key => key.startsWith(`${name}:`))
    const quiet = now - watch.lastProgress
    if (waitingOnUser) {
      if (watch.message) void showStatus(watch, `🙋 \`${name}\` is waiting for your answer on the permission prompt.`, true)
    } else if (quiet >= STATUS_STUCK_MS) {
      void showStatus(watch, `⚠️ \`${name}\` has been quiet for ${formatWait(quiet)}. It may be stuck. Check it with \`bin/rooms attach ${name}\`.`, false)
    } else if (quiet >= STATUS_AFTER_MS) {
      void showStatus(watch, `⏳ \`${name}\` is still running, quiet for ${formatWait(quiet)}. Slow API or a long task.`, false)
    }
  }
}
setInterval(updateStatuses, Math.min(1000, Math.max(100, STATUS_AFTER_MS / 2))).unref()

async function runQueuedCommand(name: string, queued: QueuedCommand): Promise<void> {
  queued.running = true
  if (!(await paneReady(name))) {
    queued.running = false
    queued.idleAt = 0
    return
  }
  const before = currentSession(name)
  const alreadyLoaded = queued.command === `/resume ${before}`
  let switched = alreadyLoaded
  if (!alreadyLoaded) {
    try {
      await sendToPane(name, queued.command)
      switched = await waitForSwitch(name, queued.command, before)
    } catch (err) {
      process.stderr.write(`broker: ${queued.command} failed for ${name}: ${err}\n`)
    }
  }
  if (!switched) {
    // Unlocking keeps this room's messages out of whichever conversation is still loaded.
    queuedCommands.delete(name)
    if (bindings[name] === queued.room) {
      delete bindings[name]
      saveBindings(bindings)
    }
    await notifyRoom(queued.room, `\`${name}\` could not run \`${queued.command}\`, so it was unlocked from this room. ${queued.held.length} waiting message(s) were not delivered.`)
    return
  }
  if (queued.command === '/clear') forgetRoomSession(queued.room)
  else if (queued.command !== '/compact') rememberRoomSession(queued.room, queued.command.slice('/resume '.length))
  await new Promise(resolve => setTimeout(resolve, COMMAND_SETTLE_MS))
  if (queued.next) {
    queuedCommands.set(name, { command: queued.next, room: queued.room, held: queued.held, idleAt: 0, running: false })
    return
  }
  queuedCommands.delete(name)
  const agent = agents.get(name)
  if (!agent) return
  for (const frame of queued.held) deliver(name, agent, frame, queued.room)
}

/** Esc skips the Stop hook. The marker counts only directly above the input box, where a live spinner would sit. */
async function wasInterrupted(name: string): Promise<boolean> {
  const stdout = await paneRequest(name, 'capture')
  const lines = stdout.split('\n')
  let index = lines.findLastIndex(line => line.trimStart().startsWith('❯'))
  while (--index >= 0) {
    const line = lines[index]!.trim()
    if (line && !/^[─━-]+$/.test(line)) return /\bInterrupted\b/.test(line)
  }
  return false
}

async function clearIfInterrupted(name: string, queued: QueuedCommand): Promise<void> {
  const interrupted = await wasInterrupted(name).catch(() => false)
  queued.interruptedHits = interrupted ? (queued.interruptedHits ?? 0) + 1 : 0
  if (queued.interruptedHits >= 2) rmSync(busyFile(name), { force: true })
}

function processQueuedCommands(): void {
  const now = Date.now()
  for (const [name, queued] of queuedCommands) {
    if (queued.running) continue
    if (!agents.has(name)) {
      queuedCommands.delete(name)
      void notifyRoom(queued.room, `\`${name}\` went offline, so \`${queued.command}\` was cancelled.`)
    } else if (isBusy(name)) {
      queued.idleAt = 0
      if (now - (queued.lastPaneCheck ?? 0) >= 1000) {
        queued.lastPaneCheck = now
        void clearIfInterrupted(name, queued)
      }
    } else if (!queued.idleAt) {
      queued.idleAt = now
    } else if (now - queued.idleAt >= IDLE_SETTLE_MS) {
      void runQueuedCommand(name, queued)
    }
  }
}
setInterval(processQueuedCommands, 250).unref()

function assertSendable(f: string): void {
  let real: string
  let stateReal: string
  try {
    real = realpathSync(f)
    stateReal = realpathSync(STATE_DIR)
  } catch { return }
  const inbox = join(stateReal, 'inbox')
  if (real.startsWith(stateReal + sep) && !real.startsWith(inbox + sep)) {
    throw new Error(`refusing to send channel state: ${f}`)
  }
}

function chunk(text: string, limit: number, mode: 'length' | 'newline'): string[] {
  if (text.length <= limit) return [text]
  const out: string[] = []
  let rest = text
  while (rest.length > limit) {
    let cut = limit
    if (mode === 'newline') {
      const para = rest.lastIndexOf('\n\n', limit)
      const line = rest.lastIndexOf('\n', limit)
      const space = rest.lastIndexOf(' ', limit)
      cut = para > limit / 2 ? para : line > limit / 2 ? line : space > 0 ? space : limit
    }
    out.push(rest.slice(0, cut))
    rest = rest.slice(cut).replace(/^\n+/, '')
  }
  if (rest) out.push(rest)
  return out
}

function safeAttName(att: Attachment): string {
  return (att.name ?? att.id).replace(/[\[\]\r\n;]/g, '_')
}

async function downloadAttachment(att: Attachment): Promise<string> {
  if (att.size > MAX_ATTACHMENT_BYTES) {
    throw new Error(`attachment too large: ${(att.size / 1024 / 1024).toFixed(1)}MB, max 25MB`)
  }
  const res = await fetch(att.url)
  const buf = Buffer.from(await res.arrayBuffer())
  const name = att.name ?? att.id
  const rawExt = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : 'bin'
  const ext = rawExt.replace(/[^a-zA-Z0-9]/g, '') || 'bin'
  const path = join(INBOX_DIR, `${Date.now()}-${att.id}.${ext}`)
  mkdirSync(INBOX_DIR, { recursive: true })
  writeFileSync(path, buf)
  return path
}

/** Every tool targets the agent's bound room, regardless of any model-supplied chat_id. */
async function boundRoom(agent: string) {
  const id = bindings[agent]
  if (!id) throw new Error('this agent is not locked to a room, ask the user to run /use-agent in Discord')
  const ch = await client.channels.fetch(id)
  if (!ch || !ch.isTextBased()) throw new Error(`room ${id} not found or not text-based`)
  return ch
}

function text(value: string): ToolResult {
  return { content: [{ type: 'text', text: value }] }
}

async function runTool(agent: string, tool: string, args: Record<string, unknown>): Promise<ToolResult> {
  try {
    const ch = await boundRoom(agent)
    switch (tool) {
      case 'reply':
      case 'send_file': {
        if (!('send' in ch)) throw new Error('channel is not sendable')
        const body = (args.text as string | undefined) ?? ''
        const reply_to = args.reply_to as string | undefined
        const files = (args.files as string[] | undefined) ?? []
        // reply is auto-approved, so it must never be able to upload local files.
        if (tool === 'reply' && files.length > 0) throw new Error('reply cannot attach files, use send_file')
        if (tool === 'send_file' && files.length === 0) throw new Error('send_file needs at least one file')
        if (files.length > 10) throw new Error('Discord allows max 10 attachments per message')
        for (const f of files) {
          assertSendable(f)
          const st = statSync(f)
          if (st.size > MAX_ATTACHMENT_BYTES) {
            throw new Error(`file too large: ${f} (${(st.size / 1024 / 1024).toFixed(1)}MB, max 25MB)`)
          }
        }
        const access = loadAccess()
        const limit = Math.max(1, Math.min(access.textChunkLimit ?? MAX_CHUNK_LIMIT, MAX_CHUNK_LIMIT))
        const replyMode = access.replyToMode ?? 'first'
        const chunks = chunk(body, limit, access.chunkMode ?? 'length')
        const sentIds: string[] = []
        try {
          for (let i = 0; i < chunks.length; i++) {
            const quote = reply_to != null && replyMode !== 'off' && (replyMode === 'all' || i === 0)
            const sent = await ch.send({
              content: chunks[i],
              ...(i === 0 && files.length > 0 ? { files } : {}),
              ...(quote ? { reply: { messageReference: reply_to!, failIfNotExists: false } } : {}),
            })
            sentIds.push(sent.id)
          }
        } catch (err) {
          throw new Error(`reply failed after ${sentIds.length} of ${chunks.length} chunk(s) sent: ${(err as Error).message}`)
        }
        const watch = statusWatches.get(agent)
        if (watch) {
          watch.lastProgress = Date.now()
          await clearStatus(watch)
        }
        return text(sentIds.length === 1 ? `sent (id: ${sentIds[0]})` : `sent ${sentIds.length} parts (ids: ${sentIds.join(', ')})`)
      }
      case 'fetch_messages': {
        const limit = Math.min((args.limit as number) ?? 20, 100)
        const msgs = await ch.messages.fetch({ limit })
        const me = client.user?.id
        const arr = [...msgs.values()].reverse()
        if (arr.length === 0) return text('(no messages)')
        return text(arr.map(m => {
          const who = m.author.id === me ? 'me' : m.author.username
          const atts = m.attachments.size > 0 ? ` +${m.attachments.size}att` : ''
          const body = m.content.replace(/[\r\n]+/g, ' ⏎ ')
          return `[${m.createdAt.toISOString()}] ${who}: ${body}  (id: ${m.id}${atts})`
        }).join('\n'))
      }
      case 'react': {
        const msg = await ch.messages.fetch(args.message_id as string)
        await msg.react(args.emoji as string)
        return text('reacted')
      }
      case 'list_emojis': {
        const emojis: Emoji[] = []
        const failed: string[] = []
        if ('guild' in ch && ch.guild) {
          try {
            const myRoles = ch.guild.members.me?.roles.cache
            for (const e of (await ch.guild.emojis.fetch()).values()) {
              if (e.available === false) continue
              if (e.roles.cache.size > 0 && !e.roles.cache.some(r => myRoles?.has(r.id) ?? false)) continue
              emojis.push(e)
            }
          } catch (err) {
            failed.push(`server ${ch.guild.id} (${(err as Error).message})`)
          }
        }
        try {
          if (!client.application) throw new Error('bot not connected yet')
          emojis.push(...(await client.application.emojis.fetch()).values())
        } catch (err) {
          failed.push(`the application (${(err as Error).message})`)
        }
        const query = ((args.query as string | undefined) ?? '').replaceAll(':', '').toLowerCase()
        const matches = emojis.filter(e => e.name?.toLowerCase().includes(query))
        const lines = matches.slice(0, MAX_EMOJIS_LISTED).map(e => `<${e.animated ? 'a' : ''}:${e.name}:${e.id}>`)
        if (matches.length === 0) lines.push(query ? `(no custom emoji match "${query}")` : '(no custom emoji found)')
        if (matches.length > MAX_EMOJIS_LISTED) lines.push(`(showing ${MAX_EMOJIS_LISTED} of ${matches.length}, pass query to narrow)`)
        if (failed.length > 0) lines.push(`(partial list, could not fetch emoji of ${failed.join(', ')})`)
        return text(lines.join('\n'))
      }
      case 'edit_message': {
        const msg = await ch.messages.fetch(args.message_id as string)
        const edited = await msg.edit(args.text as string)
        return text(`edited (id: ${edited.id})`)
      }
      case 'download_attachment': {
        const msg = await ch.messages.fetch(args.message_id as string)
        if (msg.attachments.size === 0) return text('message has no attachments')
        const lines: string[] = []
        for (const att of msg.attachments.values()) {
          const path = await downloadAttachment(att)
          lines.push(`  ${path}  (${safeAttName(att)}, ${att.contentType ?? 'unknown'}, ${(att.size / 1024).toFixed(0)}KB)`)
        }
        return text(`downloaded ${lines.length} attachment(s):\n${lines.join('\n')}`)
      }
      case 'create_thread': {
        if (ch.isThread()) throw new Error('this room is already a thread')
        if (ch.type !== ChannelType.GuildText && ch.type !== ChannelType.GuildAnnouncement) {
          throw new Error('threads need a server text or announcement channel')
        }
        const thread = await ch.threads.create({
          name: args.name as string,
          startMessage: args.message_id as string | undefined,
        })
        return text(`thread created (id: ${thread.id}). You stay in the current room until the user runs /use-agent inside the thread.`)
      }
      default:
        return { content: [{ type: 'text', text: `unknown tool: ${tool}` }], isError: true }
    }
  } catch (err) {
    return { content: [{ type: 'text', text: `${tool} failed: ${(err as Error).message}` }], isError: true }
  }
}

function permissionRow(agent: string, requestId: string, includeMore: boolean) {
  const row = new ActionRowBuilder<ButtonBuilder>()
  if (includeMore) {
    row.addComponents(new ButtonBuilder().setCustomId(`perm:more:${agent}:${requestId}`).setLabel('See more').setStyle(ButtonStyle.Secondary))
  }
  return row.addComponents(
    new ButtonBuilder().setCustomId(`perm:allow:${agent}:${requestId}`).setLabel('Allow').setEmoji('✅').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`perm:deny:${agent}:${requestId}`).setLabel('Deny').setEmoji('❌').setStyle(ButtonStyle.Danger),
  )
}

async function onPermissionRequest(agent: string, p: Omit<PermissionDetails, 'createdAt'> & { request_id: string }): Promise<void> {
  pendingPermissions.set(`${agent}:${p.request_id}`, {
    tool_name: p.tool_name,
    description: p.description,
    input_preview: p.input_preview,
    createdAt: Date.now(),
  })
  // The room shows only the tool name. Tool input stays in the private See more popup.
  const room = bindings[agent]
  if (!room) return
  try {
    const channel = await client.channels.fetch(room)
    if (!channel?.isTextBased() || !('send' in channel)) throw new Error('room is not sendable')
    await channel.send({ content: `🔐 ${agent}: ${p.tool_name}`, components: [permissionRow(agent, p.request_id, true)] })
  } catch (err) {
    process.stderr.write(`broker: permission prompt to room ${room} failed: ${err}\n`)
  }
}

function answerPermission(agent: string, request_id: string, behavior: 'allow' | 'deny'): boolean {
  const target = agents.get(agent)
  if (!target) return false
  send(target.sock, { t: 'perm', request_id, behavior })
  pendingPermissions.delete(`${agent}:${request_id}`)
  return true
}

function prune(access: Access): void {
  const now = Date.now()
  let changed = false
  for (const [code, p] of Object.entries(access.pending)) {
    if (p.expiresAt < now) {
      delete access.pending[code]
      changed = true
    }
  }
  if (changed) saveAccess(access)
}

async function handlePairing(msg: Message, access: Access): Promise<void> {
  if (access.dmPolicy !== 'pairing') return
  let code = Object.entries(access.pending).find(([, p]) => p.senderId === msg.author.id)?.[0]
  let lead = 'Still pending'
  if (code) {
    const entry = access.pending[code]!
    if (entry.replies >= 2) return
    entry.replies++
  } else {
    if (Object.keys(access.pending).length >= 3) return
    code = randomBytes(3).toString('hex')
    const now = Date.now()
    access.pending[code] = { senderId: msg.author.id, chatId: msg.channelId, createdAt: now, expiresAt: now + 60 * 60 * 1000, replies: 1 }
    lead = 'Pairing required'
  }
  saveAccess(access)
  await msg.reply(`${lead}. In Claude Code, run:\n\n\`/pair ${code}\``)
}

async function handleInbound(msg: Message): Promise<void> {
  const access = loadAccess()
  prune(access)
  if (access.dmPolicy === 'disabled') return

  const isDM = msg.channel.type === ChannelType.DM
  if (!access.allowFrom.includes(msg.author.id)) {
    if (isDM) await handlePairing(msg, access)
    return
  }

  // Exact room match. Threads deliberately do not inherit their parent's agent.
  const name = agentForRoom(msg.channelId)
  if (!name) {
    if (isDM) await msg.reply('No agent locked here. Run `/use-agent` to pick one.')
    return
  }
  const agent = agents.get(name)
  if (!agent) {
    await msg.reply(`Agent \`${name}\` is offline.`)
    return
  }

  const permission = PERMISSION_REPLY_RE.exec(msg.content)
  if (permission) {
    const allow = permission[1]!.toLowerCase().startsWith('y')
    answerPermission(name, permission[2]!.toLowerCase(), allow ? 'allow' : 'deny')
    void msg.react(allow ? '✅' : '❌').catch(() => {})
    return
  }

  if ('sendTyping' in msg.channel) void msg.channel.sendTyping().catch(() => {})
  if (access.ackReaction) void msg.react(access.ackReaction).catch(() => {})

  const atts = [...msg.attachments.values()].map(att => `${safeAttName(att)} (${att.contentType ?? 'unknown'}, ${(att.size / 1024).toFixed(0)}KB)`)
  const frame = {
    t: 'inbound',
    content: msg.content || (atts.length > 0 ? '(attachment)' : ''),
    meta: {
      chat_id: msg.channelId,
      message_id: msg.id,
      user: msg.author.username,
      user_id: msg.author.id,
      ts: msg.createdAt.toISOString(),
      ...(atts.length > 0 ? { attachment_count: String(atts.length), attachments: atts.join('; ') } : {}),
    },
  }
  // Messages wait until a queued conversation switch has finished.
  syncRoomSession(name)
  const queued = queuedCommands.get(name)
  if (queued) {
    queued.held.push(frame)
    return
  }
  deliver(name, agent, frame, msg.channelId)
}

function shortSession(name: string): string {
  try {
    return readFileSync(join(SESSIONS_DIR, name), 'utf8').trim().slice(0, 8) || 'unknown'
  } catch {
    return 'unknown'
  }
}

function agentStatus(name: string): string {
  if (queuedCommands.has(name)) return 'queued'
  return isBusy(name) ? 'busy' : 'idle'
}

function shortFolder(path: string): string {
  return path.split('/').filter(Boolean).slice(-2).join('/') || path
}

function roomLabel(name: string, here: string): string {
  const room = bindings[name]
  if (!room) return 'free'
  if (room === here) return 'this room'
  const channel = client.channels.cache.get(room)
  return channel && 'name' in channel && channel.name ? `#${channel.name}` : 'another room'
}

function describeAgent(agent: Agent, here: string): string {
  const room = bindings[agent.name]
  const where = room === here ? 'this room' : room ? `<#${room}>` : 'free'
  return `\`${agent.name}\` · ${agentStatus(agent.name)} · ${where}\n-# folder \`${agent.cwd}\` · session \`${shortSession(agent.name)}\``
}

function describeAgents(here: string): string {
  if (agents.size === 0) return 'No agents running. Start one on the host with `bin/rooms agent <name> [dir]`.'
  return [...agents.values()]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(agent => describeAgent(agent, here))
    .join('\n')
    .slice(0, MAX_CHUNK_LIMIT)
}

async function useAgent(i: ChatInputCommandInteraction): Promise<string> {
  const name = i.options.getString('agent')
  if (!name) return describeAgents(i.channelId)
  const agent = agents.get(name)
  if (!agent) return `Agent \`${name}\` is not running.`

  const room = i.channelId
  const current = agentForRoom(room)
  if (current && current !== name) return `This room is locked to \`${current}\`. Run \`/rem-agent\` first.`
  syncRoomSession(name)
  if (queuedCommands.has(name)) return `\`${name}\` is still switching conversations. Try again when it finishes.`

  const previous = bindings[name]
  const active = currentSession(name)
  let saved = roomSessions[room]
  if (agent.control && saved && !existsSync(transcriptPath(agent, saved))) {
    return `This room's saved conversation belongs to another folder, not \`${agent.cwd}\`. Use the matching agent, or lock this agent elsewhere.`
  }
  const holder = agent.control && saved ? agentHolding(saved, name) : undefined
  if (holder) return `This room's conversation is open in \`${holder}\`. Use that agent here, or switch it first.`

  bindings[name] = room
  saveBindings(bindings)

  const channel = await client.channels.fetch(room).catch(() => null)
  if (channel?.isThread() && !channel.joined && channel.joinable) await channel.join().catch(() => {})
  if (previous && previous !== room) {
    const old = await client.channels.fetch(previous).catch(() => null)
    if (old?.isTextBased() && 'send' in old) await old.send(`\`${name}\` moved to <#${room}>.`).catch(() => {})
  }

  let state = 'continuing this room\'s conversation'
  if (!agent.control) {
    state = 'using the conversation open in its window'
  } else if (saved && saved !== active) {
    queueCommand(name, `/resume ${saved}`, room)
    state = `loading this room's conversation \`${saved.slice(0, 8)}\``
  } else if (!saved && active && sessionHasChat(agent, active) && previous !== room) {
    queueCommand(name, '/clear', room)
    state = 'starting a new conversation'
  } else if (!saved) {
    state = 'new conversation'
  }
  return `Locked \`${name}\` to this room, ${state}.\n-# folder \`${agent.cwd}\``
}

async function sessionCommand(i: ChatInputCommandInteraction, command: SessionCommand): Promise<string> {
  const name = agentForRoom(i.channelId)
  if (!name) return 'No agent locked to this room.'
  const target = agents.get(name)
  if (!target) return `Agent \`${name}\` is offline.`
  if (!target.control) return `\`${name}\` runs as a plugin, so Discord cannot type into it. Type \`${command}\` in its terminal window.`
  const busy = isBusy(name)
  queueCommand(name, command, i.channelId)
  return busy
    ? `Queued \`${command}\` for \`${name}\`. It runs after the current turn, and new messages wait until then.`
    : `Sent \`${command}\` to \`${name}\`.`
}

async function onCommand(i: ChatInputCommandInteraction): Promise<void> {
  if (!COMMANDS.some(c => c.name === i.commandName)) return
  if (!loadAccess().allowFrom.includes(i.user.id)) {
    await i.reply({ content: 'Not verified. DM this bot to start pairing.', ephemeral: true })
    return
  }
  await i.deferReply({ ephemeral: true })
  let result: string
  try {
    switch (i.commandName) {
      case 'use-agent':
        result = await useAgent(i)
        break
      case 'rem-agent': {
        const name = agentForRoom(i.channelId)
        if (name && queuedCommands.has(name)) {
          result = `\`${name}\` is still switching conversations. Try again when it finishes.`
          break
        }
        if (name) unbindRoom(i.channelId)
        result = name ? `Unlocked \`${name}\`. It is still running.` : 'No agent locked to this room.'
        break
      }
      case 'new':
        result = await sessionCommand(i, '/clear')
        break
      default:
        result = await sessionCommand(i, '/compact')
    }
  } catch (err) {
    result = `Failed: ${(err as Error).message}`
  }
  await i.editReply(result)
}

async function onAutocomplete(i: AutocompleteInteraction): Promise<void> {
  if (i.commandName !== 'use-agent' || !loadAccess().allowFrom.includes(i.user.id)) {
    await i.respond([])
    return
  }
  const query = i.options.getFocused().toLowerCase()
  const choices = [...agents.values()]
    .filter(agent => agent.name.includes(query) || agent.cwd.toLowerCase().includes(query))
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, 25)
    .map(agent => ({
      name: `${agent.name} · ${agentStatus(agent.name)} · ${roomLabel(agent.name, i.channelId)} · ${shortFolder(agent.cwd)}`.slice(0, 100),
      value: agent.name,
    }))
  await i.respond(choices)
}

async function onPermissionButton(i: Interaction): Promise<void> {
  if (!i.isButton()) return
  const m = PERMISSION_BUTTON_RE.exec(i.customId)
  if (!m) return
  if (!loadAccess().allowFrom.includes(i.user.id)) {
    await i.reply({ content: 'Not authorized.', ephemeral: true })
    return
  }
  const [, behavior, agent, requestId] = m as unknown as [string, 'allow' | 'deny' | 'more', string, string]
  const d = pendingPermissions.get(`${agent}:${requestId}`)
  if (!d) {
    await i.reply({ content: 'This permission request is no longer pending.', ephemeral: true })
    return
  }
  if (behavior === 'more') {
    let input = d.input_preview
    try { input = JSON.stringify(JSON.parse(input), null, 2) } catch {}
    const content = `🔐 ${agent}: ${d.tool_name}\n\ndescription: ${d.description}\ninput_preview:\n${input}`.slice(0, MAX_CHUNK_LIMIT)
    await i.reply({ content, ephemeral: true })
    return
  }
  if (!answerPermission(agent, requestId, behavior)) {
    await i.reply({ content: `Agent \`${agent}\` is offline.`, ephemeral: true })
    return
  }
  const label = behavior === 'allow' ? '✅ Allowed' : '❌ Denied'
  await i.update({ content: `${i.message.content}\n\n${label}`.slice(0, MAX_CHUNK_LIMIT), components: [] })
}

function onFrame(sock: BusSocket, current: Agent | null, frame: any): Agent | null {
  if (frame.t === 'hello') {
    if (current) return current
    const control = frame.control !== false
    let name = String(frame.name ?? '')
    if (!name) {
      for (let n = 1; !name; n++) if (!agents.has(`ag${n}`)) name = `ag${n}`
    }
    if (!AGENT_NAME_RE.test(name)) {
      send(sock, { t: 'hello_err', error: `invalid agent name: ${name}` })
      return null
    }
    if (agents.has(name)) {
      send(sock, { t: 'hello_err', error: `agent ${name} is already connected` })
      return null
    }
    const agent: Agent = { name, cwd: String(frame.cwd ?? ''), pid: Number(frame.pid ?? 0), sock, control }
    agents.set(name, agent)
    send(sock, { t: 'hello_ok', name })
    process.stderr.write(`broker: agent connected: ${name}\n`)
    return agent
  }
  if (!current) return null
  if (frame.t === 'tmux_result') {
    const call = paneCalls.get(frame.id)
    if (call) {
      paneCalls.delete(frame.id)
      clearTimeout(call.timer)
      if (frame.ok) call.resolve(String(frame.stdout ?? ''))
      else call.reject(new Error(String(frame.error ?? 'pane request failed')))
    }
  } else if (frame.t === 'call') {
    const id = frame.id
    void runTool(current.name, String(frame.tool), (frame.args ?? {}) as Record<string, unknown>)
      .then(result => send(sock, { t: 'result', id, result }))
  } else if (frame.t === 'perm_req') {
    void onPermissionRequest(current.name, frame.params)
  }
  return current
}

if (brokerRunning(BUS_DIR)) {
  process.stderr.write('broker: another broker is already running\n')
  process.exit(1)
}

const server = serveBus(BUS_DIR, sock => {
  let agent: Agent | null = null
  let buffer = ''
  sock.setEncoding('utf8')
  sock.on('data', chunkText => {
    buffer += chunkText
    let newline: number
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      if (!line) continue
      try {
        agent = onFrame(sock, agent, JSON.parse(line))
      } catch (err) {
        process.stderr.write(`broker: bad frame: ${err}\n`)
      }
    }
  })
  sock.on('error', () => {})
  sock.on('close', () => {
    if (agent && agents.get(agent.name) === agent) {
      agents.delete(agent.name)
      process.stderr.write(`broker: agent disconnected: ${agent.name}\n`)
    }
  })
})

function checkApprovals(): void {
  let files: string[]
  try { files = readdirSync(APPROVED_DIR) } catch { return }
  for (const senderId of files) {
    const file = join(APPROVED_DIR, senderId)
    const dmChannelId = readFileSync(file, 'utf8').trim()
    rmSync(file, { force: true })
    if (!dmChannelId) continue
    void client.channels.fetch(dmChannelId)
      .then(async ch => {
        if (ch?.isTextBased() && 'send' in ch) await ch.send('Verified. Run `/use-agent` in any room or thread.')
      })
      .catch(err => process.stderr.write(`broker: approval confirm failed: ${err}\n`))
  }
}
setInterval(checkApprovals, 5000).unref()

client.on('error', err => process.stderr.write(`broker: client error: ${err}\n`))
client.on('messageCreate', msg => {
  if (msg.author.bot || msg.type === MessageType.ThreadStarterMessage) return
  handleInbound(msg).catch(err => process.stderr.write(`broker: inbound failed: ${err}\n`))
})
client.on('interactionCreate', interaction => {
  const task = interaction.isChatInputCommand()
    ? onCommand(interaction)
    : interaction.isAutocomplete()
      ? onAutocomplete(interaction)
      : onPermissionButton(interaction)
  task.catch(err => process.stderr.write(`broker: interaction failed: ${err}\n`))
})
client.on('channelDelete', channel => {
  unbindRoom(channel.id)
  forgetRoomSession(channel.id)
})
client.on('threadDelete', thread => {
  unbindRoom(thread.id)
  forgetRoomSession(thread.id)
})
client.on('threadUpdate', (_old, thread) => {
  if (thread.locked) unbindRoom(thread.id)
})
client.once('ready', async c => {
  process.stderr.write(`broker: connected as ${c.user.tag}\n`)
  await c.application.commands.set(COMMANDS)
})

function shutdown(): void {
  server.close()
  setTimeout(() => process.exit(0), 2000)
  void Promise.resolve(client.destroy()).finally(() => process.exit(0))
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
process.on('SIGHUP', shutdown)

// A broker hosted by a window must not outlive it, or the next window could not take over.
const hostPid = Number(process.env.DISCORD_BROKER_PARENT ?? 0)
if (hostPid) {
  setInterval(() => {
    if (process.ppid !== hostPid) shutdown()
  }, 1000).unref()
}

client.login(TOKEN).catch(err => {
  process.stderr.write(`broker: login failed: ${err}\n`)
  process.exit(1)
})
