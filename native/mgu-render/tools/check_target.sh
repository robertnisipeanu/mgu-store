#!/bin/sh
# Checks that BINARY loads on the head unit: ELF64 x86-64, loader /lib/ld-linux-x86-64.so.2 (the
# unit has no /lib64), only the unit's graphics libraries and glibc, no glibc symbol newer than 2.27.
set -eu
B=$1
fail=0
readelf -h "$B" | grep -q 'Class:.*ELF64' && readelf -h "$B" | grep -q 'Machine:.*X86-64' || { echo "FAIL  not ELF64 x86-64"; fail=1; }
interp=$(readelf -l "$B" | sed -n 's/.*Requesting program interpreter: \(.*\)]/\1/p')
[ "$interp" = /lib/ld-linux-x86-64.so.2 ] || { echo "FAIL  interpreter '$interp'"; fail=1; }
needed=$(readelf -d "$B" | sed -n 's/.*Shared library: \[\(.*\)\]/\1/p' | sort | tr '\n' ' ')
for n in $needed; do
    case $n in
    libwayland-client.so.0|libwayland-egl.so.1|libEGL.so.1|libGLESv2.so.2|libm.so.6|libc.so.6|libpthread.so.0) ;;
    *) echo "FAIL  needs $n"; fail=1 ;;
    esac
done
newest=$(objdump -T "$B" | grep -o 'GLIBC_2\.[0-9.]*' | sort -uV | tail -1)
case $newest in
GLIBC_2.2*|GLIBC_2.1*|GLIBC_2.0*) [ "$(printf '%s\n%s\n' "$newest" GLIBC_2.27 | sort -V | tail -1)" = GLIBC_2.27 ] || { echo "FAIL  needs $newest"; fail=1; } ;;
*) echo "FAIL  needs $newest"; fail=1 ;;
esac
[ $fail = 0 ] && echo "OK    $B: x86-64, $interp, needs $needed, glibc up to $newest ($(wc -c < "$B") bytes)"
exit $fail
