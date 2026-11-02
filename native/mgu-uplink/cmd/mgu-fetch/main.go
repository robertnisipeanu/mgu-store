// mgu-fetch: one HTTPS download for the updater, its certificates checked
// against the time NTP servers give instead of the unit's clock. A head unit
// on a bench (no GPS fix, no car to give it the time) keeps a clock decades
// off, and every certificate then reads as expired; the unit's clock is the
// time manager's, and is not touched.
//
// The updater runs it as its fetch uid in place of fetch.js for a download
// that fetch.js could not make for a certificate's dates
// (native/mgu-updater/README.md, "The unit's clock"). Job and events are
// fetch.js's, plus:
//
//	job   caFile: a PEM bundle of the roots to trust (ca, when given, comes first)
//	      clock:  {unixMs, bootNs}, a clock an earlier run reported: the time
//	              unixMs was right at CLOCK_BOOTTIME bootNs; without one the
//	              time is asked of ntp (host or host:port, 123 by default)
//	event {clock: {unixMs, bootNs}}   the time read from NTP, before the download
package main

import (
	"encoding/json"
	"io"
	"os"
)

func main() {
	var j job
	if err := json.NewDecoder(io.LimitReader(os.Stdin, 4<<20)).Decode(&j); err != nil {
		emit(os.Stdout, event{"error": "bad job"})
		os.Exit(2)
	}
	os.Exit(run(j, os.Stdout))
}
