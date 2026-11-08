#!/bin/sh
# Runs the deploy tests in Docker with the unit's code (mgu-deploy.js,
# fallback_build.js, oap_link.js, the in-place hook) on the head unit's
# Node 8.16.2 (MGU_TEST_NODE_VERSION=8.9.4: the 2019 MGU's), and the harness
# and deploy/hu on a current Node.
set -e
cd "$(dirname "$0")/../.."
docker build -q -t mgu-deploy-test --build-arg UNIT_NODE="${MGU_TEST_NODE_VERSION:-8.16.2}" - >/dev/null <<'DOCKERFILE'
ARG UNIT_NODE
FROM node:${UNIT_NODE}-stretch AS unit
FROM node:22.12.0-bookworm
COPY --from=unit /usr/local/bin/node /usr/local/bin/node8
DOCKERFILE
docker run --rm -v "$PWD:/src:ro" -e MGU_TEST_UNIT_NODE=/usr/local/bin/node8 -e MGU_TEST_ONLY -e MGU_TEST_INSTALL_EXE mgu-deploy-test \
    sh -c 'cp -R /src /w && cd /w && node deploy/test/run.js'
