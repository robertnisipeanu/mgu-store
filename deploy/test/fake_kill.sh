#!/bin/sh
# kill for the deploy tests: the app manager's death and respawn (fake_manager.js).
exec "$MGU_DEPLOY_NODE" "$(dirname "$0")/fake_manager.js" "$@"
