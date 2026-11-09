#!/bin/sh
# systemd/mgu-render-hmi.sh with a stand-in HmiMain3D, generator (node), widget folder and mount:
# the boot run only mounts a template made for this stamp and never generates; --build makes it
# (an earlier install stuck without one included), records a real failure and does not try again
# until the stamp changes, and tries again after a timeout, a signal, or a memory or disk error; under
# umask 077 the template and the boot's copy are readable by the HMI's user.
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
SCRIPT=$HERE/../systemd/mgu-render-hmi.sh
T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT
pass=0
ok() { if eval "$2"; then pass=$((pass + 1)); else echo "FAIL: $1"; exit 1; fi; }

ROOT=$T/opt/mgu-render
CUR=$ROOT/current
mkdir -p "$ROOT/versions/1" "$T/bin" "$T/widget" "$T/run"
ln -s versions/1 "$CUR"
cp "$SCRIPT" "$CUR/mgu-render-hmi.sh"
echo 'generator 1' > "$CUR/hmi_template.js"
echo 'embed_surface_id = 0x500' > "$CUR/mgu-render.conf"
head -c 4096 /dev/zero > "$T/HmiMain3D"
echo stock > "$T/widget/stock.pbw"
# node: records each run, then does what $T/mode says
cat > "$T/bin/node" <<EOF
#!/bin/sh
echo run >> "$T/gen.log"
while [ \$# -gt 1 ]; do [ "\$1" = --out ] && out=\$2; shift; done
case \$(cat "$T/mode") in
ok) echo template > "\$out/LT_State_A4A_WelcomeApp.pbw" ;;
fail) echo 'no eGfxIdParameter_titlebarH_ID7 in HmiMain3D' >&2; exit 1 ;;
sleep) sleep 30 ;;
kill) kill -9 \$\$ ;;
disk) echo 'ENOSPC: no space left on device, write' >&2; exit 3 ;;
esac
EOF
cat > "$T/bin/mount" <<EOF
#!/bin/sh
echo "mount \$*" >> "$T/mount.log"
EOF
chmod +x "$T/bin/node" "$T/bin/mount"
export MGU_RENDER_HMI=$T/HmiMain3D MGU_RENDER_WIDGETS=$T/widget MGU_RENDER_RUN=$T/run/hmi-widget \
	MGU_RENDER_MARKER=$T/run/hmi-template MGU_RENDER_NODE=$T/bin/node MGU_RENDER_BOOT=$T/run/boot MGU_RENDER_WAIT_S=0 \
	MGU_RENDER_SIN=$T/sin PATH=$T/bin:$PATH
runs() { cat "$T/gen.log" 2>/dev/null | wc -l | tr -d ' '; }
boot() { sh "$CUR/mgu-render-hmi.sh" "$CUR" "$ROOT/hmi"; }
build() { sh "$CUR/mgu-render-hmi.sh" --build; }
field() { sed -n "s/^\"$1\": //p" "$ROOT/status.json" | sed 's/,$//; s/^"//; s/"$//'; }

# an install stuck before: a template folder without a stamp (the boot generator timed out)
mkdir -p "$ROOT/hmi"
echo ok > "$T/mode"
boot
ok 'boot: no template for this stamp: nothing generated, nothing mounted, no marker' \
	'[ "$(runs)" = 0 ] && [ ! -e "$T/mount.log" ] && [ ! -e "$T/run/hmi-template" ]'
build
ok 'build: an install without a template makes it, status ok' \
	'[ "$(runs)" = 1 ] && [ -s "$ROOT/hmi/LT_State_A4A_WelcomeApp.pbw" ] && [ -s "$ROOT/hmi/stamp" ] && [ "$(field template)" = ok ] && [ "$(field problem)" = "" ]'
ok 'build: nothing left beside the template' '[ ! -e "$ROOT/hmi.new" ] && [ ! -e "$ROOT/hmi/log" ]'
boot
ok 'boot: the template for this stamp is mounted with the stock widgets, marker set' \
	'[ "$(runs)" = 1 ] && grep -q "mount --bind $T/run/hmi-widget $T/widget" "$T/mount.log" && [ -e "$T/run/hmi-template" ] &&
	 [ -e "$T/run/hmi-widget/stock.pbw" ] && [ -e "$T/run/hmi-widget/LT_State_A4A_WelcomeApp.pbw" ]'
build
ok 'build: a template in place for this stamp is not made again' '[ "$(runs)" = 1 ]'

# a real failure: recorded with the stamp and the reason, not retried until the stamp changes
echo 'generator 2' > "$CUR/hmi_template.js"
echo fail > "$T/mode"
build
ok 'build: a generator error is recorded with its reason, no retry' \
	'[ "$(runs)" = 2 ] && [ "$(field template)" = failed ] && [ "$(field retry)" = false ] &&
	 [ "$(field reason)" = "no eGfxIdParameter_titlebarH_ID7 in HmiMain3D" ] &&
	 [ "$(field problem)" = "In-page drawing unavailable: no eGfxIdParameter_titlebarH_ID7 in HmiMain3D" ] &&
	 [ "$(field stamp)" = "4096 $(stat -c %Y "$T/HmiMain3D") $(md5sum < "$CUR/hmi_template.js" | cut -d" " -f1) 0x500" ]'
ok 'build: a failed build leaves the earlier template in place' '[ -s "$ROOT/hmi/LT_State_A4A_WelcomeApp.pbw" ] && [ ! -e "$ROOT/hmi.new" ]'
rm -f "$T/mount.log" "$T/run/hmi-template"
boot
ok 'boot: the earlier template is for another stamp: not mounted, nothing generated' \
	'[ "$(runs)" = 2 ] && [ ! -e "$T/mount.log" ] && [ ! -e "$T/run/hmi-template" ]'
