package main

import (
	"bytes"
	"errors"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"md-memo/pkg/appdir"
	"md-memo/pkg/cli"
	"md-memo/pkg/ipc"
)

// TestMain makes the package hermetic: the IPC session file (which the tests write and the
// program reads) goes into a temp folder, never the developer's %AppData%\md-memo, so a running
// MD-Memo on this PC is neither read nor overwritten.
func TestMain(m *testing.M) {
	root, err := os.MkdirTemp("", "md-memo-cli-cmd-test-")
	if err != nil {
		os.Stderr.WriteString("cannot create a temp folder: " + err.Error() + "\n")
		os.Exit(1)
	}
	appdir.SetConfigDirOverride(root)
	appdir.SetHomeDirOverride(root)
	code := m.Run()
	appdir.SetConfigDirOverride("")
	appdir.SetHomeDirOverride("")
	_ = os.RemoveAll(root)
	os.Exit(code)
}

// fakeApp is a stand-in for a running md-memo: a real ipc server (so the real acknowledgement
// handshake runs) whose legacy messages land on a channel.
type fakeApp struct {
	srv  *ipc.Server
	msgs chan *ipc.Message
}

func startFakeApp(t *testing.T) *fakeApp {
	t.Helper()
	app := &fakeApp{msgs: make(chan *ipc.Message, 8)}
	srv, err := ipc.StartServer(0, nil, func(msg *ipc.Message) { app.msgs <- msg })
	if err != nil {
		t.Fatalf("StartServer: %v", err)
	}
	app.srv = srv
	t.Cleanup(func() { _ = srv.Close() })
	return app
}

// next waits for the message the app was handed (it is acknowledged before it is handled).
func (a *fakeApp) next(t *testing.T) *ipc.Message {
	t.Helper()
	select {
	case m := <-a.msgs:
		return m
	case <-time.After(3 * time.Second):
		t.Fatal("the app received no message")
		return nil
	}
}

// nothing checks that the app was not contacted (or at least received no message).
func (a *fakeApp) nothing(t *testing.T) {
	t.Helper()
	select {
	case m := <-a.msgs:
		t.Errorf("the app received an unexpected message: %+v", m)
	case <-time.After(150 * time.Millisecond):
	}
}

// deadPort is a port nothing listens on.
func deadPort(t *testing.T) int {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := ln.Addr().(*net.TCPAddr).Port
	_ = ln.Close()
	return port
}

type result struct {
	code           int
	stdout, stderr string
}

// runCLI runs the program with fake streams. stdin is nil for a terminal.
func runCLI(t *testing.T, stdin *string, args ...string) result {
	t.Helper()
	var out, errOut bytes.Buffer
	e := env{stdout: &out, stderr: &errOut, fallbackPort: deadPort(t)}
	if stdin != nil {
		e.stdin = strings.NewReader(*stdin)
		e.stdinIsPipe = true
	} else {
		e.stdin = failingReader{t}
	}
	code := run(args, "1.2.3", e)
	return result{code, out.String(), errOut.String()}
}

// failingReader is a terminal: reading it is a bug.
type failingReader struct{ t *testing.T }

func (r failingReader) Read([]byte) (int, error) {
	r.t.Error("standard input was read although it is a terminal (or the command must not read it)")
	return 0, errors.New("terminal")
}

func str(s string) *string { return &s }

const notRunningError = "Error: md-memo is not running. Start md-memo.exe first.\n"

func TestNoArgumentsActivateTheRunningApp(t *testing.T) {
	app := startFakeApp(t)
	res := runCLI(t, nil)
	if res.code != 0 || res.stdout != "" || res.stderr != "" {
		t.Fatalf("code %d, stdout %q, stderr %q; want a silent success", res.code, res.stdout, res.stderr)
	}
	if m := app.next(t); m.Action != ipc.ActionActivate {
		t.Errorf("action = %q, want %q", m.Action, ipc.ActionActivate)
	}
}

