#!/bin/sh
# Runs mgu-install without Node: downloads the standalone executable for
# this computer from the `installer` release, checks it against the
# release's SHA256SUMS, and runs it with the arguments given here
# (deploy/README.md, "mgu-install").
#
#   curl -fsSL https://raw.githubusercontent.com/robertnisipeanu/mgu-store/main/deploy/install.sh | sh -s -- first-install --identity ~/.ssh/mgu_root_key
#
# MGU_INSTALL_DOWNLOAD names another folder of the same files (a URL).
# Exit status: mgu-install's, or 1 when it could not be fetched.
set -u

BASE=${MGU_INSTALL_DOWNLOAD:-https://github.com/robertnisipeanu/mgu-store/releases/download/installer}

fail() {
    echo "mgu-install: $*" >&2
    exit 1
}

case $(uname -s) in
    Darwin) os=macos ;;
    Linux) os=linux ;;
    *) fail "no executable for $(uname -s); run mgu-install.js with Node 18+ instead (deploy/README.md)" ;;
esac
case $(uname -m) in
    x86_64 | amd64) cpu=x64 ;;
    arm64 | aarch64) cpu=arm64 ;;
    *) fail "no executable for $(uname -m) on $os; run mgu-install.js with Node 18+ instead (deploy/README.md)" ;;
esac
# a shell under Rosetta reports x86_64 on an Apple silicon Mac
if [ "$os" = macos ] && [ "$(sysctl -n hw.optional.arm64 2>/dev/null)" = 1 ]; then
    cpu=arm64
fi
name=mgu-install-$os-$cpu.gz

if command -v sha256sum >/dev/null 2>&1; then
    sum() { sha256sum "$1" | cut -d' ' -f1; }
elif command -v shasum >/dev/null 2>&1; then
    sum() { shasum -a 256 "$1" | cut -d' ' -f1; }
else
    fail "sha256sum or shasum is needed to check the download"
fi

dir=$(mktemp -d "${TMPDIR:-/tmp}/mgu-install.XXXXXX") || fail "no temporary folder"
trap 'rm -rf "$dir"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

curl -fsSL -o "$dir/SHA256SUMS" "$BASE/SHA256SUMS" || fail "could not download $BASE/SHA256SUMS"
want=$(awk -v n="$name" '$2 == n || $2 == "*" n { print $1 }' "$dir/SHA256SUMS")
[ -n "$want" ] || fail "$BASE/SHA256SUMS lists no $name"
curl -fSL --progress-bar -o "$dir/$name" "$BASE/$name" || fail "could not download $BASE/$name"
got=$(sum "$dir/$name")
[ "$got" = "$want" ] || fail "$name does not match SHA256SUMS (sha256 $got, expected $want); nothing was run. Try again in a minute"
gzip -dc "$dir/$name" >"$dir/mgu-install" || fail "could not unpack $name"
chmod 755 "$dir/mgu-install"

# Through `curl | sh` stdin is the script, so prompts read the terminal.
if [ ! -t 0 ] && { : </dev/tty; } 2>/dev/null; then
    "$dir/mgu-install" "$@" </dev/tty
else
    "$dir/mgu-install" "$@"
fi
exit $?
