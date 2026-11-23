package main

import (
	"slices"
	"testing"
	"time"
)

// The search's channels keep off the phone's band during a wireless
// session, try the last channels first, and its scans space out to every
// 2 min.
func TestAutoScanPlanAndWait(t *testing.T) {
	for _, c := range []struct {
		name        string
		sess        string
		band        int
		last        []int
		probe, full []int
		ok          bool
	}{
		{"no session", "", 0, []int{2437, 0, 5180, 2437}, []int{2437, 5180}, nil, true},
		{"no session, nothing joined yet", "", 0, []int{0}, nil, nil, true},
		{"CarPlay on 5 GHz", projCarPlay, 5, []int{5785, 2437}, []int{2437}, freqs24, true},
		{"CarPlay on 5 GHz, last on 5 GHz", projCarPlay, 5, []int{5785}, nil, freqs24, true},
		{"Android Auto on 2.4 GHz", projAndroidAuto, 2, []int{2437, 5180}, []int{5180}, freqs5, true},
		{"band not known", projCarPlay, 0, []int{2437}, nil, nil, false},
	} {
		probe, full, ok := autoScanPlan(c.sess, c.band, c.last)
		if !slices.Equal(probe, c.probe) || !slices.Equal(full, c.full) || ok != c.ok {
			t.Errorf("%s: probe %v, full %v, ok %v; want %v, %v, %v", c.name, probe, full, ok, c.probe, c.full, c.ok)
		}
		if c.band == 5 {
			for _, f := range append(probe, full...) {
				if band(f) == 5 {
					t.Errorf("%s: %d MHz scanned during a session on 5 GHz", c.name, f)
				}
			}
		}
	}
	want := []time.Duration{0, 10 * time.Second, 20 * time.Second, 40 * time.Second, 80 * time.Second, 2 * time.Minute, 2 * time.Minute}
	for step, w := range want {
		if got := autoScanWait(step); got != w {
			t.Errorf("wait before scan %d: %s, want %s", step, got, w)
		}
	}
	if got := autoScanWait(100); got != 2*time.Minute {
		t.Errorf("wait before scan 100: %s", got)
	}
}