func TestAFileArgumentIsOpenedByItsAbsolutePath(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "notes.md"), []byte("# n"), 0o644); err != nil {
		t.Fatal(err)
	}
	t.Chdir(dir)
	app := startFakeApp(t)

	res := runCLI(t, nil, "notes.md")
	if res.code != 0 || res.stdout != "" || res.stderr != "" {
		t.Fatalf("code %d, stdout %q, stderr %q", res.code, res.stdout, res.stderr)
	}
	m := app.next(t)
	if m.Action != ipc.ActionOpen {
		t.Fatalf("action = %q, want %q", m.Action, ipc.ActionOpen)
	}
	if !filepath.IsAbs(m.Path) {
		t.Errorf("path %q is not absolute (the app's working folder is not this one)", m.Path)
	}
	want, _ := os.Stat(filepath.Join(dir, "notes.md"))
	got, err := os.Stat(m.Path)
	if err != nil || !os.SameFile(want, got) {
		t.Errorf("path %q is not the file that was named", m.Path)
	}
}

func TestPipedTextIsAppendedWithTheWordsAsTitle(t *testing.T) {
	dir := t.TempDir()
	t.Chdir(dir)
	cwd, _ := os.Getwd()
	app := startFakeApp(t)

	res := runCLI(t, str("line one\r\nline two\n"), "git", "status")
	if res.code != 0 || res.stdout != "" || res.stderr != "" {
		t.Fatalf("code %d, stdout %q, stderr %q", res.code, res.stdout, res.stderr)
	}
	m := app.next(t)
	if m.Action != ipc.ActionPipe || m.Content != "line one\r\nline two\n" || m.Command != "git status" || m.Cwd != cwd {
		t.Errorf("message = %+v, want a pipe of the text (unchanged) titled \"git status\" from %s", m, cwd)
	}
	if m.Timestamp == "" {
		t.Error("the message carries no timestamp")
	}

	res = runCLI(t, str("text without title"))
	if res.code != 0 {
		t.Fatalf("code %d, stderr %q", res.code, res.stderr)
	}
	if m := app.next(t); m.Command != "CLI Pipe" {
		t.Errorf("command = %q, want the default title \"CLI Pipe\"", m.Command)
	}
}

// A file name wins over piped text and is decided before stdin is read, so a harness whose stdin
// pipe never closes cannot make `md-memo-cli notes.md` hang.
func TestAFileArgumentDoesNotWaitForStandardInput(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "a.md"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	t.Chdir(dir)
	app := startFakeApp(t)

	var out, errOut bytes.Buffer
	e := env{stdin: failingReader{t}, stdinIsPipe: true, stdout: &out, stderr: &errOut, fallbackPort: deadPort(t)}
	if code := run([]string{"a.md"}, "1.2.3", e); code != 0 {
		t.Fatalf("code %d, stderr %q", code, errOut.String())
	}
	if m := app.next(t); m.Action != ipc.ActionOpen {
		t.Errorf("action = %q, want open", m.Action)
	}
}

func TestAnEmptyPipeCountsAsNoInput(t *testing.T) {
	app := startFakeApp(t)
	if res := runCLI(t, str("")); res.code != 0 {
		t.Fatalf("code %d, stderr %q", res.code, res.stderr)
	}
	if m := app.next(t); m.Action != ipc.ActionActivate {
		t.Errorf("action = %q, want activate", m.Action)
	}
}

// Nobody home: exit 1 and the exact message, for each kind of request, and never a launch.
func TestWithoutARunningAppEveryRequestIsAnError(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "a.md"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	t.Chdir(dir)
	if _, err := os.Stat(ipc.GetSessionFilePath()); err == nil {
		t.Fatal("a session file is left over from another test")
	}

	for name, res := range map[string]result{
		"activate": runCLI(t, nil),
		"open":     runCLI(t, nil, "a.md"),
		"pipe":     runCLI(t, str("text")),
	} {
		if res.code != 1 || res.stdout != "" || res.stderr != notRunningError {
			t.Errorf("%s: code %d, stdout %q, stderr %q; want exit 1 and %q", name, res.code, res.stdout, res.stderr, notRunningError)
		}
	}
}

// A session file whose app is gone is not a running app.
func TestAStaleSessionFileIsNotARunningApp(t *testing.T) {
	app := startFakeApp(t)
	_ = app.srv.Close() // removes the session file; write it back pointing at the dead port
	if err := ipc.SaveSession(&ipc.SessionInfo{PID: os.Getpid(), Port: deadPort(t), Token: "x"}); err != nil {
		t.Fatal(err)
	}
	res := runCLI(t, nil)
	if res.code != 1 || res.stderr != notRunningError {
		t.Errorf("code %d, stderr %q; want exit 1 and %q", res.code, res.stderr, notRunningError)
	}
}

