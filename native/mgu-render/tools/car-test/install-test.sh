#!/usr/bin/env bash
# A temporary test install of this branch's mgu-render and Store (each when the branch has a newer one)
# on the head unit, the measurements around it, and the restore to the published versions.
# Runs on the Mac from a mgu-store checkout; reaches the unit through deploy/hu connect.
#
#   install-test.sh status                      installed versions, the running renderer, test settings
#   install-test.sh install                     record the installed versions, then install HEAD's build
#   install-test.sh restore                     put the published versions back and check them
#   install-test.sh restart --off-screen        restart mgu-render (no app may be on screen)
#   install-test.sh reboot --off-screen         restart the head unit as the Store's Restart head
#                                               unit does, and wait until it is back
#   install-test.sh ab [key=value...]           test settings for mgu-render's next start; none: clear
#   install-test.sh stats on|off                mgu-render's per-second stats lines in its journal
#   install-test.sh probe <probe.js args...>    run probe.js on the unit (output saved in results/)
#   install-test.sh drag <name> [seconds]       probe cpu while the owner drags, plus the journal's
#                                               stats lines of that window
#   install-test.sh sh '<command>'              run a command on the unit
#
# The target goes after "--": --car (the car over ENET, else its hotspot; with deploy/hu's --wifi,
# --hu-ip, --iface as needed), or --host <addr> --port <n> with --identity and --ssh-opt (a
# test unit). Nothing connects without one. MGU_CAR_TEST_DIR (default ~/.cache/mgu-store/car-test) holds the record of the
# installed versions, the published copy and the results.
set -euo pipefail

KIT=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$KIT/../../../.." && pwd)
STATE=${MGU_CAR_TEST_DIR:-$HOME/.cache/mgu-store/car-test}
TEST="$STATE/test"                       # present while a test install is in place
RESULTS="$STATE/results"
LPORT=${MGU_CAR_TEST_LPORT:-2224}
DEPLOY=/var/opt/mgu-deploy/mgu-deploy.sh
UNIT_TMP=/tmp/mgu-car-test
UNIT_PROBE=/tmp/mgu-car-test-probe.js
DROPIN_DIR=/run/systemd/system/mgu-render.service.d
DROPIN=$DROPIN_DIR/car-test.conf
STATS_FILE=/run/mgu-render/stats-log
STORE_STATS=/dev/shm/robertn_store-stats.log    # the Store's own per-second line while stats-log is on
RENDER_TRACE=/run/mgu-render/trace.log          # the per-frame trace (trace.js), mgu-render's and the Store's
STORE_TRACE=/dev/shm/robertn_store-trace.log
AB_KEYS="embed_zero_copy tick_early readback_pbo embed_finish fps fps.robertn_store verbose"
# on the unit: what a pid runs (its binary, else its command line)
# shellcheck disable=SC2016
RUNS_FN='runs() { e=$(readlink /proc/$1/exe 2>/dev/null); case "$e" in *mgu-render*) printf "%s" "$e" ;; *) tr "\0" " " </proc/$1/cmdline ;; esac; }'

say() { printf '%s\n' "$*"; }
die() { printf 'install-test: %s\n' "$1" >&2; exit "${2:-1}"; }

CMD=${1:-help}
[ $# -gt 0 ] && shift
ARGS=()
CONN=()
while [ $# -gt 0 ]; do
	if [ "$1" = "--" ]; then shift; CONN=("$@"); break; fi
	ARGS+=("$1"); shift
done
nargs=${#ARGS[@]}
# The target is named: --car (deploy/hu finds the car over ENET, else its hotspot), or
# --host (a test unit, or a car by address), never the default by omission.
TARGET=
CONN2=()
for c in ${CONN[@]+"${CONN[@]}"}; do
	case "$c" in
		--car) TARGET=car ;;
		--host) TARGET=${TARGET:-host}; CONN2+=("$c") ;;
		*) CONN2+=("$c") ;;
	esac
