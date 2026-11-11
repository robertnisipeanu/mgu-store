#!/bin/sh
# Runs the updater tests on the head unit's Node (8.16.2; MGU_TEST_NODE_VERSION=8.9.4:
# the 2019 MGU's), as root, in Docker:
# test_certs.js, test_uids.js, test_proxy.js, test_updater.js, and test_web.js and test_page.js (the phone page) when it is in this tree;
# with MGU_TEST_PYTHON naming a Python,
# test_certs.js again on this machine's node, its chains also through that Python.
set -e
cd "$(dirname "$0")/.."
docker run --rm -v "$PWD:/w:ro" -w /w "node:${MGU_TEST_NODE_VERSION:-8.16.2}-stretch" sh -c \
    'node test/test_certs.js && node test/test_uids.js && node test/test_proxy.js && node test/test_updater.js && if [ -f test/test_web.js ]; then node test/test_web.js && node test/test_page.js; fi'
if [ -n "$MGU_TEST_PYTHON" ]; then
    node test/test_certs.js
fi