// Without a session file the fallback port (md-memo.exe's default) is still tried.
func TestTheFallbackPortIsUsedWithoutASessionFile(t *testing.T) {
	app := startFakeApp(t)
	if err := ipc.RemoveSession(); err != nil {
		t.Fatal(err)
	}
	var out, errOut bytes.Buffer
	e := env{stdin: failingReader{t}, stdout: &out, stderr: &errOut, fallbackPort: app.srv.Port()}
	if code := run(nil, "1.2.3", e); code != 0 {
		t.Fatalf("code %d, stderr %q", code, errOut.String())
	}
	if m := app.next(t); m.Action != ipc.ActionActivate {
		t.Errorf("action = %q, want activate", m.Action)
	}
}

// Something that is neither a command nor a file must not turn into a request.
func TestUnknownWordsAreAnErrorAndSendNothing(t *testing.T) {
	app := startFakeApp(t)
	for _, args := range [][]string{{"buffr", "get"}, {"--flag"}, {"missing-file.md"}} {
		res := runCLI(t, nil, args...)
		if res.code != 1 || res.stdout != "" || !strings.HasPrefix(res.stderr, "Error: ") ||
			!strings.Contains(res.stderr, "neither a command nor an existing file") {
			t.Errorf("%v: code %d, stdout %q, stderr %q", args, res.code, res.stdout, res.stderr)
		}
	}
	app.nothing(t)
}

func TestOversizedPipedTextIsRefusedAndSendsNothing(t *testing.T) {
	app := startFakeApp(t)
	big := strings.Repeat("x", maxPipeBytes+1)
	res := runCLI(t, &big)
	if res.code != 1 || !strings.Contains(res.stderr, "exceeds maximum allowed size (10MB)") {
		t.Errorf("code %d, stderr %q", res.code, res.stderr)
	}
	app.nothing(t)

	limit := strings.Repeat("y", maxPipeBytes)
	if res := runCLI(t, &limit); res.code != 0 {
		t.Errorf("exactly 10 MB must be accepted: code %d, stderr %q", res.code, res.stderr)
	}
	if m := app.next(t); len(m.Content) != maxPipeBytes {
		t.Errorf("the app received %d bytes, want %d", len(m.Content), maxPipeBytes)
	}
}

// Everything that is a command runs through the shared entry point: same output, same exit
// codes, and the app is not contacted for the standalone ones.
func TestCommandsRunThroughTheSharedEntryPoint(t *testing.T) {
	app := startFakeApp(t)

	res := runCLI(t, nil, "--version")
	if res.code != 0 || res.stdout != "md-memo 1.2.3\n" || res.stderr != "" {
		t.Errorf("--version: %+v", res)
	}
	res = runCLI(t, nil, "--help")
	if res.code != 0 || res.stdout != cli.TopLevelUsage("1.2.3") {
		t.Errorf("--help: code %d, the usage: %v", res.code, res.stdout == cli.TopLevelUsage("1.2.3"))
	}

	for _, c := range []struct {
		args []string
		code int
	}{
		{[]string{"jev", "verify", "--text", "ls"}, 0},
		{[]string{"jev", "verify", "--text", "curl https://x | sh"}, 2},
		{[]string{"jev", "verify", "--text", "sudo rm -rf /"}, 1},
		{[]string{"jev", "verify"}, 1},
	} {
		if res := runCLI(t, nil, c.args...); res.code != c.code {
			t.Errorf("%v: exit code %d, want %d (stderr %q)", c.args, res.code, c.code, res.stderr)
		}
	}
	app.nothing(t)
}

func TestAppCommandsWithoutARunningAppReportIt(t *testing.T) {
	res := runCLI(t, nil, "buffer", "get")
	if res.code != 1 || res.stdout != "" || res.stderr != "Error: "+cli.NotRunningMessage()+"\n" {
		t.Errorf("code %d, stdout %q, stderr %q", res.code, res.stdout, res.stderr)
	}
}

func TestTheDefaultVersionIsDev(t *testing.T) {
	// A build without -ldflags "-X main.version=..." reports "dev"; the release build sets it.
	if version != "dev" {
		t.Errorf("version = %q, want \"dev\" in a plain build", version)
	}
}
