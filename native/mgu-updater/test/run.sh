#!/bin/sh
# Runs the updater tests on the head unit's Node (8.16.2), as root, in Docker:
# test_updater.js, and test_web.js and test_page.js (the phone page) when it is in this tree;
# with IDRIVE7_APPS naming a clone of idrive7-apps, test_rename_real.js on
# this machine's node and python3.
set -e
cd "$(dirname "$0")/.."
docker run --rm -v "$PWD:/w:ro" -w /w node:8.16.2-stretch sh -c \
    'node test/test_updater.js && if [ -f test/test_web.js ]; then node test/test_web.js && node test/test_page.js; fi'
if [ -n "$IDRIVE7_APPS" ]; then
    node test/test_rename_real.js "$IDRIVE7_APPS"
fi
