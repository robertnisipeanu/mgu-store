package main

// What apps see: the lease, as JSON, in
//
//	/var/opt/public/oap/oap_<uid>/data/uplink.json   each allowed app (root:<app gid> 0640)
//	/run/mgu-uplink/lease.json                       everyone (0644), for non-app uids and status
//
// present only while the uplink has a lease. The shape is the same for every
// uplink. The unit's own resolver does not reach the internet, so apps resolve
// names through the lease's dns servers.

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"

	"golang.org/x/sys/unix"
)

const appStateName = "uplink.json"

type Lease struct {
	Interface string   `json:"interface"`
	IP        string   `json:"ip"`
	Prefix    int      `json:"prefix"`
	Router    string   `json:"router"`
	DNS       []string `json:"dns"`
	LeaseSec  int      `json:"leaseSeconds"`
	Updated   string   `json:"updated"`
}

// resolveUIDs maps the configured app names through the OAP manager's
// uids.txt ("<uid>=<app>" per line; a reinstall can assign a new uid) and adds
// the static uids. Names not installed yet are returned as missing.
func resolveUIDs(c config) (uids []int, byApp map[string]int, missing []string) {
	byApp = map[string]int{}
	b, _ := os.ReadFile(c.uidsFile())
	for _, line := range strings.Split(string(b), "\n") {
		kv := strings.SplitN(strings.TrimSpace(line), "=", 2)
		if len(kv) != 2 {
			continue
		}
		uid, err := strconv.ParseUint(strings.TrimSpace(kv[0]), 10, 32)
		if err != nil || uid == 0 {
			continue
		}
		for _, a := range c.Apps {
			if strings.TrimSpace(kv[1]) == a {
				byApp[a] = int(uid)
			}
		}
	}
	seen := map[int]bool{}
	for _, a := range c.Apps {
		if uid, ok := byApp[a]; ok {
			if !seen[uid] {
				uids = append(uids, uid)
				seen[uid] = true
			}
		} else {
			missing = append(missing, a)
		}
	}
	for _, uid := range c.UIDs {
		if !seen[uid] {
			uids = append(uids, uid)
			seen[uid] = true
		}
	}
	sort.Ints(uids)
	return uids, byApp, missing
}

func marshalJSON(v interface{}) []byte {
	b, _ := json.MarshalIndent(v, "", "  ")
	return append(b, '\n')
}

// writeJSON replaces path with v atomically. It follows symlinks: only for
// root's own directories.
func writeJSON(path string, v interface{}, mode os.FileMode) error {
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, marshalJSON(v), mode); err != nil {
		return err
	}
	if err := os.Chmod(tmp, mode); err != nil {
		os.Remove(tmp)
		return err
	}
	return os.Rename(tmp, path)
}

func readLease(path string) *Lease {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	var l Lease
	if json.Unmarshal(b, &l) != nil || l.IP == "" {
		return nil
	}
	return &l
}

// The app owns oap_<uid>/ and data/, so every access below them goes through
// directory descriptors and never follows a symlink the app may have planted.

func openAppData(c config, uid int) (int, error) {
	fd, err := unix.Open(c.OAPDir, unix.O_DIRECTORY|unix.O_RDONLY|unix.O_CLOEXEC, 0)
	if err != nil {
		return -1, err
	}
	for _, name := range []string{fmt.Sprintf("oap_%d", uid), "data"} {
		next, err := unix.Openat(fd, name, unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_RDONLY|unix.O_CLOEXEC, 0)
		unix.Close(fd)
		if err != nil {
			return -1, err
		}
		fd = next
	}
	return fd, nil
}

// readAppState returns uplink.json's content if it is a regular file.
func readAppState(dir int) []byte {
	fd, err := unix.Openat(dir, appStateName, unix.O_RDONLY|unix.O_NOFOLLOW|unix.O_NONBLOCK|unix.O_CLOEXEC, 0)
	if err != nil {
		return nil
	}
	f := os.NewFile(uintptr(fd), appStateName)
	defer f.Close()
	if st, err := f.Stat(); err != nil || !st.Mode().IsRegular() || st.Size() > 4096 {
		return nil
	}
	b, _ := io.ReadAll(f)
	return b
}

// writeAppState makes the app's uplink.json hold b, as root:<uid> 0640.
func writeAppState(c config, uid int, b []byte) error {
	dir, err := openAppData(c, uid)
	if err != nil {
		return fmt.Errorf("lease for uid %d: data dir: %w", uid, err)
	}
	defer unix.Close(dir)
	if bytes.Equal(readAppState(dir), b) {
		return nil
	}
	tmp := appStateName + ".tmp"
	unix.Unlinkat(dir, tmp, 0)
	fd, err := unix.Openat(dir, tmp, unix.O_WRONLY|unix.O_CREAT|unix.O_EXCL|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0600)
	if err != nil {
		return fmt.Errorf("lease for uid %d: %v", uid, err)
	}
	f := os.NewFile(uintptr(fd), tmp)
	_, err = f.Write(b)
	if err == nil {
		err = f.Chown(0, uid)
	}
	if err == nil {
		err = f.Chmod(0640)
	}
	if e := f.Close(); err == nil {
		err = e
	}
	if err == nil {
		err = unix.Renameat(dir, tmp, dir, appStateName)
	}
	if err != nil {
		unix.Unlinkat(dir, tmp, 0)
		return fmt.Errorf("lease for uid %d: %v", uid, err)
	}
	return nil
}

func removeAppState(c config, uid int) {
	if dir, err := openAppData(c, uid); err == nil {
		unix.Unlinkat(dir, appStateName, 0)
		unix.Close(dir)
	}
}

// syncAppState writes the lease to each allowed app's data dir (apps whose data
// dir does not exist yet are skipped) and to lease.json, or removes them all
// when l is nil. Files of apps no longer allowed are removed.
func syncAppState(c config, byApp map[string]int, l *Lease) error {
	want := map[int]bool{}
	if l != nil {
		for _, uid := range byApp {
			want[uid] = true
		}
	}
	existing, _ := filepath.Glob(filepath.Join(c.OAPDir, "oap_*", "data", appStateName))
	for _, p := range existing {
		uid, err := strconv.Atoi(strings.TrimPrefix(filepath.Base(filepath.Dir(filepath.Dir(p))), "oap_"))
		if err == nil && !want[uid] {
			removeAppState(c, uid)
		}
	}
	if l == nil {
		os.Remove(c.leaseFile())
		return nil
	}
	b := marshalJSON(l)
	var errs []string
	for uid := range want {
		if err := writeAppState(c, uid, b); err != nil && !errors.Is(err, os.ErrNotExist) {
			errs = append(errs, err.Error())
		}
	}
	if cur, _ := os.ReadFile(c.leaseFile()); !bytes.Equal(cur, b) {
		if err := writeJSON(c.leaseFile(), l, 0644); err != nil {
			errs = append(errs, "lease file: "+err.Error())
		}
	}
	sort.Strings(errs)
	if len(errs) > 0 {
		return fmt.Errorf("%s", strings.Join(errs, "; "))
	}
	return nil
}
