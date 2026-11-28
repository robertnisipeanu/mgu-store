#!/bin/sh
# safe_mode.sh: the deploy tool's boot-loop guard (deploy/README.md, "Safe
# mode"). While /var/opt/mgu-deploy/safe-mode exists, our tools' units do
# not start (ConditionPathExists=! in their drop-in zz-mgu-deploy-limits.conf,
# which also orders them after this guard's start step).
#
#   safe_mode.sh start  first at each start (mgu-deploy-safe-mode.service,
#                       before any of our units): this start counts as failed
#                       until it shows otherwise, and when the starts before
#                       it failed THRESHOLD times in a row the flag is
#                       written, so our units stay off from this start on
#   safe_mode.sh stats  the same service: recmgr's last crash key, the
#                       baseline for the mark
#   safe_mode.sh boot   start, then stats (the step the guard's unit of an
#                       earlier deploy tool runs)
#   safe_mode.sh up     the same service: a start up UP_S clears the count
#   safe_mode.sh stop   the same service's stop: an orderly stop of the
#                       system (systemctl reboot or poweroff) counts as a
#                       shutdown without a restart record
#   safe_mode.sh mark   at each shutdown through the NodeStateManager
#                       (var-opt-ro.service, drop-in
#                       40-mgu-deploy-safe-mode.conf), before /var/opt goes
#                       read-only: how this start ends, the count, and at
#                       the THRESHOLD-th failed start in a row the flag
#
# A failed start ends within UP_S of the start, by a restart recmgr or
# crashhandler asked for or with no shutdown mark at all, and none of our
# tools asked for that restart (restart-requested, written by them before
# they ask, names the start). crashhandler restarts the head unit about a
# minute and a half after the crash it restarts it for, so a program that
# crashes early in every start ends each start some 2 to 3 minutes in. The
# start step counts each start as failed; what follows decides:
#   - the start stays up UP_S: the count goes back to zero;
#   - a mark at its shutdown: a restart recmgr or crashhandler asked for
#     counts, on either record of it: the restartInfo.xml each writes when it
#     asks (written in this start), or a row recmgr added to its crash
#     statistics (recmgr_stats.db, table Crash, whose keys only grow; a row
#     only for a failure it restarts the head unit for, written just before
#     it asks) since this start's stats step, the statistics written within
#     STATS_RESTART_S of the shutdown (a row has no time of its own:
#     Timestamp stays empty); recmgr's startup, some 10 s into a start,
#     deletes its restartInfo.xml, also one of that same start. A shutdown
#     without either record (a switch-off, the HMI's or the Store's restart)
#     neither counts nor clears;
#   - an orderly stop of the system (stop) is a shutdown without a record;
#   - no mark, no stop (a power cut, a reset that skipped var-opt-ro.service,
#     a head unit that hangs and is reset): the start counts.
# A state file that is missing or does not read as written counts nothing.
#
# Files in /var/opt/mgu-deploy, each written whole (renamed into place; the
# count and the flag on disk before the start step returns):
#   safe-mode-count     "<failed starts in a row before the start> <boot id> <with it>"
#   safe-mode-crashes   "<boot id> <recmgr's last crash key at its stats step>"
#   last-shutdown       "<boot id> crash|normal <uptime s> [recmgr] [crashhandler] [recmgr_stats]"
#   restart-requested   "<boot id>": a restart our tools asked for in that start
#   safe-mode           {"at": "<UTC time>", "reason": "<why>"}
#
# Always exits 0, and writes nothing without /var/opt/mgu-deploy.
VAR_OPT=${MGU_DEPLOY_VAR_OPT:-/var/opt}
DIR=$VAR_OPT/mgu-deploy
SIN=$VAR_OPT/public/sin
BOOT_ID=${MGU_DEPLOY_BOOT_ID:-/proc/sys/kernel/random/boot_id}
UPTIME=${MGU_DEPLOY_PROC:-/proc}/uptime
PROC_STAT=${MGU_DEPLOY_PROC_STAT:-/proc/stat}
SYSTEMCTL=${MGU_DEPLOY_SYSTEMCTL:-systemctl}
THRESHOLD=3
UP_S=300
# how often `up` looks at the uptime while it waits
UP_POLL_S=5
# the longest a read of recmgr's statistics may take
STATS_WAIT_S=2
# recmgr's restart follows its statistics' write within this
STATS_RESTART_S=60