build
ok 'build: the same stamp after a real failure is not tried again' '[ "$(runs)" = 2 ] && [ "$(field template)" = failed ]'
echo 'embed_surface_id = 0x501' > "$CUR/mgu-render.conf"
build
ok 'build: another id is tried' '[ "$(runs)" = 3 ]'

# a timeout, a signal (out of memory) and a memory or disk error are tried again
echo 'generator 2b' > "$CUR/hmi_template.js"
echo sleep > "$T/mode"
MGU_RENDER_LIMIT=1 build
ok 'build: a timeout is recorded for a retry' \
	'[ "$(runs)" = 4 ] && [ "$(field template)" = failed ] && [ "$(field retry)" = true ] &&
	 [ "$(field reason)" = "the page template took longer than 1 s" ]'
echo kill > "$T/mode"
build
ok 'build: after a timeout it is tried again; a signal is recorded for a retry' \
	'[ "$(runs)" = 5 ] && [ "$(field retry)" = true ] && [ "$(field reason)" = "the page template generator stopped (signal 9)" ]'
echo disk > "$T/mode"
build
ok 'build: after a signal it is tried again; a memory or disk error is recorded for a retry' \
	'[ "$(runs)" = 6 ] && [ "$(field retry)" = true ] && [ "$(field reason)" = "ENOSPC: no space left on device, write" ]'
echo ok > "$T/mode"
build
ok 'build: after a memory or disk error it is tried again, and made' '[ "$(runs)" = 7 ] && [ "$(field template)" = ok ]'
# a build stopped with the install (status building) is tried again
printf '{\n"template": "building",\n"stamp": "x",\n"reason": "",\n"retry": true,\n"problem": ""\n}\n' > "$ROOT/status.json"
echo 'generator 3' > "$CUR/hmi_template.js"
build
ok 'build: a build left at building is made again' '[ "$(runs)" = 8 ] && [ "$(field template)" = ok ]'

# an install and a boot under umask 077: the template, its folder and the copy readable by the HMI's user
mode() { stat -c %a "$1"; }
echo 'generator 4' > "$CUR/hmi_template.js"
(umask 077 && build)
ok 'build under umask 077: the template readable, its folder searchable' \
	'[ "$(runs)" = 9 ] && [ "$(mode "$ROOT/hmi")" = 755 ] && [ "$(mode "$ROOT/hmi/LT_State_A4A_WelcomeApp.pbw")" = 644 ] &&
	 [ "$(mode "$ROOT/hmi/stamp")" = 644 ]'
# a stock folder the copy would take 0700 from, and a stock widget with a mode of its own
chmod 0700 "$T/widget"; chmod 0640 "$T/widget/stock.pbw"
(umask 077 && boot)
ok 'boot under umask 077: the copy and its template readable, the stock widgets as they were' \
	'[ "$(mode "$T/run/hmi-widget")" = 755 ] && [ "$(mode "$T/run/hmi-widget/LT_State_A4A_WelcomeApp.pbw")" = 644 ] &&
	 [ "$(mode "$T/run/hmi-widget/stock.pbw")" = 640 ]'
chmod 0755 "$T/widget"; chmod 0644 "$T/widget/stock.pbw"
# a template an earlier install left unreadable: made readable by the next install, not made again
chmod 0700 "$ROOT/hmi"; chmod 0600 "$ROOT/hmi/LT_State_A4A_WelcomeApp.pbw" "$ROOT/hmi/stamp"
(umask 077 && build)
ok 'build: an unreadable template in place for this stamp is made readable, not made again' \
	'[ "$(runs)" = 9 ] && [ "$(mode "$ROOT/hmi")" = 755 ] && [ "$(mode "$ROOT/hmi/LT_State_A4A_WelcomeApp.pbw")" = 644 ]'
chmod 0600 "$ROOT/hmi/LT_State_A4A_WelcomeApp.pbw"
(umask 077 && boot)
ok 'boot: an unreadable template is copied readable' '[ "$(mode "$T/run/hmi-widget/LT_State_A4A_WelcomeApp.pbw")" = 644 ]'

# iDrive 8: no HmiMain3D
rm "$T/HmiMain3D"
build
ok 'build: no HmiMain3D, no template and no status' '[ "$(runs)" = 9 ] && [ ! -e "$ROOT/status.json" ]'
boot
ok 'boot: no HmiMain3D, nothing mounted' '[ "$(runs)" = 9 ]'

# the generator's error is one line: exit status 1 for HmiMain3D lacking identifiers, 3 for anything else
if PATH=${PATH#$T/bin:} command -v node >/dev/null 2>&1; then
	head -c 4096 /dev/zero > "$T/zero"
	rc=0
	msg=$(PATH=${PATH#$T/bin:} node "$HERE/../js/hmi_template.js" --hmi "$T/zero" --out "$T" 2>&1) || rc=$?
	ok 'generator: no identifiers in the binary is one line, exit status 1' '[ $rc = 1 ] && [ "$msg" = "no identifier table in HmiMain3D" ]'
	rc=0
	msg=$(PATH=${PATH#$T/bin:} node "$HERE/../js/hmi_template.js" --hmi "$T/missing" --out "$T" 2>&1) || rc=$?
	ok 'generator: any other error is one line, exit status 3' '[ $rc = 3 ] && [ "$(echo "$msg" | wc -l)" = 1 ]'
fi
echo "test_hmi: $pass checks pass"
