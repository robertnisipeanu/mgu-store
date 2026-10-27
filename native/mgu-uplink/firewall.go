package main

// Firewall, two parts (nftables 0.9.6 syntax, the unit's nft):
//
//  1. table inet mgu_uplink, this tool's own: only the allowed uids may send out
//     of the uplink interface; nothing may connect in from it; nothing is
//     forwarded through it. A drop in any base chain is final, so this holds
//     whatever the unit's own tables say.
//  2. One rule at the top of the unit's ip filter output chain accepting the
//     uplink interface. That chain otherwise sends uids it does not know to
//     logblocked, and an accept is needed in every base chain on the hook; the
//     rule is safe because part 1 already limits the interface to the allowed
//     uids. Skipped where the unit's table is absent.

import (
	"bytes"
	"fmt"
	"os/exec"
	"strings"
)

const (
	nftTable   = "mgu_uplink"
	nftComment = "mgu-uplink"
)

func nftRuleset(ifname string, uids []int) string {
	var b strings.Builder
	q := fmt.Sprintf("%q", ifname)
	// add+delete makes the replacement one atomic transaction whether or not
	// the table exists.
	fmt.Fprintf(&b, "add table inet %s\ndelete table inet %s\n", nftTable, nftTable)
	fmt.Fprintf(&b, "table inet %s {\n", nftTable)
	b.WriteString("\tchain output {\n\t\ttype filter hook output priority 0; policy accept;\n")
	for _, uid := range uids {
		fmt.Fprintf(&b, "\t\toifname %s meta nfproto ipv4 meta skuid %d accept\n", q, uid)
	}
	// A flow can only be established through an accepted first packet; this
	// passes the closing segments of sockets their app has already closed.
	fmt.Fprintf(&b, "\t\toifname %s meta nfproto ipv4 ct state established,related accept\n", q)
	// udhcpc's unicast renewals (root).
	fmt.Fprintf(&b, "\t\toifname %s udp sport 68 udp dport 67 accept\n", q)
	fmt.Fprintf(&b, "\t\toifname %s counter drop\n\t}\n", q)
	b.WriteString("\tchain input {\n\t\ttype filter hook input priority 0; policy accept;\n")
	fmt.Fprintf(&b, "\t\tiifname %s meta nfproto ipv4 ct state established,related accept\n", q)
	fmt.Fprintf(&b, "\t\tiifname %s udp sport 67 udp dport 68 accept\n", q)
	fmt.Fprintf(&b, "\t\tiifname %s counter drop\n\t}\n", q)
	b.WriteString("\tchain forward {\n\t\ttype filter hook forward priority 0; policy accept;\n")
	fmt.Fprintf(&b, "\t\tiifname %s drop\n\t\toifname %s drop\n\t}\n}\n", q, q)
	return b.String()
}

func (c config) nft(stdin string, args ...string) (string, error) {
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

// applyFirewall installs both parts for the given uids.
func applyFirewall(c config, ifname string, uids []int) error {
	if _, err := c.nft(nftRuleset(ifname, uids), "-f", "-"); err != nil {
		return err
	}
	return ensureUnitAccept(c, ifname)
}

func firewallPresent(c config) bool {
	_, err := c.nft("", "list", "table", "inet", nftTable)
	return err == nil
}

func unitChainPresent(c config) bool {
	_, err := c.nft("", "list", "chain", "ip", "filter", "output")
	return err == nil
}

// unitAcceptHandles returns the handles of this tool's rules in the unit's
// ip filter output chain.
func unitAcceptHandles(c config) []string {
	out, err := c.nft("", "-a", "list", "chain", "ip", "filter", "output")
	if err != nil {
		return nil
	}
	var hs []string
	for _, line := range strings.Split(out, "\n") {
		if !strings.Contains(line, `comment "`+nftComment+`"`) {
			continue
		}
		if i := strings.LastIndex(line, "# handle "); i >= 0 {
			hs = append(hs, strings.TrimSpace(line[i+len("# handle "):]))
		}
	}
	return hs
}

func ensureUnitAccept(c config, ifname string) error {
	if !unitChainPresent(c) || len(unitAcceptHandles(c)) > 0 {
		return nil
	}
	_, err := c.nft("", "insert", "rule", "ip", "filter", "output",
		"oifname", fmt.Sprintf("%q", ifname), "accept", "comment", fmt.Sprintf("%q", nftComment))
	return err
}

func deleteFirewall(c config) {
	c.nft("", "delete", "table", "inet", nftTable)
	for _, h := range unitAcceptHandles(c) {
		c.nft("", "delete", "rule", "ip", "filter", "output", "handle", h)
	}
}
