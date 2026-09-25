package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"md-memo/pkg/slotagent"
)

// ParseSlotsRPC's runAgent is what the frontend asks about before a run, so it must be the definition the run really
// gets. Each case parses, then runs the same text with the agent process stubbed and compares.
func TestParseSlotsRPC_RunAgentIsTheAgentTheRunStarts(t *testing.T) {
	custom := `{"version":2,"default_agent":"main","agents":{` +
		`"main":{"command":"main-cli","args":["{instruction}"]},` +
		`"writer":{"command":"writer-cli","args":["--quiet"],"append_instruction":false},` +
		`"empty":{"command":""}},` +
		`"slot_profiles":[` +
		`{"trigger_open":"{{","trigger_close":"}}","name":"w","agent":"writer"},` +
		`{"trigger_open":"<<","trigger_close":">>","name":"x","agent":"nobody"},` +
		`{"trigger_open":"((","trigger_close":"))","name":"e","agent":"empty"}]}`
	cases := []struct {
		name, doc, marker, cfg, wantKey string
	}{
		{"built-in {{ }} profile", "前\n{{ code: A }}\n後", "code", "", "claude-code"},
		{"@alias", "日本語😀\n{{ @gemini 調べて }}\n", "@gemini", "", "agy"},
		{"@key", "{{ @codex 直して }}", "@codex", "", "codex"},
		{"profile agent", "{{ 書いて }}", "書いて", custom, "writer"},
		{"unknown profile agent: the default agent", "<< 書いて >>", "書いて", custom, "main"},
		{"profile agent without a command: the default agent", "(( 書いて ))", "書いて", custom, "main"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			cursor := utf16IndexOf(c.doc, c.marker)
			resp, err := (&App{}).ParseSlotsRPC(c.doc, cursor, c.cfg)
			if err != nil || resp.TargetSlot == nil {
				t.Fatalf("parse: %v / %+v", err, resp)
			}
			if resp.RunAgentKey != c.wantKey || resp.RunAgent == nil {
				t.Fatalf("runAgentKey = %q (%v), want %q", resp.RunAgentKey, resp.RunAgent, c.wantKey)
			}

			calls := stubSlotExecute(t, &slotagent.AgentExecutionResult{Output: "ok", RawOutput: "ok\n"})
			runSlot(t, c.doc, cursor, c.cfg)
			ran := calls()
			if len(ran) != 1 {
				t.Fatalf("expected one agent run, got %d", len(ran))
			}
			if !reflect.DeepEqual(ran[0].agent, *resp.RunAgent) {
				t.Errorf("the run started %+v, but ParseSlotsRPC named %+v", ran[0].agent, *resp.RunAgent)
			}
		})
	}
}

func TestParseSlotsRPC_RunAgentForRecipesAndGates(t *testing.T) {
	app := &App{}
	resp, _ := app.ParseSlotsRPC("[>> 調べて実装 ]", 3, "")
	if resp.TargetSlot == nil || resp.TargetSlot.Type != "recipe" || resp.RunAgentKey != "claude-code" || resp.RunAgent == nil {
		t.Errorf("a recipe runs the default agent: %+v key=%q", resp.TargetSlot, resp.RunAgentKey)
	}

	resp, _ = app.ParseSlotsRPC("手順\n- [x] 続ける // approve\n", 0, "")
	if resp.TargetSlot != nil || resp.RunAgentKey != "claude-code" || resp.RunAgent == nil {
		t.Errorf("an approved gate resumes the recipe with the default agent: key=%q agent=%v", resp.RunAgentKey, resp.RunAgent)
	}

	resp, _ = app.ParseSlotsRPC("手順\n- [ ] まだ // approve\n", 0, "")
	if resp.RunAgentKey != "" || resp.RunAgent != nil {
		t.Errorf("nothing runs without a slot or an approved gate: key=%q", resp.RunAgentKey)
	}
	raw, _ := json.Marshal(resp)
	if containsKey(raw, "runAgent") || containsKey(raw, "runAgentKey") {
		t.Errorf("an absent run agent must not be sent: %s", raw)
	}
}