done
CONN=(${CONN2[@]+"${CONN2[@]}"})
if [ -z "$TARGET" ] && [ -n "${HU_HOST:-}" ]; then TARGET=host; fi
arg() { if [ "$nargs" -gt "$1" ]; then printf '%s' "${ARGS[$1]}"; fi; }

# ---- connection ---------------------------------------------------------------------------------

SSH=()
LINK_PID=
LINK_DIR=
close_link() {
	if [ -n "$LINK_PID" ]; then kill "$LINK_PID" 2>/dev/null || true; wait "$LINK_PID" 2>/dev/null || true; fi
	[ -n "$LINK_DIR" ] && rm -rf "$LINK_DIR"
	LINK_PID=
}
open_link() {
	[ -n "$TARGET" ] || die "name the target after --: --car for the car (ENET, else its hotspot), or --host <addr> --port <n> ... for a test unit" 2
	LINK_DIR=$(mktemp -d /tmp/mgu-car-test-link.XXXXXX)
	trap close_link EXIT
	"$REPO/deploy/hu" connect --lport "$LPORT" --hold 7200 ${CONN[@]+"${CONN[@]}"} \
		>"$LINK_DIR/out" 2>"$LINK_DIR/err" </dev/null &
	LINK_PID=$!
	local i=0 line=
	while :; do
		line=$(head -n 1 "$LINK_DIR/out" 2>/dev/null || true)
		case "$line" in ssh\ *) break ;; esac
		if ! kill -0 "$LINK_PID" 2>/dev/null; then
			cat "$LINK_DIR/err" >&2
			die "no connection to the unit (deploy/hu connect)"
		fi
		i=$((i + 1))
		[ $i -le 240 ] || { cat "$LINK_DIR/err" >&2; die "no connection to the unit after 120 s"; }
		sleep 0.5
	done
	eval "SSH=($line)"
}
on_unit() { "${SSH[@]}" "$1" </dev/null; }
upload() { "${SSH[@]}" "cat > '$2'" <"$1"; }
unit_sha256() {
	on_unit "node -e 'process.stdout.write(require(\"crypto\").createHash(\"sha256\").update(require(\"fs\").readFileSync(process.argv[1])).digest(\"hex\"))' '$1'"
}
local_sha256() { shasum -a 256 "$1" | cut -d' ' -f1; }

# The deploy tool's status --json and mgu-render's installed manifest, into $1/status.json and
# $1/mgu-render.component.json.
record_unit() {
	mkdir -p "$1"
	on_unit "sh $DEPLOY status --json" >"$1/status.json" || return 1
	node -e 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))' "$1/status.json" 2>/dev/null || return 1
	on_unit "cat /var/opt/mgu-render/current/component.json" >"$1/mgu-render.component.json" || return 1
	[ -s "$1/mgu-render.component.json" ]
}

