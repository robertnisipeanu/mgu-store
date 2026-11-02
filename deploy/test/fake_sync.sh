#!/bin/sh
# sync for the deploy tests: each call appends a line to $FAKE_SYNC_LOG,
# "sync" then, for each path in $FAKE_SYNC_WATCH, " <name>=" and the
# file's lines joined by "|" ("present" for another kind, "-" when absent).
# The call whose number is $FAKE_SYNC_KILL_AT kills the deploy tool, and
# the sh window it runs in (a power cut there); the one whose number is
# $FAKE_SYNC_FAIL_AT fails.
[ -n "$FAKE_SYNC_LOG" ] || exit 0
line=sync
for f in $FAKE_SYNC_WATCH; do
    if [ -f "$f" ]; then v=$(tr '\n' '|' < "$f"); elif [ -e "$f" ] || [ -L "$f" ]; then v=present; else v=-; fi
    line="$line $(basename "$f")=$v"
done
echo "$line" >> "$FAKE_SYNC_LOG"
calls=$(wc -l < "$FAKE_SYNC_LOG")
if [ "$calls" -eq "${FAKE_SYNC_KILL_AT:-0}" ]; then
    case "$(cat "/proc/$PPID/comm")" in
    sh|dash|bash) kill -9 "$(cut -d' ' -f4 "/proc/$PPID/stat")" "$PPID" ;;
    *) kill -9 "$PPID" ;;
    esac
    exit 0
fi
if [ "$calls" -eq "${FAKE_SYNC_FAIL_AT:-0}" ]; then echo "sync failing as asked" >&2; exit 1; fi
exit 0
