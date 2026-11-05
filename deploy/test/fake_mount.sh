#!/bin/sh
# mount for the deploy tests. --bind <source> <target>: appends
# "<target><TAB><source><TAB><source's inode>" to $MGU_DEPLOY_FAKE_BINDS; a
# missing source fails as mount does. -o remount,rw|ro /: / as that in
# $MGU_DEPLOY_PROC_MOUNTS, each remount appended to $FAKE_MOUNT_LOG when
# set. While the file $FAKE_MOUNT_STUCK names exists, read-only fails once,
# / left read-write, and the file goes.
if [ "$1" = -o ] && [ "$3" = / ]; then
    [ -z "$FAKE_MOUNT_LOG" ] || echo "$2" >> "$FAKE_MOUNT_LOG"
    if [ "$2" = remount,ro ] && [ -n "$FAKE_MOUNT_STUCK" ] && [ -e "$FAKE_MOUNT_STUCK" ]; then
        rm -f "$FAKE_MOUNT_STUCK"; echo 'mount: / is busy' >&2; exit 32
    fi
    case "$2" in
    remount,rw) echo 'rootfs / ext4 rw,relatime 0 0' > "$MGU_DEPLOY_PROC_MOUNTS"; exit 0 ;;
    remount,ro) echo 'rootfs / ext4 ro,relatime 0 0' > "$MGU_DEPLOY_PROC_MOUNTS"; exit 0 ;;
    esac
fi
[ "$1" = --bind ] || { echo "fake mount: only --bind and remount of /" >&2; exit 1; }
[ -e "$2" ] || { echo "mount: mounting $2 on $3 failed: special device $2 does not exist." >&2; exit 32; }
printf '%s\t%s\t%s\n' "$3" "$2" "$(ls -i "$2" | awk '{print $1}')" >> "$MGU_DEPLOY_FAKE_BINDS"
