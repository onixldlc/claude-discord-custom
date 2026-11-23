---
description: Verify a Discord user with their pairing code
argument-hint: <code>
disable-model-invocation: true
allowed-tools: Bash(bin/rooms pair:*)
---

The user typed this command to approve Discord pairing code: `$ARGUMENTS`

If the code is not exactly 6 lowercase hexadecimal characters, say it is invalid and stop.

Otherwise run exactly `bin/rooms pair <code>` from the project root, then report the result in one line. Do nothing else.