LAST=$DIR/last-shutdown
COUNT=$DIR/safe-mode-count
CRASHES=$DIR/safe-mode-crashes
REQUESTED=$DIR/restart-requested
FLAG=$DIR/safe-mode
STATS=$SIN/recmgr/recmgr_stats.db

say() { echo "safe mode: $*"; }

first_line() { [ -f "$1" ] && head -n 1 "$1" 2>/dev/null; }

# Whole seconds of uptime; empty when unreadable.
uptime_s() {
  u=$(cut -d. -f1 "$UPTIME" 2>/dev/null | cut -d' ' -f1)
  case "$u" in ''|*[!0-9]*) return ;; esac
  echo "$u"
}

# wait_up <s>: until the start has been up s seconds by /proc/uptime, which
# counts a suspend too (sleep does not); at once when it cannot be read
wait_up() {
  while u=$(uptime_s) && [ -n "$u" ] && [ "$u" -lt "$1" ]; do
    w=$(($1 - u))
    [ "$w" -gt "$UP_POLL_S" ] && w=$UP_POLL_S
    sleep "$w"
  done
}

is_number() { case "$1" in ''|*[!0-9]*) return 1 ;; esac; [ "${#1}" -le 9 ]; }
# a count of failed starts before a start: below the threshold
is_count() { is_number "$1" && [ "$1" -lt "$THRESHOLD" ]; }

# put <file> <text>: the text whole into the file
put() { printf '%s\n' "$2" > "$1.tmp.$$" && mv -f "$1.tmp.$$" "$1"; }

# The count line as this guard writes it, in b, id and c: b failed starts
# before start id (below the threshold), c with it (b, b + 1 or 0); b and c
# empty when the line does not read so.
read_count() {
  # shellcheck disable=SC2046 # three words
  set -- $(first_line "$COUNT")
  b=$1 id=$2 c=$3
  case "$id" in ''|*[!0-9A-Za-z-]*) b= c= ; return ;; esac
  if ! is_count "$b" || ! is_number "$c" || { [ "$c" != "$b" ] && [ "$c" != $((b + 1)) ] && [ "$c" != 0 ]; }; then
    b= c=
  fi
}

flag_on() {
  [ -e "$FLAG" ] || put "$FLAG" "{\"at\": \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\", \"reason\": \"$1 failed starts in a row, each within $UP_S s\"}"
}

# count_set <count before> <boot id> <count after>: the count, and at the
# threshold the flag (the count then starts again)
count_set() {
  c=$3
  if [ "$c" -ge "$THRESHOLD" ]; then
    flag_on "$c"
    c=0
  fi
  put "$COUNT" "$1 $2 $c"
}

# This start counted as failed until it shows otherwise, once per start:
# the failed starts before it are what the last start's count says it ended
# with; at the threshold the flag. On disk before it returns, so a start that
# ends with no mark (a power cut, a reset) still counts.
start() {
  read_count
  [ "$id" = "$boot" ] && [ -n "$b" ] && return 0
  base=${c:-0}
  if [ "$base" -ge "$THRESHOLD" ]; then
    flag_on "$base"
    say "on: $base failed starts in a row; our tools' units do not start"
    base=0
  fi
  put "$COUNT" "$base $boot $((base + 1))"
  sync
}

# recmgr's last crash key (0 with none), read from the database opened
# read-only within STATS_WAIT_S; empty without its statistics or sqlite3,
# or when they cannot be read.
crash_key() {
  [ -f "$STATS" ] && command -v sqlite3 >/dev/null 2>&1 || return 0
  out=$DIR/.crash-key.$$
  # a read that meets recmgr's commit waits up to 200 ms for it
  sqlite3 "file:$STATS?mode=ro" 'PRAGMA busy_timeout=200; SELECT ifnull(max(CrashKey), 0) FROM Crash;' > "$out" 2>/dev/null &
  pid=$!
  # the timer holds none of the caller's output open, and takes its sleep along when stopped
  ( trap 'kill $s 2>/dev/null; exit 0' TERM; sleep "$STATS_WAIT_S" & s=$!; wait $s; kill "$pid" 2>/dev/null ) >/dev/null 2>&1 &
  timer=$!
  wait "$pid"
  status=$?
  kill "$timer" 2>/dev/null
  k=$(tail -n 1 "$out" 2>/dev/null)
  rm -f "$out"
  [ "$status" -eq 0 ] && is_number "$k" && echo "$k"
  return 0
}

