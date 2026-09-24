package main

import (
	"strings"
	"testing"
)

// TestOllamaInstallPlan covers every {goos, hasBrew} combination the automated Ollama setup
// flow (SetupOllamaGemma4Async, via buildInstallOllamaCmd) can hit, including the darwin/no
// Homebrew case that used to silently fall back to a Linux-only "curl | sh" installer and fail
// on macOS with a confusing shell error instead of a clear one. Because ollamaInstallPlan is a
// pure function of its two arguments, every branch runs here regardless of host OS - this is
// how the darwin and linux paths get covered on this project's Windows dev/CI machines.
func TestOllamaInstallPlan(t *testing.T) {
	cases := []struct {
		name       string
		goos       string
		hasBrew    bool
		wantCmd    string // name + " " + args, empty when wantErr
		wantErr    bool
		wantErrHas string // substring the error message must contain, when wantErr
	}{
		{
			name:    "darwin with Homebrew uses the cask",
			goos:    "darwin",
			hasBrew: true,
			wantCmd: "brew install --cask ollama",
		},
		{
			name:       "darwin without Homebrew errors instead of running the Linux installer",
			goos:       "darwin",
			hasBrew:    false,
			wantErr:    true,
			wantErrHas: "Homebrew",
		},
		{
			name:    "darwin hasBrew is ignored for other platforms: linux always uses install.sh",
			goos:    "linux",
			hasBrew: true,
			wantCmd: "sh -c curl -fsSL https://ollama.com/install.sh | sh",
		},
		{
			name:    "linux without brew is unaffected (same as with)",
			goos:    "linux",
			hasBrew: false,
			wantCmd: "sh -c curl -fsSL https://ollama.com/install.sh | sh",
		},
		{
			name:    "windows uses winget regardless of hasBrew",
			goos:    "windows",
			hasBrew: false,
			wantCmd: "winget install -e --id Ollama.Ollama --accept-source-agreements --accept-package-agreements",
		},
		{
			name:    "windows with hasBrew true is still winget (hasBrew only means something on darwin)",
			goos:    "windows",
			hasBrew: true,
			wantCmd: "winget install -e --id Ollama.Ollama --accept-source-agreements --accept-package-agreements",
		},
		{
			name:    "unknown platform falls back to the POSIX installer, same as linux",
			goos:    "freebsd",
			hasBrew: false,
			wantCmd: "sh -c curl -fsSL https://ollama.com/install.sh | sh",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			name, args, err := ollamaInstallPlan(tc.goos, tc.hasBrew)

			if tc.wantErr {
				if err == nil {
					t.Fatalf("ollamaInstallPlan(%q, %v) = (%q, %v, nil), want an error", tc.goos, tc.hasBrew, name, args)
				}
				if tc.wantErrHas != "" && !strings.Contains(err.Error(), tc.wantErrHas) {
					t.Errorf("error %q does not mention %q", err.Error(), tc.wantErrHas)
				}
				if name != "" || args != nil {
					t.Errorf("expected no command alongside an error, got name=%q args=%v", name, args)
				}
				return
			}

			if err != nil {
				t.Fatalf("ollamaInstallPlan(%q, %v) returned unexpected error: %v", tc.goos, tc.hasBrew, err)
			}
			got := name
			for _, a := range args {
				got += " " + a
			}
			if got != tc.wantCmd {
				t.Errorf("ollamaInstallPlan(%q, %v) = %q, want %q", tc.goos, tc.hasBrew, got, tc.wantCmd)
			}
		})
	}
}

// TestOllamaStartCmdFor covers the background-launch command selection the same way: pure
// function of {goos, hasOllamaApp}, so the darwin App-bundle branch and the generic
// "ollama serve" fallback both run here without needing a Mac or a filesystem check.
func TestOllamaStartCmdFor(t *testing.T) {
	cases := []struct {
		name          string
		goos          string
		hasOllamaApp  bool
		wantCmdPrefix string
	}{
		{"darwin with Ollama.app uses open -a", "darwin", true, "open -a Ollama"},
		{"darwin without Ollama.app falls back to ollama serve", "darwin", false, "sh -c ollama serve"},
		{"linux always uses ollama serve, hasOllamaApp is meaningless there", "linux", true, "sh -c ollama serve"},
		{"linux without app flag, same result", "linux", false, "sh -c ollama serve"},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			name, args := ollamaStartCmdFor(tc.goos, tc.hasOllamaApp)
			got := name
			for _, a := range args {
				got += " " + a
			}
			if !strings.HasPrefix(got, tc.wantCmdPrefix) {
				t.Errorf("ollamaStartCmdFor(%q, %v) = %q, want prefix %q", tc.goos, tc.hasOllamaApp, got, tc.wantCmdPrefix)
			}
		})
	}
}

// TestBuildInstallOllamaCmd_WindowsShape locks in that buildInstallOllamaCmd keeps producing
// exactly the same command line getInstallOllamaCmdOS used to build for Windows before this
// refactor: winget's arguments wrapped in "cmd.exe /c <line>", not run directly. This is the
// part of Bug 4's fix that must NOT change behaviour on Windows.
func TestBuildInstallOllamaCmd_WindowsShape(t *testing.T) {
	name, args, err := ollamaInstallPlan("windows", false)
	if err != nil {
		t.Fatalf("ollamaInstallPlan(windows, false) returned error: %v", err)
	}
	line := strings.TrimSpace(name + " " + strings.Join(args, " "))
	want := "winget install -e --id Ollama.Ollama --accept-source-agreements --accept-package-agreements"
	if line != want {
		t.Errorf("windows install command line = %q, want %q", line, want)
	}
}
