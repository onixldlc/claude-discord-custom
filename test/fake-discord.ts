/** Bun preload replacing discord.js with an in-process fake driven over a Unix socket. */

import { EventEmitter } from 'events'
import { rmSync } from 'fs'

const CTRL = process.env.FAKE_DISCORD_CTRL!
const log: any[] = []
let seq = 1000
const nextId = () => String(++seq)

class Chain {
  data: Record<string, unknown> = {}
  components: unknown[] = []
  setCustomId(v: string) { this.data.customId = v; return this }
  setLabel(v: string) { this.data.label = v; return this }
  setEmoji(v: string) { this.data.emoji = v; return this }
  setStyle(v: unknown) { this.data.style = v; return this }
  addComponents(...items: unknown[]) { this.components.push(...items); return this }
}

const ChannelType = { GuildText: 0, DM: 1, GuildAnnouncement: 5, PublicThread: 11 }
const MessageType = { Default: 0, ThreadStarterMessage: 21 }

function customIds(payload: any): string[] {
  return (payload?.components ?? []).flatMap((row: any) => row.components.map((b: any) => b.data.customId))
}

function makeChannel(id: string): any {
  const type = id.startsWith('dm-') ? ChannelType.DM : id.startsWith('t-') ? ChannelType.PublicThread : ChannelType.GuildText
  const channel: any = {
    id,
    type,
    joined: false,
    joinable: true,
    locked: false,
    parentId: type === ChannelType.PublicThread ? 'c-parent' : null,
    isTextBased: () => true,
    isThread: () => type === ChannelType.PublicThread,
    join: async () => { channel.joined = true; log.push({ kind: 'join', room: id }) },
    sendTyping: async () => {},
    send: async (payload: any) => {
      const body = typeof payload === 'string' ? { content: payload } : payload
      const sentId = nextId()
      const sent = {
        id: sentId,
        edit: async (p: any) => { log.push({ kind: 'edit', room: id, message: sentId, text: p.content ?? p }); return sent },
        delete: async () => { log.push({ kind: 'delete', room: id, message: sentId }) },
      }
      log.push({ kind: 'send', room: id, content: body.content, id: sent.id, buttons: customIds(body) })
      return sent
    },
    messages: {
      fetch: async (arg: any) => {
        if (typeof arg === 'string') {
          return { id: arg, attachments: new Map(), react: async (e: string) => { log.push({ kind: 'react', room: id, message: arg, emoji: e }) } , edit: async (t: string) => { log.push({ kind: 'edit', room: id, message: arg, text: t }); return { id: arg } } }
        }
        return new Map()
      },
    },
  }
  return channel
}

const channels = new Map<string, any>()
const channelFor = (id: string) => {
  if (!channels.has(id)) channels.set(id, makeChannel(id))
  return channels.get(id)
}

let instance: any = null

class Client extends EventEmitter {
  user = { id: 'bot', tag: 'fake-bot#0000' }
  application = {
    commands: { set: async (c: any[]) => { log.push({ kind: 'commands', names: c.map(x => x.name) }) } },
    emojis: { fetch: async () => new Map() },
  }
  channels = { cache: channels, fetch: async (id: string) => channelFor(id) }
  users = {
    fetch: async (id: string) => ({
      id,
      send: async (payload: any) => { log.push({ kind: 'dm', user: id, content: payload.content, buttons: customIds(payload) }) },
    }),
  }
  constructor(_opts: unknown) { super(); instance = this }
  async login(_token: string) { setTimeout(() => this.emit('ready', this), 5); return 'ok' }
  destroy() {}
}

function baseInteraction(user: string, room: string) {
  return {
    user: { id: user },
    channelId: room,
    isChatInputCommand: () => false,
    isAutocomplete: () => false,
    isButton: () => false,
  }
}

async function dispatch(op: any): Promise<unknown> {
  switch (op.op) {
    case 'log': return log
    case 'message': {
      const channel = channelFor(op.room)
      const id = nextId()
      instance.emit('messageCreate', {
        id,
        type: MessageType.Default,
        content: op.content,
        channel,
        channelId: op.room,
        author: { id: op.user, username: `u${op.user}`, bot: false },
        attachments: new Map(),
        createdAt: new Date(),
        reply: async (content: string) => { log.push({ kind: 'reply', room: op.room, content }) },
        react: async (emoji: string) => { log.push({ kind: 'react', room: op.room, message: id, emoji }) },
      })
      return { id }
    }
    case 'command': {
      const result: any = {}
      const opts = op.options ?? {}
      await new Promise<void>(resolve => {
        instance.emit('interactionCreate', {
          ...baseInteraction(op.user, op.room),
          isChatInputCommand: () => true,
          commandName: op.name,
          options: { getString: (k: string) => opts[k] ?? null, getBoolean: (k: string) => opts[k] ?? null },
          reply: async (p: any) => { result.text = p.content; result.ephemeral = p.ephemeral; resolve() },
          deferReply: async (p: any) => { result.ephemeral = p.ephemeral },
          editReply: async (t: string) => { result.text = t; resolve() },
        })
      })
      return result
    }
    case 'autocomplete': {
      return await new Promise(resolve => {
        instance.emit('interactionCreate', {
          ...baseInteraction(op.user, op.room),
          isAutocomplete: () => true,
          commandName: op.command ?? 'use-agent',
          options: { getFocused: () => op.query ?? '' },
          respond: async (r: unknown) => resolve(r),
        })
      })
    }
    case 'button': {
      return await new Promise(resolve => {
        instance.emit('interactionCreate', {
          ...baseInteraction(op.user, 'dm-perm'),
          isButton: () => true,
          customId: op.customId,
          message: { content: op.messageContent ?? 'prompt' },
          reply: async (p: any) => resolve({ reply: p.content, ephemeral: p.ephemeral }),
          update: async (p: any) => resolve({ update: p.content, buttons: customIds(p) }),
        })
      })
    }
    case 'threadDelete':
      instance.emit('threadDelete', { id: op.room })
      return {}
    case 'threadLock': {
      const thread = channelFor(op.room)
      thread.locked = true
      instance.emit('threadUpdate', thread, thread)
      return {}
    }
    case 'threadArchive': {
      const thread = channelFor(op.room)
      thread.archived = true
      instance.emit('threadUpdate', thread, thread)
      return {}
    }
    default:
      throw new Error(`unknown op ${op.op}`)
  }
}

rmSync(CTRL, { force: true })
Bun.serve({
  unix: CTRL,
  async fetch(req) {
    try {
      return Response.json((await dispatch(await req.json())) ?? {})
    } catch (err) {
      return Response.json({ error: String(err) }, { status: 500 })
    }
  },
})

const fake = {
  Client,
  ActionRowBuilder: Chain,
  ButtonBuilder: Chain,
  ChannelType,
  MessageType,
  GatewayIntentBits: { DirectMessages: 1, Guilds: 2, GuildMessages: 3, MessageContent: 4 },
  Partials: { Channel: 1 },
  ButtonStyle: { Secondary: 2, Success: 3, Danger: 4 },
  ApplicationCommandOptionType: { String: 3, Boolean: 5 },
}

Bun.plugin({
  name: 'fake-discord',
  setup(build) {
    build.module('discord.js', () => ({ exports: fake, loader: 'object' }))
  },
})
