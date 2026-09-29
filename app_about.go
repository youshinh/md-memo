package main

import (
	"os"
	"runtime"
	"runtime/debug"
	"strings"

	"md-memo/pkg/appdir"
)

// AppInfo is what the About dialog shows and what its "Copy details" button puts on the clipboard for a bug report.
// It holds nothing secret: a version, the OS, and paths. No key, token or note text is read to build it.
type AppInfo struct {
	Version string `json:"version"`
	// Commit and BuiltAt come from the build info Go embeds when the binary is built inside a git checkout (empty otherwise,
	// for example a `go run` build). Commit ends in "+dirty" when the tree had uncommitted changes.
	Commit  string `json:"commit"`
	BuiltAt string `json:"builtAt"`
	OS      string `json:"os"`
	Arch    string `json:"arch"`
	// Executable is the program that is running (empty when the OS cannot tell).
	Executable string `json:"executable"`
	// ConfigDir holds config.json, agents.yaml and session.json; ScrapDir holds the daily notes.
	ConfigDir  string `json:"configDir"`
	ConfigFile string `json:"configFile"`
	ScrapDir   string `json:"scrapDir"`
	// Signing says how this build is signed: "adhoc-not-notarized" (macOS: ad-hoc signed, not notarized by Apple) or
	// "unsigned" (Windows and elsewhere: no code signature). The frontend words it in the UI language.
	Signing string `json:"signing"`
}

// signingFor is the signing note for a platform. It is a pure function of the OS name so the darwin branch can be tested on
// Windows. It describes how releases are built (build_mac.sh signs ad-hoc; there is no signing step for Windows); it does
// not inspect the running binary.
func signingFor(goos string) string {
	if goos == "darwin" {
		return "adhoc-not-notarized"
	}
	return "unsigned"
}

// buildStampFrom reads the VCS settings Go embeds (vcs.revision, vcs.time, vcs.modified) out of a build's settings.
func buildStampFrom(settings []debug.BuildSetting) (commit, builtAt string) {
	modified := false
	for _, s := range settings {
		switch s.Key {
		case "vcs.revision":
			commit = s.Value
		case "vcs.time":
			builtAt = s.Value
		case "vcs.modified":
			modified = s.Value == "true"
		}
	}
	if len(commit) > 7 {
		commit = commit[:7]
	}
	if commit != "" && modified {
		commit += "+dirty"
	}
	return commit, strings.TrimSpace(builtAt)
}

// GetAppInfo is bound as backend_getAppInfo. It is called only when the About dialog opens, and does a few string
// operations and one os.Executable call.
func (a *App) GetAppInfo() AppInfo {
	info := AppInfo{
		Version:    AppVersion,
		OS:         runtime.GOOS,
		Arch:       runtime.GOARCH,
		ConfigDir:  appdir.AppConfigDir(),
		ConfigFile: appdir.ConfigFilePath(),
		ScrapDir:   a.GetScrapDir(),
		Signing:    signingFor(runtime.GOOS),
	}
	if exe, err := os.Executable(); err == nil {
		info.Executable = exe
	}
	if bi, ok := debug.ReadBuildInfo(); ok {
		info.Commit, info.BuiltAt = buildStampFrom(bi.Settings)
	}
	return info
}
