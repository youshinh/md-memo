package main

import (
	"os"
	"regexp"
	"strings"
	"testing"

	"md-memo/pkg/cli"
)

// `md-memo --help` documents the JSON-RPC methods by hand. This keeps that text honest: a method
// added to app_rpc.go without a line in the help (the text an AI agent reads first) fails here.
func TestHelpListsEveryRPCMethod(t *testing.T) {
	src, err := os.ReadFile("app_rpc.go")
	if err != nil {
		t.Fatalf("read app_rpc.go: %v", err)
	}
	methods := regexp.MustCompile(`case "([a-z_]+\.[a-z_]+)":`).FindAllStringSubmatch(string(src), -1)
	if len(methods) < 10 {
		t.Fatalf("expected the RPC switch in app_rpc.go to hold 11 methods, found %d: the pattern needs updating", len(methods))
	}
	usage := cli.TopLevelUsage(AppVersion)
	for _, m := range methods {
		if !strings.Contains(usage, m[1]) {
			t.Errorf("RPC method %s is handled in app_rpc.go but missing from `md-memo --help`", m[1])
		}
	}
}

func TestHelpShowsTheRealVersion(t *testing.T) {
	text, ok := cli.HelpRequest([]string{"--version"}, AppVersion)
	if !ok || text != "md-memo "+AppVersion+"\n" {
		t.Errorf("--version printed %q (ok=%v)", text, ok)
	}
	usage := cli.TopLevelUsage(AppVersion)
	if !strings.HasPrefix(usage, "md-memo "+AppVersion+" ") {
		t.Errorf("usage should start with the app version, got %q", usage[:20])
	}
}
