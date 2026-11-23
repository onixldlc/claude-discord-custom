#!/usr/bin/env bun
/** Proves windows elect one broker host, and that another window takes over when it closes. */

import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'fs'
import { join } from 'path'

const ROOT = join(import.meta.dir, '..')
const DIR = join(ROOT, '.test-state', `takeover-${process.pid}`)
const SHARED = join(DIR, 'shared')
const STATE = join(SHARED, 'state')
mkdirSync(STATE, { recursive: true })
writeFileSync(join(STATE, '.env'), 'DISCORD_BOT_TOKEN=fake\n')

const env = {
  ...process.env,
  DISCORD_SHARED_DIR: SHARED,
  DISCORD_STATE_DIR: STATE,
  FAKE_DISCORD_CTRL: join(DIR, 'ctrl'),
  BUN_OPTIONS: `--preload ${join(ROOT, 'test/fake-discord.ts')}`,
} as Record<string, string>
delete env.CC_AGENT_NAME
delete env.TMUX_PANE

// The trailing ":" keeps sh alive as the parent, whose arguments carry the channel flag.
const openWindow = () => Bun.spawn(
  ['sh', '-c', `"${process.execPath}" "${join(ROOT, 'server.ts')}"; :`, 'plugin:discord-rooms@test'],
  { cwd: ROOT, env, stdin: 'pipe', stdout: 'ignore', stderr: 'ignore' },
)

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
let failed = 0
function check(name: string, ok: boolean): void {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}`)
  if (!ok) failed++
}

function brokers(): number {
  let count = 0
  for (const pid of readdirSync('/proc')) {
    if (!/^\d+$/.test(pid)) continue
    try {
      const args = readFileSync(`/proc/${pid}/cmdline`, 'utf8')
      const environ = readFileSync(`/proc/${pid}/environ`, 'utf8')
      if (args.includes('broker.ts') && environ.includes(`DISCORD_SHARED_DIR=${SHARED}`)) count++
    } catch {}
  }
  return count
}

const beatFresh = () => {
  try {
    return Date.now() - statSync(join(SHARED, 'bus', 'broker-alive')).mtimeMs < 3000
  } catch {
    return false
  }
}
const lockOwner = () => {
  try {
    return readFileSync(join(SHARED, 'bus', 'host.lock'), 'utf8')
  } catch {
    return ''
  }
}

async function until(test: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (test()) return true
    await wait(100)
  }
  return test()
}

const windows = [openWindow(), openWindow(), openWindow()]
try {
  check('first windows start a broker', await until(beatFresh, 8000))
  await wait(3000)
  check('exactly one broker with three windows', brokers() === 1)

  const owner = lockOwner()
  const hostIndex = windows.findIndex(w => owner.startsWith(`${w.pid}-`))
  // The lock holds the server pid, a child of the sh window process.
  const hostPid = Number(owner.split('-')[0])
  check('one window holds the host lock', hostPid > 0)
  const hostWindow = hostIndex >= 0
    ? windows[hostIndex]!
    : windows.find(w => readFileSync(`/proc/${hostPid}/stat`, 'utf8').split(' ')[3] === String(w.pid))!
  hostWindow.stdin.end()
  await hostWindow.exited

  check('another window takes over', await until(() => lockOwner() !== '' && lockOwner() !== owner && beatFresh(), 15000))
  await wait(3000)
  check('still exactly one broker after takeover', brokers() === 1)

  for (const w of windows) if (w !== hostWindow) w.stdin.end()
  await Promise.all(windows.map(w => w.exited))
  check('broker stops when every window closes', await until(() => brokers() === 0, 6000))
} finally {
  for (const w of windows) w.kill()
}

console.log(failed ? `${failed} failed` : 'all passed')
process.exit(failed ? 1 : 0)
