// Package shellenv recovers the PATH a macOS user actually has in their terminal.
//
// An app bundle launched from Finder, the Dock or Spotlight inherits launchd's environment,
// not the user's shell environment. That PATH is essentially
// "/usr/bin:/bin:/usr/sbin:/sbin", so every tool installed by Homebrew (/opt/homebrew/bin,
// /usr/local/bin), by pip/pipx (~/.local/bin) or behind a version-manager shim - git in some
// setups, and certainly jq, claude, codex, ollama, gh, node - is invisible to exec.LookPath.
// MD-Memo then reports "not found" for the command bar, the AI CLI, Quick Actions, slot
// agents, git sync and CheckAgentAvailability, while the exact same command works fine when
// the user launches the app from a terminal.
//
// The fix is the standard one: ask the user's own login shell what its PATH is, and merge it
// into the process environment. Everything here except ResolveLoginShellPath and Apply is a
// pure function so the marker parsing and the merge rules can be unit-tested on any platform.
//
// The package is only ever used on macOS. It therefore hard-codes ":" as the PATH separator
// rather than using os.PathListSeparator, which keeps the pure functions deterministic when
// their tests run on Windows.
package shellenv

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"md-memo/pkg/appdir"
	"md-memo/pkg/procutil"
)

const (
	// pathSep is the PATH list separator on the platforms this package targets.
	pathSep = ":"

	// markerBegin / markerEnd fence the value inside the probe's stdout. An interactive login
	// shell runs the user's rc files, which routinely print banners, version notices, direnv
	// chatter or fortune output, so the raw stdout cannot be trusted to be just the PATH.
	markerBegin = "__MDMEMO_PATH__"
	markerEnd   = "__MDMEMO_END__"

	// probeTimeout bounds one shell invocation. An interactive shell that hangs waiting on
	// something must never delay MD-Memo, which is why Apply also runs off the startup path.
	probeTimeout = 3 * time.Second

	// maxProbeOutput caps how much of a chatty rc file's output is buffered.
	maxProbeOutput = 1 << 20 // 1MB

	// defaultShell is used when $SHELL is unset or does not name an existing absolute path.
	defaultShell = "/bin/zsh"
)

// probeScript is what the login shell is asked to run. printf (a shell builtin in sh, bash
// and zsh) is used rather than echo so no trailing newline lands inside the markers.
const probeScript = `printf "` + markerBegin + `%s` + markerEnd + `" "$PATH"`

// ErrNoMarkers is returned when the shell ran but its output did not contain the fenced
// value, e.g. because the shell died before reaching the printf.
var ErrNoMarkers = errors.New("shellenv: login shell output did not contain the PATH markers")

// ExtractPath pulls the PATH out of a probe's stdout, ignoring anything an rc file printed
// before or after it. It reports false when the markers are absent or empty.
func ExtractPath(out string) (string, bool) {
	start := strings.Index(out, markerBegin)
	if start < 0 {
		return "", false
	}
	rest := out[start+len(markerBegin):]
	end := strings.Index(rest, markerEnd)
	if end < 0 {
		return "", false
	}
	value := strings.TrimSpace(rest[:end])
	if value == "" {
		return "", false
	}
	return value, true
}

// MergePath combines a resolved PATH with the current one: every entry of resolved first, in
// order, then every entry of current that is not already present.
//
// Empty entries are dropped (a stray "::" in a user's PATH means "the current directory",
// which is a well-known foot-gun), as are relative entries - a GUI app's working directory is
// meaningless, and honouring a relative PATH entry would let whatever directory the app
// happens to sit in supply executables.
func MergePath(resolved, current string) string {
	seen := make(map[string]bool)
	out := make([]string, 0, 16)

	add := func(list string) {
		for _, entry := range strings.Split(list, pathSep) {
			entry = strings.TrimSpace(entry)
			if entry == "" {
				continue
			}
			if !strings.HasPrefix(entry, "/") {
				continue
			}
			// Trailing slashes make otherwise identical entries look different.
			normalized := entry
			for len(normalized) > 1 && strings.HasSuffix(normalized, "/") {
				normalized = normalized[:len(normalized)-1]
			}
			if seen[normalized] {
				continue
			}
			seen[normalized] = true
			out = append(out, normalized)
		}
	}

	add(resolved)
	add(current)

	return strings.Join(out, pathSep)
}

