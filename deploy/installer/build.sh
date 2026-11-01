#!/bin/sh
# Builds mgu-install.js into a standalone executable for this computer: a
# Node single executable application of the `node` on PATH, made with
# postject (this folder's package-lock.json), and its gzip for the
# `installer` release (deploy/README.md, "mgu-install"):
#
#   sh deploy/installer/build.sh <out folder> <name>   # name: linux-x64, macos-arm64, windows-x64, ...
#
# Writes <out>/mgu-install-<name>[.exe] and <out>/mgu-install-<name>[.exe].gz.
# .github/workflows/installer.yml runs it on each platform.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
mkdir -p "$1"
out=$(cd "$1" && pwd)
name=$2
ext=
case $name in windows-*) ext=.exe ;; esac
exe=$out/mgu-install-$name$ext
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

(cd "$here" && npm ci --ignore-scripts --no-audit --no-fund --silent)
cp "$here/../mgu-install.js" "$work/mgu-install.js"
cat >"$work/sea.json" <<'EOF'
{ "main": "mgu-install.js", "output": "sea.blob", "disableExperimentalSEAWarning": true, "useCodeCache": false,
  "assets": { "mgu-install.js": "mgu-install.js" } }
EOF
(cd "$work" && node --experimental-sea-config sea.json)
cp "$(node -p process.execPath)" "$exe"
chmod 755 "$exe"
case $name in
    macos-*)
        codesign --remove-signature "$exe"
        node "$here/node_modules/postject/dist/cli.js" "$exe" NODE_SEA_BLOB "$work/sea.blob" \
            --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2 --macho-segment-name NODE_SEA
        codesign --sign - "$exe"
        ;;
    *)
        node "$here/node_modules/postject/dist/cli.js" "$exe" NODE_SEA_BLOB "$work/sea.blob" \
            --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2
        ;;
esac
gzip -9 -n -c "$exe" >"$exe.gz"
