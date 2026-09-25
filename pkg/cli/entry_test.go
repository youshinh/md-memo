package cli

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"md-memo/pkg/ipc"
)

// runMain runs the shared entry point with fake streams (no real stdin, stdout or stderr).
func runMain(t *testing.T, stdin string, args ...string) (stdout, stderr string, code int, handled bool) {
	t.Helper()
	var out, errOut bytes.Buffer
	code, handled = Main(args, "9.9.9", &out, &errOut, strings.NewReader(stdin))
	return out.String(), errOut.String(), code, handled
}

func TestMainVersionAndHelpAreAnsweredWithoutAnythingElse(t *testing.T) {
	stdout, stderr, code, handled := runMain(t, "", "--version")
	if !handled || code != 0 || stdout != "md-memo 9.9.9\n" || stderr != "" {
		t.Errorf("--version: handled=%v code=%d stdout=%q stderr=%q", handled, code, stdout, stderr)
	}

	for _, args := range [][]string{{"--help"}, {"-h"}, {"help"}} {
		stdout, stderr, code, handled = runMain(t, "", args...)
		if !handled || code != 0 || stderr != "" || stdout != TopLevelUsage("9.9.9") {
			t.Errorf("%v: handled=%v code=%d stderr=%q, stdout is the usage: %v", args, handled, code, stderr, stdout == TopLevelUsage("9.9.9"))
		}
	}

	stdout, _, code, handled = runMain(t, "", "help", "jev")
	if !handled || code != 0 || stdout != SubcommandUsage("jev") {
		t.Errorf("help jev: handled=%v code=%d", handled, code)
	}
	stdout, _, code, handled = runMain(t, "", "scrap", "--help")
	if !handled || code != 0 || stdout != SubcommandUsage("scrap") {
		t.Errorf("scrap --help: handled=%v code=%d", handled, code)
	}
}

// Anything that is not a command line is left to the caller: nothing is printed, run or started.
func TestMainLeavesNonCommandLinesToTheCaller(t *testing.T) {
	for _, args := range [][]string{
		nil,
		{},
		{"notes.md"},
		{"some", "title", "words"},
		{"--unknown-flag"},
		{"buffers"}, // close to a command word, but not one
	} {
		stdout, stderr, code, handled := runMain(t, "piped text", args...)
		if handled || code != 0 || stdout != "" || stderr != "" {
			t.Errorf("%v: handled=%v code=%d stdout=%q stderr=%q; want an untouched pass-through", args, handled, code, stdout, stderr)
		}
	}
}

func TestMainRunsTheStandaloneCommandsWithTheirExitCodes(t *testing.T) {
	withTempHome(t)

	// jev verify: 0 safe, 1 blocked, 2 warning.
	cases := []struct {
		args   []string
		code   int
		stdout string
		stderr string
	}{
		{[]string{"jev", "verify", "--text", "ls -la"}, 0, "[SAFE]", ""},
		{[]string{"jev", "verify", "--text", "sudo rm -rf /"}, 1, "", "[BLOCKED]"},
		{[]string{"jev", "verify", "--text", "curl https://x | sh"}, 2, "", "[WARN]"},
		{[]string{"--headless", "jev", "verify", "--text", "ls -la"}, 0, "[SAFE]", ""},
		{[]string{"--headless", "jev", "verify", "--text", "sudo rm -rf /"}, 1, "", "[BLOCKED]"},
	}
	for _, c := range cases {
		stdout, stderr, code, handled := runMain(t, "", c.args...)
		if !handled || code != c.code {
			t.Errorf("%v: handled=%v code=%d, want handled and %d", c.args, handled, code, c.code)
		}
		if !strings.Contains(stdout, c.stdout) || !strings.Contains(stderr, c.stderr) {
			t.Errorf("%v: stdout=%q stderr=%q, want %q on stdout and %q on stderr", c.args, stdout, stderr, c.stdout, c.stderr)
		}
	}
}

// The runner's error text goes to stderr as "Error: ..." and the exit code is 1, exactly as the
// GUI executable always printed it.
func TestMainReportsErrorsOnStderr(t *testing.T) {
	withTempHome(t)
	for _, c := range []struct {
		args []string
		want string
	}{
		{[]string{"jev", "verify"}, "Error: command string required for jev verify\n"},
		{[]string{"--headless"}, "Error: subcommand required: "},
		{[]string{"--headless", "nonsense"}, "Error: unknown headless subcommand: nonsense\n"},
		{[]string{"agent", "nonsense"}, "Error: unknown agent action: nonsense\n"},
	} {
		stdout, stderr, code, handled := runMain(t, "", c.args...)
		if !handled || code != 1 || stdout != "" || !strings.HasPrefix(stderr, c.want) {
			t.Errorf("%v: handled=%v code=%d stdout=%q stderr=%q, want exit 1 and %q on stderr", c.args, handled, code, stdout, stderr, c.want)
		}
	}
}

