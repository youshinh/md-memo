package main

import (
	"os"
	"path/filepath"
	"testing"

	"md-memo/pkg/appdir"
)

// TestCheckAgentAvailability resolves agents out of the active slot config and reports
// whether their command is on PATH. TestMain has already redirected the config/home dirs
// into a temp tree, so writing config.json + agents.yaml here is side-effect free.
func TestCheckAgentAvailability(t *testing.T) {
	home, err := appdir.HomeDir()
	if err != nil {
		t.Fatalf("appdir.HomeDir failed: %v", err)
	}

	scrapDir := filepath.Join(home, "availability-scraps")
	agentsDir := filepath.Join(scrapDir, ".md-memo")
	if err := os.MkdirAll(agentsDir, 0755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(scrapDir) })

	// "go" is guaranteed present: the test suite is being run by it.
	agentsYAML := "version: 2\ndefault_agent: present\nagents:\n" +
		"  present:\n    command: \"go\"\n    args: [\"version\"]\n" +
		"  missing:\n    command: \"md-memo-definitely-not-installed-xyzzy\"\n    args: []\n" +
		"  blank:\n    command: \"\"\n    args: []\n"
	if err := os.WriteFile(filepath.Join(agentsDir, "agents.yaml"), []byte(agentsYAML), 0644); err != nil {
		t.Fatalf("write agents.yaml: %v", err)
	}

	cfgPath := getConfigFilePath()
	t.Cleanup(func() { _ = os.Remove(cfgPath) })
	if err := os.WriteFile(cfgPath, []byte(`{"scrap_dir": `+quote(filepath.ToSlash(scrapDir))+`}`), 0600); err != nil {
		t.Fatalf("write config.json: %v", err)
	}

	app := &App{}

	if got := app.CheckAgentAvailability("present"); !got.Available || got.Command != "go" {
		t.Errorf("present agent: got %+v, want {true go}", got)
	}
	if got := app.CheckAgentAvailability("missing"); got.Available {
		t.Errorf("missing agent: got %+v, want Available=false", got)
	} else if got.Command != "md-memo-definitely-not-installed-xyzzy" {
		t.Errorf("missing agent: command = %q, want the configured command echoed back", got.Command)
	}
	if got := app.CheckAgentAvailability("blank"); got.Available || got.Command != "" {
		t.Errorf("agent with no command: got %+v, want {false \"\"}", got)
	}
	if got := app.CheckAgentAvailability("no-such-agent"); got.Available || got.Command != "" {
		t.Errorf("unknown agent: got %+v, want {false \"\"}", got)
	}
	if got := app.CheckAgentAvailability(""); got.Available || got.Command != "" {
		t.Errorf("empty agent name: got %+v, want {false \"\"}", got)
	}
}

func TestLookPathCached_UsesCache(t *testing.T) {
	const cmd = "md-memo-lookpath-cache-probe"

	lookPathCacheMu.Lock()
	delete(lookPathCache, cmd)
	lookPathCacheMu.Unlock()

	if lookPathCached(cmd) {
		t.Fatalf("%q should not exist on PATH", cmd)
	}

	lookPathCacheMu.Lock()
	entry, ok := lookPathCache[cmd]
	lookPathCacheMu.Unlock()
	if !ok {
		t.Fatal("negative result was not cached")
	}
	if entry.found {
		t.Fatal("cached entry claims the command was found")
	}

	if lookPathCached("") {
		t.Error("empty command must never be reported as available")
	}
}

// TestDetectLLMProvider checks the bound helper returns exactly the four documented strings
// and delegates to the shared pkg/llm heuristic.
func TestDetectLLMProvider(t *testing.T) {
	app := &App{}

	cases := []struct {
		baseURL, apiKey, want string
	}{
		{"http://localhost:11434", "", "ollama"},
		{"http://localhost:1234/v1", "", "openai-compatible"},
		{"http://localhost:8080", "", "openai-compatible"},
		{"https://generativelanguage.googleapis.com", "key", "gemini"},
		{"https://openrouter.ai/api/v1", "sk-or-v1-x", "openai-compatible"},
		{"", "", "unknown"},
	}
	for _, c := range cases {
		if got := app.DetectLLMProvider(c.baseURL, c.apiKey); got != c.want {
			t.Errorf("DetectLLMProvider(%q, %q) = %q, want %q", c.baseURL, c.apiKey, got, c.want)
		}
	}
}

func quote(s string) string {
	return `"` + s + `"`
}
