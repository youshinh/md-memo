package slotagent

import (
	"reflect"
	"testing"
)

// A built-in agent written in agents.yaml with only a setting of its own ("lessons: false") must keep the built-in program and
// aliases. Before, such an entry replaced the whole agent and left it with no command, so it could not run.
func TestShortEntryOfABuiltInAgentKeepsTheBuiltInDefinition(t *testing.T) {
	def := DefaultSlotConfig().Agents["claude-code"]
	if def.Command == "" {
		t.Fatal("the built-in claude-code agent has no command: the test has nothing to compare")
	}

	cfg := mustParse(t, "version: 2\nagents:\n  claude-code:\n    lessons: false\n", ".yaml")
	got, ok := cfg.Agents["claude-code"]
	if !ok {
		t.Fatalf("the agent is gone: %v", keysOf(cfg.Agents))
	}
	if got.Command != def.Command || !reflect.DeepEqual(got.Args, def.Args) {
		t.Errorf("command/args = %q %v, want the built-in %q %v", got.Command, got.Args, def.Command, def.Args)
	}
	if got.LessonsEnabled() {
		t.Error("lessons: false was lost")
	}
	if key, found := ResolveAgentName(cfg, "cc"); !found || key != "claude-code" {
		t.Errorf("the built-in alias cc resolves to %q, %v", key, found)
	}

	// a full definition is used exactly as written
	cfg = mustParse(t, "version: 2\nagents:\n  claude-code:\n    command: mine\n    args: [\"{instruction}\"]\n    lessons: false\n", ".yaml")
	if g := cfg.Agents["claude-code"]; g.Command != "mine" || !reflect.DeepEqual(g.Args, []string{"{instruction}"}) {
		t.Errorf("a full definition changed: %q %v", g.Command, g.Args)
	}

	// an entry of the person's own agent is not made up: it stays as written
	cfg = mustParse(t, "version: 2\nagents:\n  mine:\n    lessons: false\n", ".yaml")
	if g := cfg.Agents["mine"]; g.Command != "" {
		t.Errorf("a custom agent got a command it was never given: %q", g.Command)
	}

	// switching a built-in agent off still removes it
	cfg = mustParse(t, "version: 2\nagents:\n  agy:\n    enabled: false\n", ".yaml")
	if _, there := cfg.Agents["agy"]; there {
		t.Error("enabled: false must still remove the agent")
	}
}
