/**
 * Newline-JSON transport over a shared directory.
 * Containers have different SELinux labels, so they cannot connect to each other's Unix sockets.
 */

import { randomBytes } from 'crypto'
import { EventEmitter } from 'events'
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'fs'
import { join } from 'path'
import { StringDecoder } from 'string_decoder'

const POLL_MS = 50
const SCAN_MS = 200
const BEAT_MS = 1000
const DEAD_MS = 5000

function touch(path: string): void {
  try {
    const now = new Date()
    utimesSync(path, now, now)
  } catch {
    try { writeFileSync(path, '', { mode: 0o600 }) } catch {}
  }
}

function isAlive(path: string): boolean {
  try {
    return Date.now() - statSync(path).mtimeMs < DEAD_MS
  } catch {
    return false
  }
}

export class BusSocket extends EventEmitter {
  destroyed = false
  private offset = 0
  private decoder = new StringDecoder('utf8')
  private poll: Timer
  private beat: Timer

  constructor(
    private dir: string,
    private inFile: string,
    private outFile: string,
    private myBeat: string,
    private peerBeat: string,
  ) {
    super()
    touch(myBeat)
    this.poll = setInterval(() => this.read(), POLL_MS)
    this.beat = setInterval(() => this.heartbeat(), BEAT_MS)
    this.poll.unref()
    this.beat.unref()
  }

  setEncoding(_encoding: string): this {
    return this
  }

  write(text: string): boolean {
    if (this.destroyed) return false
    try {
      appendFileSync(join(this.dir, this.outFile), text, { mode: 0o600 })
      return true
    } catch {
      this.destroy()
      return false
    }
  }

  private read(): void {
    if (this.destroyed) return
    if (!existsSync(this.dir)) {
      this.destroy()
      return
    }
    const path = join(this.dir, this.inFile)
    try {
      const size = statSync(path).size
      if (size <= this.offset) return
      const buf = Buffer.alloc(size - this.offset)
      const fd = openSync(path, 'r')
      try {
        readSync(fd, buf, 0, buf.length, this.offset)
      } finally {
        closeSync(fd)
      }
      this.offset = size
      this.emit('data', this.decoder.write(buf))
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') this.destroy()
    }
  }

  private heartbeat(): void {
    if (this.destroyed) return
    touch(this.myBeat)
    if (!isAlive(this.peerBeat)) this.destroy()
  }

  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    clearInterval(this.poll)
    clearInterval(this.beat)
    this.emit('close')
  }
}

const brokerBeat = (root: string) => join(root, 'broker-alive')
const connsDir = (root: string) => join(root, 'conns')

export function brokerRunning(root: string): boolean {
  return isAlive(brokerBeat(root))
}

export function serveBus(root: string, onConnection: (sock: BusSocket) => void): { close: () => void } {
  const conns = connsDir(root)
  const beatPath = brokerBeat(root)
  rmSync(conns, { recursive: true, force: true })
  mkdirSync(conns, { recursive: true, mode: 0o700 })
  touch(beatPath)
  const seen = new Set<string>()
  const beat = setInterval(() => touch(beatPath), BEAT_MS)
  const scan = setInterval(() => {
    let ids: string[]
    try { ids = readdirSync(conns) } catch { return }
    for (const id of ids) {
      const dir = join(conns, id)
      const agentBeat = join(dir, 'agent-alive')
      if (seen.has(id) || !existsSync(agentBeat)) continue
      seen.add(id)
      const sock = new BusSocket(dir, 'to-broker', 'to-agent', beatPath, agentBeat)
      sock.on('close', () => {
        seen.delete(id)
        rmSync(dir, { recursive: true, force: true })
      })
      onConnection(sock)
    }
  }, SCAN_MS)
  return {
    close() {
      clearInterval(beat)
      clearInterval(scan)
      rmSync(beatPath, { force: true })
      rmSync(conns, { recursive: true, force: true })
    },
  }
}

export function connectBus(root: string): BusSocket | null {
  const beatPath = brokerBeat(root)
  if (!isAlive(beatPath)) return null
  const dir = join(connsDir(root), randomBytes(8).toString('hex'))
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
  } catch {
    return null
  }
  const sock = new BusSocket(dir, 'to-agent', 'to-broker', join(dir, 'agent-alive'), beatPath)
  sock.on('close', () => rmSync(dir, { recursive: true, force: true }))
  return sock
}
