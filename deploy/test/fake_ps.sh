#!/bin/sh
# ps for the deploy tests: the app manager's node child, with the pid in
# $FAKE_MGR_PIDFILE, when that file is not empty, running from
# /usr/lib/$FAKE_MGR_DIR (oap-mainapp); no apps are running. Its install
# worker while the epoch second is below $FAKE_WORKER_UNTIL. $FAKE_PS_EXTRA:
# more lines as they are.
echo "  PID USER       VSZ STAT COMMAND"
if [ -n "$FAKE_MGR_PIDFILE" ] && [ -s "$FAKE_MGR_PIDFILE" ]; then
    echo "$(cat "$FAKE_MGR_PIDFILE") root      1000 S    /usr/bin/node /usr/lib/${FAKE_MGR_DIR:-oap-mainapp}/src/main.js"
fi
if [ -n "$FAKE_WORKER_UNTIL" ] && [ "$(date +%s)" -lt "$FAKE_WORKER_UNTIL" ]; then
    echo " 4100 root      1000 S    /usr/bin/node /usr/lib/${FAKE_MGR_DIR:-oap-mainapp}/src/AppManagement/AppManagement"
fi
[ -n "$FAKE_PS_EXTRA" ] && echo "$FAKE_PS_EXTRA"
exit 0
