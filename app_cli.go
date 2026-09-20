package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"regexp"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"md-memo/pkg/boundedbuf"
	"md-memo/pkg/encoding"
	"md-memo/pkg/jev"
	"md-memo/pkg/procutil"
)

// Compiled on first use, not at start-up: most command output carries no escape codes at all.
var ansiEscapeRegex = sync.OnceValue(func() *regexp.Regexp {
	return regexp.MustCompile(`\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\].*?(\x07|\x1b\\)`)
})

func stripAnsi(s string) string {
	if !strings.Contains(s, "\x1b") {
		return s
	}
	return ansiEscapeRegex().ReplaceAllString(s, "")
}

// CommandResult represents the output from executing an external CLI filter.
type CommandResult struct {
	Output   string `json:"output"`
	Error    string `json:"error"`
	ExitCode int    `json:"exitCode"`
}

// mapUnixFilterForWindows translates common Unix pipeline filters to PowerShell equivalents on Windows.
func mapUnixFilterForWindows(trimmed string) (string, bool) {
	lower := strings.ToLower(trimmed)
	if lower == "sort -r" || lower == "sort -r -" {
		return "$input | Sort-Object -Descending", true
	}
	if lower == "sort -u" || lower == "sort -u -" {
		return "$input | Sort-Object -Unique", true
	}
	if lower == "uniq" || lower == "uniq -" {
		return "$input | Get-Unique", true
	}
	return trimmed, false
}

// maxCliOutputBytes caps how much stdout/stderr a single CLI filter invocation retains in
// memory, matching the 10MB order of magnitude used for piped stdin (see maxPipeBytes in
// main.go). Beyond it a single truncation marker is appended and the rest is drained but
// discarded, so the child process never blocks on a full pipe.
const maxCliOutputBytes = 10 * 1024 * 1024

var (
	pwshLookupOnce sync.Once
	pwshExePath    string
)

// resolvePwshExe locates pwsh.exe on PATH once and caches the result for the lifetime of the process,
// avoiding a filesystem PATH scan on every CLI filter invocation.
func resolvePwshExe() string {
	pwshLookupOnce.Do(func() {
		if p, lookErr := exec.LookPath("pwsh.exe"); lookErr == nil && p != "" {
			pwshExePath = p
		}
	})
	return pwshExePath
}

func runSingleShell(ctx context.Context, shellType, trimmed, input string) (string, string, int, error) {
	var cmd *exec.Cmd
	if runtime.GOOS == "windows" {
		if shellType == "powershell" {
			shellExe := "powershell.exe"
			if p := resolvePwshExe(); p != "" {
				shellExe = p
			}

			cleanCmd := trimmed
			if mapped, ok := mapUnixFilterForWindows(cleanCmd); ok {
				cleanCmd = mapped
			} else if strings.HasPrefix(cleanCmd, "|") {
				cleanCmd = "$input " + cleanCmd
			} else {
				lower := strings.ToLower(cleanCmd)
				if strings.HasPrefix(lower, "sort-object") || strings.HasPrefix(lower, "where-object") ||
					strings.HasPrefix(lower, "select-string") || strings.HasPrefix(lower, "select-object") ||
					strings.HasPrefix(lower, "foreach-object") || strings.HasPrefix(lower, "get-unique") ||
					strings.HasPrefix(lower, "group-object") {
					cleanCmd = "$input | " + cleanCmd
				}
			}

			// [Console]::InputEncoding's setter calls SetConsoleCP, which throws when stdin has
			// been redirected (always true here: cmd.Stdin is a pipe) rather than being a real
			// console input buffer. Wrapping it in try/catch keeps that a no-op instead of
			// aborting the whole script before cleanCmd ever runs. OutputEncoding assignments
			// target a StreamWriter over the redirected stdout stream and work regardless.
			psScript := "$env:NO_COLOR = '1'; if ($PSStyle) { $PSStyle.OutputRendering = 'PlainText' }; try { [Console]::InputEncoding = [System.Text.Encoding]::UTF8 } catch {}; try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}; $OutputEncoding = [System.Text.Encoding]::UTF8; " + cleanCmd
			cmd = exec.CommandContext(ctx, shellExe, "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", psScript)
		} else {
			cmdStr := "chcp 65001 >nul & " + trimmed
			cmd = exec.CommandContext(ctx, "cmd.exe", "/c", cmdStr)
		}
	} else {
		cmd = exec.CommandContext(ctx, "sh", "-c", trimmed)
	}

	cmd.Env = append(os.Environ(), "NO_COLOR=1", "TERM=dumb")
	setupCmdProcessTreeKill(cmd)
	setCmdWindowFlags(cmd)
	cmd.Stdin = strings.NewReader(input)
	// Bounded accumulators: a filter command that cats a huge file must not be able to grow
	// these without limit. os/exec keeps draining the child's pipes either way, because
	// boundedbuf.Writer never returns a short write or an error.
	stdoutBuf := boundedbuf.New(maxCliOutputBytes)
	stderrBuf := boundedbuf.New(maxCliOutputBytes)
	cmd.Stdout = stdoutBuf
	cmd.Stderr = stderrBuf

	err := cmd.Run()
	exitCode := 0

	stdout, _, _ := encoding.DetectAndDecode(stdoutBuf.Bytes())
	stderr, _, _ := encoding.DetectAndDecode(stderrBuf.Bytes())
	stdout = stripAnsi(stdout)
	stderr = stripAnsi(strings.TrimSpace(stderr))

	if err != nil {
		if ctx.Err() == context.Canceled {
			exitCode = 130
			stderr = "Command was cancelled by user"
		} else if ctx.Err() == context.DeadlineExceeded {
			exitCode = 124
			stderr = "Command timed out (30s limit exceeded)"
		} else if exitErr, ok := err.(*exec.ExitError); ok {
			exitCode = exitErr.ExitCode()
		} else {
			exitCode = 1
		}
		if stderr == "" {
			stderr = err.Error()
		}
	}
	return stdout, stderr, exitCode, err
}

