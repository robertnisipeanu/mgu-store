#!/bin/sh
# mgu-render's page template in the HMI's widgets.
#   mgu-render-hmi.sh [--build | --confirm | --stop | --shutdown] [DIR [OUT]]
# DIR holds hmi_template.js and mgu-render.conf (default: this script's directory); OUT keeps the
# template (default: hmi beside DIR, DIR being <root>/current); status.json beside OUT says how its last build went.
#
# --build (the install runs it: component.json postInstall) makes the template from the installed
# HmiMain3D for the conf's embed_surface_id, unless OUT holds it for this stamp already (that binary,
# the generator and the id: its identifier numbers belong to one HmiMain3D build) or the last build
# for this stamp failed for good (the generator found HmiMain3D lacking what the template needs). The
# generator runs at nice 19, first in line for the out-of-memory killer, for at most 120 s; any other
# failure (that limit, a signal, memory or disk) is tried again at the next install.
#   status.json: {"template": "ok" | "building" | "failed", "stamp", "reason", "retry", "problem", "hmi"}
#
# Without --build (mgu-render-hmi.service, before the HMI starts) nothing is generated: when OUT holds
# the template for this stamp, a copy of bmw/widget/ plus the template (the HMI loads every *.pbw in
# its widget directories) is made in /run and mounted over it, else the stock widgets stay. Nothing on
# /mnt/dataro is written, and the copy is made afresh at each boot. The marker tells the renderer the
# template is in place for this HMI start.
#
# The HMI runs as its own user (not root): the template, its folder and the copy are made readable by
# everyone (0644 files, 0755 folders) whatever umask the install or the boot runs with.
# Undo: umount /mnt/dataro/data/hmi/bmw/widget
#
# Boot count (hmi-boot beside OUT). An HMI that fails with the template at every start would restart
# the head unit at every start, so each boot that mounts it is counted:
#   - the boot run records the template it mounts (its key: the stamp and the MD5 of the .pbw
#     files), this boot's id (a random id it keeps in /run/mgu-render/boot, which every
#     boot starts without) and the time, state "mounted", and starts --confirm;
#   - --confirm (in the background, in mgu-render-hmi.service) waits for hmi.service to be active,
#     notes its main PID and start time, and HEALTHY s later, when the same HmiMain3D run is still
#     active and the template still in place, marks the boot "confirmed" and clears the count;
#   - --stop (the service's ExecStop, which every systemd shutdown runs: Conflicts=shutdown.target)
#     marks an unconfirmed boot "clean" when systemd stops the system (a systemctl reboot or poweroff);
#   - --shutdown (a drop-in of var-opt-ro.service, which runs at every NodeStateManager shutdown, a
#     switch-off and a crash restart alike, before /var/opt goes read-only) writes hmi-shutdown,
#     "<boot id> hmi|other|none": whether a restart record of recmgr or crashhandler
#     (restartInfo.xml) written since the mount names the HMI (hmi, hmi.service or HmiMain3D). A
#     record is written since the mount when it was not there then or its modification time, size or
#     inode changed (seen: each record's at the mount), whatever the clock did in between;
#   - the next boot run counts the last mounted boot as one failure only when it was neither
#     confirmed nor clean and the HMI is named: by its hmi-shutdown line, or, with no line for that
#     boot, by a restart record still on disk written since its mount (recmgr and crashhandler delete
#     theirs some 10 s after the HMI starts, after this run). A switch-off, a restart asked for (BMW's
#     menu, the Store, an update), a power cut or a slow HMI leaves no such record and counts nothing.
#     Only a confirmed boot clears the count.
# At FAILS failures the template is marked failed ("failed") and not mounted again, the HMI keeping its
# stock widgets, until the key changes (another generator, HmiMain3D, embed_surface_id or template) or
# mgu-render is removed and installed again. A template marked failed is never mounted; any other error
# in the count mounts the template.
#   hmi-boot: template=<key>, fails=<n>, boot=<boot id>, at=<s>, seen=<recmgr's> <crashhandler's>
#             (each <mtime>.<size>.<inode> or -),
#             state=mounted|confirmed|clean|failed
set -eu
MODE=boot
case "${1:-}" in
--build) MODE=build; shift ;;
--confirm) MODE=confirm; shift ;;
--stop) MODE=stop; shift ;;
--shutdown) MODE=shutdown; shift ;;
esac
DIR=${1:-$(dirname "$0")}
OUT=${2:-$(dirname "$DIR")/hmi}
STATUS=$(dirname "$OUT")/status.json
STATE=$(dirname "$OUT")/hmi-boot
MARK=$(dirname "$OUT")/hmi-shutdown
HMI=${MGU_RENDER_HMI:-/usr/bin/HmiMain3D}
WIDGETS=${MGU_RENDER_WIDGETS:-/mnt/dataro/data/hmi/bmw/widget}
RUN=${MGU_RENDER_RUN:-/run/mgu-render/hmi-widget}
MARKER=${MGU_RENDER_MARKER:-/run/mgu-render/hmi-template}
NODE=${MGU_RENDER_NODE:-node}
LIMIT=${MGU_RENDER_LIMIT:-120}
SIN=${MGU_RENDER_SIN:-/var/opt/public/sin}
BOOT=${MGU_RENDER_BOOT:-/run/mgu-render/boot}
SYSTEMCTL=${MGU_RENDER_SYSTEMCTL:-systemctl}
PROC=${MGU_RENDER_PROC:-/proc}
HEALTHY=${MGU_RENDER_HEALTHY_S:-120}
POLL=${MGU_RENDER_POLL_S:-5}
WAIT=${MGU_RENDER_WAIT_S:-600}
FAILS=2

