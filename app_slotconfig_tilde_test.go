package main

import (
	"os"
	"path/filepath"
	"testing"

	"md-memo/pkg/appdir"
)

// TestResolveActiveSlotConfig_ExpandsTildeScrapDir covers the bug where the scrap directory
// handed to slotagent.FindAgentConfigFile was used verbatim. The default configured value is
// the literal string "~/Documents/md-memo/scraps", and FindAgentConfigFile only os.Stats its
// candidates - so for every user who never changed the scrap directory (i.e. the default
// path), <scraps>/.md-memo/agents.yaml was silently never found.
//
// TestMain points appdir's home and config overrides at one temp directory, so "~" here
// expands inside that temp tree and nothing outside it is touched.
func TestResolveActiveSlotConfig_ExpandsTildeScrapDir(t *testing.T) {
	home, err := appdir.HomeDir()
	if err != nil {
		t.Fatalf("appdir.HomeDir failed: %v", err)
	}

	const relDir = "Documents/md-memo/scraps"
	scrapAbs := filepath.Join(home, filepath.FromSlash(relDir))
	agentsDir := filepath.Join(scrapAbs, ".md-memo")
	if err := os.MkdirAll(agentsDir, 0755); err != nil {
		t.Fatalf("failed to create %s: %v", agentsDir, err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(filepath.Join(home, "Documents")) })

	agentsYAML := "version: 2\ndefault_agent: tilde-agent\nagents:\n  tilde-agent:\n    command: \"echo\"\n    args: [\"from-tilde-path\"]\n"
	if err := os.WriteFile(filepath.Join(agentsDir, "agents.yaml"), []byte(agentsYAML), 0644); err != nil {
		t.Fatalf("failed to write agents.yaml: %v", err)
	}

	cfgPath := getConfigFilePath()
	t.Cleanup(func() { _ = os.Remove(cfgPath) })
	// Exactly the literal default that parseScrapConfig produces when nothing is configured.
	if err := os.WriteFile(cfgPath, []byte(`{"scrap_dir": "~/`+relDir+`"}`), 0600); err != nil {
		t.Fatalf("failed to write config.json: %v", err)
	}

	app := &App{}
	cfg := app.resolveActiveSlotConfig("")

	if cfg.DefaultAgent != "tilde-agent" {
		t.Fatalf("agents.yaml under the tilde-expanded scrap dir was not picked up: default_agent = %q", cfg.DefaultAgent)
	}
	if got := cfg.Agents["tilde-agent"].Command; got != "echo" {
		t.Errorf("unexpected agent command %q", got)
	}
}