# What the unit's mgu-render runs: the running daemon's binary, and the test settings.
show_renderer() {
	on_unit "$RUNS_FN
		pid=\$(systemctl show -p MainPID mgu-render.service | cut -d= -f2)
		printf 'mgu-render.service: %s' \"\$(systemctl is-active mgu-render.service || true)\"
		if [ -n \"\$pid\" ] && [ \"\$pid\" != 0 ]; then printf ', pid %s, runs %s\n' \"\$pid\" \"\$(runs \$pid)\"; else echo; fi
		echo \"current: \$(readlink /var/opt/mgu-render/current)\"
		if [ -f $DROPIN ]; then echo 'test settings (next start):'; sed -n 's/^ExecStart=./  &/p' $DROPIN; else echo 'test settings: none'; fi
		if [ -e $STATS_FILE ]; then echo 'stats-log: on'; else echo 'stats-log: off'; fi
		if [ -n \"\$pid\" ] && [ \"\$pid\" != 0 ]; then journalctl -b _PID=\$pid -o cat 2>/dev/null | grep -E 'embed: (zero-copy|readback)' | tail -n 3; fi
		true"
}

# ---- commands -----------------------------------------------------------------------------------

cmd_status() {
	open_link
	local d
	d=$(mktemp -d /tmp/mgu-car-test-status.XXXXXX)
	record_unit "$d" || die "could not read the unit's status"
	node "$KIT/kit.js" versions "$d/status.json"
	show_renderer
	if [ -d "$TEST" ]; then
		say "test install in place since $(cat "$TEST/at"): $(tr '\n' ' ' <"$TEST/installed")(restore puts back the versions in $TEST)"
	else
		say "no test install recorded"
	fi
	rm -rf "$d"
}

cmd_install() {
	[ ! -d "$TEST" ] || die "a test install is in place already ($TEST); run restore first" 2
	if [ -n "$(git -C "$REPO" status --porcelain --untracked-files=no -- native/mgu-render apps/robertn_store)" ]; then
		die "native/mgu-render or apps/robertn_store has uncommitted changes; the test build is HEAD's: commit first" 2
	fi
	local head work
	head=$(git -C "$REPO" rev-parse HEAD)
	work=$(mktemp -d /tmp/mgu-car-test-install.XXXXXX)

	say "== the unit's installed versions"
	open_link
	record_unit "$work/before" || die "could not record the installed versions; nothing installed" 2
	node "$KIT/kit.js" versions "$work/before/status.json"

	say "== the published release (a stick copy, every artifact checked against the catalog)"
	mkdir -p "$STATE/published"
	node "$REPO/deploy/mgu-install.js" usb-repo "$STATE/published" || die "could not copy the published release; nothing installed" 2
	local pub="$STATE/published/mgu-repo/mgu-store"
	[ -f "$pub/catalog.json" ] || die "no catalog in $pub; nothing installed" 2
	# in a clone of HEAD, so the checkout is left as it is; with the release commit stamp makes, so a
	# changed mgu-render carries the version its release gives it
	if ! { git clone -q --no-checkout "$REPO" "$work/src" && git -C "$work/src" checkout -q --detach "$head"; }; then
		die "could not clone HEAD for the build; nothing installed" 2
	fi
	(cd "$work/src" && MGU_RELEASE_LABELS=off node release/release.js stamp >/dev/null) || die "could not stamp the next versions; nothing installed" 2
	node "$KIT/kit.js" plan "$work/src" "$work/before/status.json" "$pub/catalog.json" >"$work/plan.json" || exit 2
	node -e 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).notes.forEach((n) => console.log(n))' "$work/plan.json"
	# an mgu-render this test replaces must be the published artifact byte for byte, or restore could
	# not put it back
	local pub_render
	pub_render=$(node -e 'const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).restore.find((x) => x.id === "mgu-render"); console.log(r ? r.artifact : "")' "$work/plan.json")
	if [ -n "$pub_render" ]; then
		tar -xzOf "$pub/$pub_render" component.json >"$work/published-render.component.json"
		cmp -s "$work/published-render.component.json" "$work/before/mgu-render.component.json" ||
			die "the unit's mgu-render is not the published $pub_render; nothing installed" 2
	fi

	say "== building HEAD ($head)"
	local ids
	ids=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).install.map((a) => a.id).join(" "))' "$work/plan.json")
	# shellcheck disable=SC2086
	(cd "$work/src" && node release/release.js build $ids) || die "the build failed; nothing installed" 2

	say "== uploading"
	on_unit "rm -rf $UNIT_TMP && mkdir -p $UNIT_TMP"
	local flags="" a f
	for a in $(node -e 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).install.forEach((a) => console.log(a.artifact))' "$work/plan.json"); do
		f="$work/src/release/out/$a"
		[ -f "$f" ] || die "the build did not produce $a; nothing installed" 2
		upload "$f" "$UNIT_TMP/$a"
		[ "$(unit_sha256 "$UNIT_TMP/$a")" = "$(local_sha256 "$f")" ] || die "$a arrived damaged; nothing installed" 2
		flags="$flags --artifact $UNIT_TMP/$a"
		say "$a $(local_sha256 "$f")"
	done

	# the record restore works from, kept before anything changes
	mkdir -p "$STATE"
	mv "$work/before" "$TEST"
	cp "$work/plan.json" "$TEST/plan.json"
	echo "$head" >"$TEST/head"
	date '+%Y-%m-%d %H:%M:%S' >"$TEST/at"
	node -e 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).install.forEach((a) => console.log(a.id + " " + a.version))' "$work/plan.json" >"$TEST/installed"
	rm -rf "$work"

	say "== installing with the unit's deploy tool"
	local rc=0
	on_unit "sh $DEPLOY install$flags --yes" || rc=$?
	on_unit "rm -rf $UNIT_TMP" || true
	say "== now"
	show_renderer
	[ $rc -eq 0 ] || die "the install failed (exit $rc); the deploy tool rolled it back. Run restore to check the versions" $rc
	if [ -n "$pub_render" ]; then
		say "Installed. mgu-render runs the test build from its next start: with no app on screen, $0 restart --off-screen when the unit's mgu-render draws zero-copy (k status: embed: zero-copy), else $0 reboot --off-screen"
	else
		say "Installed. The Store runs the test build from its next opening; mgu-render stays as it is (no restart)"
	fi
}

