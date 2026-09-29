package main

import (
	"encoding/json"
	"path/filepath"
	"runtime"
	"runtime/debug"
	"strings"
	"testing"

	"md-memo/pkg/appdir"
)

// The About dialog's data. TestMain redirects the settings and home folders into a temp dir, so nothing here reads the
// developer's real folders.
func TestGetAppInfo(t *testing.T) {
	app := &App{}
	info := app.GetAppInfo()

	if info.Version != AppVersion {
		t.Errorf("Version = %q, want %q", info.Version, AppVersion)
	}
	if info.OS != runtime.GOOS || info.Arch != runtime.GOARCH {
		t.Errorf("OS/Arch = %s/%s, want %s/%s", info.OS, info.Arch, runtime.GOOS, runtime.GOARCH)
	}
	if info.ConfigDir != appdir.AppConfigDir() {
		t.Errorf("ConfigDir = %q, want %q", info.ConfigDir, appdir.AppConfigDir())
	}
	if info.ConfigFile != filepath.Join(info.ConfigDir, "config.json") {
		t.Errorf("ConfigFile = %q, want config.json inside %q", info.ConfigFile, info.ConfigDir)
	}
	if info.ScrapDir == "" || !filepath.IsAbs(info.ScrapDir) {
		t.Errorf("ScrapDir = %q, want an absolute path", info.ScrapDir)
	}
	if info.Executable == "" {
		t.Error("Executable is empty although os.Executable works in a test binary")
	}
	if info.Signing != signingFor(runtime.GOOS) {
		t.Errorf("Signing = %q, want %q", info.Signing, signingFor(runtime.GOOS))
	}
}

// A scrap folder the settings name wins over the default, the way the rest of the app resolves it.
func TestGetAppInfoScrapDir(t *testing.T) {
	app := &App{scrapDir: filepath.Join(t.TempDir(), "notes")}
	if got := app.GetAppInfo().ScrapDir; got != app.scrapDir {
		t.Errorf("ScrapDir = %q, want the configured %q", got, app.scrapDir)
	}
}

// The JSON keys are what the frontend (about_dialog.js) reads, and none of them may carry a secret.
func TestGetAppInfoJSONKeys(t *testing.T) {
	raw, err := json.Marshal((&App{}).GetAppInfo())
	if err != nil {
		t.Fatal(err)
	}
	var m map[string]interface{}
	if err := json.Unmarshal(raw, &m); err != nil {
		t.Fatal(err)
	}
	for _, k := range []string{"version", "commit", "builtAt", "os", "arch", "executable", "configDir", "configFile", "scrapDir", "signing"} {
		if _, ok := m[k]; !ok {
			t.Errorf("JSON has no %q key: %s", k, raw)
		}
	}
	for k := range m {
		l := strings.ToLower(k)
		if strings.Contains(l, "key") || strings.Contains(l, "token") || strings.Contains(l, "secret") || strings.Contains(l, "password") {
			t.Errorf("JSON key %q looks like a secret", k)
		}
	}
}

func TestSigningFor(t *testing.T) {
	cases := map[string]string{
		"darwin":  "adhoc-not-notarized",
		"windows": "unsigned",
		"linux":   "unsigned",
		"":        "unsigned",
	}
	for goos, want := range cases {
		if got := signingFor(goos); got != want {
			t.Errorf("signingFor(%q) = %q, want %q", goos, got, want)
		}
	}
}

func TestBuildStampFrom(t *testing.T) {
	clean := []debug.BuildSetting{
		{Key: "-trimpath", Value: "true"},
		{Key: "vcs.revision", Value: "a8bfea5d0c0e4f4f9d0f0a1b2c3d4e5f60718293"},
		{Key: "vcs.time", Value: "2026-09-30T05:12:34Z"},
		{Key: "vcs.modified", Value: "false"},
	}
	if c, b := buildStampFrom(clean); c != "a8bfea5" || b != "2026-09-30T05:12:34Z" {
		t.Errorf("clean build: got %q, %q", c, b)
	}

	dirty := append([]debug.BuildSetting{}, clean...)
	dirty[3].Value = "true"
	if c, _ := buildStampFrom(dirty); c != "a8bfea5+dirty" {
		t.Errorf("dirty build: commit = %q, want a8bfea5+dirty", c)
	}

	if c, b := buildStampFrom(nil); c != "" || b != "" {
		t.Errorf("no VCS info: got %q, %q, want both empty", c, b)
	}
	// A time without a revision (never seen in practice) must not invent a commit.
	if c, b := buildStampFrom([]debug.BuildSetting{{Key: "vcs.time", Value: "2026-01-01T00:00:00Z"}, {Key: "vcs.modified", Value: "true"}}); c != "" || b == "" {
		t.Errorf("time only: got %q, %q", c, b)
	}
}
