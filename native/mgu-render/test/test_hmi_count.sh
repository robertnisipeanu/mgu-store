#!/bin/sh
# systemd/mgu-render-hmi.sh's boot count with a stand-in HmiMain3D, widget folder, mount, systemctl, boot id,
# /proc and the restart records of recmgr and crashhandler: a boot that mounts the template and is never
# confirmed healthy counts one failure only when a restart record names the HMI; two such boots in a row stop
# the mount until the template changes; a confirmed boot clears the count; switch-offs, restarts asked for,
# orderly reboots, power cuts, other programs' restarts and slow HMIs count nothing; an unreadable count mounts.
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
SCRIPT=$HERE/../systemd/mgu-render-hmi.sh
T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT
pass=0
ok() { if eval "$2"; then pass=$((pass + 1)); else echo "FAIL: $1"; cat "$T/log" 2>/dev/null; exit 1; fi; }

ROOT=$T/opt/mgu-render
CUR=$ROOT/current
mkdir -p "$ROOT/versions/1" "$T/bin" "$T/widget" "$T/run" "$T/sin/recmgr" "$T/sin/crashhandler" "$T/proc/700" "$T/proc/701"
ln -s versions/1 "$CUR"
cp "$SCRIPT" "$CUR/mgu-render-hmi.sh"
echo 'generator 1' > "$CUR/hmi_template.js"
echo 'embed_surface_id = 0x500' > "$CUR/mgu-render.conf"
head -c 4096 /dev/zero > "$T/HmiMain3D"
echo stock > "$T/widget/stock.pbw"
cat > "$T/bin/node" <<EOF
#!/bin/sh
while [ \$# -gt 1 ]; do [ "\$1" = --out ] && out=\$2; shift; done
echo template > "\$out/LT_State_A4A_WelcomeApp.pbw"
EOF
cat > "$T/bin/mount" <<EOF
#!/bin/sh
echo "mount \$*" >> "$T/mount.log"
EOF
# systemctl: hmi.service as $T/hmi says ("<state> <pid> <start>"), the system as $T/system, shutdown.target's job as $T/job
cat > "$T/bin/systemctl" <<EOF
#!/bin/sh
case "\$1 \$2" in
"show hmi.service") read -r a p s < "$T/hmi"; printf 'MainPID=%s\nActiveState=%s\nExecMainStartTimestampMonotonic=%s\n' "\$p" "\$a" "\$s" ;;
"show shutdown.target") printf 'Job=%s\n' "\$(cat "$T/job")" ;;
"is-system-running "*) cat "$T/system" ;;
*) exit 1 ;;
esac
EOF
chmod +x "$T/bin/node" "$T/bin/mount" "$T/bin/systemctl"
echo HmiMain3D > "$T/proc/700/comm"
echo HmiMain3D > "$T/proc/701/comm"
echo running > "$T/system"
: > "$T/job"
echo 'inactive 0 0' > "$T/hmi"
export MGU_RENDER_HMI=$T/HmiMain3D MGU_RENDER_WIDGETS=$T/widget MGU_RENDER_RUN=$T/run/hmi-widget \
	MGU_RENDER_MARKER=$T/run/hmi-template MGU_RENDER_NODE=$T/bin/node MGU_RENDER_SIN=$T/sin \
	MGU_RENDER_BOOT=$T/run/boot MGU_RENDER_PROC=$T/proc \
	MGU_RENDER_SYSTEMCTL=$T/bin/systemctl MGU_RENDER_WAIT_S=0 MGU_RENDER_POLL_S=1 MGU_RENDER_HEALTHY_S=0 PATH=$T/bin:$PATH
# A call of run with a variable set before it goes in a subshell: ash keeps such a variable after a function call.
run() { sh "$CUR/mgu-render-hmi.sh" "$@" "$CUR" "$ROOT/hmi" >> "$T/log" 2>&1; }
build() { sh "$CUR/mgu-render-hmi.sh" --build >> "$T/log" 2>&1; }
get() { sed -n "s/^$1=//p" "$ROOT/hmi-boot"; }
field() { sed -n "s/^\"$1\": //p" "$ROOT/status.json" | sed 's/,$//; s/^"//; s/"$//'; }
mounted() { [ -s "$T/mount.log" ] && [ -e "$T/run/hmi-template" ]; }

