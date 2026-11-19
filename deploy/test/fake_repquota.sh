#!/bin/sh
# repquota for the deploy tests: every app home in $MGU_DEPLOY_OAP holds
# files of its uid, so its uid is listed, as "#<uid>" (no account).
echo "User            used    soft    hard  grace    used  soft  hard  grace"
for d in "$MGU_DEPLOY_OAP"/oap_*; do
    [ -d "$d" ] && echo "#${d##*/oap_}    --      80   16160   16160              7     0     0"
done
exit 0