func executeCli(ctx context.Context, trimmed, input string) (*CommandResult, error) {
	if runtime.GOOS != "windows" {
		stdout, stderr, exitCode, err := runSingleShell(ctx, "sh", trimmed, input)
		return &CommandResult{Output: stdout, Error: stderr, ExitCode: exitCode}, err
	}

	preferPS := jev.IsPowerShellSyntax(trimmed)
	primaryShell := "cmd"
	fallbackShell := "powershell"
	if preferPS {
		primaryShell = "powershell"
		fallbackShell = "cmd"
	}

	stdout, stderr, exitCode, err := runSingleShell(ctx, primaryShell, trimmed, input)
	if err == nil && exitCode == 0 {
		return &CommandResult{Output: stdout, Error: stderr, ExitCode: 0}, nil
	}

	if ctx.Err() != nil {
		return &CommandResult{Output: stdout, Error: stderr, ExitCode: exitCode}, err
	}

	shouldFallback := false
	if primaryShell == "cmd" {
		lowerErr := strings.ToLower(stderr)
		if strings.Contains(lowerErr, "not recognized") ||
			strings.Contains(stderr, "認識されていません") ||
			strings.Contains(lowerErr, "syntax of the command is incorrect") ||
			strings.Contains(stderr, "構文が誤っています") ||
			strings.Contains(lowerErr, "cannot find the file specified") ||
			strings.Contains(stderr, "指定されたファイルが見つかりません") {
			shouldFallback = true
		}
	}

	if shouldFallback {
		fbStdout, fbStderr, fbExitCode, fbErr := runSingleShell(ctx, fallbackShell, trimmed, input)
		if fbErr == nil && fbExitCode == 0 {
			return &CommandResult{Output: fbStdout, Error: fbStderr, ExitCode: 0}, nil
		}
		if fbStdout != "" || fbExitCode == 0 {
			return &CommandResult{Output: fbStdout, Error: fbStderr, ExitCode: fbExitCode}, fbErr
		}
	}

	return &CommandResult{Output: stdout, Error: stderr, ExitCode: exitCode}, err
}

// RunCommandFilter executes an external command with input fed into standard input and returns stdout/stderr.
func (a *App) RunCommandFilter(cmdStr string, input string) (*CommandResult, error) {
	trimmed := strings.TrimSpace(cmdStr)
	if trimmed == "" {
		return &CommandResult{ExitCode: 1, Error: "コマンドが指定されていません"}, nil
	}

	val := validateCliCommand(trimmed)
	if val.IsBlocked {
		return &CommandResult{ExitCode: 126, Error: val.Reason}, nil
	}

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	return executeCli(ctx, trimmed, input)
}

func setupCmdProcessTreeKill(cmd *exec.Cmd) {
	if runtime.GOOS == "windows" {
		procutil.KillTreeOnCancel(cmd)
	}
}

// RunCommandFilterAsync executes an external command in a background goroutine and dispatches the result to webview.
func (a *App) RunCommandFilterAsync(reqID, cmdStr, input string) {
	go func() {
		trimmed := strings.TrimSpace(cmdStr)
		if trimmed == "" {
			a.dispatchCliResult(reqID, &CommandResult{ExitCode: 1, Error: "コマンドが指定されていません"}, nil)
			return
		}

		val := validateCliCommand(trimmed)
		if val.IsBlocked {
			a.dispatchCliResult(reqID, &CommandResult{ExitCode: 126, Error: val.Reason}, nil)
			return
		}

		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		a.cliCancels.Store(reqID, cancel)
		defer func() {
			cancel()
			a.cliCancels.Delete(reqID)
		}()

		res, err := executeCli(ctx, trimmed, input)
		if atomic.LoadInt32(&a.isDestroyed) != 0 {
			return
		}

		a.dispatchCliResult(reqID, res, err)
	}()
}

func (a *App) dispatchCliResult(reqID string, res *CommandResult, err error) {
	if atomic.LoadInt32(&a.isDestroyed) != 0 || a.w == nil {
		return
	}
	resJSON, _ := json.Marshal(res)
	errStr := ""
	if err != nil && res.Error == "" {
		errStr = err.Error()
	}
	errJSON, _ := json.Marshal(errStr)

	a.w.Dispatch(func() {
		if atomic.LoadInt32(&a.isDestroyed) == 0 {
			js := fmt.Sprintf("if (window.__onCliFilterResult) { window.__onCliFilterResult(%q, %s, %s); }", reqID, string(resJSON), string(errJSON))
			a.w.Eval(js)
		}
	})
}

// CancelCommandFilter cancels a running CLI filter command by its request ID.
func (a *App) CancelCommandFilter(reqID string) {
	if val, ok := a.cliCancels.Load(reqID); ok {
		if cancel, ok := val.(context.CancelFunc); ok {
			cancel()
		}
		a.cliCancels.Delete(reqID)
	}
}