# A new boot of the head unit: /run starts empty (the boot run makes its id), nothing mounted.
newboot() {
	rm -f "$T/run/boot" "$T/run/hmi-template" "$T/mount.log"
	echo 'inactive 0 0' > "$T/hmi"
	echo running > "$T/system"
	: > "$T/job"
	: > "$T/log"
}
# What recmgr and crashhandler write when they ask for a head-unit restart, naming $1 and $2; each new
# one a second later than the one before, as records of different boots are.
written=$(date +%s)
records() {
	written=$((written + 1))
	for f in recmgr:"$1" crashhandler:"$2"; do
		printf '<RestartInfo>\n    <ServiceName value="%s"/>\n    <Result value="core-dump"/>\n    <FailureID value="f84ec646b38f7ea4"/>\n    <LifeCycle value="0"/>\n</RestartInfo>\n' \
			"${f#*:}" > "$T/sin/${f%%:*}/restartInfo.xml"
		touch -d "@$written" "$T/sin/${f%%:*}/restartInfo.xml"
	done
}
# each deletes its own record when it starts in the next boot
clear_records() { rm -f "$T/sin/recmgr/restartInfo.xml" "$T/sin/crashhandler/restartInfo.xml"; }
# a NodeStateManager shutdown: var-opt-ro.service's drop-in, then the next boot
nsm_down() { run --shutdown; newboot; }
# the HMI crashes, recmgr and crashhandler ask for the restart, the shutdown runs, the next boot starts
hmi_crash() { records hmi.service HmiMain3D; nsm_down; }
# the boot step and, after it, recmgr and crashhandler deleting their records
boot() { run; clear_records; }
# the HMI up and healthy: --confirm sees the same run active twice
healthy() { echo 'active 700 5000000' > "$T/hmi"; (MGU_RENDER_WAIT_S=2 run --confirm); }

newboot
build
ok 'build: the template made' '[ -s "$ROOT/hmi/LT_State_A4A_WelcomeApp.pbw" ] && [ "$(field template)" = ok ] && [ "$(field hmi)" = "" ]'

boot
ok 'first boot: mounted, counted from 0' \
	'mounted && [ "$(get state)" = mounted ] && [ "$(get fails)" = 0 ] && [ -s "$T/run/boot" ] && [ "$(get boot)" = "$(cat "$T/run/boot")" ] &&
	 [ "$(get template)" = "$(cat "$ROOT/hmi/stamp") $(cat "$ROOT/hmi"/*.pbw | md5sum | cut -d" " -f1)" ]'
healthy
ok 'confirm: the same HmiMain3D run active after the window: confirmed' '[ "$(get state)" = confirmed ] && [ "$(get fails)" = 0 ]'
run --shutdown
ok 'shutdown: a confirmed boot leaves no shutdown record' '[ ! -e "$ROOT/hmi-shutdown" ]'
newboot

# one HMI crash: counted, mounted again
boot
was=$(cat "$T/run/boot")
hmi_crash
ok 'shutdown: an HMI restart recorded for the mounted boot' \
	'[ "$(cut -d" " -f2 "$ROOT/hmi-shutdown")" = hmi ] && [ "$(cut -d" " -f1 "$ROOT/hmi-shutdown")" = "$was" ]'
boot
ok 'one HMI restart of an unconfirmed boot: failure 1, mounted again' \
	'mounted && [ "$(get fails)" = 1 ] && [ "$(get state)" = mounted ] && grep -q "failure 1 of 2" "$T/log"'

# none of these count
nsm_down
boot
ok 'a switch-off or a restart asked for (no restart record) before the confirmation: not counted' \
	'mounted && [ "$(get fails)" = 1 ] && grep -q "not counted" "$T/log"'
newboot
boot
ok 'a power cut (no shutdown record, no restart record): not counted' 'mounted && [ "$(get fails)" = 1 ]'
records hmi HmiMain3D
echo stopping > "$T/system"
run --stop
newboot
boot
ok 'an orderly reboot (systemd stopping) with the HMI dumped on its way down: not counted' \
	'mounted && [ "$(get fails)" = 1 ]'
records hmi.service HmiMain3D
echo 42 > "$T/job"
run --stop
ok 'an orderly reboot (shutdown.target queued): marked clean' '[ "$(get state)" = clean ]'
newboot
boot
ok 'an orderly reboot (shutdown.target queued) with HMI restart records written after the mount: not counted' \
	'mounted && [ "$(get fails)" = 1 ]'
