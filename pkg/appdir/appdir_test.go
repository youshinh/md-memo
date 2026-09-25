package appdir

import (
	"os"
	"path/filepath"
	"testing"
)

func TestConfigFilePathUsesTheOverrideAndCreatesNothing(t *testing.T) {
	root := t.TempDir()
	SetConfigDirOverride(root)
	defer SetConfigDirOverride("")

	if got, want := AppConfigDir(), filepath.Join(root, "md-memo"); got != want {
		t.Errorf("AppConfigDir = %q, want %q", got, want)
	}
	if got, want := ConfigFilePath(), filepath.Join(root, "md-memo", "config.json"); got != want {
		t.Errorf("ConfigFilePath = %q, want %q", got, want)
	}
	// A read-only command must be able to ask for the path without leaving a folder behind.
	if _, err := os.Stat(filepath.Join(root, "md-memo")); !os.IsNotExist(err) {
		t.Errorf("computing the path must not create the folder (stat err = %v)", err)
	}
}