# A JSON string's contents: control characters dropped, \ and " escaped, at most 200 characters.
json() { printf '%s' "$1" | tr -d '\000-\037' | cut -c1-200 | sed 's/\\/\\\\/g; s/"/\\"/g'; }
# status STATE REASON RETRY [STAMP [HMI]]: HMI "failed" when the boot count stopped mounting the template
status() {
	problem=
	if [ "$1" = failed ]; then
		problem="In-page drawing unavailable: $2"
	elif [ "${5:-}" = failed ]; then
		problem="In-page drawing unavailable: the HMI failed with the page template"
	fi
	printf '{\n"template": "%s",\n"stamp": "%s",\n"reason": "%s",\n"retry": %s,\n"problem": "%s",\n"hmi": "%s"\n}\n' \
		"$1" "$(json "${4:-$stamp}")" "$(json "$2")" "$3" "$(json "$problem")" "$(json "${5:-}")" > "$STATUS.tmp"
	mv -f "$STATUS.tmp" "$STATUS"
}
# one value of status.json as written above, without its quotes
field() { sed -n "s/^\"$1\": //p" "$STATUS" 2>/dev/null | sed 's/,$//; s/^"//; s/"$//'; }
built() { [ "$(cat "$OUT/stamp" 2>/dev/null)" = "$stamp" ] && ls "$OUT"/*.pbw >/dev/null 2>&1; }
readable() { chmod 0755 "$OUT" && chmod 0644 "$OUT"/*.pbw "$OUT/stamp"; }

# ---- the boot count ----

load() {
	s_template= s_fails= s_boot= s_at= s_seen= s_state=
	[ -f "$STATE" ] || return 0
	while IFS= read -r line || [ -n "$line" ]; do
		case $line in
		template=*) s_template=${line#template=} ;;
		fails=*) s_fails=${line#fails=} ;;
		boot=*) s_boot=${line#boot=} ;;
		at=*) s_at=${line#at=} ;;
		seen=*) s_seen=${line#seen=} ;;
		state=*) s_state=${line#state=} ;;
		esac
	done 2>/dev/null < "$STATE" || :
	ok=1
	case $s_fails in '' | *[!0-9]* | ????*) ok= ;; esac
	case $s_at in '' | *[!0-9]*) ok= ;; esac
	case $s_seen in *[!0-9' '.-]* | *' '*' '* | ' '* | *' ') ok= ;; esac
	case $s_seen in *' '*) ;; *) ok= ;; esac
	case $s_boot in '' | *[!0-9a-f-]*) ok= ;; esac
	case $s_state in mounted | confirmed | clean | failed) ;; *) ok= ;; esac
	[ -n "$s_template" ] || ok=
	[ -n "$ok" ] || { s_template= s_fails= s_boot= s_at= s_seen= s_state=; }
}
save() {
	printf 'template=%s\nfails=%s\nboot=%s\nat=%s\nseen=%s\nstate=%s\n' "$s_template" "$s_fails" "$s_boot" "$s_at" \
		"$s_seen" "$s_state" > "$STATE.tmp" && mv -f "$STATE.tmp" "$STATE"
}
# this boot's id, empty when unreadable: a random one the boot run keeps in /run, which every boot starts empty
boot_id() { b=; read -r b 2>/dev/null < "$BOOT" || :; case $b in '' | *[!0-9a-f-]*) b= ;; esac; echo "$b"; }
new_boot() {
	[ -s "$BOOT" ] && return 0
	mkdir -p "$(dirname "$BOOT")" && cat /proc/sys/kernel/random/uuid > "$BOOT.tmp" && mv -f "$BOOT.tmp" "$BOOT"
}
# Whether restart record $1 names the HMI: recmgr's names the unit (<ServiceName value="hmi.service"/>),
# crashhandler's the program as dlt-cdh, the kernel's core handler, gives it: the file name of
# /proc/<pid>/exe (HmiMain3D).
names_hmi() { grep -q -E '<ServiceName[^>]*value="(hmi|hmi\.service|HmiMain3D)"' "$1" 2>/dev/null; }
# "<mtime>.<size>.<inode>" of a restart record, "-" when it is not there: a record rewritten within the
# same second is still told apart
mtime() { t=$(stat -c %Y.%s.%i "$1" 2>/dev/null) || t=-; case $t in *[!0-9.]* | *..* | .* | *.) t=- ;; esac; echo "$t"; }
seen() { echo "$(mtime "$SIN/recmgr/restartInfo.xml") $(mtime "$SIN/crashhandler/restartInfo.xml")"; }
# The restart records written since they were as $1 (seen): "hmi" when one names the HMI, "other" when
# one names something else, else "none".
records() {
	r=none
	for f in recmgr crashhandler; do
		was=${1%% *}
		set -- "${1#* }"
		t=$(mtime "$SIN/$f/restartInfo.xml")
		[ "$t" != - ] && [ "$t" != "$was" ] || continue
		if names_hmi "$SIN/$f/restartInfo.xml"; then r=hmi; break; fi
		r=other
	done
	echo "$r"
}
# How boot $s_boot, mounted at $s_at, ended: "hmi" for a restart record naming the HMI, by its
# hmi-shutdown line or, without one, by a record still on disk written since that mount (each deletes
# its record some 10 s after the HMI starts, after this run).
ended() {
	m_boot= m_rec=
	read -r m_boot m_rec _ 2>/dev/null < "$MARK" || :
	if [ -n "$m_boot" ] && [ "$m_boot" = "$s_boot" ]; then
		echo "${m_rec:-none} (its shutdown record)"
		return
	fi
	echo "$(records "$s_seen") (no shutdown record; the restart records on disk)"
}
# Whether this boot may mount the template keyed $1 (0) or not (1: marked failed). Writes hmi-boot.
may_mount() {
	key=$1
	boot=$(boot_id)
	load
	if [ "$s_state" = failed ] && { [ "$s_template" = "$key" ] || [ -z "$key" ]; }; then
		return 1
	fi
	[ -n "$key" ] && [ -n "$boot" ] || return 0
	if [ -z "$s_template" ] && [ -f "$STATE" ]; then
		echo "mgu-render-hmi: $STATE unreadable; the count starts again"
	fi
	if [ "$s_template" != "$key" ]; then
		[ "$s_state" = failed ] && echo "mgu-render-hmi: a new page template; the one marked failed is mounted no more"
		s_template=$key s_fails=0 s_boot= s_at=0 s_seen= s_state=
	fi
	if [ "$s_state" = mounted ] && [ "$s_boot" != "$boot" ]; then
		how=$(ended)
		case $how in
		hmi*)
			s_fails=$((s_fails + 1))
			echo "mgu-render-hmi: the last start with the page template ended in an HMI restart, $how: failure $s_fails of $FAILS"
			;;
		*) echo "mgu-render-hmi: the last start with the page template ended unconfirmed with no HMI restart, $how: not counted" ;;
		esac
	fi
	if [ "$s_state" = failed ] || [ "$s_fails" -ge "$FAILS" ]; then
		if [ "$s_state" != failed ]; then
			s_state=failed s_boot=$boot s_at=$(date +%s) s_seen=$(seen)
			save || :
		fi
		return 1
	fi
	s_boot=$boot s_at=$(date +%s) s_seen=$(seen) s_state=mounted
	save || echo "mgu-render-hmi: $STATE not written; this start is not counted"
	return 0
}
report() {
	[ "$(field hmi)" != "$1" ] || return 0
	t=$(field template) r=$(field retry)
	case $t in ok | building | failed) ;; *) t=ok ;; esac
	case $r in true | false) ;; *) r=false ;; esac
	status "$t" "$(field reason)" "$r" "$(field stamp)" "$1"
}
# "<ActiveState> <MainPID> <ExecMainStartTimestampMonotonic>" of hmi.service, numbers 0 when unknown
hmi_run() {
	show=$("$SYSTEMCTL" show hmi.service -p ActiveState -p MainPID -p ExecMainStartTimestampMonotonic 2>/dev/null)
	a=$(printf '%s\n' "$show" | sed -n 's/^ActiveState=//p')
	p=$(printf '%s\n' "$show" | sed -n 's/^MainPID=//p')
	s=$(printf '%s\n' "$show" | sed -n 's/^ExecMainStartTimestampMonotonic=//p')
	case $p in '' | *[!0-9]*) p=0 ;; esac
	case $s in '' | *[!0-9]*) s=0 ;; esac
	echo "${a:-unknown} $p $s"
}

if [ "$MODE" = shutdown ]; then
	# var-opt-ro.service: fast, never fails, writes only for a boot that mounted the template and was not confirmed
	set +e
	load
	boot=$(boot_id)
	[ -n "$boot" ] && [ "$s_boot" = "$boot" ] && [ "$s_state" = mounted ] || exit 0
	printf '%s %s\n' "$boot" "$(records "$s_seen")" > "$MARK.tmp" && mv -f "$MARK.tmp" "$MARK"
	exit 0
fi
if [ "$MODE" = stop ]; then
	# ExecStop: an unconfirmed boot that systemd ends in order counts nothing
	set +e
	load
	boot=$(boot_id)
	[ -n "$boot" ] && [ "$s_boot" = "$boot" ] && [ "$s_state" = mounted ] || exit 0
	sys=$("$SYSTEMCTL" is-system-running 2>/dev/null)
	job=$("$SYSTEMCTL" show shutdown.target -p Job 2>/dev/null)
	case "$sys $job" in
	stopping* | *Job=[0-9]*)
		s_state=clean
		save && echo "mgu-render-hmi: the system stops before the HMI was confirmed healthy; this start is not counted"
		;;
	esac
	exit 0
fi
if [ "$MODE" = confirm ]; then
	set +e
	renice -n 19 -p $$ >/dev/null 2>&1
	load
	boot=$(boot_id)
	[ -n "$boot" ] && [ "$s_boot" = "$boot" ] && [ "$s_state" = mounted ] || exit 0
	at=$s_at waited=0 run=
	while [ "$waited" -lt "$WAIT" ]; do
		sleep "$POLL"
		waited=$((waited + POLL))
		set -- $(hmi_run)
		[ "$1" = active ] && [ "$2" -gt 0 ] && { run="$2 $3"; break; }
		if [ "${1:-}" = failed ]; then
			echo "mgu-render-hmi: hmi.service failed with the page template"
			exit 0
		fi
	done
	if [ -z "$run" ]; then
		echo "mgu-render-hmi: hmi.service not active within $WAIT s; this start stays unconfirmed"
		exit 0
	fi
	sleep "$HEALTHY"
	set -- $(hmi_run)
	comm=
	read -r comm 2>/dev/null < "$PROC/$2/comm"
	if [ "$1" != active ] || [ "$2 $3" != "$run" ] || [ "$comm" != HmiMain3D ] || [ ! -e "$MARKER" ]; then
		echo "mgu-render-hmi: the HMI did not run $HEALTHY s unbroken with the page template; this start stays unconfirmed"
		exit 0
	fi
	load
	[ "$s_boot" = "$boot" ] && [ "$s_state" = mounted ] && [ "$s_at" = "$at" ] || exit 0
	s_fails=0 s_state=confirmed
	save && echo "mgu-render-hmi: the HMI has run $HEALTHY s with the page template; the count is cleared"
	exit 0
fi

[ "$MODE" = build ] || rm -f "$MARKER"
if [ ! -e "$HMI" ]; then
	# iDrive 8: no HmiMain3D, no page template
	[ "$MODE" = boot ] || rm -f "$STATUS"
	exit 0
fi
id=$(sed -n 's/^[[:space:]]*embed_surface_id[[:space:]]*=[[:space:]]*\([0-9A-Fa-fx]*\).*/\1/p' \
	"$DIR/mgu-render.conf" 2>/dev/null | tail -n 1)
id=${id:-0x500}
stamp="$(stat -L -c '%s %Y' "$HMI") $(md5sum < "$DIR/hmi_template.js" | cut -d' ' -f1) $id"

if [ "$MODE" = build ]; then
	if built; then
		readable
		[ "$(field template)" = ok ] && [ "$(field stamp)" = "$stamp" ] || status ok "" false
		echo "mgu-render-hmi: the page template is in place for this HmiMain3D"
		exit 0
	fi
	if [ "$(field template)" = failed ] && [ "$(field stamp)" = "$stamp" ] && [ "$(field retry)" = false ]; then
		echo "mgu-render-hmi: no page template for this HmiMain3D: $(field reason)"
		exit 0
	fi
	status building "" true
	NEW=$OUT.new
	rm -rf "$NEW"
	mkdir -p "$NEW"
	"$NODE" "$DIR/hmi_template.js" --hmi "$HMI" --surface-id "$id" --out "$NEW" >/dev/null 2>"$NEW/log" &
	gen=$!
	# the unit's shell has renice, not nice
	renice -n 19 -p $gen >/dev/null 2>&1 || :
	{ echo 1000 > /proc/$gen/oom_score_adj; } 2>/dev/null || :
	(
		i=0
		while [ $i -lt "$LIMIT" ] && kill -0 $gen 2>/dev/null; do sleep 1; i=$((i + 1)); done
		if kill -0 $gen 2>/dev/null; then : > "$NEW/timeout"; kill -9 $gen 2>/dev/null || :; fi
	) >/dev/null 2>&1 &
	watch=$!
	rc=0
	wait $gen || rc=$?
	wait $watch || :
	if [ $rc -eq 0 ] && ls "$NEW"/*.pbw >/dev/null 2>&1; then
		rm -f "$NEW/log"
		echo "$stamp" > "$NEW/stamp"
		rm -rf "$OUT"
		mv "$NEW" "$OUT"
		readable
		status ok "" false
		echo "mgu-render-hmi: page template made: $(cd "$OUT" && ls *.pbw)"
		exit 0
	fi
	if [ -e "$NEW/timeout" ]; then
		reason="the page template took longer than $LIMIT s"; retry=true
	elif [ $rc -gt 128 ]; then
		reason="the page template generator stopped (signal $((rc - 128)))"; retry=true
	else
		reason=$(grep -v '^[[:space:]]*$' "$NEW/log" | tail -n 1)
		reason=${reason:-the page template generator exited $rc}
		retry=true; [ $rc -eq 1 ] && retry=false
	fi
	rm -rf "$NEW"
	status failed "$reason" $retry
	echo "mgu-render-hmi: no page template: $reason" >&2
	exit 0
fi

if ! built; then
	# a template marked failed was for another stamp
	report "" || :
	echo "mgu-render-hmi: no page template for this HmiMain3D; the stock widgets stay"
	exit 0
fi
# our own earlier mount only (another tool's mount over the same folder stays, and is copied)
ours() { grep -q " /mgu-render/hmi-widget $WIDGETS " /proc/self/mountinfo; }
key= boot= s_state= s_boot=
new_boot || :
pbw=$(cat "$OUT"/*.pbw | md5sum | cut -d' ' -f1) && key="$stamp $pbw" || key=
if ! may_mount "$key"; then
	if ours; then umount "$WIDGETS" || :; fi
	report failed || :
	echo "mgu-render-hmi: the HMI failed $FAILS times with this page template; it is not mounted, and the stock widgets stay until HmiMain3D or the template changes"
	exit 0
fi
report "" || :
if ours; then
	umount "$WIDGETS"
fi
rm -rf "$RUN"
mkdir -p "$RUN"
cp -a "$WIDGETS"/. "$RUN"/
cp "$OUT"/*.pbw "$RUN"/
chmod 0755 "$RUN"
(cd "$OUT" && for f in *.pbw; do chmod 0644 "$RUN/$f"; done)
mount --bind "$RUN" "$WIDGETS"
touch "$MARKER"
echo "mgu-render-hmi: $(cd "$OUT" && ls *.pbw) added to $WIDGETS"
if [ "$s_state" = mounted ] && [ "$s_boot" = "$boot" ]; then
	sh "$0" --confirm "$DIR" "$OUT" </dev/null &
fi
