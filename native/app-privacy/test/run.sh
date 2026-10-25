#!/bin/sh
# Runs the app-privacy tests on the head unit's Node (8.16.2), in Docker,
# with the repository's apps and, when present, the decoded oap-mainapp.
set -e
cd "$(dirname "$0")/../../.."
FIRMWARE=${FIRMWARE_MAINAPP_DIR:-$HOME/workspaces/personal/claude-bmw-ecu/mgu18/decoded/oap-mainapp}
if [ -d "$FIRMWARE/src" ]; then
    set -- -v "$FIRMWARE:/firmware:ro" -e FIRMWARE_MAINAPP_DIR=/firmware
fi
docker run --rm -v "$PWD:/w:ro" -w /w "$@" node:8.16.2-stretch \
    node native/app-privacy/test/test_patch_mainapp.js
