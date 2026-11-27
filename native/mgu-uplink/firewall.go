package main

// Firewall, two parts (nftables 0.9.6 syntax, the unit's nft), for each
// interface the service guards (session.go guarded: the uplink interface,
// and the Wi-Fi interface while the Wi-Fi provider has it):
//
//  1. table inet mgu_uplink, this tool's own: only the allowed uids may send out
//     of the interface; nothing may connect in from it; nothing is
//     forwarded through it. A drop in any base chain is final, so this holds
//     whatever the unit's own tables say.
//  2. One rule per interface at the top of the unit's ip filter output chain
//     accepting it. That chain otherwise sends uids it does not know to
//     logblocked, and an accept is needed in every base chain on the hook; the
//     rule is safe because part 1 already limits the interface to the allowed
//     uids. Skipped where the unit's table is absent.

import (
	"bytes"
	"fmt"
	"os/exec"
	"sort"
	"strings"
)

const (
	nftTable   = "mgu_uplink"
	nftComment = "mgu-uplink"
)

func nftRuleset(ifnames []string, uids []int) string {
	var b strings.Builder
	// add+delete makes the replacement one atomic transaction whether or not
	// the table exists.
	fmt.Fprintf(&b, "add table inet %s\ndelete table inet %s\n", nftTable, nftTable)
	fmt.Fprintf(&b, "table inet %s {\n", nftTable)
	b.WriteString("\tchain output {\n\t\ttype filter hook output priority 0; policy accept;\n")
	for _, ifname := range ifnames {
		q := fmt.Sprintf("%q", ifname)
		for _, uid := range uids {
			fmt.Fprintf(&b, "\t\toifname %s meta nfproto ipv4 meta skuid %d accept\n", q, uid)
		}
		// A flow can only be established through an accepted first packet; this
		// passes the closing segments of sockets their app has already closed.
		fmt.Fprintf(&b, "\t\toifname %s meta nfproto ipv4 ct state established,related accept\n", q)
		// udhcpc's unicast renewals (root).
		fmt.Fprintf(&b, "\t\toifname %s udp sport 68 udp dport 67 accept\n", q)
		fmt.Fprintf(&b, "\t\toifname %s counter drop\n", q)
	}
	b.WriteString("\t}\n\tchain input {\n\t\ttype filter hook input priority 0; policy accept;\n")
	for _, ifname := range ifnames {
		q := fmt.Sprintf("%q", ifname)
		fmt.Fprintf(&b, "\t\tiifname %s meta nfproto ipv4 ct state established,related accept\n", q)
		fmt.Fprintf(&b, "\t\tiifname %s udp sport 67 udp dport 68 accept\n", q)
		fmt.Fprintf(&b, "\t\tiifname %s counter drop\n", q)
	}
	b.WriteString("\t}\n\tchain forward {\n\t\ttype filter hook forward priority 0; policy accept;\n")
	for _, ifname := range ifnames {
		q := fmt.Sprintf("%q", ifname)
		fmt.Fprintf(&b, "\t\tiifname %s drop\n\t\toifname %s drop\n", q, q)
	}
	b.WriteString("\t}\n}\n")
	return b.String()
}

// Replaced by tests.
var runNFT = execNFT

func execNFT(stdin string, args ...string) (string, error) {
	cmd := exec.Command("nft", args...)
	if stdin != "" {
		cmd.Stdin = strings.NewReader(stdin)
	}
	var out bytes.Buffer
	cmd.Stdout = &out
	cmd.Stderr = &out
	err := cmd.Run()
	if err != nil {
		return out.String(), fmt.Errorf("nft %s: %v: %s", strings.Join(args, " "), err, strings.TrimSpace(out.String()))
	}
	return out.String(), nil
}

func (c config) nft(stdin string, args ...string) (string, error) {
	return runNFT(stdin, args...)
}

// applyFirewall installs both parts for the given interfaces and uids.
func applyFirewall(c config, ifnames []string, uids []int) error {
	if _, err := c.nft(nftRuleset(ifnames, uids), "-f", "-"); err != nil {
		return err
	}
	return ensureUnitAccept(c, ifnames)
}

func firewallPresent(c config) bool {
	_, err := c.nft("", "list", "table", "inet", nftTable)
	return err == nil
}

// unitAcceptHandles returns the handles of this tool's rules in the unit's
// ip filter output chain.
func unitAcceptHandles(c config) []string {
	have, _ := unitAccepts(c)
	var hs []string
	for h := range have {
		hs = append(hs, h)
	}
	sort.Strings(hs)
	return hs
}

// unitAccepts maps the handles of this tool's rules in the unit's ip
// filter output chain to the interface each accepts. ok is false when the
// chain is absent.
func unitAccepts(c config) (map[string]string, bool) {
	out, err := c.nft("", "-a", "list", "chain", "ip", "filter", "output")
	if err != nil {
		return nil, false
	}
	return parseUnitAccepts(out), true
}

func parseUnitAccepts(listing string) map[string]string {
	rules := map[string]string{}
	for _, line := range strings.Split(listing, "\n") {
		i := strings.LastIndex(line, "# handle ")
		if !strings.Contains(line, `comment "`+nftComment+`"`) || i < 0 {
			continue
		}
		ifname := ""
		if _, rest, ok := strings.Cut(line, `oifname "`); ok {
			ifname, _, _ = strings.Cut(rest, `"`)
		}
		rules[strings.TrimSpace(line[i+len("# handle "):])] = ifname
	}
	return rules
}

// ensureUnitAccept makes this tool's rules in the unit's chain accept
// exactly ifnames.
func ensureUnitAccept(c config, ifnames []string) error {
	have, ok := unitAccepts(c)
	if !ok {
		return nil
	}
	var got []string
	for _, n := range have {
		got = append(got, n)
	}
	want := append([]string(nil), ifnames...)
	sort.Strings(got)
	sort.Strings(want)
	if strings.Join(got, " ") == strings.Join(want, " ") {
		return nil
	}
	for h := range have {
		c.nft("", "delete", "rule", "ip", "filter", "output", "handle", h)
	}
	for _, n := range ifnames {
		if _, err := c.nft("", "insert", "rule", "ip", "filter", "output",
			"oifname", fmt.Sprintf("%q", n), "accept", "comment", fmt.Sprintf("%q", nftComment)); err != nil {
			return err
		}
	}
	return nil
}

func deleteFirewall(c config) {
	c.nft("", "delete", "table", "inet", nftTable)
	for _, h := range unitAcceptHandles(c) {
		c.nft("", "delete", "rule", "ip", "filter", "output", "handle", h)
	}
}
