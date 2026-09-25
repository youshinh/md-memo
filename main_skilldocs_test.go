package main

import (
	"os"
	"regexp"
	"sort"
	"strings"
	"testing"

	"md-memo/pkg/cli"
)

// The agent skill (skills/md-memo) is what an AI agent reads to drive this CLI. It has to name every
// command and every flag `md-memo --help` prints, or the agent works from a stale picture. main_help_test.go
// does the same for the RPC methods.
func TestSkillDocumentsEveryCommandAndFlag(t *testing.T) {
	read := func(p string) string {
		b, err := os.ReadFile(p)
		if err != nil {
			t.Fatalf("read %s: %v", p, err)
		}
		return string(b)
	}
	skill := read("skills/md-memo/SKILL.md")
	interfaces := read("skills/md-memo/references/interfaces.md")

	commands := append(cli.CommandNames(false), cli.CommandNames(true)...)
	if len(commands) < 9 {
		t.Fatalf("expected the command registry to hold at least 9 commands, got %v", commands)
	}
	flagRe := regexp.MustCompile(`--[a-z][a-z0-9-]*`)
	for _, name := range commands {
		usage := cli.SubcommandUsage(name)
		if usage == "" {
			t.Errorf("command %q has no usage text", name)
			continue
		}
		if !strings.Contains(interfaces, "md-memo "+name) && !strings.Contains(interfaces, "`"+name+" ") {
			t.Errorf("references/interfaces.md never mentions the command `md-memo %s`", name)
		}
		if !strings.Contains(skill, name) {
			t.Errorf("SKILL.md never mentions the command %q", name)
		}
		seen := map[string]bool{}
		var missing []string
		for _, flag := range flagRe.FindAllString(usage, -1) {
			if seen[flag] {
				continue
			}
			seen[flag] = true
			if !strings.Contains(interfaces, flag) {
				missing = append(missing, flag)
			}
		}
		sort.Strings(missing)
		if len(missing) > 0 {
			t.Errorf("`md-memo help %s` prints flags that references/interfaces.md never mentions: %s", name, strings.Join(missing, " "))
		}
	}
}