records vsomeipd vsomeipd
nsm_down
boot
ok 'a restart for another program: not counted' 'mounted && [ "$(get fails)" = 1 ] && grep -q "other (its shutdown record)" "$T/log"'
# a slow HMI: not active yet when the switch-off comes, then healthy at the next start
echo 'activating 700 5000000' > "$T/hmi"
(MGU_RENDER_WAIT_S=1 run --confirm)
ok 'a slow HMI: unconfirmed, nothing written' '[ "$(get state)" = mounted ] && grep -q "not active within 1 s" "$T/log"'
nsm_down
boot
ok 'a slow HMI switched off: not counted' 'mounted && [ "$(get fails)" = 1 ]'
run --stop
ok 'stop outside a system stop (an uninstall): nothing written' '[ "$(get state)" = mounted ]'

# --confirm only for the same, unbroken HmiMain3D run with the template in place
echo 'active 700 5000000' > "$T/hmi"
# seen at 1 s, then another run (HmiMain3D too) from 2 s, checked at 4 s
( sleep 2; echo 'active 701 9000000' > "$T/hmi" ) &
(MGU_RENDER_WAIT_S=2 MGU_RENDER_HEALTHY_S=3 run --confirm)
wait
ok 'confirm: another HmiMain3D run at the end of the window: unconfirmed' '[ "$(get state)" = mounted ] && [ "$(get fails)" = 1 ]'
echo 'active 702 5000000' > "$T/hmi"
(MGU_RENDER_WAIT_S=2 run --confirm)
ok 'confirm: a main PID that is not HmiMain3D: unconfirmed' '[ "$(get state)" = mounted ]'
echo 'failed 0 0' > "$T/hmi"
(MGU_RENDER_WAIT_S=2 run --confirm)
ok 'confirm: hmi.service failed: unconfirmed' '[ "$(get state)" = mounted ] && grep -q "hmi.service failed" "$T/log"'
rm -f "$T/run/hmi-template"
healthy
ok 'confirm: the template no longer in place: unconfirmed' '[ "$(get state)" = mounted ]'
touch "$T/run/hmi-template"

# a healthy boot clears the count
healthy
ok 'a healthy boot clears the count' '[ "$(get state)" = confirmed ] && [ "$(get fails)" = 0 ]'
hmi_crash
run
ok 'an HMI restart after the confirmation: not counted' 'mounted && [ "$(get fails)" = 0 ]'
nsm_down
run
ok 'restart records already there at the mount (a switch-off before their owners deleted them): not counted' \
	'mounted && [ "$(get fails)" = 0 ] && grep -q "none (its shutdown record)" "$T/log"'
clear_records
hmi_crash
boot
ok 'after a healthy boot, one HMI restart is failure 1 again' 'mounted && [ "$(get fails)" = 1 ]'

# with no shutdown record (the IOC reset the unit before var-opt-ro.service), the records still on disk count
records vsomeipd.service HmiMain3D
newboot
boot
ok 'no shutdown record, an HMI restart record written in that boot: failure 2, not mounted, marked failed' \
	'! mounted && [ ! -e "$T/run/hmi-template" ] && [ "$(get state)" = failed ] && [ "$(get fails)" = 2 ] &&
	 grep -q "failure 2 of 2" "$T/log" && grep -q "not mounted" "$T/log"'
ok 'failed: status.json says so, its build fields kept' \
	'[ "$(field hmi)" = failed ] && [ "$(field template)" = ok ] && [ "$(field retry)" = false ] &&
	 [ "$(field stamp)" = "$(cat "$ROOT/hmi/stamp")" ] && [ "$(field problem)" = "In-page drawing unavailable: the HMI failed with the page template" ]'
run --shutdown
ok 'failed: no shutdown record written' '[ "$(cut -d" " -f1 "$ROOT/hmi-shutdown")" != "$(cat "$T/run/boot")" ]'
nsm_down
boot
newboot
boot
ok 'failed: later boots do not mount it either' '! mounted && [ "$(get state)" = failed ]'
build
ok 'failed: an install with the same template keeps it failed' '[ "$(get state)" = failed ]'
newboot
boot
ok 'failed: status.json says so again after an install rewrote it' '! mounted && [ "$(field hmi)" = failed ]'

