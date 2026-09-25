package main

import (
	"fmt"
	"os"
	"testing"

	"md-memo/pkg/appdir"
)

// TestMain makes the root package's test binary hermetic. Without it `go test .` acts on the
// developer's actual machine:
//
//   - Ollama: starting / force-killing the real service (stubbed via the package vars below).
//   - Config: getConfigFilePath(), getSessionFilePath(), the generated-image assets folder,
//     and slotagent.FindAgentConfigFile all resolve under os.UserConfigDir(), i.e. the real
//     %AppData%\md-memo. Tests wrote over the user's config.json.
//   - Scraps: an unset scrap_dir defaults to "~/Documents/md-memo/scraps", so anything that
//     went through scrap.ResolveScrapDir touched (and InitScrapEngine would git-pull) the
//     user's real notes repository.
//   - Network: with a key present in the real config.json, Jev prediction POSTed test text to
//     a remote endpoint. An inherited OPENROUTER_API_KEY / JEV_API_* in the developer's
//     environment could do the same even with an empty config.
//
// Both directory roots are redirected into one temp dir for the whole run, and every
// credential/endpoint environment variable the Jev client consults is cleared.
//
// Tests must also never call App.OpenExternal: it hands the URL to the OS and really
// launches the browser / VS Code. Use validateExternalURL instead.
func TestMain(m *testing.M) {
	startOllamaService = func() error { return nil }
	stopOllamaService = func() error { return nil }
	// The run-time "is the agent's program installed?" check would otherwise depend on what the developer has on PATH
	// (the runs in these tests never start the real program: slotExecute is stubbed). The tests of the check itself put
	// lookPathCached back and use a fake PATH.
	agentCommandFound = func(string) bool { return true }

	tempRoot, err := os.MkdirTemp("", "md-memo-test-home-")
	if err != nil {
		fmt.Fprintf(os.Stderr, "failed to create temp home for tests: %v\n", err)
		os.Exit(1)
	}
	appdir.SetConfigDirOverride(tempRoot)
	appdir.SetHomeDirOverride(tempRoot)

	// A developer's exported credentials must not leak into the suite (and must not let a
	// test reach the network).
	for _, k := range []string{"JEV_API_URL", "JEV_API_KEY", "JEV_MODEL", "TYPESAFE_API_KEY", "OPENROUTER_API_KEY"} {
		_ = os.Unsetenv(k)
	}

	code := m.Run()

	appdir.SetConfigDirOverride("")
	appdir.SetHomeDirOverride("")
	_ = os.RemoveAll(tempRoot)

	os.Exit(code)
}
