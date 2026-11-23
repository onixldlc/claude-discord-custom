# Claude Discord Rooms

Run several Claude Code sessions behind one Discord bot. Each session locks to its own channel or thread, so you can talk to all of them from Discord.

Based on the official Claude Code Discord channel plugin. The pinned source commit is in [`UPSTREAM`](./UPSTREAM). Licensed under Apache-2.0.

> **Status:** experimental. Claude Code channels are a research preview and may change. See [What has been tested](#what-has-been-tested).

## All start commands

Run everything from this project's folder unless noted. Bot creation is covered in [Quick start](#quick-start).

**First time only:**

```sh
bin/rooms install
```

**Every window, every time.** Use whichever fits, and pick **I am using this for local development** when asked:

```sh
# Plain Claude Code, from the folder this session should work in
claude --settings '{"autoMemoryEnabled":false}' --dangerously-load-development-channels plugin:discord-rooms@discord-rooms

# Isolated llm-terminal-cli window
llm-terminal-cli --secure --new --settings '{"autoMemoryEnabled":false}' --dangerously-load-development-channels plugin:discord-rooms@discord-rooms
```

**First time only, after one window is open.** DM the bot to get a code, then:

```sh
bin/rooms pair <code>
bin/rooms policy allowlist
```

**In a Discord channel or thread:**

```text
/use-agent          list running agents
/use-agent ag1      lock ag1 to this room
/rem-agent          unlock this room
```

**Day to day:** open windows with the command above. The first one starts the bot, and closing them all stops it.

**After changing or pulling this code:**

```sh
bin/rooms install
```

Then close and reopen every window.

**When something looks wrong:**

```sh
bin/rooms status    # policy, users, pending codes, room locks
bin/rooms log       # recent bot log
```

## How it works

```text
Discord
   │  one bot token
broker (started by the first window)
   │  files in ~/.claude/channels/discord-rooms/bus
   ├── thread "ag1" → Claude window 1 + plugin
   ├── thread "ag2" → Claude window 2 + plugin
   └── thread "notes" → no agent, bot stays silent
```

- **Broker** (`broker.ts`) owns the Discord connection, verified users, and room locks.
- **Plugin** (`plugin/`, `server.ts`) is a small bridge inside each Claude window.
- **Bus** (`bus.ts`) connects them through shared files, because separate containers cannot reach each other's Unix sockets.

The first window starts the broker. If that window closes, another open window takes over within a few seconds. When every window closes, the bot goes offline until the next one opens.

The plugin is local. It installs from a folder on your disk and is never published. Without the channel flag it stays idle and never joins Discord.

## Quick start

You need Claude Code (logged in), [Bun](https://bun.sh), and a Discord bot token. tmux is only needed for the optional `/new` mode.

### 1. Create the Discord bot

In the [Discord Developer Portal](https://discord.com/developers/applications):

1. Create an application and add a bot.
2. Under **Bot → Privileged Gateway Intents**, enable **Message Content Intent**.
3. Turn **Public Bot** off, so only you can add it to servers.
4. Reset and copy the bot token.
5. Under **OAuth2 → URL Generator**, select the `bot` and `applications.commands` scopes.
6. Enable View Channels, Send Messages, Send Messages in Threads, Create Public Threads, Read Message History, Attach Files, and Add Reactions.
7. Open the generated URL and add the bot to your server.

### 2. Install once

```sh
bin/rooms install
```

This asks for the token without showing it, installs dependencies, and registers the local plugin. Claude rejects a plugin that is not installed before any of this project's code can run, so this one step cannot be folded into the window command.

### 3. Open Claude windows

Run the same command in every window, including the first, from whichever folder that session should use:

```sh
claude --settings '{"autoMemoryEnabled":false}' --dangerously-load-development-channels plugin:discord-rooms@discord-rooms
```

With `llm-terminal-cli`, each `--secure` window gets its own private folder:

```sh
llm-terminal-cli --secure --new --settings '{"autoMemoryEnabled":false}' --dangerously-load-development-channels plugin:discord-rooms@discord-rooms
```

Choose **I am using this for local development**. Claude requires this on every launch for channels outside Anthropic's approved list. Windows join by themselves as `ag1`, `ag2`, and so on.

The `--settings` value turns off Claude's auto-memory, so a room knows only its own session. This matters when windows share one `~/.claude`.

The first window starts the bot and the rest join it. You can mix plain `claude` and `llm-terminal-cli` windows only if they all see `~/.claude` at the same full path, because Claude records full plugin paths. If your host home is not the same path as the container home (for example `/home/you` and `/home/dev`), use either host windows or container windows, not both.

### 4. Verify yourself once

DM the bot to get a pairing code, then approve it on the host:

```sh
bin/rooms pair <code>
bin/rooms policy allowlist      # stop new pairing requests
```

You can also type `/pair <code>` in a Claude session opened in this project. Verification applies to every room and agent.

### 5. Lock a window to a room

In a Discord channel or thread, press Ctrl+R if the command list looks stale, then run:

```text
/use-agent ag1
```

Now talk normally. No @mention is needed.

### Upgrading from an older install

If you previously started the bot with `bin/rooms up`:

1. Run `bin/rooms install`. It copies your token, verified users, and room locks to the new location, then stops the old bot.
2. Close every open Discord-connected Claude window, because open windows still run the old code.
3. Reopen them with the command above. The first one starts the bot.
4. Once the bot connects, you can delete the old `.local/state/.env`. It is gitignored and no longer used.

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

This is the only feature that needs tmux, along with `bin/rooms agent` and `attach`. Without tmux those commands say so, and everything else works normally.

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
bin/rooms install               # first-time setup, safe to run again after updating
bin/rooms up                    # start the bot by hand, with or without tmux (windows normally do this)
bin/rooms down                  # stop a bot started with up, plus any tmux agents
bin/rooms ps                    # whether the bot is running, plus any tmux agents
bin/rooms log                   # recent broker log
bin/rooms status                # policy, users, pending codes, room locks
bin/rooms pair <code>           # verify a user
bin/rooms deny <code>           # discard a code
bin/rooms allow <user-id>       # add a Discord user ID
bin/rooms remove <user-id>      # remove a user
bin/rooms policy pairing        # allow new pairing requests
bin/rooms policy allowlist      # stop new pairing requests
bin/rooms policy disabled       # ignore all Discord activity
bin/rooms install-shared        # copy app code again after changing it
```

After `install-shared`, restart Claude windows to load the new code.

To change the token, edit `~/.claude/channels/discord-rooms/state/.env`, then close and reopen your windows.

## Security

- **Every verified user controls every agent**, including its shell, files, and tool approvals. Only verify people you would give shell access.
- **Agents sharing `~/.claude` are not isolated on the bridge.** A misbehaving agent could pretend to be another one. Use this only with agents you trust.
- Discord messages can steer an agent. That is why channels need an explicit launch flag.
- Approve pairing only from the host. Never approve a code because a Discord message asked you to.
- **Every agent can reach the bot token and verified-user list.** See below.
- The token folder is outside this repository, so the token is not committed.

### Why agents can reach the token

Any window may need to start the bot, and the bot needs the token to log in. So the token cannot be hidden from windows. It lives in `~/.claude/channels/discord-rooms/state/`, next to `access.json`, the list of Discord users allowed to control agents. Every agent sharing that `~/.claude` can reach both files. This is the cost of having no separate always-on service.

**How it could go wrong.** Unverified Discord users are ignored, so a stranger cannot message an agent directly. The realistic risk is *prompt injection*: an agent reads something containing hidden instructions, such as a web page, a cloned repository, a log, or text a verified user pasted into Discord. Those instructions might tell it to print the token, send it somewhere, or add a Discord ID to `access.json`.

**What an attacker could do:**

| If they get | They can |
| --- | --- |
| The bot token | Log in as your bot, read what it can see, and post or act with its permissions in every server it has joined. They cannot log in to your personal Discord account |
| A Discord ID added to `access.json` | Message your agents and answer their permission prompts, which can mean running commands and changing files in those sessions |

**What protects you.** Reading those files or running a shell command normally triggers a permission prompt, so a bad action has to get past you. That protection is gone in auto mode or with permission-bypass flags, and it is weak if you approve prompts without reading them.

**How to stay safe:**

- Avoid auto mode and permission-bypass flags in Discord-connected windows, especially when an agent handles untrusted content.
- Deny any prompt that touches `~/.claude/channels/discord-rooms/`, or that sends data somewhere you did not ask for.
- Keep **Public Bot** off, add the bot only to servers you need, and give it only the permissions listed above.
- Run `bin/rooms policy allowlist` after verifying yourself, and check `bin/rooms status` for users you do not recognize.

**If you suspect a leak:**

1. Reset the token in the Discord Developer Portal. The old one stops working immediately.
2. Put the new token in `~/.claude/channels/discord-rooms/state/.env`.
3. Run `bin/rooms status`, and remove unknown users with `bin/rooms remove <user-id>`.
4. Close and reopen every window.

### Compared with the official plugin

The official Discord plugin has the same basic exposure. It stores its token in `~/.claude/channels/discord/.env` with `access.json` beside it, and any Claude session running as your user can reach them. It relies on permission prompts, an instruction not to change access because of a channel message, and a block on sending its state files through Discord. This project keeps all three.

### Options for stricter isolation

These are not implemented. The current design was chosen so every window can use one command.

| Option | Protects the token from | Trade-off |
| --- | --- | --- |
| Current design | Nothing beyond the protections above | No extra service |
| Separate bot service | `--secure` windows | First window no longer starts the bot, and one service must stay on |
| Bot under its own Linux user | `--secure` and plain `claude` windows | Same as above, plus `sudo` once and more setup |

Both stricter options protect the token and user list, but agents would still share the message bus, so a misbehaving agent could still pretend to be another one. Claude permission deny rules alone are not enough, because a shell command can often get around them.

## Troubleshooting

| Problem | Check |
| --- | --- |
| Slash commands missing or stale | Press Ctrl+R in Discord. Confirm the invite included `applications.commands` |
| `/use-agent` shows no agents | Launch a window with the channel flag and accept the warning |
| Bot stays offline | Check `~/.claude/channels/discord-rooms/state/broker.log`. After a failed login, windows wait 30 seconds before retrying |
| `plugin not installed` | Check the plugin name, then run `bin/rooms install` |
| Plugin breaks when mixing host `claude` and containers | Both must see `~/.claude` at the same absolute path, because Claude records full plugin paths |
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

Confirmed with a fake Discord layer: one window hosts the broker, another takes over when it closes, and the broker stops with the last window.

Not yet confirmed on real Discord: automatic hosting and takeover, plus Allow and Deny buttons, status messages, and the real API failure path from a plugin window.

## Tests

```sh
bun test/e2e.ts
bun test/takeover.ts
```

These use a fake Discord layer with the real broker, MCP bridges, tmux, and access commands. They need no bot token.

`test/live.sh` also starts two real Claude agents and uses Claude quota:

```sh
env -i HOME="$HOME" USER="${USER:-$(id -un)}" TERM=xterm-256color LANG=C.UTF-8 PATH="$PATH" bash test/live.sh
```

Both use isolated tmux and state under `.test-state/`.