stats() {
  k=$(crash_key)
  if [ -n "$k" ]; then put "$CRASHES" "$boot $k"; else rm -f "$CRASHES"; fi
  [ -e "$FLAG" ] && say "on: our tools' units do not start"
}

# whether this start has a shutdown mark already
marked() { [ "$(first_line "$LAST" | cut -d' ' -f1)" = "$boot" ]; }

# end <kind> <uptime s>: how this start ends, and the count
end() {
  kind=$1 up=$2
  read_count
  # the count before this start: the one its start step wrote, else the last
  # start's (no start step ran in this start)
  if [ "$id" = "$boot" ] && [ -n "$b" ]; then
    base=$b
  else
    base=${c:-0}
    if [ "$base" -ge "$THRESHOLD" ]; then flag_on "$base"; base=0; fi
  fi
  if [ "$(first_line "$REQUESTED")" = "$boot" ] || [ "$up" -ge "$UP_S" ]; then
    count=0
  elif [ "$kind" = crash ]; then
    count=$((base + 1))
  else
    count=$base
  fi
  count_set "$base" "$boot" "$count"
}

[ -d "$DIR" ] || exit 0
boot=$(first_line "$BOOT_ID")
case "$boot" in ''|*[!0-9A-Za-z-]*) exit 0 ;; esac

case "$1" in
start)
  start
  ;;
stats)
  stats
  ;;
boot)
  start
  stats
  ;;
mark)
  up=$(uptime_s)
  [ -n "$up" ] || exit 0
  now=$(date +%s)
  since=$(sed -n 's/^btime //p' "$PROC_STAT" 2>/dev/null)
  case "$since" in ''|*[!0-9]*) since=$((now - up)) ;; esac
  who=
  for m in recmgr crashhandler; do
    # written in this start: not before its btime, not after now, a second
    # of slack each way (busybox's stat -c, BSD's -f)
    t=$(stat -c %Y "$SIN/$m/restartInfo.xml" 2>/dev/null || stat -f %m "$SIN/$m/restartInfo.xml" 2>/dev/null) || continue
    case "$t" in ''|*[!0-9]*) continue ;; esac
    [ "$t" -ge $((since - 1)) ] && [ "$t" -le $((now + 1)) ] && who="$who $m"
  done
  # the mark so far, before the slower statistics read: a shutdown cut
  # during that read still finds this start marked
  if [ -n "$who" ]; then put "$LAST" "$boot crash $up$who"; else put "$LAST" "$boot normal $up"; fi
  # shellcheck disable=SC2046 # two words
  set -- $(first_line "$CRASHES")
  if [ "$1" = "$boot" ] && is_number "$2"; then
    k=$(crash_key)
    # recmgr writes the row, then asks for the restart: the shutdown is that restart
    # when the statistics were written within STATS_RESTART_S of it
    t=$(stat -c %Y "$STATS" 2>/dev/null || stat -f %m "$STATS" 2>/dev/null)
    case "$t" in ''|*[!0-9]*) t=0 ;; esac
    [ -n "$k" ] && [ "$k" -gt "$2" ] && [ "$t" -ge $((now - STATS_RESTART_S)) ] && who="$who recmgr_stats"
  fi
  if [ -n "$who" ]; then kind=crash; else kind=normal; fi
  put "$LAST" "$boot $kind $up$who"
  end "$kind" "$up"
  ;;
stop)
  # an orderly stop of the system only (systemctl reboot or poweroff), not a
  # stop of this unit alone; a start the NodeStateManager's shutdown marked
  # keeps its mark
  sys=$("$SYSTEMCTL" is-system-running 2>/dev/null)
  job=$("$SYSTEMCTL" show shutdown.target -p Job 2>/dev/null)
  case "$sys $job" in
  stopping* | *Job=[0-9]*) ;;
  *) exit 0 ;;
  esac
  marked && exit 0
  up=$(uptime_s)
  [ -n "$up" ] || exit 0
  put "$LAST" "$boot normal $up"
  end normal "$up"
  sync
  ;;
up)
  wait_up "$UP_S"
  # shellcheck disable=SC2046 # three words
  set -- $(first_line "$COUNT")
  if [ "$*" != "0 $boot 0" ]; then
    put "$COUNT" "0 $boot 0"
    sync
    say "up ${UP_S} s: the count starts again"
  fi
  ;;
esac
exit 0
