package main

import (
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"

	"md-memo/pkg/slotagent"
)

// TestResolveActiveSlotConfig_CachesAgentsFileAndPicksUpChanges exercises the caching added to
// resolveActiveSlotConfig: repeated calls with nothing changed on disk must return an
// (independently mutable) copy of the same result, and editing the external agents.yaml file
// must be picked up on the very next call.
//
// resolveActiveSlotConfig derives its search directory for agents.yaml from the real, global
// config.json (via getConfigFilePath/App.GetConfig), so this test carefully backs up whatever
// is there, points it at a temp scrap directory for the duration of the test, and restores the
// original content (or removes the file if none existed) afterward.
func TestResolveActiveSlotConfig_CachesAgentsFileAndPicksUpChanges(t *testing.T) {
	cfgPath := getConfigFilePath()
	origData, origErr := os.ReadFile(cfgPath)
	t.Cleanup(func() {
		if origErr == nil {
			_ = os.WriteFile(cfgPath, origData, 0600)
		} else {
			_ = os.Remove(cfgPath)
		}
	})

	scrapDir := t.TempDir()
	testCfgJSON := fmt.Sprintf(`{"scrap_dir": %q}`, filepath.ToSlash(scrapDir))
	if err := os.WriteFile(cfgPath, []byte(testCfgJSON), 0600); err != nil {
		t.Fatalf("failed to write test config.json: %v", err)
	}

	agentsDir := filepath.Join(scrapDir, ".md-memo")
	if err := os.MkdirAll(agentsDir, 0755); err != nil {
		t.Fatalf("failed to create .md-memo dir: %v", err)
	}
	agentsPath := filepath.Join(agentsDir, "agents.yaml")
	yaml1 := "version: 2\ndefault_agent: alpha\nagents:\n  alpha:\n    command: \"echo\"\n    args: [\"hi\"]\n"
	if err := os.WriteFile(agentsPath, []byte(yaml1), 0644); err != nil {
		t.Fatalf("failed to write agents.yaml: %v", err)
	}

	app := &App{}

	cfg1 := app.resolveActiveSlotConfig("")
	if cfg1.DefaultAgent != "alpha" {
		t.Fatalf("expected default_agent 'alpha', got %q", cfg1.DefaultAgent)
	}

	// Second call with nothing changed on disk should return the same (cached) result.
	cfg2 := app.resolveActiveSlotConfig("")
	if cfg2.DefaultAgent != "alpha" {
		t.Fatalf("expected cached default_agent 'alpha' on second call, got %q", cfg2.DefaultAgent)
	}

	// Mutating the returned config's maps must not corrupt the cached copy (defensive clone).
	cfg2.Agents["alpha"] = slotagent.AgentDef{Command: "mutated-by-caller"}
	cfg3 := app.resolveActiveSlotConfig("")
	if cfg3.Agents["alpha"].Command != "echo" {
		t.Errorf("cache was mutated by a caller's copy: got command %q, want %q", cfg3.Agents["alpha"].Command, "echo")
	}

	// Give the filesystem's mtime clock room to tick forward (some filesystems have ~1s
	// resolution), then edit the external agents file and confirm the change is picked up.
	time.Sleep(1100 * time.Millisecond)

	yaml2 := "version: 2\ndefault_agent: beta\nagents:\n  beta:\n    command: \"echo\"\n    args: [\"bye\"]\n"
	if err := os.WriteFile(agentsPath, []byte(yaml2), 0644); err != nil {
		t.Fatalf("failed to rewrite agents.yaml: %v", err)
	}

	cfg4 := app.resolveActiveSlotConfig("")
	if cfg4.DefaultAgent != "beta" {
		t.Errorf("expected updated default_agent 'beta' after external agents file edit, got %q", cfg4.DefaultAgent)
	}
}

// TestCloneSlotConfig_DeepCopiesNestedCollections verifies cloneSlotConfig's defensive copy
// covers not just the top-level map/slice headers but the nested slices inside AgentDef/Recipe.
func TestCloneSlotConfig_DeepCopiesNestedCollections(t *testing.T) {
	original := slotagent.SlotConfig{
		DefaultAgent: "alpha",
		Agents: map[string]slotagent.AgentDef{
			"alpha": {Command: "echo", Args: []string{"a", "b"}},
		},
		SlotProfiles: []slotagent.SlotProfile{
			{TriggerOpen: "{{", TriggerClose: "}}", Name: "code"},
		},
		Recipes: []slotagent.Recipe{
			{TriggerOpen: "[>>", TriggerClose: "]", Steps: []string{"step1", "step2"}},
		},
	}

	clone := cloneSlotConfig(original)

	// Mutate the clone's nested collections in place and ensure the original is untouched.
	alpha := clone.Agents["alpha"]
	alpha.Command = "mutated"
	alpha.Args[0] = "MUTATED"
	clone.Agents["alpha"] = alpha
	clone.SlotProfiles[0].Name = "mutated"
	clone.Recipes[0].Steps[0] = "MUTATED"

	if original.Agents["alpha"].Command != "echo" {
		t.Errorf("mutating clone.Agents leaked into original: got %q", original.Agents["alpha"].Command)
	}
	if original.Agents["alpha"].Args[0] != "a" {
		t.Errorf("mutating clone.Agents[...].Args leaked into original: got %q", original.Agents["alpha"].Args[0])
	}
	if original.SlotProfiles[0].Name != "code" {
		t.Errorf("mutating clone.SlotProfiles leaked into original: got %q", original.SlotProfiles[0].Name)
	}
	if original.Recipes[0].Steps[0] != "step1" {
		t.Errorf("mutating clone.Recipes[...].Steps leaked into original: got %q", original.Recipes[0].Steps[0])
	}
}
