#!/bin/sh
# mount for the deploy tests. --bind <source> <target>: appends
# "<target><TAB><source><TAB><source's inode>" to $MGU_DEPLOY_FAKE_BINDS; a
# missing source fails as mount does. -o remount,rw|ro /: / as that in
# $MGU_DEPLOY_PROC_MOUNTS.
if [ "$1" = -o ] && [ "$3" = / ]; then
    case "$2" in
    remount,rw) echo 'rootfs / ext4 rw,relatime 0 0' > "$MGU_DEPLOY_PROC_MOUNTS"; exit 0 ;;
    remount,ro) echo 'rootfs / ext4 ro,relatime 0 0' > "$MGU_DEPLOY_PROC_MOUNTS"; exit 0 ;;
    esac
fi
[ "$1" = --bind ] || { echo "fake mount: only --bind and remount of /" >&2; exit 1; }
[ -e "$2" ] || { echo "mount: mounting $2 on $3 failed: special device $2 does not exist." >&2; exit 32; }
printf '%s\t%s\t%s\n' "$3" "$2" "$(ls -i "$2" | awk '{print $1}')" >> "$MGU_DEPLOY_FAKE_BINDS"
