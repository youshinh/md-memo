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
			"jev verify", "jev score", "jev predict", "jev dispatch", "agent prune", "ocr ", "--headless", "--version",
			"buffer get --out", "info ", "scrap path", "scrap list", "scrap search", "config get", "md-memo-cli.exe"} {
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
		{[]string{"agent", "install-skill", "--help"}, "agent"},
		{[]string{"agent", "install-skill", "--dir", "some folder", "-h"}, "agent"}, // the value of --dir is stepped over
		{[]string{"ocr", "--help"}, "ocr"},
		{[]string{"ocr", "--json", "-h"}, "ocr"},
		{[]string{"jev", "--help"}, "jev"},
		{[]string{"jev", "help"}, "jev"},
		{[]string{"help", "jev"}, "jev"},
		{[]string{"buffer", "get", "--out", "x.md", "-h"}, "buffer"}, // the value of --out is stepped over
		{[]string{"info", "--help"}, "info"},
		{[]string{"info", "--json", "-h"}, "info"},
		{[]string{"help", "info"}, "info"},
		{[]string{"scrap", "--help"}, "scrap"},
		{[]string{"scrap", "list", "-h"}, "scrap"},
		{[]string{"scrap", "search", "--limit", "3", "-h"}, "scrap"}, // the value of --limit is stepped over
		{[]string{"scrap", "path", "--date", "2026-09-25", "--help"}, "scrap"},
		{[]string{"help", "scrap"}, "scrap"},
		{[]string{"config", "--help"}, "config"},
		{[]string{"config", "get", "-h"}, "config"},
		{[]string{"help", "config"}, "config"},
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
		{"info", "extra", "-h"},            // reaches the runner, which rejects the extra word
		{"scrap", "search", "topic", "-h"}, // reaches the runner, which prints the usage itself
		{"config", "get", "vision", "--help"},
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
		{"unknown"},
		{"notes.md", "--some-flag"},
		{"--some-flag"},
	} {
		if text, ok := HelpRequest(args, "1.0.0"); ok {
			t.Errorf("%v: unexpected help request %q", args, firstLine(text))
		}
	}
}

func TestSubcommandUsageCoversAllSubcommands(t *testing.T) {
	// The names are pinned here on purpose: dropping or renaming a command must be a decision.
	pinned := []string{"buffer", "tab", "ui", "jev", "agent", "ocr", "info", "scrap", "config"}
	registered := append(CommandNames(false), CommandNames(true)...)
	if strings.Join(registered, " ") != strings.Join(pinned, " ") {
		t.Errorf("registry commands = %v, want %v", registered, pinned)
	}
	for _, name := range pinned {
		if !IsSubcommand(name) {
			t.Errorf("%s should be a subcommand", name)
		}
		text := SubcommandUsage(name)
		if !strings.HasPrefix(text, "md-memo "+name) {
			t.Errorf("%s usage should start with the command line, got %q", name, firstLine(text))
		}
		// ... and the top-level help must show every one of them.
		if !strings.Contains(TopLevelUsage("1.0.0"), "  "+name+" ") {
			t.Errorf("top-level usage does not list the %s command", name)
		}
	}
	if SubcommandUsage("bogus") != "" || IsSubcommand("bogus") {
		t.Error("unknown words must not have usage")
	}
}

