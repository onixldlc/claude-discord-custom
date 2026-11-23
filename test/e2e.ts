#!/usr/bin/env bun
/** End-to-end test: real broker, shims, ctl, Unix socket, and tmux. Only Discord is faked. */

import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
import { join, resolve } from 'path'

const ROOT = resolve(import.meta.dir, '..')
const TEST_DIR = join(ROOT, '.test-state')
const STATE = join(TEST_DIR, 'state')
const CTRL = join(TEST_DIR, 'fake.sock')
const PATH = `${join(ROOT, '.local/bin')}:${process.env.PATH}`
const TMUX_DIR = join(TEST_DIR, 'tmux')
const ENV = { ...process.env, PATH, TMUX_TMPDIR: TMUX_DIR, DISCORD_STATE_DIR: STATE, DISCORD_SHARED_DIR: STATE, DISCORD_TMUX_COMMANDS: '1', DISCORD_BOT_TOKEN: 'fake', FAKE_DISCORD_CTRL: CTRL, CLAUDE_CONFIG_DIR: join(TEST_DIR, 'claude'), DISCORD_STATUS_AFTER_MS: '400' } as Record<string, string>
delete ENV.TMUX
const OWNER = '100000000000000001'
const STRANGER = '200000000000000002'

let passed = 0
const failures: string[] = []
function check(name: string, ok: unknown, detail?: unknown): void {
  if (ok) { passed++; console.log(`  pass  ${name}`) }
  else { failures.push(name); console.log(`  FAIL  ${name}${detail === undefined ? '' : ` :: ${JSON.stringify(detail)}`}`) }
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
async function until<T>(fn: () => Promise<T> | T, ms = 3000): Promise<T | undefined> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const v = await fn()
    if (v) return v
    await sleep(25)
  }
  return undefined
}

async function ctrl(body: unknown): Promise<any> {
  const res = await fetch('http://fake/', { unix: CTRL, method: 'POST', body: JSON.stringify(body) } as RequestInit)
  return res.json()
}
const say = (room: string, content: string, user = OWNER) => ctrl({ op: 'message', room, content, user })
const cmd = (room: string, name: string, options: Record<string, unknown> = {}, user = OWNER) => ctrl({ op: 'command', room, name, options, user })
const events = () => ctrl({ op: 'log' }) as Promise<any[]>

function ctl(...args: string[]): { code: number; out: string } {
  const p = Bun.spawnSync([process.execPath, join(ROOT, 'ctl.ts'), ...args], { env: ENV })
  return { code: p.exitCode ?? -1, out: p.stdout.toString() + p.stderr.toString() }
}
function tmux(...args: string[]): string {
  return Bun.spawnSync(['tmux', ...args], { env: ENV }).stdout.toString()
}

let broker: ReturnType<typeof Bun.spawn> | null = null
async function startBroker(): Promise<void> {
  rmSync(CTRL, { force: true })
  broker = Bun.spawn([process.execPath, '--preload', join(ROOT, 'test/fake-discord.ts'), join(ROOT, 'broker.ts')], {
    env: ENV, stdout: 'ignore', stderr: Bun.file(join(TEST_DIR, 'broker.log')),
  })
  const up = await until(async () => { try { await ctrl({ op: 'log' }); return statSync(join(STATE, 'bus', 'broker-alive')) } catch { return undefined } }, 5000)
  if (!up) throw new Error('broker did not start')
}
async function stopBroker(): Promise<void> {
  broker?.kill('SIGTERM')
  await broker?.exited
  broker = null
}

