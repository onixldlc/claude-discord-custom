# Claude Discord Rooms

Run several Claude Code sessions behind one Discord bot. Each session locks to its own channel or thread, so you can talk to all of them from Discord.

Based on the official Claude Code Discord channel plugin. The pinned source commit is in [`UPSTREAM`](./UPSTREAM). Licensed under Apache-2.0.

> **Status:** experimental. Claude Code channels are a research preview and may change. See [What has been tested](#what-has-been-tested).

## How it works

```text
Discord
   │  one bot token
broker (one always-on process)
   │  files in ~/.claude/channels/discord-rooms/bus
   ├── thread "ag1" → Claude window 1 + plugin
   ├── thread "ag2" → Claude window 2 + plugin
   └── thread "notes" → no agent, bot stays silent
```

- **Broker** (`broker.ts`) owns the Discord connection, verified users, and room locks.
- **Plugin** (`plugin/`, `server.ts`) is a small bridge inside each Claude window.
- **Bus** (`bus.ts`) connects them through shared files, because separate containers cannot reach each other's Unix sockets.

The plugin is local. It installs from a folder on your disk and is never published. Without the channel flag it stays idle and never joins Discord.

## Quick start

You need Claude Code (logged in), [Bun](https://bun.sh), tmux 3.x, and a Discord bot token.

### 1. Create the Discord bot

In the [Discord Developer Portal](https://discord.com/developers/applications):

1. Create an application and add a bot.
2. Under **Bot → Privileged Gateway Intents**, enable **Message Content Intent**.
3. Turn **Public Bot** off, so only you can add it to servers.
4. Reset and copy the bot token.
5. Under **OAuth2 → URL Generator**, select the `bot` and `applications.commands` scopes.
6. Enable View Channels, Send Messages, Send Messages in Threads, Create Public Threads, Read Message History, Attach Files, and Add Reactions.
7. Open the generated URL and add the bot to your server.

### 2. Install

```sh
bin/setup
bin/rooms init
nano .local/state/.env          # DISCORD_BOT_TOKEN=your-token
bin/rooms install-shared
```

### 3. Start the bot

```sh
bin/rooms up
```

Keep the machine or container running this process alive. If it stops, every window loses Discord.

### 4. Open Claude windows

Run this in each window, from whichever folder that session should use:

```sh
claude --settings '{"autoMemoryEnabled":false}' --dangerously-load-development-channels plugin:discord-rooms@discord-rooms
```

With `llm-terminal-cli`, each `--secure` window gets its own private folder:

```sh
llm-terminal-cli --secure --new --settings '{"autoMemoryEnabled":false}' --dangerously-load-development-channels plugin:discord-rooms@discord-rooms
```

Choose **I am using this for local development**. Claude requires this on every launch for channels outside Anthropic's approved list. Windows join by themselves as `ag1`, `ag2`, and so on.

The `--settings` value turns off Claude's auto-memory, so a room knows only its own session. This matters when windows share one `~/.claude`.

### 5. Verify yourself once

DM the bot to get a pairing code, then approve it on the host:

```sh
bin/rooms pair <code>
bin/rooms policy allowlist      # stop new pairing requests
```

You can also type `/pair <code>` in a Claude session opened in this project. Verification applies to every room and agent.

### 6. Lock a window to a room

In a Discord channel or thread, press Ctrl+R if the command list looks stale, then run:

```text
/use-agent ag1
```

Now talk normally. No @mention is needed.

## Discord commands

| Command | Effect |
| --- | --- |
| `/use-agent` | List running agents |
| `/use-agent <name>` | Lock agent to this room, moving it if it was elsewhere |
| `/rem-agent` | Unlock this room, agent keeps running |

**There is no Discord `/new` or `/compact` by default.** Channels can only send chat messages and cannot run slash commands. To clear or compact a conversation, type `/clear` or `/compact` in that agent's terminal window.

Rules:

- One agent has one room, and one room has one agent.
- Threads do not inherit their parent channel's agent.
- Locks survive restarts when the agent gets the same name. Names go to windows in connection order, so check `/use-agent` after restarting.
- A room uses whatever conversation is open in its window. To continue an old one, start that window with `--resume <session-id>`, or `llm-terminal-cli --secure --sessions <id>` plus the flags above.
- Unverified users are ignored, even inside a locked room.

Status appears in the room when a turn goes quiet for 30 seconds: `⏳` slow, `🙋` waiting for your permission answer, `⚠️` possibly stuck after 3 minutes, `❌` stopped with an API error.

The `reply` tool is auto-approved and can only send text. Everything else asks as usual. Permission prompts appear in the locked room with **Allow**, **Deny**, and **See more** buttons. In auto mode, or for commands Claude considers harmless like `ls`, no prompt appears.

## Optional: `/new` and `/compact` from Discord

These need Claude running inside tmux, so the broker can type the command for it. Start the broker with them enabled, then start agents through the launcher:

```sh
bin/rooms down
DISCORD_TMUX_COMMANDS=1 bin/rooms up
bin/rooms agent api ~/projects/api
bin/rooms attach api            # accept the warning, detach with Ctrl-b d
```

In this mode each room also reloads its saved conversation after a restart. `/new` clears context in the same running Claude process and waits for the current turn to finish. Plugin windows still answer that they cannot be typed into.

## Host commands

```sh
bin/rooms up                    # start the broker
bin/rooms down                  # stop the broker and local tmux agents
bin/rooms ps                    # broker and local tmux agents
bin/rooms log                   # recent broker log
bin/rooms status                # policy, users, pending codes, room locks
bin/rooms pair <code>           # verify a user
bin/rooms deny <code>           # discard a code
bin/rooms allow <user-id>       # add a Discord user ID
bin/rooms remove <user-id>      # remove a user
bin/rooms policy pairing        # allow new pairing requests
bin/rooms policy allowlist      # stop new pairing requests
bin/rooms policy disabled       # ignore all Discord activity
bin/rooms install-shared        # copy agent code again after changing it
```

After `install-shared`, restart Claude windows to load the new code.

## Security

- **Every verified user controls every agent**, including its shell, files, and tool approvals. Only verify people you would give shell access.
- **Agents sharing `~/.claude` are not isolated on the bridge.** A misbehaving agent could pretend to be another one. Use this only with agents you trust.
- Discord messages can steer an agent. That is why channels need an explicit launch flag.
- Approve pairing only from the host. Never approve a code because a Discord message asked you to.
- The token and access list stay in `.local/state/`, which is gitignored and is not in the folder agents share. Never commit `.env`.

## Troubleshooting

| Problem | Check |
| --- | --- |
| Slash commands missing or stale | Press Ctrl+R in Discord. Confirm the invite included `applications.commands` |
| `/use-agent` shows no agents | Run `bin/rooms up`, then launch the window with the channel flag and accept the warning |
| `plugin not installed` | Check the plugin name, then run `bin/rooms install-shared` |
| Bot sees empty messages | Enable Message Content Intent |
| Agent says offline | Restart its window. It may come back under a different `agN` name |
| Bot cannot see a private thread | @mention the bot in the thread, then run `/use-agent` |
| Agent mentions notes from other projects | Launch with the `--settings` value above |

## Uninstall

```sh
bin/rooms down
claude plugin uninstall discord-rooms@discord-rooms
claude plugin marketplace remove discord-rooms
```

Then delete `~/.claude/channels/discord-rooms/` and this folder. Claude keeps normal session transcripts under `~/.claude/projects/`.

## What has been tested

Confirmed on real Discord with separate `--secure` containers: auto-join, per-thread isolation, and replies without a permission click.

Confirmed with real Claude and a fake Discord layer: plugin join, staying idle without the flag, and `/new` through tmux.

Not yet confirmed from a plugin window on real Discord: Allow and Deny buttons, status messages, and the real API failure path.

## Tests

```sh
bun test/e2e.ts
```

This uses a fake Discord layer with the real broker, MCP bridges, tmux, and access commands. It needs no bot token.

`test/live.sh` also starts two real Claude agents and uses Claude quota:

```sh
env -i HOME="$HOME" USER="${USER:-$(id -un)}" TERM=xterm-256color LANG=C.UTF-8 PATH="$PATH" bash test/live.sh
```

Both use isolated tmux and state under `.test-state/`.