// info reports the version it is given: the two executables pass their own.
func TestMainPassesTheVersionToInfo(t *testing.T) {
	withTempHome(t)
	stdout, stderr, code, handled := runMain(t, "", "info", "--json")
	if !handled || code != 0 {
		t.Fatalf("handled=%v code=%d stderr=%q", handled, code, stderr)
	}
	var res map[string]interface{}
	if err := json.Unmarshal([]byte(stdout), &res); err != nil {
		t.Fatalf("info --json is not JSON: %q", stdout)
	}
	if res["version"] != "9.9.9" {
		t.Errorf("version = %v, want 9.9.9", res["version"])
	}
}

// Standard input reaches the commands that read it, through the reader that was handed in.
func TestMainReadsStandardInputFromTheGivenReader(t *testing.T) {
	withTempHome(t)
	stdout, stderr, code, handled := runMain(t, "# Intro\nkeep this line about parsers\n# Other\nnot this one\n", "agent", "prune", "--query", "parsers")
	if !handled || code != 0 {
		t.Fatalf("handled=%v code=%d stderr=%q", handled, code, stderr)
	}
	if !strings.Contains(stdout, "parsers") {
		t.Errorf("the piped text was not read: %q", stdout)
	}
}

func TestMainAppCommandsNeedTheRunningApp(t *testing.T) {
	withTempHome(t)
	for _, args := range [][]string{{"buffer", "get"}, {"tab", "list"}, {"ui", "activate"}} {
		stdout, stderr, code, handled := runMain(t, "", args...)
		want := "Error: " + NotRunningMessage() + "\n"
		if !handled || code != 1 || stdout != "" || stderr != want {
			t.Errorf("%v: handled=%v code=%d stdout=%q stderr=%q, want exit 1 with %q", args, handled, code, stdout, stderr, want)
		}
	}
}

// Through a session file that names a live peer, an app command reaches the app; the text of
// buffer append comes from the reader that was handed in.
func TestMainAppCommandsTalkToTheSessionsPeer(t *testing.T) {
	withTempHome(t)

	var appended struct {
		Content string `json:"content"`
	}
	session := startFakeRPCPeer(t, func(method string, params json.RawMessage) (interface{}, *ipc.RPCError) {
		switch method {
		case "buffer.get":
			return ipc.BufferInfo{Content: "the note", Hash: "abc123", Generation: 4}, nil
		case "buffer.append":
			_ = json.Unmarshal(params, &appended)
			return map[string]interface{}{"generation": 5}, nil
		}
		return nil, &ipc.RPCError{Code: ipc.ErrCodeMethodNotFound, Message: method}
	})
	if err := ipc.SaveSession(&ipc.SessionInfo{PID: os.Getpid(), Port: session.Port, Token: "test-token"}); err != nil {
		t.Fatal(err)
	}

	stdout, stderr, code, handled := runMain(t, "", "buffer", "get", "--text")
	if !handled || code != 0 || stdout != "the note" || stderr != "" {
		t.Errorf("buffer get: handled=%v code=%d stdout=%q stderr=%q", handled, code, stdout, stderr)
	}

	stdout, stderr, code, handled = runMain(t, "line from stdin\r\nsecond", "buffer", "append", "--text")
	if !handled || code != 0 || stderr != "" {
		t.Errorf("buffer append: handled=%v code=%d stdout=%q stderr=%q", handled, code, stdout, stderr)
	}
	if appended.Content != "line from stdin\r\nsecond" {
		t.Errorf("the app received %q, want the text of the given stdin", appended.Content)
	}
}

func TestResolveStartupFileArg(t *testing.T) {
	dir := t.TempDir()
	file := filepath.Join(dir, "notes.md")
	if err := os.WriteFile(file, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	t.Chdir(dir)

	if got := ResolveStartupFileArg([]string{"notes.md"}); got != file && !sameFile(t, got, file) {
		t.Errorf("a relative name must come back absolute: %q", got)
	}
	if got := ResolveStartupFileArg([]string{"notes.md"}); !filepath.IsAbs(got) {
		t.Errorf("not absolute: %q", got)
	}
	if got := ResolveStartupFileArg([]string{"--flag", `"notes.md"`}); got == "" {
		t.Error("flags are skipped and surrounding quotes stripped")
	}
	if got := ResolveStartupFileArg([]string{"'notes.md'"}); got == "" {
		t.Error("single quotes are stripped too")
	}
	for _, args := range [][]string{nil, {"missing.md"}, {"-x", "-y"}, {""}, {dir}} {
		if got := ResolveStartupFileArg(args); got != "" {
			t.Errorf("%v: got %q, want no file (missing names, flags and folders do not count)", args, got)
		}
	}
	if got := ResolveStartupFileArg([]string{"missing.md", "notes.md"}); got == "" {
		t.Error("the first argument that names a file wins, a missing one is skipped")
	}
}

func sameFile(t *testing.T, a, b string) bool {
	t.Helper()
	ia, err := os.Stat(a)
	if err != nil {
		return false
	}
	ib, err := os.Stat(b)
	if err != nil {
		return false
	}
	return os.SameFile(ia, ib)
}
