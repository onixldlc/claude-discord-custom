#!/usr/bin/env bash
# Live test with two real Claude Code agents. Only Discord is faked.
# Run with: env -i HOME="$HOME" USER="$USER" TERM=xterm-256color LANG=C.UTF-8 PATH="$PWD/.local/bin:$PATH" bash test/live.sh
set -uo pipefail

ROOT="$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)"
cd "$ROOT"
TEST="$ROOT/.test-state"
export DISCORD_STATE_DIR="$TEST/live" DISCORD_BOT_TOKEN=fake FAKE_DISCORD_CTRL="$TEST/live-ctrl.sock"
export TMUX_TMPDIR="$TEST/tmux"
unset TMUX
mkdir -p "$TMUX_TMPDIR"
chmod 700 "$TMUX_TMPDIR"
OWNER=100000000000000001

wait_s() { timeout "$1" tail -f /dev/null; }
api() { curl -sS --unix-socket "$FAKE_DISCORD_CTRL" -X POST http://fake/ -d "$1"; }
pane() { tmux capture-pane -p -J -S -200 -t "=cc-$1:"; }
sends() { api '{"op":"log"}' | ROOM="$1" bun -e 'const r=process.env.ROOM;const l=JSON.parse(await Bun.stdin.text()).filter(e=>e.kind==="send"&&e.room===r);console.log(JSON.stringify(l.map(e=>e.content)))'; }
count() { sends "$1" | bun -e 'console.log(JSON.parse(await Bun.stdin.text()).length)'; }
cmd() { api "{\"op\":\"command\",\"room\":\"$1\",\"name\":\"$2\",\"options\":${3:-{\}},\"user\":\"$OWNER\"}"; echo; }

ask() {
  local room="$1" text="$2" before now i
  before="$(count "$room")"
  api "$(ROOM="$room" TEXT="$text" USER_ID="$OWNER" bun -e 'console.log(JSON.stringify({op:"message",room:process.env.ROOM,user:process.env.USER_ID,content:process.env.TEXT}))')" >/dev/null
  for i in $(seq 1 90); do
    now="$(count "$room")"
    [ "$now" -gt "$before" ] && break
    wait_s 1
  done
  wait_s 2
  echo "[$room] -> $(sends "$room" | bun -e 'const a=JSON.parse(await Bun.stdin.text());console.log(a.at(-1)??"(no reply)")')"
}

wait_idle() {
  local agent="$1" i
  for i in $(seq 1 120); do
    pane "$agent" | tail -12 | grep -qE 'esc to interrupt|Compacting|…\s*\(' || { wait_s 2; pane "$agent" | tail -12 | grep -qE 'esc to interrupt|Compacting|…\s*\(' || return 0; }
    wait_s 1
  done
  echo "timeout waiting for $agent"
}

tmux kill-server 2>/dev/null
wait_s 1
rm -rf "$DISCORD_STATE_DIR"
mkdir -p "$DISCORD_STATE_DIR" "$TEST/agents/red" "$TEST/agents/blue"
chmod 700 "$DISCORD_STATE_DIR"
printf '{"dmPolicy":"allowlist","allowFrom":["%s"],"pending":{}}\n' "$OWNER" > "$DISCORD_STATE_DIR/access.json"
tmux new-session -d -s broker -c "$ROOT" -x 120 -y 30 "bun --preload $ROOT/test/fake-discord.ts $ROOT/broker.ts 2> $TEST/live-broker.log"
wait_s 2

for agent in red blue; do
  bin/cc-agent "$agent" "$TEST/agents/$agent" -- --strict-mcp-config
  for i in $(seq 1 20); do pane "$agent" | grep -q 'I am using this for local development' && break; wait_s 1; done
  tmux send-keys -t "=cc-$agent:" Enter
done
for i in $(seq 1 30); do [ "$(grep -c 'agent connected' "$TEST/live-broker.log")" -ge 2 ] && break; wait_s 1; done
wait_s 5
cat "$TEST/live-broker.log"

echo; echo '== bind'
cmd t-red use-agent '{"agent":"red"}'
cmd t-blue use-agent '{"agent":"blue"}'

echo '== isolation'
ask t-red 'Remember codeword ORCHID-7431 for this conversation. Reply using the reply tool with exactly: stored'
ask t-blue 'Remember codeword MAPLE-2086 for this conversation. Reply using the reply tool with exactly: stored'
ask t-red 'What codeword did I give you? Reply using the reply tool with only the codeword, or NONE if you have none. Do not search files.'
ask t-blue 'What codeword did I give you? Reply using the reply tool with only the codeword, or NONE if you have none. Do not search files.'

echo '== move keeps session memory'
cmd t-red-2 use-agent '{"agent":"red"}'
ask t-red-2 'What codeword did I give you? Reply using the reply tool with only the codeword, or NONE if you have none. Do not search files.'

echo '== compact'
wait_idle red
cmd t-red-2 compact
wait_s 3
wait_idle red
pane red | grep -iE 'compact' | tail -3
ask t-red-2 'What codeword did I give you? Reply using the reply tool with only the codeword, or NONE if you have none. Do not search files.'

echo '== reset'
wait_idle red
cmd t-red-2 reset
wait_s 4
wait_idle red
ask t-red-2 'What codeword did I give you? Reply using the reply tool with only the codeword, or NONE if you have none. Do not search files.'
ask t-blue 'What codeword did I give you? Reply using the reply tool with only the codeword, or NONE if you have none. Do not search files.'

echo '== reset while busy'
wait_idle red
ask t-red-2 'Remember codeword TULIP-5519 for this conversation. Reply using the reply tool with exactly: stored'
wait_idle red
wait_s 2
PID_BEFORE="$(tmux list-panes -t '=cc-red:' -F '#{pane_pid}')"
api "{\"op\":\"message\",\"room\":\"t-red-2\",\"user\":\"$OWNER\",\"content\":\"Use Bash in the foreground, not background, to run: sleep 12. After it finishes, use the reply tool with exactly: busy-finished\"}" >/dev/null
wait_s 6
echo "busy file during task: $([ -e "$DISCORD_STATE_DIR/busy/red" ] && echo yes || echo no)"
cmd t-red-2 reset
ask t-red-2 'What codeword did I give you? Reply using the reply tool with only the codeword, or NONE if you have none. Do not search files.'
for i in $(seq 1 60); do sends t-red-2 | grep -q 'NONE.*NONE\|busy-finished.*NONE' && break; wait_s 1; done
echo "messages after busy reset: $(sends t-red-2)"
echo "same process: $([ "$PID_BEFORE" = "$(tmux list-panes -t '=cc-red:' -F '#{pane_pid}')" ] && echo yes || echo no)"

echo '== interrupted turn'
wait_idle red
wait_s 2
api "{\"op\":\"message\",\"room\":\"t-red-2\",\"user\":\"$OWNER\",\"content\":\"Use Bash in the foreground, not background, to run: python3 -c 'import time; time.sleep(40)'. After it finishes, use the reply tool with exactly: interrupted-finished\"}" >/dev/null
wait_s 8
echo "busy before Esc: $([ -e "$DISCORD_STATE_DIR/busy/red" ] && echo yes || echo no)"
pane red | grep -E 'python3|time.sleep' | tail -2
tmux send-keys -t '=cc-red:' Escape
wait_s 5
echo "busy after Esc: $([ -e "$DISCORD_STATE_DIR/busy/red" ] && echo yes || echo no)"
cmd t-red-2 reset
wait_s 6
echo "busy after reset attempt: $([ -e "$DISCORD_STATE_DIR/busy/red" ] && echo yes || echo no)"
ask t-red-2 'Remember codeword IRIS-3302 for this conversation. Reply using the reply tool with exactly: stored'

echo '== old Interrupted text must not clear a new running task'
wait_idle red
wait_s 2
api "{\"op\":\"message\",\"room\":\"t-red-2\",\"user\":\"$OWNER\",\"content\":\"Use Bash in the foreground, not background, to run: python3 -c 'import time; time.sleep(40)'. After it finishes, use the reply tool with exactly: never\"}" >/dev/null
wait_s 8
tmux send-keys -t '=cc-red:' Escape
wait_s 4
api "{\"op\":\"message\",\"room\":\"t-red-2\",\"user\":\"$OWNER\",\"content\":\"Use Bash in the foreground, not background, to run: python3 -c 'import time; time.sleep(14)'. After it finishes, use the reply tool with exactly: second-finished\"}" >/dev/null
wait_s 7
cmd t-red-2 reset
for i in $(seq 1 45); do sends t-red-2 | grep -q 'second-finished' && break; wait_s 1; done
wait_idle red
wait_s 4
ask t-red-2 'What codeword did I give you? Reply using the reply tool with only the codeword, or NONE if you have none. Do not search files.'
echo "final messages: $(sends t-red-2)"
echo "same process: $([ "$PID_BEFORE" = "$(tmux list-panes -t '=cc-red:' -F '#{pane_pid}')" ] && echo yes || echo no)"

echo; echo '== broker log'
cat "$TEST/live-broker.log"
tmux kill-server
