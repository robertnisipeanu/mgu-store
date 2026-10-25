#!/bin/sh
# ps for the deploy tests: the app manager's node child, with the pid in
# $FAKE_MGR_PIDFILE, when that file is not empty; no apps are running.
echo "  PID USER       VSZ STAT COMMAND"
if [ -n "$FAKE_MGR_PIDFILE" ] && [ -s "$FAKE_MGR_PIDFILE" ]; then
    echo "$(cat "$FAKE_MGR_PIDFILE") root      1000 S    /usr/bin/node /usr/lib/oap-mainapp/src/main.js"
fi