type TestAgent = { name: string; mcp: McpClient; inbox: any[]; perms: any[]; close: () => Promise<void> }
async function startAgent(name: string | null): Promise<TestAgent> {
  const env = { ...ENV }
  delete env.CC_AGENT_NAME
  if (name) env.CC_AGENT_NAME = name
  const cwd = join(TEST_DIR, 'agents', name ?? 'none')
  mkdirSync(cwd, { recursive: true })
  const transport = new StdioClientTransport({ command: process.execPath, args: [join(ROOT, 'server.ts')], env, cwd, stderr: 'ignore' })
  const mcp = new McpClient({ name: 'e2e', version: '1' }, { capabilities: {} })
  const agent: TestAgent = { name: name ?? '', mcp, inbox: [], perms: [], close: () => mcp.close() }
  mcp.fallbackNotificationHandler = async (n: any) => {
    if (n.method === 'notifications/claude/channel') agent.inbox.push(n.params)
    if (n.method === 'notifications/claude/channel/permission') agent.perms.push(n.params)
  }
  await mcp.connect(transport)
  return agent
}
const tool = (a: TestAgent, name: string, args: Record<string, unknown>) => a.mcp.callTool({ name, arguments: args }) as Promise<any>
const permReq = (a: TestAgent, request_id: string) => a.mcp.notification({
  method: 'notifications/claude/channel/permission_request' as any,
  params: { request_id, tool_name: 'Bash', description: `from ${a.name}`, input_preview: '{"command":"ls"}' } as any,
})
const setIdle = (name: string) => rmSync(join(STATE, 'busy', name), { force: true })
const setBusy = (name: string) => {
  mkdirSync(join(STATE, 'busy'), { recursive: true })
  writeFileSync(join(STATE, 'busy', name), '')
}
const running = async (name: string) => (await cmd('c-any', 'use-agent')).text?.includes(`\`${name}\``)

