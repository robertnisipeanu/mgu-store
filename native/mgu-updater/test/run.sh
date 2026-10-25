#!/bin/sh
# Runs the updater tests on the head unit's Node (8.16.2), as root, in Docker.
set -e
cd "$(dirname "$0")/.."
docker run --rm -v "$PWD:/w:ro" -w /w node:8.16.2-stretch node test/test_updater.js
