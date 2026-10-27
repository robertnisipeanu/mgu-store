#!/bin/sh
# systemctl for the deploy tests. Every call is appended to
# $FAKE_SYSTEMCTL_LOG. Unit state lives in the folder $FAKE_UNITS:
# <unit>.active holds a unit's ActiveState (without it, "active" for the
# units named in $FAKE_ACTIVE, else "inactive"), <unit>.nrestarts its
# NRestarts (0 without it). start and restart make a unit active, stop
# inactive. A unit whose <unit>.crash file holds "<link> <target>"
# crash-loops while that link points at that target: each show then
# finds its NRestarts one higher. A call whose arguments equal $FAKE_FAIL
# exits 1. is-enabled answers "enabled" for a unit file present in
# $MGU_DEPLOY_SYSTEMD.
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
    set -- $(cat "$S/$1.crash")
    [ "$(readlink "$1")" = "$2" ]
}
case "$1" in
--version) echo "systemd 237"; exit 0 ;;
is-active)
    a=$(active_of "$2"); echo "$a"
    [ "$a" = active ] && exit 0
    exit 3 ;;
is-enabled)
    if [ -f "$MGU_DEPLOY_SYSTEMD/$2" ]; then echo enabled; exit 0; fi
    echo disabled; exit 1 ;;
show)
    for unit in "$@"; do :; done
    n=0
    if [ -n "$S" ] && [ -f "$S/$unit.nrestarts" ]; then n=$(cat "$S/$unit.nrestarts"); fi
    if crashing "$unit"; then n=$((n + 1)); echo "$n" > "$S/$unit.nrestarts"; fi
    echo "ActiveState=$(active_of "$unit")"
    echo "NRestarts=$n"
    exit 0 ;;
start|restart) if [ -n "$S" ]; then echo active > "$S/$2.active"; fi; exit 0 ;;
stop) if [ -n "$S" ]; then echo inactive > "$S/$2.active"; fi; exit 0 ;;
esac
exit 0
