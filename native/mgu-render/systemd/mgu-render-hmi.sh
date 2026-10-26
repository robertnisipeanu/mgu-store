#!/bin/sh
# Adds mgu-render's page template to the HMI's widgets; run as root before the HMI starts
# (mgu-render-hmi.service).
#   mgu-render-hmi.sh [DIR [OUT]]
# DIR holds hmi_template.js and mgu-render.conf (default: this script's directory); OUT keeps the
# generated template (default: DIR/hmi).
# The template is made from the installed HmiMain3D into OUT, for the conf's embed_surface_id, and made
# again whenever that binary, the generator or the id changes: its identifier numbers belong to one
# HmiMain3D build. The HMI loads every *.pbw in its widget directories; a tmpfs copy of bmw/widget/
# plus the template is mounted over it. Nothing on /mnt/dataro is written, and the copy is made afresh
# at each boot. The marker tells the renderer the template is in place for this HMI start.
# Undo: umount /mnt/dataro/data/hmi/bmw/widget
set -eu
DIR=${1:-$(dirname "$0")}
OUT=${2:-$DIR/hmi}
HMI=/usr/bin/HmiMain3D
WIDGETS=/mnt/dataro/data/hmi/bmw/widget
RUN=/run/mgu-render/hmi-widget
MARKER=/run/mgu-render/hmi-template

rm -f "$MARKER"
id=$(sed -n 's/^[[:space:]]*embed_surface_id[[:space:]]*=[[:space:]]*\([0-9A-Fa-fx]*\).*/\1/p' \
	"$DIR/mgu-render.conf" 2>/dev/null | tail -n 1)
id=${id:-0x500}
stamp="$(stat -L -c '%s %Y' "$HMI" "$DIR/hmi_template.js") $id"
if [ "$(cat "$OUT/stamp" 2>/dev/null)" != "$stamp" ]; then
	rm -rf "$OUT"
	mkdir -p "$OUT"
	# The generator gets 20 s, inside the unit's 30: a stuck one is stopped, the script fails and
	# the stock widgets stay (it runs again next boot).
	node "$DIR/hmi_template.js" --hmi "$HMI" --surface-id "$id" --out "$OUT" &
	gen=$!
	(sleep 20 && kill -9 $gen) &
	watch=$!
	if ! wait $gen; then
		kill $watch 2>/dev/null || :
		echo "mgu-render-hmi: the template generator failed or ran past 20 s" >&2
		exit 1
	fi
	kill $watch 2>/dev/null || :
	echo "$stamp" > "$OUT/stamp"
fi

# our own earlier mount only (another tool's mount over the same folder stays, and is copied)
if grep -q " /mgu-render/hmi-widget $WIDGETS " /proc/self/mountinfo; then
	umount "$WIDGETS"
fi
rm -rf "$RUN"
mkdir -p "$RUN"
cp -a "$WIDGETS"/. "$RUN"/
cp "$OUT"/*.pbw "$RUN"/
mount --bind "$RUN" "$WIDGETS"
touch "$MARKER"
echo "mgu-render-hmi: $(cd "$OUT" && ls *.pbw) added to $WIDGETS"