func TestRegistryKinds(t *testing.T) {
	for _, name := range []string{"jev", "agent", "ocr", "info", "scrap", "config"} {
		if !IsStandalone(name) {
			t.Errorf("%s runs without the GUI", name)
		}
	}
	for _, name := range []string{"buffer", "tab", "ui"} {
		if IsStandalone(name) || !IsSubcommand(name) {
			t.Errorf("%s needs the running app", name)
		}
	}
	if IsStandalone("bogus") || IsStandalone("") || IsSubcommand("") {
		t.Error("unknown words are not commands")
	}
	msg := NotRunningMessage()
	for _, want := range []string{"md-memo is not running", "buffer, tab and ui need the running app", "(jev, agent, ocr, info, scrap and config do not)"} {
		if !strings.Contains(msg, want) {
			t.Errorf("NotRunningMessage = %q, want it to contain %q", msg, want)
		}
	}
	// A run through the wrong runner is refused, not executed.
	var out, errOut bytes.Buffer
	if code, err := NewHeadlessRunner(&out, &errOut).Run([]string{"buffer", "get"}); code != 1 || err == nil {
		t.Errorf("--headless buffer must be refused, got code %d, err %v", code, err)
	}
	if code, err := NewClientRunner(nil, &out, &errOut).Run([]string{"jev", "score", "ls"}); code != 1 || err == nil {
		t.Errorf("the client runner must not run jev, got code %d, err %v", code, err)
	}
}

// ocr takes an image path and info nothing, not an action word, so only their LEADING flags can
// ask for help.
func TestHasNoActionCommands(t *testing.T) {
	if !hasNoAction("ocr") || !hasNoAction("info") || hasNoAction("buffer") || hasNoAction("bogus") {
		t.Error("ocr and info have no action word; buffer and unknown words are not treated that way")
	}
}

func TestHeadlessHelpListsEveryHeadlessCommand(t *testing.T) {
	var stdout, stderr bytes.Buffer
	code, err := NewHeadlessRunner(&stdout, &stderr).Run([]string{"--help"})
	if err != nil || code != 0 {
		t.Fatalf("--headless --help: code %d, err %v", code, err)
	}
	for _, want := range []string{"jev verify", "jev score", "jev predict", "jev dispatch", "agent prune", "ocr", "info", "scrap path", "scrap list", "scrap search", "config get", "md-memo --help"} {
		if !strings.Contains(stdout.String(), want) {
			t.Errorf("headless help does not mention %q:\n%s", want, stdout.String())
		}
	}
}

// The two surfaces that are not commands (a pipe and the JSON-RPC port) have their own help
// topics, and an agent that guesses `md-memo rpc --help` or any other word must get usage
// text rather than a GUI start.
func TestHelpRequestTopicsAndGuessedWords(t *testing.T) {
	cases := []struct {
		args []string
		want string
	}{
		{[]string{"help", "rpc"}, rpcHelp},
		{[]string{"help", "pipe"}, pipeHelp},
		{[]string{"rpc", "--help"}, rpcHelp},
		{[]string{"pipe", "-h"}, pipeHelp},
		{[]string{"settings", "--help"}, TopLevelUsage("1.0.0")}, // not a command: the full usage
		{[]string{"share", "-h"}, TopLevelUsage("1.0.0")},
	}
	for _, c := range cases {
		text, ok := HelpRequest(c.args, "1.0.0")
		if !ok || text != c.want {
			t.Errorf("%v: got ok=%v %q", c.args, ok, firstLine(text))
		}
	}
}

func TestTopLevelUsageCoversRPCAndPipe(t *testing.T) {
	text := TopLevelUsage("1.0.0")
	for _, want := range []string{
		"JSON-RPC 2.0", "ipc-session.json", "127.0.0.1", `"auth"`, "one JSON object per line",
		"buffer.get", "buffer.set", "buffer.append", "buffer.replace", "buffer.get_selection", "buffer.replace_selection",
		"tab.list", "tab.switch", "ui.activate", "ui.toggle_split", "ui.eval",
		"-32001", "-32003", "-32602", "-32601", "-32603", "-32000",
		"<command> | md-memo", "STARTS it", "--expected-hash", "help rpc", "help pipe",
	} {
		if !strings.Contains(text, want) {
			t.Errorf("top-level usage does not mention %q", want)
		}
	}
}

func firstLine(s string) string {
	if i := strings.IndexByte(s, '\n'); i >= 0 {
		return s[:i]
	}
	return s
}
