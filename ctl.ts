#!/usr/bin/env bun
/** Host-only access control. Discord messages can never run these commands. */

import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { APPROVED_DIR, loadAccess, loadBindings, saveAccess, type Access } from './state.ts'

const USAGE = `usage:
  bun ctl.ts status
  bun ctl.ts pair <code>
  bun ctl.ts deny <code>
  bun ctl.ts allow <user-id>
  bun ctl.ts remove <user-id>
  bun ctl.ts policy <pairing|allowlist|disabled>`

function die(message: string): never {
  process.stderr.write(`${message}\n`)
  process.exit(1)
}

const [command, value] = process.argv.slice(2)
const access = loadAccess()

function needValue(label: string): string {
  if (!value) die(`missing ${label}\n${USAGE}`)
  return value
}

function needUserId(): string {
  const id = needValue('user id')
  if (!/^\d{15,22}$/.test(id)) die(`invalid Discord user id: ${id}`)
  return id
}

switch (command) {
  case 'status':
    console.log(JSON.stringify({
      dmPolicy: access.dmPolicy,
      allowFrom: access.allowFrom,
      pending: Object.fromEntries(Object.entries(access.pending).map(([code, p]) => [code, p.senderId])),
      bindings: loadBindings(),
    }, null, 2))
    break
  case 'pair': {
    const code = needValue('code')
    const entry = access.pending[code]
    if (!entry) die(`no pending code: ${code}`)
    if (entry.expiresAt < Date.now()) die(`code expired: ${code}`)
    if (!access.allowFrom.includes(entry.senderId)) access.allowFrom.push(entry.senderId)
    delete access.pending[code]
    saveAccess(access)
    mkdirSync(APPROVED_DIR, { recursive: true, mode: 0o700 })
    writeFileSync(join(APPROVED_DIR, entry.senderId), entry.chatId, { mode: 0o600 })
    console.log(`verified ${entry.senderId}`)
    break
  }
  case 'deny': {
    const code = needValue('code')
    if (!access.pending[code]) die(`no pending code: ${code}`)
    delete access.pending[code]
    saveAccess(access)
    console.log(`denied ${code}`)
    break
  }
  case 'allow': {
    const id = needUserId()
    if (!access.allowFrom.includes(id)) access.allowFrom.push(id)
    saveAccess(access)
    console.log(`allowed ${id}`)
    break
  }
  case 'remove': {
    const id = needUserId()
    access.allowFrom = access.allowFrom.filter(user => user !== id)
    saveAccess(access)
    console.log(`removed ${id}`)
    break
  }
  case 'policy': {
    const policy = needValue('policy')
    if (!['pairing', 'allowlist', 'disabled'].includes(policy)) die(`invalid policy: ${policy}`)
    access.dmPolicy = policy as Access['dmPolicy']
    saveAccess(access)
    console.log(`policy ${policy}`)
    break
  }
  default:
    die(USAGE)
}