# a new template clears the mark: a regenerated .pbw, then another generator; another mgu-render version does not
echo 'template 2' > "$ROOT/hmi/LT_State_A4A_WelcomeApp.pbw"
newboot
boot
ok 'a regenerated template (another hash): mounted, counted from 0, status.json cleared' \
	'mounted && [ "$(get state)" = mounted ] && [ "$(get fails)" = 0 ] && [ "$(field hmi)" = "" ] && [ "$(field problem)" = "" ] &&
	 grep -q "mounted no more" "$T/log"'
hmi_crash
boot
hmi_crash
boot
ok 'two HMI restarts in a row: marked failed again' '! mounted && [ "$(get state)" = failed ]'
mkdir -p "$ROOT/versions/2"
cp -a "$CUR"/. "$ROOT/versions/2/"
rm "$CUR"
ln -s versions/2 "$CUR"
newboot
boot
ok 'another mgu-render version with the same template: still failed, not mounted' '! mounted && [ "$(get state)" = failed ]'
echo 'generator 2' > "$CUR/hmi_template.js"
build
newboot
boot
ok 'another generator: mounted, counted from 0' 'mounted && [ "$(get fails)" = 0 ] && [ "$(get state)" = mounted ]'
hmi_crash
boot
hmi_crash
boot
ok 'marked failed again' '! mounted && [ "$(get state)" = failed ]'

# a template marked failed is never mounted
newboot
(MGU_RENDER_BOOT=$T/HmiMain3D/boot run)
ok 'failed, no boot id: not mounted' '! mounted && [ "$(get state)" = failed ]'
newboot
# a firmware update: another HmiMain3D, no template for it until the next install
touch -d @1000000000 "$T/HmiMain3D"
boot
ok 'failed, then another HmiMain3D: status.json no longer says failed' \
	'! mounted && [ "$(field hmi)" = "" ] && [ "$(field problem)" = "" ] && [ "$(field template)" = ok ]'
build
newboot
boot
ok 'another HmiMain3D, its template made: mounted, counted from 0' 'mounted && [ "$(get fails)" = 0 ] && [ "$(get state)" = mounted ]'

# unreadable state: mounts
printf 'template=\001garbage\nfails=x\n' > "$ROOT/hmi-boot"
newboot
boot
ok 'a corrupt count: mounted, counted from 0' 'mounted && [ "$(get fails)" = 0 ] && [ "$(get state)" = mounted ] && grep -q "unreadable" "$T/log"'
rm -f "$ROOT/hmi-boot"
newboot
boot
ok 'no count: mounted, counted from 0' 'mounted && [ "$(get fails)" = 0 ]'
echo 'garbage' > "$ROOT/hmi-shutdown"
hmi_crash
ok 'shutdown: a corrupt shutdown record is replaced' '[ "$(cut -d" " -f2 "$ROOT/hmi-shutdown")" = hmi ]'
printf '\377\376 junk\n' > "$ROOT/hmi-shutdown"
records hmi HmiMain3D
newboot
boot
ok 'a corrupt shutdown record: the records on disk decide' 'mounted && [ "$(get fails)" = 1 ]'
nsm_down
(MGU_RENDER_BOOT=$T/HmiMain3D/boot run)
ok 'no boot id: mounted, the count left as it was' 'mounted && [ "$(get fails)" = 1 ] && [ "$(get state)" = mounted ]'
newboot
mkdir "$ROOT/hmi-boot.tmp"
boot
ok 'a count that cannot be written: mounted' 'mounted && grep -q "not written" "$T/log"'
rmdir "$ROOT/hmi-boot.tmp"

# a restart record rewritten within the second it was seen in at the mount
rm -f "$ROOT/hmi-boot"
records vsomeipd.service vsomeipd
newboot
run
printf '<RestartInfo>\n    <ServiceName value="hmi.service"/>\n</RestartInfo>\n' > "$T/sin/recmgr/restartInfo.xml"
touch -d "@$written" "$T/sin/recmgr/restartInfo.xml"
nsm_down
boot
ok 'a restart record rewritten with the same modification time: counted' 'mounted && [ "$(get fails)" = 1 ]'

# iDrive 8: no HmiMain3D, no count
rm -f "$ROOT/hmi-boot"
mv "$T/HmiMain3D" "$T/HmiMain3D.away"
newboot
boot
ok 'no HmiMain3D: nothing mounted, no count' '! mounted && [ ! -e "$ROOT/hmi-boot" ]'
echo "test_hmi_count: $pass checks pass"
