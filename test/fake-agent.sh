#!/usr/bin/env bash
# Stands in for Claude in tmux: echoes session commands and records the active session.
file="$1"
while IFS= read -r line; do
  printf '%s\n' "$line"
  case "$line" in
    /clear) printf 'aaaaaaaa-aaaa-4aaa-8aaa-%012d\n' "$RANDOM$RANDOM" > "$file" ;;
    "/resume "*) printf '%s\n' "${line#/resume }" > "$file" ;;
  esac
done
