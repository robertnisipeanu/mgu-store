#!/bin/sh
# Runs the updater tests on the head unit's Node (8.16.2), as root, in Docker:
# test_updater.js, and test_web.js (the phone page) when it is in this tree.
set -e
cd "$(dirname "$0")/.."
docker run --rm -v "$PWD:/w:ro" -w /w node:8.16.2-stretch sh -c \
    'node test/test_updater.js && if [ -f test/test_web.js ]; then node test/test_web.js; fi'
