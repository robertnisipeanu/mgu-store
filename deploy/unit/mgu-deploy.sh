#!/bin/sh
# mgu-deploy on the head unit: sh mgu-deploy.sh check|install|status|rollback|restore|backups|fallback ...
# (mgu-deploy.js, run by the unit's Node 8; usage: sh mgu-deploy.sh help)
exec "${MGU_DEPLOY_NODE:-/usr/bin/node}" "$(cd "$(dirname "$0")" && pwd)/mgu-deploy.js" "$@"
