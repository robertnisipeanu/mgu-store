#!/bin/sh
# ssh for the deploy/hu tests: call <n> appends its arguments as line <n>
# of $FAKE_SSH_LOG and saves its stdin to $FAKE_SSH_LOG.<n>.
n=0
if [ -f "$FAKE_SSH_LOG" ]; then n=$(wc -l < "$FAKE_SSH_LOG"); n=$((n + 0)); fi
printf '%s\n' "$*" >> "$FAKE_SSH_LOG"
cat > "$FAKE_SSH_LOG.$n"
exit 0
