package slotagent

import (
	"fmt"
	"os"
	"testing"

	"md-memo/pkg/appdir"
)

// TestMain redirects the global agents-config location into a temp directory. Without it
// FindAgentConfigFile / GetDefaultAgentConfigPath fall back to the real
// %AppData%\md-memo\agents.yaml, so the suite's behaviour depended on whatever the developer
// happens to have configured (and a future write-path test would overwrite it).
func TestMain(m *testing.M) {
	tempRoot, err := os.MkdirTemp("", "md-memo-slotagent-test-")
	if err != nil {
		fmt.Fprintf(os.Stderr, "failed to create temp config dir for tests: %v\n", err)
		os.Exit(1)
	}
	appdir.SetConfigDirOverride(tempRoot)

	code := m.Run()

	appdir.SetConfigDirOverride("")
	_ = os.RemoveAll(tempRoot)
	os.Exit(code)
}
