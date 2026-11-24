import { readFileSync } from 'fs'
const lines = readFileSync(process.argv[2]!, 'utf8').trim().split('\n').slice(-1500)
const counts: Record<string, number> = {}
const seq: string[] = []
for (const l of lines) { try { const e = JSON.parse(l); const c = e.message?.content; const kinds = Array.isArray(c) ? c.map((p: any) => p.type).join('+') : typeof c; const k = `${e.type}/${e.subtype ?? ''}/${e.type === 'assistant' ? 'stop=' + e.message?.stop_reason + '/' + kinds : ''}`; counts[k] = (counts[k] ?? 0) + 1; seq.push(k) } catch {} }
console.log(Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 18).map(([k, v]) => `${v} ${k}`).join('\n'))
console.log('--- entries right before each user prompt turn end')
for (let i = 0; i < seq.length; i++) if (seq[i]!.startsWith('system/turn_duration') || seq[i]!.startsWith('system/stop_hook')) { console.log(seq.slice(Math.max(0, i - 2), i + 2).join('  >  ')); break }
console.log('--- last 4'); console.log(seq.slice(-4).join('\n'))
