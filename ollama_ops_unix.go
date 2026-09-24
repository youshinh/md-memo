//go:build !windows

package main

import (
	"os"
	"os/exec"
	"runtime"
	"strings"

	"md-memo/pkg/procutil"
)

// setCmdWindowFlags is a no-op on Unix platforms.
func setCmdWindowFlags(cmd *exec.Cmd) {
	procutil.HideWindow(cmd)
}

// getInstallOllamaCmdOS returns the platform-specific command to install Ollama, as a single
// shell command line, built from the pure ollamaInstallPlan (see ollama_ops.go). On darwin
// without Homebrew there is no automated install path, so this returns "": the real setup flow
// (SetupOllamaGemma4Async in ollama_ops.go) calls buildInstallOllamaCmd directly instead of
// this function precisely so it can surface that case as a clear error rather than running an
// empty or broken command.
func getInstallOllamaCmdOS() string {
	hasBrew := false
	if runtime.GOOS == "darwin" {
		if _, err := exec.LookPath("brew"); err == nil {
			hasBrew = true
		}
	}
	name, args, err := ollamaInstallPlan(runtime.GOOS, hasBrew)
	if err != nil {
		return ""
	}
	return strings.TrimSpace(name + " " + strings.Join(args, " "))
}

// startDetachedAndReap starts cmd and, on success, reaps it in the background instead of
// leaving that to whoever calls this function. It exists for commands we deliberately do not
// want to block on synchronously - EnsureOllamaRunning polls the HTTP health check instead of
// waiting on the launcher process - but whose exit status still needs to be read by *someone*:
// on Unix, an exited child that nobody calls Wait() on stays a zombie entry in the process
// table until its parent (this process) does, or until this process itself exits. Ollama setup
// can be triggered repeatedly in one long-lived app session, so each call used to leak one.
func startDetachedAndReap(cmd *exec.Cmd) error {
	if err := cmd.Start(); err != nil {
		return err
	}
	go func() { _ = cmd.Wait() }()
	return nil
}

// startOllamaServiceOS attempts to start Ollama in the background on macOS/Linux.
func startOllamaServiceOS() error {
	hasOllamaApp := false
	if runtime.GOOS == "darwin" {
		if _, err := os.Stat("/Applications/Ollama.app"); err == nil {
			hasOllamaApp = true
		}
	}
	name, args := ollamaStartCmdFor(runtime.GOOS, hasOllamaApp)
	return startDetachedAndReap(exec.Command(name, args...))
}

// stopOllamaServiceOS terminates running Ollama background processes on macOS/Linux.
func stopOllamaServiceOS() error {
	if runtime.GOOS == "darwin" {
		cmdApp := exec.Command("osascript", "-e", `quit app "Ollama"`)
		_ = cmdApp.Run()
	}
	// `pkill -f 'ollama serve'` matches the server's full command line, which is what we
	// actually want to stop. The fallback used to be `pkill -f 'ollama'`, which matches ANY
	// command line containing the substring - an editor with ollama.log open, `tail -f
	// ollama.log`, a `grep ollama`, and the user's own foreground `ollama run llama3` - and
	// killed all of them. `pkill -x ollama` matches only processes whose executable name is
	// exactly "ollama", which is the real server started without the "serve" argument.
	cmd := exec.Command("sh", "-c", "pkill -f 'ollama serve' || pkill -x ollama")
	_ = cmd.Run()
	return nil
}