// FallbackPath is the static best guess used when the login shell cannot be asked. It covers
// Homebrew on Apple Silicon and on Intel, plus the per-user bin directory pip/pipx install
// into. home may be empty, in which case the "~/.local/bin" entry is skipped.
func FallbackPath(home string) string {
	entries := []string{
		"/opt/homebrew/bin",
		"/opt/homebrew/sbin",
		"/usr/local/bin",
	}
	if strings.TrimSpace(home) != "" {
		entries = append(entries, filepath.ToSlash(filepath.Join(home, ".local", "bin")))
	}
	return strings.Join(entries, pathSep)
}

// LoginShell reports the shell to probe: $SHELL when it is an absolute path to something that
// exists, and defaultShell otherwise. exists is injected so the decision logic is testable.
func LoginShell(shellEnv string, exists func(string) bool) string {
	candidate := strings.TrimSpace(shellEnv)
	if candidate != "" && strings.HasPrefix(candidate, "/") && exists(candidate) {
		return candidate
	}
	return defaultShell
}

// ResolveLoginShellPath runs the user's login shell and returns the PATH it reports.
//
// It tries an interactive login shell first (-l -i), because plenty of people only extend
// PATH from .zshrc / .bashrc, which a non-interactive shell never reads; if that fails it
// retries without -i, which is the configuration where an interactive shell would hang on a
// prompt or a missing tty.
func ResolveLoginShellPath(ctx context.Context) (string, error) {
	shell := LoginShell(os.Getenv("SHELL"), func(p string) bool {
		info, err := os.Stat(p)
		return err == nil && !info.IsDir()
	})

	attempts := [][]string{
		{"-l", "-i", "-c", probeScript},
		{"-l", "-c", probeScript},
	}

	var lastErr error
	for _, args := range attempts {
		value, err := runProbe(ctx, shell, args)
		if err == nil {
			return value, nil
		}
		lastErr = err
	}
	if lastErr == nil {
		lastErr = ErrNoMarkers
	}
	return "", fmt.Errorf("shellenv: could not read PATH from %s: %w", shell, lastErr)
}

func runProbe(ctx context.Context, shell string, args []string) (string, error) {
	runCtx, cancel := context.WithTimeout(ctx, probeTimeout)
	defer cancel()

	cmd := exec.CommandContext(runCtx, shell, args...)
	// An interactive shell that tries to read from stdin must see EOF immediately rather than
	// inherit whatever MD-Memo was started with (which may be a pipe still being written to).
	cmd.Stdin = nil
	var stdout bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = nil
	cmd.Env = os.Environ()
	// An rc file can easily spawn children of its own; killing only the shell would leave
	// them running.
	procutil.KillTreeOnCancel(cmd)

	err := cmd.Run()

	out := stdout.String()
	if len(out) > maxProbeOutput {
		out = out[:maxProbeOutput]
	}

	// The markers are checked even when the shell exited non-zero: a broken rc file that
	// fails after printing is still a shell that told us the truth about PATH.
	if value, ok := ExtractPath(out); ok {
		return value, nil
	}
	if err != nil {
		return "", err
	}
	return "", ErrNoMarkers
}

// Apply resolves the login shell's PATH (falling back to the static list when that fails),
// merges it into the process PATH and installs the result with os.Setenv. It reports whether
// the process PATH actually changed.
//
// It is intended to be called exactly once, from a goroutine, on macOS only.
func Apply() bool {
	current := os.Getenv("PATH")

	resolved, err := ResolveLoginShellPath(context.Background())
	if err != nil || strings.TrimSpace(resolved) == "" {
		home, homeErr := appdir.HomeDir()
		if homeErr != nil {
			home = ""
		}
		resolved = FallbackPath(home)
	}

	merged := MergePath(resolved, current)
	if merged == "" || merged == current {
		return false
	}
	if err := os.Setenv("PATH", merged); err != nil {
		return false
	}
	return true
}
