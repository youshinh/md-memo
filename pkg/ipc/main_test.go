package ipc

import (
	"fmt"
	"os"
	"testing"

	"md-memo/pkg/appdir"
)

// TestMain redirects the session file into a temp directory for the whole package. Without
// it StartServer writes GetSessionFilePath() - the real %AppData%\md-memo\ipc-session.json -
// on every run, which clobbers the session of an MD-Memo instance the developer has open and
// makes its CLI handoff point at a port that died with the test binary.
func TestMain(m *testing.M) {
	tempRoot, err := os.MkdirTemp("", "md-memo-ipc-test-")
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
