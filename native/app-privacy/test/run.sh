#!/bin/sh
# Runs the app-privacy tests on the head unit's Node (8.16.2;
# MGU_TEST_NODE_VERSION=8.9.4: the 2019 MGU's), in Docker,
# with the repository's apps and, when present, the decoded oap-mainapp
# (iDrive 7, 8.3.2, 8.2.10, 8.1.1 and 6.5.5) and MainApp-21 (iDrive 8, 9.3.4 or 9.2.15).
set -e
cd "$(dirname "$0")/../../.."
FIRMWARE=${FIRMWARE_MAINAPP_DIR:-}
if [ -n "$FIRMWARE" ] && [ -d "$FIRMWARE/src" ]; then
    set -- -v "$FIRMWARE:/firmware:ro" -e FIRMWARE_MAINAPP_DIR=/firmware
fi
FIRMWARE21=${FIRMWARE_MAINAPP21_DIR:-}
if [ -n "$FIRMWARE21" ] && [ -d "$FIRMWARE21/src" ]; then
    set -- "$@" -v "$FIRMWARE21:/firmware21:ro" -e FIRMWARE_MAINAPP21_DIR=/firmware21
fi
FIRMWARE811=${FIRMWARE_MAINAPP_8_1_1_DIR:-}
if [ -n "$FIRMWARE811" ] && [ -d "$FIRMWARE811/src" ]; then
    set -- "$@" -v "$FIRMWARE811:/firmware811:ro" -e FIRMWARE_MAINAPP_8_1_1_DIR=/firmware811
fi
FIRMWARE8210=${FIRMWARE_MAINAPP_8_2_10_DIR:-}
if [ -n "$FIRMWARE8210" ] && [ -d "$FIRMWARE8210/src" ]; then
    set -- "$@" -v "$FIRMWARE8210:/firmware8210:ro" -e FIRMWARE_MAINAPP_8_2_10_DIR=/firmware8210
fi
FIRMWARE655=${FIRMWARE_MAINAPP_6_5_5_DIR:-}
if [ -n "$FIRMWARE655" ] && [ -d "$FIRMWARE655/src" ]; then
    set -- "$@" -v "$FIRMWARE655:/firmware655:ro" -e FIRMWARE_MAINAPP_6_5_5_DIR=/firmware655
fi
docker run --rm -v "$PWD:/w:ro" -w /w "$@" "node:${MGU_TEST_NODE_VERSION:-8.16.2}-stretch" \
    node native/app-privacy/test/test_patch_mainapp.js
