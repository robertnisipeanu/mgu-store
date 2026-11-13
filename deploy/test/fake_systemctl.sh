#!/bin/sh
# systemctl for the deploy tests. Every call is appended to
# $FAKE_SYSTEMCTL_LOG. Unit state lives in the folder $FAKE_UNITS:
# <unit>.active holds a unit's ActiveState (without it, "active" for the
# units named in $FAKE_ACTIVE, else "inactive"), <unit>.nrestarts its
# NRestarts (0 without it). start and restart make a unit active, stop
# inactive. A unit whose <unit>.crash file holds "<link> <target> [<n>]"
# crash-loops while that link points at that target (with <n>: only while
# <unit>.starts, its count of starts and restarts, is at most <n>): each
# show then finds its NRestarts one higher. A call whose arguments equal
# $FAKE_FAIL exits 1. is-enabled answers "enabled" for a unit file present in
# $MGU_DEPLOY_SYSTEMD. is-system-running answers what $FAKE_UNITS/system holds,
# else "running". show also gives <unit>.result's Result (success without
# it).
echo "$*" >> "$FAKE_SYSTEMCTL_LOG"
if [ -n "$FAKE_FAIL" ] && [ "$*" = "$FAKE_FAIL" ]; then echo "failing as asked" >&2; exit 1; fi
S="$FAKE_UNITS"
active_of() {
    if [ -n "$S" ] && [ -f "$S/$1.active" ]; then cat "$S/$1.active"; return; fi
    for u in $FAKE_ACTIVE; do
        if [ "$u" = "$1" ]; then echo active; return; fi
    done
    echo inactive
}
crashing() {
    [ -n "$S" ] && [ -f "$S/$1.crash" ] || return 1
    starts=$(cat "$S/$1.starts" 2>/dev/null || echo 0)
    set -- $(cat "$S/$1.crash")
    [ -z "$3" ] || [ "$starts" -le "$3" ] || return 1
    [ "$(readlink "$1")" = "$2" ]
}
case "$1" in
--version) echo "systemd 237"; exit 0 ;;
is-active)
    shift; rc=3
    for u in "$@"; do a=$(active_of "$u"); echo "$a"; [ "$a" = active ] && rc=0; done
    exit $rc ;;
is-system-running)
    if [ -n "$S" ] && [ -f "$S/system" ]; then cat "$S/system"; else echo running; fi
    exit 0 ;;
is-enabled)
    shift; rc=1
    for u in "$@"; do
        if [ -f "$MGU_DEPLOY_SYSTEMD/$u" ]; then echo enabled; rc=0; else echo disabled; fi
    done
    exit $rc ;;
show)
    for unit in "$@"; do :; done
    n=0
    if [ -n "$S" ] && [ -f "$S/$unit.nrestarts" ]; then n=$(cat "$S/$unit.nrestarts"); fi
    if crashing "$unit"; then n=$((n + 1)); echo "$n" > "$S/$unit.nrestarts"; fi
    echo "ActiveState=$(active_of "$unit")"
    echo "NRestarts=$n"
    if [ -n "$S" ] && [ -f "$S/$unit.result" ]; then echo "Result=$(cat "$S/$unit.result")"; else echo "Result=success"; fi
    exit 0 ;;
start|restart)
    if [ -n "$S" ]; then
        echo active > "$S/$2.active"
        echo $(( $(cat "$S/$2.starts" 2>/dev/null || echo 0) + 1 )) > "$S/$2.starts"
    fi
    exit 0 ;;
stop) if [ -n "$S" ]; then echo inactive > "$S/$2.active"; fi; exit 0 ;;
esac
exit 0
