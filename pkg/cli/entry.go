package cli

import (
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"md-memo/pkg/ipc"
)

// Main is the one entry point of the command line, shared by the two executables: md-memo.exe /
// the macOS binary (main.go, which also starts the GUI) and the console-subsystem md-memo-cli.exe
// (cmd/md-memo-cli, which never starts it).
//
// It answers everything that does not need a window:
//
//   - --help, -h, help [command], --version (HelpRequest);
//   - --headless <command> (the standalone commands with an explicit "no GUI" marker);
//   - a command word of the registry (registry.go): a standalone command runs in this process, an
//     app command (buffer, tab, ui) is sent to the running app through its IPC session.
//
// handled is false when args are not a command line at all: no arguments, a file name, or text
// piped in for the scrap. Nothing has been written or run in that case and the caller decides
// (the GUI exe starts or activates the window, md-memo-cli forwards the request to the running
// app or says that none is running). When handled is true, exitCode is what the process must
// exit with.
//
// stdout and stderr receive the output (nil means os.Stdout / os.Stderr); stdin is what the
// commands that read text from standard input consume (nil means os.Stdin, read only when it is
// piped). Terminal detection for the output format still looks at the real os.Stdout: a caller
// that hands in other writers gets the piped-output format (JSON) unless it passes --text.
func Main(args []string, version string, stdout, stderr io.Writer, stdin io.Reader) (exitCode int, handled bool) {
	if stdout == nil {
		stdout = os.Stdout
	}
	if stderr == nil {
		stderr = os.Stderr
	}

	// --help / -h / help [command] / --version: print and stop before anything can start or raise
	// the GUI (an agent probing the CLI must not open the user's window).
	if text, ok := HelpRequest(args, version); ok {
		fmt.Fprint(stdout, text)
		return 0, true
	}

	// --headless <command>
	if len(args) > 0 && args[0] == "--headless" {
		runner := NewHeadlessRunner(stdout, stderr).WithVersion(version).WithStdin(stdin)
		code, err := runner.Run(args[1:])
		return finish(code, err, stderr), true
	}

	// The list of command words, and which of them run without the GUI, is the registry in
	// registry.go.
	if len(args) > 0 && IsSubcommand(args[0]) {
		subcmd := args[0]

		// The standalone commands (jev, agent, ocr, info, scrap, config) are headless-capable
		// computations (instant execution, no running instance required) - ocr in particular must
		// work with md-memo not running at all, since it's what the Explorer "Send to" menu
		// entry invokes.
		if IsStandalone(subcmd) {
			runner := NewHeadlessRunner(stdout, stderr).WithVersion(version).WithStdin(stdin)
			code, err := runner.Run(args)
			return finish(code, err, stderr), true
		}

		session, err := ipc.LoadSession()
		if err != nil || session == nil {
			fmt.Fprintf(stderr, "Error: %s\n", NotRunningMessage())
			return 1, true
		}
		client := NewClientRunner(session, stdout, stderr).WithStdin(stdin)
		code, err := client.Run(args)
		return finish(code, err, stderr), true
	}

	return 0, false
}

// finish prints a runner's error the way every command does ("Error: ..." on stderr) and returns
// the exit code.
func finish(code int, err error, stderr io.Writer) int {
	if err != nil {
		fmt.Fprintf(stderr, "Error: %v\n", err)
	}
	return code
}

// ResolveStartupFileArg picks the first command-line argument that names an existing file and
// returns its absolute path, or "" when there is none.
//
// It deliberately mirrors the GUI's GetStartupFile argument scanning (skip flags, strip
// surrounding quotes, stat the result) so a file opened through an already-running instance and a
// file opened on a cold start are selected by exactly the same rule. The path is made absolute
// here, in the process that still has the user's working directory: the running instance's cwd
// is wherever it happened to be launched from.
func ResolveStartupFileArg(args []string) string {
	for _, arg := range args {
		if strings.HasPrefix(arg, "-") {
			continue
		}
		cleanPath := strings.Trim(arg, "\"")
		cleanPath = strings.Trim(cleanPath, "'")
		if cleanPath == "" {
			continue
		}
		info, err := os.Stat(cleanPath)
		if err != nil || info.IsDir() {
			continue
		}
		absPath, err := filepath.Abs(cleanPath)
		if err != nil {
			return cleanPath
		}
		return absPath
	}
	return ""
}
