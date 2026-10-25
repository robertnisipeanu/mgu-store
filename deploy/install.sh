#!/bin/sh
# Installs the Store on the head unit from this kit (deploy/README.md,
# "The install kit"). As root on the unit:
#
#   sh install.sh [--with-uplink]
#
# The kit's own deploy tool installs itself, app-privacy, the updater and
# the Store (a source package, built here against an app already on the
# unit), with --with-uplink also the internet uplink, then seeds the
# updater's sources and, when the kit carries a token, the mgu-store
# source's token. Newer installed apps and tools are kept.
set -e
KIT=$(cd "$(dirname "$0")" && pwd)
# the deploy tool's own overrides (deploy/test runs this against a fake root)
VAR_OPT=${MGU_DEPLOY_VAR_OPT:-/var/opt}
uplink=
for a in "$@"; do
    case "$a" in
    --with-uplink) uplink=1 ;;
    *) echo "usage: sh install.sh [--with-uplink]" >&2; exit 2 ;;
    esac
done
if [ "$(id -u)" != 0 ] && [ "$MGU_DEPLOY_FAKE_ROOT" != 1 ]; then echo "install.sh: run as root" >&2; exit 2; fi
if [ -n "$uplink" ] && ! ls "$KIT"/optional/mgu-uplink@*.tgz >/dev/null 2>&1; then
    echo "install.sh: this kit has no optional/mgu-uplink@<version>.tgz" >&2
    exit 2
fi
# runs from a copy on the unit: the stick can be read-only or pulled
umask 077
STAGE=$VAR_OPT/mgu-deploy-kit-$$
rm -rf "$STAGE"
mkdir -p "$STAGE"
trap 'rm -rf "$STAGE"' EXIT
trap 'exit 1' INT TERM HUP
cp -R "$KIT"/. "$STAGE"/
set --
for f in "$STAGE"/artifacts/*.tgz; do set -- "$@" --artifact "$f"; done
if [ -n "$uplink" ]; then
    for f in "$STAGE"/optional/mgu-uplink@*.tgz; do set -- "$@" --artifact "$f"; done
fi
sh "$STAGE/mgu-deploy.sh" install "$@" --skip-older --yes
sh "$STAGE/mgu-deploy.sh" updater-sources < "$STAGE/sources.json"
if [ -f "$STAGE/token" ]; then
    sh "$STAGE/mgu-deploy.sh" updater-token --source mgu-store < "$STAGE/token"
fi
sh "$VAR_OPT/mgu-deploy/mgu-deploy.sh" status