cmd_restore() {
	[ -d "$TEST" ] || die "no test install recorded in $TEST; nothing to restore" 2
	local pub="$STATE/published/mgu-repo/mgu-store"
	open_link
	say "== clearing the test settings"
	ab_clear
	on_unit "rm -f $STATS_FILE $STORE_STATS $RENDER_TRACE $STORE_TRACE"

	say "== uploading the published versions"
	on_unit "rm -rf $UNIT_TMP && mkdir -p $UNIT_TMP"
	local flags="" a sha store=0
	while read -r a sha; do
		[ -f "$pub/$a" ] || die "the published copy has no $a ($pub)"
		[ "$(local_sha256 "$pub/$a")" = "$sha" ] || die "$pub/$a does not match the catalog"
		upload "$pub/$a" "$UNIT_TMP/$a"
		[ "$(unit_sha256 "$UNIT_TMP/$a")" = "$sha" ] || die "$a arrived damaged"
		flags="$flags --artifact $UNIT_TMP/$a"
		case "$a" in robertn_store@*) store=1 ;; esac
	done < <(node -e 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).restore.forEach((r) => console.log(r.artifact + " " + r.sha256))' "$TEST/plan.json")

	if [ $store -eq 1 ]; then
		# an app has no rollback and no downgrade: the test Store goes, then the published one installs. A restore
		# that stopped after the uninstall finds no Store, or the published one: nothing to remove then.
		local have want now
		want=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).restore.filter((r) => r.id === "robertn_store")[0].version)' "$TEST/plan.json")
		now=$(mktemp /tmp/mgu-car-test-now.XXXXXX)
		on_unit "sh $DEPLOY status --json" >"$now" || { rm -f "$now"; die "could not read the unit's status; run restore again"; }
		have=$(node "$KIT/kit.js" versions "$now" | sed -n 's/^robertn_store //p')
		rm -f "$now"
		if [ -n "$have" ] && [ "$have" != - ] && [ "$have" != "$want" ]; then
			say "== removing the test Store ($have)"
			on_unit "sh $DEPLOY uninstall robertn_store --yes" || die "the Store's uninstall failed; run restore again"
		fi
	fi
	say "== installing the published versions"
	on_unit "sh $DEPLOY install$flags --yes" || die "the install of the published versions failed; run restore again"
	on_unit "rm -rf $UNIT_TMP" || true

	say "== checking"
	local d ok=1
	d=$(mktemp -d /tmp/mgu-car-test-after.XXXXXX)
	record_unit "$d" || die "could not read the unit's status after the restore"
	node "$KIT/kit.js" verify "$TEST/status.json" "$d/status.json" || ok=0
	if cmp -s "$TEST/mgu-render.component.json" "$d/mgu-render.component.json"; then
		say "same     mgu-render files: the published manifest, every file's sha256"
	else
		say "DIFFERS  mgu-render files: current/component.json is not the one recorded before"; ok=0
	fi
	show_renderer
	[ $ok -eq 1 ] || die "the unit does not match the record in $TEST; run restore again"
	local done_dir
	done_dir="$STATE/restored-$(date '+%Y%m%d-%H%M%S')"
	mv "$TEST" "$done_dir"
	rm -rf "$d"
	if grep -q '^mgu-render ' "$done_dir/installed"; then
		say "Restored (record moved to $done_dir). The published mgu-render runs from its next start: with no app on screen, $0 restart --off-screen (after a readback run in this HMI run: $0 reboot --off-screen)"
	else
		say "Restored (record moved to $done_dir). mgu-render was not changed: no restart"
	fi
}