async function main(): Promise<void> {
  rmSync(TEST_DIR, { recursive: true, force: true })
  mkdirSync(STATE, { recursive: true, mode: 0o700 })
  mkdirSync(TMUX_DIR, { recursive: true, mode: 0o700 })
  mkdirSync(join(STATE, 'sessions'), { recursive: true })
  for (const name of ['alpha', 'beta']) {
    tmux('new-session', '-d', '-s', `cc-${name}`, '-x', '120', '-y', '30', `bash ${join(ROOT, 'test/fake-agent.sh')} ${join(STATE, 'sessions', name)}`)
  }
  const pane = (s: string) => tmux('capture-pane', '-p', '-t', `=${s}:`)
  await startBroker()

  console.log('\nglobal pairing')
  const registered = await until(async () => (await events()).find(e => e.kind === 'commands'))
  check('slash commands registered', registered?.names?.join() === 'use-agent,rem-agent,new,compact', registered)
  check('unverified slash command refused', (await cmd('t-1', 'use-agent', {}, STRANGER)).text?.includes('Not verified'))
  await say('dm-owner', 'hello')
  const pairMsg = await until(async () => (await events()).find(e => e.kind === 'reply' && e.room === 'dm-owner'))
  const code = /pair ([0-9a-f]{6})/.exec(pairMsg?.content ?? '')?.[1]
  check('DM returns pairing code', code, pairMsg)
  check('Discord message cannot approve itself', !JSON.parse(readFileSync(join(STATE, 'access.json'), 'utf8')).allowFrom.includes(OWNER))
  check('wrong code rejected', ctl('pair', 'ffffff').code !== 0)
  check('host ctl approves code', ctl('pair', code!).code === 0)
  check('pairing confirmation sent', await until(async () => (await events()).find(e => e.kind === 'send' && e.room === 'dm-owner' && e.content.includes('Verified')), 7000))
  check('state files private', (statSync(join(STATE, 'access.json')).mode & 0o077) === 0 && (statSync(join(STATE, 'bus', 'broker-alive')).mode & 0o077) === 0)

  console.log('\nagent discovery')
  const alpha = await startAgent('alpha')
  const beta = await startAgent('beta')
  const plain = await startAgent(null)
  check('agents listed', await until(async () => (await running('alpha')) && (await running('beta'))))
  check('plain session has no tools', (await plain.mcp.listTools()).tools.length === 0)
  check('agent has 8 tools', (await alpha.mcp.listTools()).tools.length === 8)
  check('list shows agent directory', (await cmd('c-any', 'use-agent')).text?.includes(join(TEST_DIR, 'agents', 'alpha')))
  const picker = await ctrl({ op: 'autocomplete', room: 't-1', user: OWNER, query: 'be' })
  check('picker filters and identifies agent', picker.length === 1 && picker[0].value === 'beta' && picker[0].name === 'beta · idle · free · agents/beta', picker)
  writeFileSync(join(STATE, 'sessions', 'alpha'), 'abcdef1234567890\n')
  check('list shows short session ID', (await cmd('c-any', 'use-agent')).text?.includes('session `abcdef12`'))
  check('stranger autocomplete empty', JSON.stringify(await ctrl({ op: 'autocomplete', room: 't-1', user: STRANGER, query: '' })) === '[]')
  const dup = await startAgent('alpha')
  await sleep(150)
  const dupResult = await tool(dup, 'reply', { chat_id: 'x', text: 'dup' })
  check('duplicate name refused', dupResult.isError, dupResult)
  await dup.close()

  console.log('\nrooms and threads')
  check('lock alpha to thread', (await cmd('t-1', 'use-agent', { agent: 'alpha' })).text?.includes('Locked'))
  check('bot joins thread', (await events()).some(e => e.kind === 'join' && e.room === 't-1'))
  check('lock beta to thread', (await cmd('t-2', 'use-agent', { agent: 'beta' })).text?.includes('Locked'))
  await say('t-1', 'for alpha')
  await say('t-2', 'for beta')
  check('alpha gets own message', await until(() => alpha.inbox.some(m => m.content === 'for alpha')))
  check('beta gets own message', await until(() => beta.inbox.some(m => m.content === 'for beta')))
  check('no cross-delivery', !alpha.inbox.some(m => m.content === 'for beta') && !beta.inbox.some(m => m.content === 'for alpha'))
  await say('c-parent', 'parent chatter')
  await say('t-unbound', 'unbound thread')
  await say('t-1', 'stranger text', STRANGER)
  await sleep(150)
  check('parent, unbound, stranger not delivered', ![...alpha.inbox, ...beta.inbox].some(m => ['parent chatter', 'unbound thread', 'stranger text'].includes(m.content)))
  check('occupied room refuses second agent', (await cmd('t-1', 'use-agent', { agent: 'beta' })).text?.includes('locked to'))

  const forged = await tool(alpha, 'reply', { chat_id: 't-2', text: 'forged target' })
  check('reply succeeds', !forged.isError, forged)
  const sent = (await events()).find(e => e.kind === 'send' && e.content === 'forged target')
  check('forged chat_id stays in bound room', sent?.room === 't-1', sent)

  console.log('\nmove and unlock')
  check('move alpha to t-3', (await cmd('t-3', 'use-agent', { agent: 'alpha' })).text?.includes('Locked'))
  check('old room gets moved notice', (await events()).some(e => e.kind === 'send' && e.room === 't-1' && e.content.includes('moved to')))
  await say('t-1', 'old room')
  await say('t-3', 'new room')
  check('new room delivers', await until(() => alpha.inbox.some(m => m.content === 'new room')))
  check('old room silent', !alpha.inbox.some(m => m.content === 'old room'))
  check('rem-agent unlocks', (await cmd('t-3', 'rem-agent')).text?.includes('still running'))
  check('unlocked agent still listed', await running('alpha'))
  check('unlocked agent cannot post', (await tool(alpha, 'reply', { chat_id: 't-3', text: 'x' })).isError)
  await cmd('t-3', 'use-agent', { agent: 'alpha' })

  console.log('\nroom sessions')
  const S1 = '11111111-1111-4111-8111-111111111111'
  const S2 = '22222222-2222-4222-8222-222222222222'
  const S3 = '33333333-3333-4333-8333-333333333333'
  const S4 = '44444444-4444-4444-8444-444444444444'
  const roomsNow = () => { try { return JSON.parse(readFileSync(join(STATE, 'room-sessions.json'), 'utf8')) } catch { return {} } }
  const sessionNow = (name: string) => readFileSync(join(STATE, 'sessions', name), 'utf8').trim()
  const transcriptFile = (name: string, id: string) => join(TEST_DIR, 'claude', 'projects', join(TEST_DIR, 'agents', name).replace(/[^a-zA-Z0-9]/g, '-'), `${id}.jsonl`)
  const chatIn = (name: string, id: string, title: string) => {
    const file = transcriptFile(name, id)
    mkdirSync(join(file, '..'), { recursive: true })
    writeFileSync(file, JSON.stringify({ type: 'user', isMeta: true, origin: { kind: 'channel' }, message: { content: `<channel source="discord-rooms">${title}</channel>` } }) + '\n')
    writeFileSync(join(STATE, 'sessions', name), `${id}\n`)
  }
  const settled = (name: string) => until(async () => !(await cmd('c-any', 'use-agent')).text?.includes(`\`${name}\` · queued`), 8000)
  setIdle('alpha')
  setIdle('beta')
  chatIn('alpha', S1, 'first topic')
  check('room saves its conversation', await until(() => roomsNow()['t-3'] === S1, 3000), roomsNow())
  check('/new reports sent', (await cmd('t-3', 'new')).text?.includes('/clear'))
  check('/clear reached alpha pane', await until(() => pane('cc-alpha').includes('/clear')))
  check('/new leaves new session', await until(() => sessionNow('alpha') !== S1))
  check('/new clears room default', await until(() => roomsNow()['t-3'] === undefined), roomsNow())
  check('/new keeps old transcript', statSync(transcriptFile('alpha', S1)).size > 0)
  check('beta pane untouched', !pane('cc-beta').includes('/clear'))
  await settled('alpha')
  await cmd('t-2', 'compact')
  check('/compact reached beta pane', await until(() => pane('cc-beta').includes('/compact')))
  check('alpha did not get /compact', !pane('cc-alpha').includes('/compact'))
  await settled('beta')
  chatIn('alpha', S2, 'second topic')
  await until(() => roomsNow()['t-3'] === S2)
  check('move to empty room starts fresh', (await cmd('t-4', 'use-agent', { agent: 'alpha' })).text?.includes('new conversation') && await until(() => sessionNow('alpha') !== S2), roomsNow())
  check('old room keeps its conversation', roomsNow()['t-3'] === S2, roomsNow())
  await settled('alpha')
  chatIn('alpha', S3, 'third topic')
  await until(() => roomsNow()['t-4'] === S3)
  check('return to room loads its conversation', (await cmd('t-3', 'use-agent', { agent: 'alpha' })).text?.includes('loading') && await until(() => sessionNow('alpha') === S2), roomsNow())
  check('other room keeps its conversation', roomsNow()['t-4'] === S3, roomsNow())
  await settled('alpha')
  check('Discord /resume is gone', (await events()).find(e => e.kind === 'commands')?.names?.includes('resume') === false)
  chatIn('alpha', S3, 'third topic')
  check('terminal resume becomes room default', await until(() => roomsNow()['t-3'] === S3), roomsNow())
  check('session lives in one room only', roomsNow()['t-4'] === undefined, roomsNow())
  await settled('alpha')
  writeFileSync(join(STATE, 'sessions', 'alpha'), '99999999-9999-4999-8999-999999999999\n')
  check('restarted empty agent restores room', await until(() => sessionNow('alpha') === S3, 8000))
  await settled('alpha')
  chatIn('beta', S4, 'beta topic')
  await until(() => roomsNow()['t-2'] === S4)
  await cmd('t-4', 'use-agent', { agent: 'alpha' })
  await settled('alpha')

  console.log('\nnew waits for the running turn')
  const clears = () => pane('cc-alpha').match(/\/clear/g)?.length ?? 0
  const clearsBefore = clears()
  setBusy('alpha')
  check('busy /new is queued', (await cmd('t-4', 'new')).text?.includes('Queued'))
  await say('t-4', 'held until clear')
  await sleep(1800)
  check('busy agent not interrupted', clears() === clearsBefore, pane('cc-alpha'))
  check('new message held during turn', !alpha.inbox.some(m => m.content === 'held until clear'))
  setIdle('alpha')
  check('clear runs after turn ends', await until(() => clears() > clearsBefore, 4000))
  check('held message delivered after clear', await until(() => alpha.inbox.some(m => m.content === 'held until clear'), 5000))
  check('process and lock survive /new', (await running('alpha')) && JSON.parse(readFileSync(join(STATE, 'bindings.json'), 'utf8')).alpha === 't-4')
  setIdle('alpha')

  console.log('\npermissions')
  await permReq(alpha, 'abcde')
  await permReq(beta, 'abcde')
  const prompts = await until(async () => {
    const p = (await events()).filter(e => e.kind === 'send' && e.content.startsWith('🔐'))
    return p.length >= 2 ? p : undefined
  })
  check('prompts land in each agent room', prompts?.some(p => p.room === 't-4' && p.content.includes('alpha')) && prompts?.some(p => p.room === 't-2' && p.content.includes('beta')), prompts)
  check('prompts have buttons', prompts?.every(p => p.buttons.length === 3), prompts)
  check('no permission DMs', !(await events()).some(e => e.kind === 'dm'))
  check('room prompt hides tool input', !prompts?.some(p => p.content.includes('command')), prompts)
  const details = await ctrl({ op: 'button', user: OWNER, customId: 'perm:more:alpha:abcde' })
  check('See more is a private popup', details.ephemeral === true && details.reply?.includes('"command"'), details)
  check('stranger cannot see details', (await ctrl({ op: 'button', user: STRANGER, customId: 'perm:more:alpha:abcde' })).reply === 'Not authorized.')
  check('stranger button refused', (await ctrl({ op: 'button', user: STRANGER, customId: 'perm:allow:alpha:abcde' })).reply === 'Not authorized.')
  check('stranger did not approve', alpha.perms.length === 0)
  await ctrl({ op: 'button', user: OWNER, customId: 'perm:allow:alpha:abcde' })
  check('same request ID routes to alpha only', await until(() => alpha.perms.length === 1) && beta.perms.length === 0)
  await say('t-2', 'n abcde')
  check('text answer routes to room agent', await until(() => beta.perms[0]?.behavior === 'deny'), beta.perms)
  check('permission text not sent as chat', !beta.inbox.some(m => m.content === 'n abcde'))
  check('answered prompt cannot be reused', (await ctrl({ op: 'button', user: OWNER, customId: 'perm:allow:alpha:abcde' })).reply?.includes('no longer pending'))
  check('reused button not forwarded', alpha.perms.length === 1, alpha.perms)

  console.log('\nstatus messages')
  const fileProbe = join(TEST_DIR, 'probe.txt')
  writeFileSync(fileProbe, 'x')
  check('reply cannot upload files', (await tool(beta, 'reply', { chat_id: 't-2', text: 'x', files: [fileProbe] })).isError)
  check('send_file can upload', !(await tool(beta, 'send_file', { chat_id: 't-2', files: [fileProbe] })).isError)
  setIdle('alpha')
  setIdle('beta')
  await sleep(1200)
  const seenBefore = (await events()).length
  const fresh = async () => (await events()).slice(seenBefore)
  await say('t-2', 'slow turn')
  const slow = await until(async () => (await fresh()).find(e => e.kind === 'send' && e.room === 't-2' && e.content.startsWith('⏳')))
  check('quiet turn posts status', slow, await fresh())
  await tool(beta, 'reply', { chat_id: 't-2', text: 'done' })
  check('reply removes status', await until(async () => (await fresh()).some(e => e.kind === 'delete' && e.message === slow?.id)), await fresh())
  setIdle('beta')
  await sleep(1200)
  const seenWait = (await events()).length
  await say('t-2', 'needs answer')
  const waitStatus = await until(async () => (await events()).slice(seenWait).find(e => e.kind === 'send' && e.content.startsWith('⏳')))
  await permReq(beta, 'fghij')
  check('status shows waiting on user', await until(async () => (await events()).slice(seenWait).some(e => e.kind === 'edit' && e.message === waitStatus?.id && e.text.includes('waiting for your answer'))))
  await ctrl({ op: 'button', user: OWNER, customId: 'perm:deny:beta:fghij' })
  const errorFile = transcriptFile('beta', S4)
  writeFileSync(errorFile, readFileSync(errorFile, 'utf8') + JSON.stringify({ type: 'assistant', isApiErrorMessage: true, message: { content: [{ type: 'text', text: 'API Error: boom' }] } }) + '\n')
  setIdle('beta')
  mkdirSync(join(STATE, 'failed'), { recursive: true })
  await say('t-2', 'turn that fails')
  writeFileSync(join(STATE, 'failed', 'beta'), '')
  const failure = await until(async () => (await events()).find(e => e.kind === 'send' && e.room === 't-2' && e.content.startsWith('❌')))
  check('failed turn reports API error', failure?.content.includes('API Error: boom'), failure)
  setIdle('beta')
  await say('t-2', 'retry after failure')
  check('next message clears failure notice', await until(async () => (await events()).some(e => e.kind === 'delete' && e.message === failure?.id)))
  setIdle('beta')
  await sleep(1200)

  console.log('\nthread lifecycle')
  await ctrl({ op: 'threadArchive', room: 't-2' })
  await say('t-2', 'after archive')
  check('archived thread keeps lock', await until(() => beta.inbox.some(m => m.content === 'after archive')))
  await ctrl({ op: 'threadLock', room: 't-2' })
  await say('t-2', 'after lock')
  await sleep(100)
  check('locked thread unbinds', !beta.inbox.some(m => m.content === 'after lock'))
  await ctrl({ op: 'threadDelete', room: 't-4' })
  check('deleted thread unbinds', !JSON.parse(readFileSync(join(STATE, 'bindings.json'), 'utf8')).alpha)

  console.log('\nrestart and offline')
  await cmd('t-5', 'use-agent', { agent: 'alpha' })
  await stopBroker()
  check('broker down gives tool error', (await tool(alpha, 'reply', { chat_id: 't-5', text: 'x' })).isError)
  await startBroker()
  check('agents reconnect', await until(async () => running('alpha'), 6000))
  await say('t-5', 'after restart')
  check('binding survives broker restart', await until(() => alpha.inbox.some(m => m.content === 'after restart'), 4000))
  await alpha.close()
  check('closed agent leaves list', await until(async () => !(await running('alpha')), 4000))
  await say('t-5', 'while offline')
  check('offline notice shown', await until(async () => (await events()).some(e => e.kind === 'reply' && e.room === 't-5' && e.content.includes('offline'))))
  const again = await startAgent('alpha')
  await until(async () => running('alpha'), 4000)
  await say('t-5', 'back online')
  check('relaunch with same name resumes room', await until(() => again.inbox.some(m => m.content === 'back online')))

  await again.close()
  await beta.close()
  await plain.close()
  await stopBroker()
  tmux('kill-server')
  console.log(`\n${passed} passed, ${failures.length} failed`)
  if (failures.length) { console.log(failures.map(f => `- ${f}`).join('\n')); process.exit(1) }
  process.exit(0)
}

main().catch(async err => {
  console.error(err)
  await stopBroker().catch(() => {})
  tmux('kill-server')
  process.exit(1)
})
