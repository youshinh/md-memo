package cli

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"

	"md-memo/pkg/appdir"
)

// withTempHome points the per-user folders at fresh temp folders for one test and returns the home
// folder (where the default scrap folder ~/Documents/md-memo/scraps would be). The md-memo settings
// folder is appdir.AppConfigDir(); it is NOT created, so a test can check that a command leaves the
// disk alone. TestMain's shared temp folder is restored afterwards.
func withTempHome(t *testing.T) (home string) {
	t.Helper()
	root := t.TempDir()
	prevCfg, _ := appdir.ConfigDir()
	prevHome, _ := appdir.HomeDir()
	home = filepath.Join(root, "home")
	appdir.SetConfigDirOverride(filepath.Join(root, "cfg"))
	appdir.SetHomeDirOverride(home)
	t.Cleanup(func() {
		appdir.SetConfigDirOverride(prevCfg)
		appdir.SetHomeDirOverride(prevHome)
	})
	return home
}

// writeConfigFile writes config.json (creating its folder) and returns its path.
func writeConfigFile(t *testing.T, content string) string {
	t.Helper()
	path := appdir.ConfigFilePath()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

// runHeadless runs a standalone command through the headless runner, with the version pinned.
func runHeadless(t *testing.T, args ...string) (stdout, stderr string, code int, err error) {
	t.Helper()
	var out, errOut bytes.Buffer
	code, err = NewHeadlessRunner(&out, &errOut).Run(args)
	return out.String(), errOut.String(), code, err
}

// writeFile writes a test file, creating its folder.
func writeFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

// exists reports whether path exists at all.
func exists(path string) bool {
	_, err := os.Lstat(path)
	return err == nil
}