cmd_restart() {
	[ "$(arg 0)" = "--off-screen" ] || die "restart needs --off-screen: first make sure no app is on screen (the Store and every renderer app closed, HOME or another stock screen shown). Stopping mgu-render while an app's surface is up can restart the head unit" 2
	open_link
	local out
	out=$(on_unit "pid=\$(systemctl show -p MainPID mgu-render.service | cut -d= -f2)
		if [ \"\$(systemctl is-active mgu-render.service || true)\" != active ] || [ -z \"\$pid\" ] || [ \"\$pid\" = 0 ]; then echo NOT-RUNNING; exit 0; fi
		if [ -f /etc/recmgr-restartlist.conf ] && ! grep -qE '^[[:space:]]*mgu-render[[:space:]]*\$' /etc/recmgr-restartlist.conf; then echo NO-RECMGR; exit 0; fi
		j=\$(journalctl -b _PID=\$pid -o cat 2>/dev/null) && [ -n \"\$j\" ] || { echo NO-JOURNAL; exit 0; }
		if printf '%s\\n' \"\$j\" | grep -qE ': surface 0x[0-9a-f]+ on layer '; then echo LAYER; exit 0; fi
		echo \"LAST \$(printf '%s\\n' \"\$j\" | grep -oE 'embed: surface 0x[0-9a-f]+ (created|destroyed)' | tail -n 1)\"")
	case "$out" in
		NOT-RUNNING) say "mgu-render is not running: it starts with the installed version at the next app's connection"; return 0 ;;
		NO-JOURNAL) die "mgu-render's journal could not be read, so whether an app is on screen is unknown; not restarted" 2 ;;
		LAYER) die "an app drew over the HMI in this renderer run, which the journal does not show closed; not restarted: restart the head unit instead ($0 reboot --off-screen)" 2 ;;
		NO-RECMGR) die "mgu-render is not in recmgr's restart list on the unit: stopping it could reboot the head unit; not restarted" 2 ;;
		*created*) die "mgu-render's embed surface is up (the Store or another app is on screen): close it, then run again" 2 ;;
	esac
	say "restarting mgu-render.service"
	on_unit "systemctl restart mgu-render.service"
	on_unit "$RUNS_FN
		sleep 5
		pid=\$(systemctl show -p MainPID mgu-render.service | cut -d= -f2)
		echo \"mgu-render.service: \$(systemctl is-active mgu-render.service || true), runs \$(runs \$pid)\"
		journalctl -b _PID=\$pid -o cat 2>/dev/null | grep -E 'embed:|GL:|compositor|wl_|error|unknown setting' | head -n 30
		true"
	say "Open the Store to see it on the restarted renderer."
}

