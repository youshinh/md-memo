package main

import (
	"errors"
	"fmt"
	"io"
	"os"
	"strings"
	"time"

	"md-memo/pkg/cli"
	"md-memo/pkg/ipc"
)

// notRunning is the whole error when a request has nobody to go to. The console binary never
// launches the app: starting it is md-memo.exe's job.
const notRunning = "md-memo is not running. Start md-memo.exe first."

// maxPipeBytes is the limit md-memo.exe puts on text piped into the scrap.
const maxPipeBytes = 10 * 1024 * 1024

// sendTimeout is how long the running app has to acknowledge a request. md-memo.exe waits only
// 300 ms because it falls back to starting itself; here there is no fallback, and answering
// "not running" to a busy app would be wrong.
const sendTimeout = 2 * time.Second

// env is everything run touches outside its arguments, so tests can hand in fakes.
type env struct {
	stdin  io.Reader
	stdout io.Writer
	stderr io.Writer
	// stdinIsPipe: standard input is a pipe or a file, not a terminal (text is being piped in).
	stdinIsPipe bool
	// fallbackPort is tried when there is no usable ipc-session.json, the way md-memo.exe does.
	fallbackPort int
	// sendTimeout overrides the default acknowledgement timeout (tests on a slow machine).
	sendTimeout time.Duration
}

// systemEnv is the real process environment.
func systemEnv() env {
	stat, err := os.Stdin.Stat()
	return env{
		stdin:        os.Stdin,
		stdout:       os.Stdout,
		stderr:       os.Stderr,
		stdinIsPipe:  err == nil && (stat.Mode()&os.ModeCharDevice) == 0,
		fallbackPort: ipc.DefaultPort,
	}
}

// run is the whole program; it returns the exit code.
//
// Every command (help, --version, --headless, buffer/tab/ui, jev/agent/ocr/info/scrap/config) is
// cli.Main, the code md-memo.exe runs too. What is left is what md-memo.exe answers by starting or
// raising the window: no arguments, a file name, or text piped in. Here those are forwarded to
// the running app with the same messages md-memo.exe sends (activate, open with an absolute
// path, pipe with the text), or answered with an error when no app is running.
func run(args []string, version string, e env) int {
	if code, handled := cli.Main(args, version, e.stdout, e.stderr, e.stdin); handled {
		return code
	}

	msg, err := handoffMessage(args, e)
	if err != nil {
		fmt.Fprintf(e.stderr, "Error: %v\n", err)
		return 1
	}

	port := e.fallbackPort
	if session, _ := ipc.LoadSession(); session != nil && session.Port > 0 {
		port = session.Port
	}
	timeout := e.sendTimeout
	if timeout == 0 {
		timeout = sendTimeout
	}
	if err := ipc.Send(port, msg, timeout); err != nil {
		fmt.Fprintf(e.stderr, "Error: %s\n", notRunning)
		return 1
	}
	return 0
}

// handoffMessage builds the legacy message for a command line that is not a command.
//
//   - a file name (the first argument that names an existing file) -> open, with its absolute
//     path. It is decided before standard input is looked at, so a caller whose stdin is a pipe
//     that never closes (an agent harness) cannot hang this on a plain "md-memo-cli notes.md";
//   - text on a piped stdin -> pipe, the words on the command line being the title (max 10 MB);
//   - no arguments -> activate.
//
// Anything else (an unknown word or option, or a missing file) is an error rather than a request:
// md-memo.exe would start the GUI for it, this program must not.
func handoffMessage(args []string, e env) (*ipc.Message, error) {
	now := time.Now().Format(time.RFC3339)

	if path := cli.ResolveStartupFileArg(args); path != "" {
		return &ipc.Message{Action: ipc.ActionOpen, Path: path, Timestamp: now}, nil
	}

	if e.stdinIsPipe && e.stdin != nil {
		data, err := io.ReadAll(io.LimitReader(e.stdin, maxPipeBytes+1))
		if err != nil {
			return nil, fmt.Errorf("failed to read standard input: %v", err)
		}
		if len(data) > maxPipeBytes {
			return nil, errors.New("standard input exceeds maximum allowed size (10MB)")
		}
		if len(data) > 0 {
			cwd, _ := os.Getwd()
			return &ipc.Message{
				Action:    ipc.ActionPipe,
				Content:   string(data),
				Command:   commandName(args),
				Cwd:       cwd,
				Timestamp: now,
			}, nil
		}
		// An empty pipe (a harness's closed stdin) carries nothing: treat it as no input at all.
	}

	if len(args) == 0 {
		return &ipc.Message{Action: ipc.ActionActivate, Timestamp: now}, nil
	}
	return nil, fmt.Errorf("%q is neither a command nor an existing file (md-memo-cli --help lists the commands)", strings.Join(args, " "))
}

// commandName is the heading of a piped entry: the words on the command line, or "CLI Pipe".
func commandName(args []string) string {
	if len(args) > 0 {
		return strings.Join(args, " ")
	}
	return "CLI Pipe"
}
