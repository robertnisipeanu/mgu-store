#!/bin/sh
# Runs the linker and packer tests on the head unit's Node (8.16.2), in
# Docker. MGU_TEST_DONORS (colon-separated) and MGU_TEST_THIRDPARTY name
# files and a folder on this machine; they are mounted read-only.
set -e
cd "$(dirname "$0")/../.."
set --
donors=
i=0
IFS=:
for d in ${MGU_TEST_DONORS:-}; do
    i=$((i + 1))
    set -- "$@" -v "$d:/donor$i/$(basename "$d"):ro"
    donors="$donors${donors:+:}/donor$i/$(basename "$d")"
done
unset IFS
if [ -n "$donors" ]; then set -- "$@" -e "MGU_TEST_DONORS=$donors"; fi
if [ -n "${MGU_TEST_THIRDPARTY:-}" ]; then
    set -- "$@" -v "$MGU_TEST_THIRDPARTY:/thirdparty:ro" -e MGU_TEST_THIRDPARTY=/thirdparty
fi
docker run --rm -v "$PWD:/w:ro" -w /w "$@" node:8.16.2-stretch node tools/test/run.js
