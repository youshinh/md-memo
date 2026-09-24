package cli

import (
	"bytes"
	"strings"
	"testing"
)

func TestHelpRequestTopLevel(t *testing.T) {
	for _, args := range [][]string{{"--help"}, {"-h"}, {"-help"}, {"help"}, {"help", "nonsense"}} {
		text, ok := HelpRequest(args, "9.9.9")
		if !ok {
			t.Errorf("%v: expected a help request", args)
			continue
		}
		if !strings.HasPrefix(text, "md-memo 9.9.9 ") {
			t.Errorf("%v: usage should start with the version, got %q", args, firstLine(text))
		}
		// Every command word the dispatcher knows must be documented in the top-level help.
		for _, want := range []string{"buffer get", "buffer set", "buffer append", "buffer replace", "buffer replace-selection",
			"tab list", "tab switch", "ui activate", "ui toggle-split", "ui eval",
			"jev verify", "jev score", "jev predict", "jev dispatch", "agent prune", "ocr ", "--headless", "--version"} {
			if !strings.Contains(text, want) {
				t.Errorf("%v: top-level usage does not mention %q", args, want)
			}
		}
	}
}

func TestHelpRequestVersion(t *testing.T) {
	for _, a := range []string{"--version", "-version", "-v", "-V"} {
		text, ok := HelpRequest([]string{a}, "1.2.3")
		if !ok || text != "md-memo 1.2.3\n" {
			t.Errorf("%s: got %q, %v", a, text, ok)
		}
	}
}

func TestHelpRequestSubcommands(t *testing.T) {
	cases := []struct {
		args []string
		name string
	}{
		{[]string{"help", "buffer"}, "buffer"},
		{[]string{"buffer", "--help"}, "buffer"},
		{[]string{"buffer", "-h"}, "buffer"},
		{[]string{"buffer", "help"}, "buffer"},
		{[]string{"buffer", "get", "--help"}, "buffer"},
		{[]string{"buffer", "append", "-h"}, "buffer"},
		{[]string{"buffer", "get", "--tab", "3", "-h"}, "buffer"}, // the value of --tab is stepped over
		{[]string{"buffer", "set", "--expected-hash=abc", "--help"}, "buffer"},
		{[]string{"tab", "--help"}, "tab"},
		{[]string{"tab", "list", "-h"}, "tab"},
		{[]string{"ui", "eval", "--help"}, "ui"},
		{[]string{"agent", "prune", "--help"}, "agent"},
		{[]string{"agent", "-h"}, "agent"},
		{[]string{"ocr", "--help"}, "ocr"},
		{[]string{"ocr", "--json", "-h"}, "ocr"},
		{[]string{"jev", "--help"}, "jev"},
		{[]string{"jev", "help"}, "jev"},
		{[]string{"help", "jev"}, "jev"},
	}
	for _, c := range cases {
		text, ok := HelpRequest(c.args, "1.0.0")
		if !ok {
			t.Errorf("%v: expected help", c.args)
			continue
		}
		if text != SubcommandUsage(c.name) {
			t.Errorf("%v: expected the %s usage, got %q", c.args, c.name, firstLine(text))
		}
	}
}

// A help flag that is really part of the command's text must not be swallowed: the text of an
// append is written to the user's note, and the text of jev verify is what gets judged.
func TestHelpRequestLeavesCommandTextAlone(t *testing.T) {
	for _, args := range [][]string{
		{"buffer", "append", "hello", "-h"},
		{"buffer", "append", "-h note"}, // one argument that merely starts with "-h"
		{"buffer", "append", "--", "-h"},
	} {
		if text, ok := HelpRequest(args, "1.0.0"); ok {
			t.Errorf("%v: must not be treated as a help request, got %q", args, firstLine(text))
		}
	}
	for _, args := range [][]string{
		{"ocr", "photo.png", "-h"},
		{"ocr", "--", "-h"},
		{"ui", "eval", "1+1", "-h"},
		{"tab", "switch", "tab_1", "--help"},
	} {
		if text, ok := HelpRequest(args, "1.0.0"); ok {
			t.Errorf("%v: must not be treated as a help request, got %q", args, firstLine(text))
		}
	}
}

// jev verify's exit status is a verdict (0 = safe), so a help flag after its action word must
// never be turned into "print help, exit 0". It has to reach the flag parser, which rejects it.
func TestHelpRequestNeverInterceptsJevVerify(t *testing.T) {
	for _, args := range [][]string{
		{"jev", "verify", "-h"},
		{"jev", "verify", "--help"},
		{"jev", "verify", "-h", "&&", "rm", "-rf", "/"},
		{"jev", "verify", "--mode", "strict", "--help"},
		{"jev", "score", "-h"},
		{"jev", "predict", "--help"},
		{"jev", "verify", "ls", "-h"},
	} {
		if text, ok := HelpRequest(args, "1.0.0"); ok {
			t.Errorf("%v: jev must not be intercepted past its action word, got %q", args, firstLine(text))
		}
	}
	// ...and the runner really does fail closed for those.
	var stdout, stderr bytes.Buffer
	runner := NewHeadlessRunner(&stdout, &stderr)
	code, _ := runner.Run([]string{"jev", "verify", "-h", "&&", "rm", "-rf", "/"})
	if code == 0 {
		t.Errorf("jev verify -h && rm -rf / must not exit 0 (safe)")
	}
}

func TestHelpRequestIgnoresEverythingElse(t *testing.T) {
	for _, args := range [][]string{
		nil,
		{},
		{"notes.md"},
		{"--headless", "help"}, // handled by HeadlessRunner, not here
		{"buffer"},
		{"tab"},
		{"unknown", "--help"},
		{"--some-flag"},
	} {
		if text, ok := HelpRequest(args, "1.0.0"); ok {
			t.Errorf("%v: unexpected help request %q", args, firstLine(text))
		}
	}
}

func TestSubcommandUsageCoversAllSubcommands(t *testing.T) {
	for _, name := range []string{"buffer", "tab", "ui", "jev", "agent", "ocr"} {
		if !isSubcommand(name) {
			t.Errorf("%s should be a subcommand", name)
		}
		text := SubcommandUsage(name)
		if !strings.HasPrefix(text, "md-memo "+name) {
			t.Errorf("%s usage should start with the command line, got %q", name, firstLine(text))
		}
	}
	if SubcommandUsage("bogus") != "" || isSubcommand("bogus") {
		t.Error("unknown words must not have usage")
	}
}

func TestHeadlessHelpListsEveryHeadlessCommand(t *testing.T) {
	var stdout, stderr bytes.Buffer
	code, err := NewHeadlessRunner(&stdout, &stderr).Run([]string{"--help"})
	if err != nil || code != 0 {
		t.Fatalf("--headless --help: code %d, err %v", code, err)
	}
	for _, want := range []string{"jev verify", "jev score", "jev predict", "jev dispatch", "agent prune", "ocr", "md-memo --help"} {
		if !strings.Contains(stdout.String(), want) {
			t.Errorf("headless help does not mention %q:\n%s", want, stdout.String())
		}
	}
}

func firstLine(s string) string {
	if i := strings.IndexByte(s, '\n'); i >= 0 {
		return s[:i]
	}
	return s
}
