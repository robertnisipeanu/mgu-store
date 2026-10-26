#!/bin/sh
# Replays sessions through the original daemons (test/reference) and mgu-render, offscreen with Mesa's
# llvmpipe, and compares every frame byte for byte (--raw) and the last one (--out).
#   test/replay.sh BUILD_DIR      (inside the test container: make test)
# Sessions: test/sessions/<dialect>/*.bin.gz (recorded from the kits' file sinks, test/sessions/README.md) and the synthetic ones
# test/gen_sessions.js writes. Streams named bad-* must end with "bad message" and exit 1 in both
# daemons, over-* must log the refusal and still draw.
set -u
B=$1
S=$(cd "$(dirname "$0")" && pwd)
export LIBGL_ALWAYS_SOFTWARE=1 EGL_PLATFORM=surfaceless
CF="-O2 -g0 -w -std=gnu11 -I$B/protocol"
GEN="$B/protocol/ivi-application-protocol.c $B/protocol/ivi-controller-protocol.c"
LIBS="-lwayland-client -lwayland-egl -lEGL -lGLESv2 -lm"
for d in upstream iterio; do
    cc $CF -I"$S/reference/$d" -o "$B/ref-$d" "$S"/reference/$d/*.c $GEN $LIBS || exit 1
done
W=$B/replay
rm -rf "$W"; mkdir -p "$W/synthetic"
node "$S/gen_sessions.js" "$W/synthetic" >/dev/null || exit 1
fail=0; n=0

run() {  # daemon stream outbase -> exit status in $rc, log in outbase.log
    "$1" --replay "$2" --out "$3.pam" --raw "$3.rgba" > "$3.log" 2>&1
    rc=$?
}

# against an original daemon
compare() {  # dialect stream
    name=$(basename "$2" .bin); o=$W/$1-$name
    run "$B/ref-$1" "$2" "$o.ref"; rref=$rc
    run "$B/mgu-render" "$2" "$o.our"; rour=$rc
    n=$((n + 1))
    case $name in
    bad-*)
        if [ $rref = 1 ] && [ $rour = 1 ] && grep -q 'bad message' "$o.ref.log" && grep -q 'bad message' "$o.our.log"; then
            echo "ok   $1/$name: refused by both"
        else
            echo "FAIL $1/$name: original exit $rref, mgu-render exit $rour"; sed 's/^/     /' "$o.our.log"; fail=1
        fi
        return ;;
    esac
    if [ $rref != 0 ] || [ $rour != 0 ]; then
        echo "FAIL $1/$name: original exit $rref, mgu-render exit $rour"; sed 's/^/     /' "$o.ref.log" "$o.our.log"; fail=1; return
    fi
    case $name in over-*)
        grep -q 'at most\|use .* MB already' "$o.our.log" || { echo "FAIL $1/$name: no refusal logged"; fail=1; return; } ;;
    esac
    if cmp -s "$o.ref.rgba" "$o.our.rgba" && cmp -s "$o.ref.pam" "$o.our.pam"; then
        frames=$(sed -n 's/.*\] I \([0-9]*\) frames.*/\1/p' "$o.our.log")
        echo "ok   $1/$name: $frames frames identical ($(sed -n 's/.*, \([a-z]*\) dialect.*/\1/p' "$o.our.log") dialect)"
    else
        echo "FAIL $1/$name: frames differ"; python3 "$S/pamdiff.py" "$o.ref.pam" "$o.our.pam"; fail=1
    fi
}

for d in upstream iterio; do
    mkdir -p "$W/recorded/$d"
    for z in "$S/sessions/$d"/*.bin.gz; do gunzip -c "$z" > "$W/recorded/$d/$(basename "$z" .gz)"; done
    for f in "$W/recorded/$d"/*.bin "$W/synthetic/$d"-*.bin; do
        [ -f "$f" ] && compare "$d" "$f"
    done
done

# native pixmaps vs the same pictures sent as iterio pictures, both through mgu-render
for k in index8 rgba; do
    o=$W/native-$k
    run "$B/mgu-render" "$W/synthetic/native-$k.bin" "$o"; a=$rc
    run "$B/mgu-render" "$W/synthetic/native-$k-ref.bin" "$o.ref"; b=$rc
    run "$B/ref-iterio" "$W/synthetic/native-$k-ref.bin" "$o.orig"; c=$rc
    n=$((n + 1))
    if [ $a = 0 ] && [ $b = 0 ] && [ $c = 0 ] && cmp -s "$o.rgba" "$o.ref.rgba" && cmp -s "$o.rgba" "$o.orig.rgba" &&
        grep -q 'native dialect' "$o.log"; then
        echo "ok   native/$k: pixmap regions + palette = the same pictures in both daemons"
    else
        echo "FAIL native/$k: exits $a $b $c"; sed 's/^/     /' "$o.log"; python3 "$S/pamdiff.py" "$o.ref.pam" "$o.pam"; fail=1
    fi
done

# the two originals cannot read each other's sessions: what the dialect detection is for
run "$B/ref-iterio" "$W/recorded/upstream/doom.bin" "$W/control-iterio"; a=$rc
run "$B/ref-upstream" "$W/recorded/iterio/screen-car-data-sketches-A_dash.bin" "$W/control-upstream"; b=$rc
if [ $a = 1 ] && [ $b = 1 ]; then
    echo "ok   control: IterioDev's daemon refuses upstream's doom, upstream's refuses IterioDev's screen"
else
    echo "FAIL control: exits $a $b (expected each original to refuse the other dialect)"; fail=1
fi

echo "$n replays, $([ $fail = 0 ] && echo 'all identical' || echo 'FAILURES')"
exit $fail