# The head unit's own restart: the Node State Manager's, as the updater's reboot request runs it
# (native/mgu-updater/README.md, "Restarting the head unit"). Waits until the unit answers with a
# new boot id, or (a unit that keeps its boot id) a new HMI start.
cmd_reboot() {
	[ "$(arg 0)" = "--off-screen" ] || die "reboot needs --off-screen: the owner is at the car, the Store and every renderer app are closed, and the car is parked on stable power" 2
	open_link
	local boot out
	local hmi='systemctl show -p ActiveEnterTimestampMonotonic --value hmi.service'
	boot=$(on_unit "echo \$(cat /proc/sys/kernel/random/boot_id) \$($hmi)")
	on_unit "for p in /proc/[0-9]*; do tr '\\0' ' ' <\$p/cmdline 2>/dev/null | grep -q 'mgu-deploy[.]js' && exit 1; done; exit 0" ||
		die "the deploy tool is running (an install or update): wait until it ends, then run again" 2
	say "asking the head unit to restart"
	# this start's boot id in the deploy tool's restart-requested first: its safe mode never counts the
	# restart as a failed start (deploy/README.md, "Safe mode")
	out=$(on_unit "R=/var/opt/mgu-deploy/restart-requested; [ -d /var/opt/mgu-deploy ] && cat /proc/sys/kernel/random/boot_id > \$R.tmp && mv -f \$R.tmp \$R; /usr/bin/nsm_control --requestRestart 7 --normal 2>&1" || true)
	[ -n "$out" ] && say "$out"
	case "$out" in *rror*) die "the restart was not taken; ask the owner to use the Store's Restart head unit" ;; esac
	close_link
	trap - EXIT
	local t0 now
	t0=$(date +%s)
	while :; do
		now=$(date +%s)
		[ $((now - t0)) -lt 420 ] || die "the head unit has not come back with a new boot after 7 minutes; check it, then run status"
		sleep 10
		# a fresh connection each time: the old one ends with the shutdown
		if out=$( (open_link >/dev/null 2>&1 && on_unit "cat /proc/sys/kernel/random/boot_id; $hmi") 2>/dev/null ); then
			# shellcheck disable=SC2086
			set -- $out
			if [ -n "${1:-}" ] && [ -n "${2:-}" ] && [ "${2:-}" != 0 ] && [ "$1 $2" != "$boot" ]; then
				say "the head unit is back, the HMI started again"
				return 0
			fi
		fi
	done
}

ab_clear() {
	on_unit "rm -f $DROPIN; rmdir $DROPIN_DIR 2>/dev/null; systemctl daemon-reload"
}

cmd_ab() {
	open_link
	if [ "$nargs" -eq 0 ]; then
		ab_clear
		say "test settings cleared: mgu-render starts with its own settings at its next start ($0 restart --off-screen)"
		return 0
	fi
	local p k v keys="" sets=""
	for p in "${ARGS[@]}"; do
		k=${p%%=*}; v=${p#*=}
		case " $AB_KEYS " in *" $k "*) ;; *) die "unknown setting $k (one of: $AB_KEYS)" 2 ;; esac
		case "$k" in
			fps|fps.*) case "$v" in 0|[1-9]|[1-9][0-9]|[1-9][0-9][0-9]|1000) ;; *) die "$k takes frames a second, 0..1000 (0: the app's own)" 2 ;; esac
				keys="$keys 0..1000" ;;                    # the fps settings' own error text: only a renderer with them has it
			*) case "$v" in 0|1) ;; *) die "$k takes 0 or 1" 2 ;; esac
				keys="$keys $k" ;;
		esac
		sets="$sets -s $k=$v"
	done
	on_unit "set -e
		b=/var/opt/mgu-render/current/mgu-render
		for k in$keys; do grep -qF \"\$k\" \"\$b\" || { echo \"the installed mgu-render does not know \$k: not set\" >&2; exit 2; }; done
		line=\$(sed -n 's/^ExecStart=//p' /etc/systemd/system/mgu-render.service | tail -n 1)
		[ -n \"\$line\" ] || { echo 'no ExecStart in mgu-render.service' >&2; exit 2; }
		mkdir -p $DROPIN_DIR
		printf '[Service]\nExecStart=\nExecStart=%s%s\n' \"\$line\" '$sets' > $DROPIN
		systemctl daemon-reload
		sed -n 's/^ExecStart=./  &/p' $DROPIN"
	say "set for mgu-render's next start (gone at the next head-unit start). Now, with no app on screen: $0 restart --off-screen"
}

cmd_stats() {
	open_link
	case "$(arg 0)" in
		on) on_unit "[ -d /run/mgu-render ] && touch $STATS_FILE" || die "/run/mgu-render is not there (mgu-render.socket not running)"; say "stats-log on" ;;
		off) on_unit "rm -f $STATS_FILE $STORE_STATS $RENDER_TRACE $STORE_TRACE"; say "stats-log off" ;;
		*) die "usage: $0 stats on|off" 2 ;;
	esac
}