func containsKey(raw []byte, key string) bool {
	var m map[string]json.RawMessage
	_ = json.Unmarshal(raw, &m)
	_, ok := m[key]
	return ok
}

// withAgentsFile points config.json at a temporary scraps folder whose .md-memo/agents.yaml holds yamlText (plus any
// extra config.json fields), for the duration of the test.
func withAgentsFile(t *testing.T, yamlText, extraConfig string) {
	t.Helper()
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
	cfgJSON := fmt.Sprintf(`{"scrap_dir": %q%s}`, filepath.ToSlash(scrapDir), extraConfig)
	if err := os.WriteFile(cfgPath, []byte(cfgJSON), 0600); err != nil {
		t.Fatal(err)
	}
	if yamlText != "" {
		dir := filepath.Join(scrapDir, ".md-memo")
		if err := os.MkdirAll(dir, 0755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dir, "agents.yaml"), []byte(yamlText), 0644); err != nil {
			t.Fatal(err)
		}
	}
}

func activeConfigIssues(t *testing.T, app *App) ([]slotagent.AgentIssue, map[string]json.RawMessage) {
	t.Helper()
	var out struct {
		AgentIssues []slotagent.AgentIssue `json:"agent_issues"`
	}
	raw := app.GetActiveSlotConfigJSON()
	if err := json.Unmarshal([]byte(raw), &out); err != nil {
		t.Fatalf("GetActiveSlotConfigJSON is not JSON: %v", err)
	}
	var all map[string]json.RawMessage
	_ = json.Unmarshal([]byte(raw), &all)
	return out.AgentIssues, all
}

func TestGetActiveSlotConfigJSON_ReportsAgentIssues(t *testing.T) {
	withAgentsFile(t, "version: 2\nagents:\n  runner:\n    command: \"pwsh\"\n    args: [\"-NoProfile\", \"-Command\"]\n  quiet:\n    command: \"bash\"\n    args: [\"-c\", \"make\"]\n    append_instruction: false\n",
		`, "agents": {"legacy-shell": {"command": "cmd", "args": ["/c"]}}`)
	app := &App{}
	issues, all := activeConfigIssues(t, app)
	for _, k := range []string{"version", "agents", "slot_profiles", "default_agent"} {
		if _, ok := all[k]; !ok {
			t.Errorf("the slot config fields must stay at the top level; %q is missing", k)
		}
	}
	got := map[string]string{}
	for _, is := range issues {
		if is.Kind == slotagent.IssueShellAppend {
			got[is.Agent] = is.Detail
		}
	}
	want := map[string]string{"runner": "pwsh", "legacy-shell": "cmd"}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("shell issues = %v, want %v (all: %+v)", got, want, issues)
	}
	var agents map[string]slotagent.AgentDef
	_ = json.Unmarshal(all["agents"], &agents)
	if p := agents["quiet"].AppendInstruction; p == nil || *p {
		t.Errorf("append_instruction must reach the frontend, got %v", p)
	}
}

func TestGetActiveSlotConfigJSON_NoIssuesNoField(t *testing.T) {
	withAgentsFile(t, "", "")
	issues, all := activeConfigIssues(t, &App{})
	if len(issues) != 0 {
		t.Errorf("the built-in agents must not be reported: %+v", issues)
	}
	if _, ok := all["agent_issues"]; ok {
		t.Error("agent_issues must be left out when there is nothing to report")
	}
}

func TestCloneSlotConfig_CopiesAppendInstruction(t *testing.T) {
	f := false
	cfg := slotagent.DefaultSlotConfig()
	cfg.Agents["files"] = slotagent.AgentDef{Command: "x", AppendInstruction: &f}
	clone := cloneSlotConfig(cfg)
	*clone.Agents["files"].AppendInstruction = true
	if *cfg.Agents["files"].AppendInstruction {
		t.Error("a caller changing the clone's append_instruction changed the original")
	}
}