cmd_probe() {
	[ "$nargs" -gt 0 ] || die "usage: $0 probe globals|gpu|cpu|all [args]" 2
	open_link
	mkdir -p "$RESULTS"
	local name
	name="$(date '+%H%M%S')-$(printf '%s' "${ARGS[*]}" | tr -c 'A-Za-z0-9' '-' | cut -c1-40)"
	upload "$KIT/probe.js" "$UNIT_PROBE"
	local q="" p
	for p in "${ARGS[@]}"; do q="$q '$p'"; done
	on_unit "node $UNIT_PROBE$q --json /tmp/mgu-probe-$name.json" | tee "$RESULTS/$name.txt"
	on_unit "cat /tmp/mgu-probe-$name.json && rm -f /tmp/mgu-probe-$name.json" >"$RESULTS/$name.json"
	say "saved $RESULTS/$name.txt and .json"
}

cmd_drag() {
	local name secs
	name=$(arg 0); secs=$(arg 1); secs=${secs:-10}
	case "$name" in ''|*[!A-Za-z0-9_-]*) die "usage: $0 drag <name: letters, digits, - and _> [seconds]" 2 ;; esac
	case "$secs" in *[!0-9]*) die "seconds: a number" 2 ;; esac
	open_link
	mkdir -p "$RESULTS"
	upload "$KIT/probe.js" "$UNIT_PROBE"
	say "measuring $secs s from the next line: the owner drags the Store's list now, without stopping"
	on_unit "t0=\$(date '+%Y-%m-%d %H:%M:%S')
		for f in $STORE_STATS $RENDER_TRACE $STORE_TRACE; do if [ -f \$f ]; then : > \$f; fi; done
		node $UNIT_PROBE cpu $secs --gpu-freq --json /tmp/mgu-probe-$name.json
		journalctl -u mgu-render --since \"\$t0\" -o cat 2>/dev/null | grep -E ' stats | fps, render |embed: ' > /tmp/mgu-probe-$name.stats
		cat $STORE_STATS >> /tmp/mgu-probe-$name.stats 2>/dev/null
		true" | tee "$RESULTS/$name.txt"
	on_unit "cat /tmp/mgu-probe-$name.json; rm -f /tmp/mgu-probe-$name.json" >"$RESULTS/$name.json"
	on_unit "cat /tmp/mgu-probe-$name.stats; rm -f /tmp/mgu-probe-$name.stats" >"$RESULTS/$name.stats"
	say "journal stats lines ($RESULTS/$name.stats):"
	if [ -s "$RESULTS/$name.stats" ]; then cat "$RESULTS/$name.stats"; else say "  none (stats-log off, or a renderer without it)"; fi
	sleep 1                                   # the Store writes its trace once a second
	on_unit "cat $RENDER_TRACE 2>/dev/null; true" >"$RESULTS/$name.render-trace"
	on_unit "cat $STORE_TRACE 2>/dev/null; true" >"$RESULTS/$name.store-trace"
	say "per-frame trace ($RESULTS/$name.render-trace, .store-trace):"
	node "$KIT/trace.js" "$RESULTS/$name.render-trace" "$RESULTS/$name.store-trace" | tee "$RESULTS/$name.trace.txt"
}

cmd_sh() {
	[ "$nargs" -eq 1 ] || die "usage: $0 sh '<command>'" 2
	open_link
	on_unit "$(arg 0)"
}

case "$CMD" in
	status) cmd_status ;;
	install) cmd_install ;;
	restore) cmd_restore ;;
	restart) cmd_restart ;;
	reboot) cmd_reboot ;;
	ab) cmd_ab ;;
	stats) cmd_stats ;;
	probe) cmd_probe ;;
	drag) cmd_drag ;;
	sh) cmd_sh ;;
	help|-h|--help) sed -n '2,/^set -euo/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//' ;;
	*) die "unknown command $CMD ($0 help)" 2 ;;
esac
