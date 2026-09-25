package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"testing"

	"md-memo/pkg/slotagent"
)

// Switching agents off (enabled: false / disabled_agents), and the check that an agent's program is installed before
// a run starts one. Nothing here starts a process: slotExecute is stubbed, the recipe cases fail before any run, and
// PATH is a temporary folder.

func activeSlotConfig(t *testing.T, app *App) map[string]json.RawMessage {
	t.Helper()
	var all map[string]json.RawMessage
	if err := json.Unmarshal([]byte(app.GetActiveSlotConfigJSON()), &all); err != nil {
		t.Fatalf("GetActiveSlotConfigJSON is not JSON: %v", err)
	}
	return all
}

func agentKeysOf(t *testing.T, all map[string]json.RawMessage) []string {
	t.Helper()
	var agents map[string]slotagent.AgentDef
	_ = json.Unmarshal(all["agents"], &agents)
	keys := make([]string, 0, len(agents))
	for k := range agents {
		keys = append(keys, k)
	}
	return keys
}

func TestActiveSlotConfig_DisabledAgentsFromAgentsYAML(t *testing.T) {
	withAgentsFile(t, "version: 2\ndefault_agent: agy\nagents:\n  hermes:\n    enabled: false\ndisabled_agents: [agy]\n", "")
	app := &App{}
	all := activeSlotConfig(t, app)

	var disabled []string
	_ = json.Unmarshal(all["disabled_agents"], &disabled)
	if !reflect.DeepEqual(disabled, []string{"agy", "hermes"}) {
		t.Errorf("disabled_agents on the wire = %v", disabled)
	}
	keys := agentKeysOf(t, all)
	if len(keys) != 2 {
		t.Errorf("agents = %v, want claude-code and codex only", keys)
	}
	for _, k := range keys {
		if k == "agy" || k == "hermes" {
			t.Errorf("%s is disabled but sent to the page", k)
		}
	}
	var def string
	_ = json.Unmarshal(all["default_agent"], &def)
	if def != "claude-code" {
		t.Errorf("default_agent = %q: a disabled default falls back to the first enabled agent", def)
	}

	// the same through the cache (a clone), and the issue channel says the default was disabled
	issues, _ := activeConfigIssues(t, app)
	var found *slotagent.AgentIssue
	for i := range issues {
		if issues[i].Kind == slotagent.IssueDefaultDisabled {
			found = &issues[i]
		}
	}
	if found == nil || found.Agent != "agy" || found.Detail != "claude-code" {
		t.Errorf("agent_issues must carry default-disabled (agy -> claude-code): %+v", issues)
	}
	all2 := activeSlotConfig(t, app)
	if string(all2["disabled_agents"]) != string(all["disabled_agents"]) {
		t.Errorf("a cached read differs: %s vs %s", all2["disabled_agents"], all["disabled_agents"])
	}

	// nothing disabled: no field and no issue
	withAgentsFile(t, "version: 2\n", "")
	app2 := &App{}
	if _, ok := activeSlotConfig(t, app2)["disabled_agents"]; ok {
		t.Errorf("disabled_agents must be left out when nothing is disabled")
	}
	for _, is := range func() []slotagent.AgentIssue { i, _ := activeConfigIssues(t, app2); return i }() {
		if is.Kind == slotagent.IssueDefaultDisabled {
			t.Errorf("unexpected %+v", is)
		}
	}
}

// A note that names a disabled agent gets the clear message. It is never "skill not found", never another agent, and
// the note is not rewritten.
func TestRunSlotAgentAsync_DisabledAgentMention(t *testing.T) {
	withAgentsFile(t, "version: 2\ndisabled_agents: [agy]\n", "")
	calls := stubSlotExecute(t, &slotagent.AgentExecutionResult{Output: "ran", RawOutput: "ran"})
	doc := "前\n{{ @agy 調べて }}\n後"
	cursor := utf16IndexOf(doc, "@agy")

	// the page still holds an older copy of its config that has agy (and knows nothing of the switch)
	stale, _ := json.Marshal(slotagent.DefaultSlotConfig())

	for name, cfg := range map[string]string{"no page config": "", "stale page config": string(stale)} {
		t.Run(name, func(t *testing.T) {
			resp, err := (&App{}).ParseSlotsRPC(doc, cursor, cfg)
			if err != nil || resp.TargetSlot == nil {
				t.Fatalf("parse: %v %+v", err, resp)
			}
			if resp.RunProblem == nil || resp.RunProblem.Kind != slotagent.ProblemDisabled || resp.RunProblem.Agent != "agy" {
				t.Fatalf("runProblem = %+v", resp.RunProblem)
			}
			if resp.RunAgent != nil || resp.RunAgentKey != "" {
				t.Errorf("no run agent must be named when the run cannot start: %q %v", resp.RunAgentKey, resp.RunAgent)
			}
			if resp.TargetSlot.SkillName != "" || resp.TargetSlot.AgentName != "" {
				t.Errorf("the mention is neither a skill nor an agent: %+v", resp.TargetSlot)
			}
			raw, _ := json.Marshal(resp)
			if !strings.Contains(string(raw), `"runProblem":{"kind":"disabled","agent":"agy"`) {
				t.Errorf("wire form: %s", raw)
			}

			got, _ := runSlot(t, doc, cursor, cfg)
			r := got.res
			if r.Status != "failed" || r.Problem == nil || r.Problem.Kind != slotagent.ProblemDisabled {
				t.Fatalf("result = %+v", r)
			}
			if !strings.HasPrefix(r.ErrorMsg, `Agent "agy" is disabled in agents.yaml (enabled: false)`) {
				t.Errorf("error = %q", r.ErrorMsg)
			}
			if strings.Contains(r.ErrorMsg, "スキル") {
				t.Errorf("must not say skill not found: %q", r.ErrorMsg)
			}
			if r.OldContent != "{{ @agy 調べて }}" || r.NewContent != r.OldContent {
				t.Errorf("the note must not be rewritten: old %q new %q", r.OldContent, r.NewContent)
			}
			if s := utf16Slice(doc, r.StartOffset, r.EndOffset); s != "{{ @agy 調べて }}" {
				t.Errorf("offsets hold %q", s)
			}
			if n := len(calls()); n != 0 {
				t.Errorf("an agent was started %d time(s)", n)
			}
		})
	}
}

// A freed alias is an ordinary name again: the skill lookup, not the disabled agent and not another agent.
func TestRunSlotAgentAsync_FreedAliasIsNotTheDisabledAgent(t *testing.T) {
	withAgentsFile(t, "version: 2\ndisabled_agents: [agy]\n", "")
	calls := stubSlotExecute(t, &slotagent.AgentExecutionResult{Output: "ran", RawOutput: "ran"})
	doc := "{{ @gemini 調べて }}"
	got, _ := runSlot(t, doc, 3, "")
	if got.res.Problem != nil || !strings.Contains(got.res.ErrorMsg, "gemini") {
		t.Errorf("result = %+v", got.res)
	}
	if len(calls()) != 0 {
		t.Errorf("no agent may run for a missing skill")
	}
}

func TestRunSlotAgentAsync_ProfileWithDisabledAgent(t *testing.T) {
	withAgentsFile(t, "version: 2\nagents:\n  hermes:\n    enabled: false\n", "")
	calls := stubSlotExecute(t, &slotagent.AgentExecutionResult{Output: "ran", RawOutput: "ran"})

	// the built-in 【? 】 profile writes with hermes
	doc := "【? 箇条書きにして 】"
	cursor := utf16IndexOf(doc, "箇条書き")
	resp, _ := (&App{}).ParseSlotsRPC(doc, cursor, "")
	if resp.RunProblem == nil || resp.RunProblem.Kind != slotagent.ProblemDisabled || resp.RunProblem.Agent != "hermes" {
		t.Fatalf("runProblem = %+v", resp.RunProblem)
	}
	got, _ := runSlot(t, doc, cursor, "")
	if got.res.Status != "failed" || got.res.Problem == nil || got.res.NewContent != got.res.OldContent || got.res.OldContent != doc {
		t.Errorf("result = %+v", got.res)
	}
	if !strings.HasPrefix(got.res.ErrorMsg, `Agent "hermes" is disabled in agents.yaml (enabled: false)`) {
		t.Errorf("error = %q", got.res.ErrorMsg)
	}
	if len(calls()) != 0 {
		t.Errorf("hermes must not be replaced by another agent")
	}

	// the other profiles are not affected
	got, _ = runSlot(t, "{{ code: A }}", 5, "")
	if got.res.Status != "completed" || len(calls()) != 1 || calls()[0].agent.Command != "claude" {
		t.Errorf("other profiles: %+v calls=%d", got.res, len(calls()))
	}
}

func TestRunSlotAgentAsync_AllAgentsDisabled(t *testing.T) {
	withAgentsFile(t, "version: 2\ndisabled_agents: [claude-code, hermes, codex, agy]\n", "")
	calls := stubSlotExecute(t, &slotagent.AgentExecutionResult{Output: "ran", RawOutput: "ran"})
	all := activeSlotConfig(t, &App{})
	if keys := agentKeysOf(t, all); len(keys) != 0 {
		t.Errorf("agents = %v", keys)
	}

	// A slot or a mention names an agent (its profile's, or @agent): that one is disabled. A recipe and a resumed gate
	// use the default agent, and there is none.
	for name, c := range map[string]struct{ doc, want string }{
		"a slot":           {"{{ code: A }}", slotagent.ProblemDisabled},
		"a mention":        {"{{ @codex 直して }}", slotagent.ProblemDisabled},
		"a recipe":         {"[>> 調べて実装 ]", slotagent.ProblemNoneEnabled},
		"an approved gate": {"手順\n- [x] 続ける // approve\n", slotagent.ProblemNoneEnabled},
	} {
		doc, want := c.doc, c.want
		t.Run(name, func(t *testing.T) {
			cursor := 3
			resp, err := (&App{}).ParseSlotsRPC(doc, cursor, "")
			if err != nil {
				t.Fatal(err)
			}
			if resp.RunProblem == nil {
				t.Fatalf("no problem for %q", doc)
			}
			if resp.RunProblem.Kind != want {
				t.Errorf("kind = %q, want %q", resp.RunProblem.Kind, want)
			}
			got, _ := runSlot(t, doc, cursor, "")
			if got.res.Status != "failed" || got.res.Problem == nil || got.res.Problem.Kind != want {
				t.Errorf("result = %+v", got.res)
			}
			if got.res.NewContent != got.res.OldContent {
				t.Errorf("the note must not be rewritten: %q -> %q", got.res.OldContent, got.res.NewContent)
			}
		})
	}
	if len(calls()) != 0 {
		t.Errorf("nothing may run, ran %d", len(calls()))
	}
}

// With no agents.yaml the page's own config is all there is: disabled_agents / enabled: false in it count.
func TestSlotConfigFromThePage_DisabledAgents(t *testing.T) {
	withAgentsFile(t, "", "")
	calls := stubSlotExecute(t, &slotagent.AgentExecutionResult{Output: "ran", RawOutput: "ran"})
	page := `{"default_agent":"agy","agents":{"agy":{"command":"agy","args":["{instruction}"]},"claude-code":{"command":"claude","args":["{instruction}"]}},"disabled_agents":["agy"]}`
	doc := "{{ @agy x }}"
	resp, _ := (&App{}).ParseSlotsRPC(doc, 3, page)
	if resp.RunProblem == nil || resp.RunProblem.Kind != slotagent.ProblemDisabled {
		t.Fatalf("runProblem = %+v", resp.RunProblem)
	}
	// the default agent (agy, disabled) is claude-code for a plain slot
	got, _ := runSlot(t, "{{ code: A }}", 5, page)
	if got.res.Status != "completed" || len(calls()) != 1 || calls()[0].agent.Command != "claude" {
		t.Errorf("plain slot: %+v calls=%d", got.res, len(calls()))
	}
	// enabled: false on an entry of the page's config
	page2 := `{"agents":{"claude-code":{"command":"claude","enabled":false},"mine":{"command":"mine-cli","args":["{instruction}"]}}}`
	resp, _ = (&App{}).ParseSlotsRPC("{{ @claude x }}", 3, page2)
	if resp.RunProblem == nil || resp.RunProblem.Agent != "claude-code" {
		t.Errorf("enabled: false from the page: %+v", resp.RunProblem)
	}
}

func TestCloneSlotConfig_CopiesDisabledAgentsAndEnabled(t *testing.T) {
	no := false
	cfg := slotagent.DefaultSlotConfig()
	cfg.Agents["files"] = slotagent.AgentDef{Command: "x", Enabled: &no}
	cfg.DisabledAgents = []string{"agy"}
	cfg.DefaultAgentDisabled = "agy"
	clone := cloneSlotConfig(cfg)
	*clone.Agents["files"].Enabled = true
	clone.DisabledAgents[0] = "changed"
	if *cfg.Agents["files"].Enabled || cfg.DisabledAgents[0] != "agy" {
		t.Error("a caller changing the clone changed the original")
	}
	if clone.DefaultAgentDisabled != "agy" {
		t.Errorf("DefaultAgentDisabled = %q", clone.DefaultAgentDisabled)
	}
	if got := cloneSlotConfig(slotagent.SlotConfig{}); got.DisabledAgents != nil {
		t.Errorf("an absent list must stay absent: %#v", got.DisabledAgents)
	}
}

func TestCheckAgentAvailability_DisabledAgentIsUnknown(t *testing.T) {
	withAgentsFile(t, "version: 2\ndisabled_agents: [agy]\n", "")
	app := &App{}
	for _, name := range []string{"agy", "gemini"} {
		if got := app.CheckAgentAvailability(name); got != (AgentAvailability{}) {
			t.Errorf("CheckAgentAvailability(%q) = %+v", name, got)
		}
	}
}

// ---- the program of the agent is looked up before a run starts it ------------------------------------------------

// fakePATH makes PATH a temporary folder holding an (empty) program per name, and puts the real lookup back for the
// test. It returns the folder.
func fakePATH(t *testing.T, programs ...string) string {
	t.Helper()
	dir := t.TempDir()
	t.Setenv("PATH", dir)
	if runtime.GOOS == "windows" {
		t.Setenv("PATHEXT", ".COM;.EXE;.BAT;.CMD")
	}
	for _, name := range programs {
		addFakeProgram(t, dir, name)
	}
	invalidateLookPathCache()
	t.Cleanup(invalidateLookPathCache)
	prev := agentCommandFound
	agentCommandFound = lookPathThenRefresh
	t.Cleanup(func() { agentCommandFound = prev })
	return dir
}

func addFakeProgram(t *testing.T, dir, name string) {
	t.Helper()
	file := name
	if runtime.GOOS == "windows" {
		file += ".exe"
	}
	if err := os.WriteFile(filepath.Join(dir, file), []byte("#!/bin/sh\nexit 0\n"), 0o755); err != nil {
		t.Fatal(err)
	}
}

func TestRunSlotAgentAsync_ProgramNotInstalled(t *testing.T) {
	withAgentsFile(t, "", "")
	dir := fakePATH(t) // nothing installed
	calls := stubSlotExecute(t, &slotagent.AgentExecutionResult{Output: "ran", RawOutput: "ran"})
	const want = `Agent "hermes" needs "ollama", which was not found in PATH. Install it or choose another agent in agents.yaml.`

	doc := "前\n【? 箇条書きにして 】\n後" // the writing profile: hermes -> ollama
	cursor := utf16IndexOf(doc, "箇条書き")

	resp, err := (&App{}).ParseSlotsRPC(doc, cursor, "")
	if err != nil {
		t.Fatal(err)
	}
	p := resp.RunProblem
	if p == nil || p.Kind != slotagent.ProblemMissing || p.Agent != "hermes" || p.Command != "ollama" {
		t.Fatalf("runProblem = %+v", p)
	}
	if !strings.HasPrefix(p.Message, want) {
		t.Errorf("message = %q", p.Message)
	}
	if resp.RunAgent != nil {
		t.Errorf("no run agent when the program is missing")
	}

	got, _ := runSlot(t, doc, cursor, "")
	r := got.res
	if r.Status != "failed" || r.Problem == nil || r.Problem.Kind != slotagent.ProblemMissing || !strings.HasPrefix(r.ErrorMsg, want) {
		t.Fatalf("result = %+v", r)
	}
	if r.OldContent != "【? 箇条書きにして 】" || r.NewContent != r.OldContent {
		t.Errorf("the placeholder must stay as it was: old %q new %q", r.OldContent, r.NewContent)
	}
	if len(calls()) != 0 {
		t.Errorf("no process may be started for a missing program, ran %d", len(calls()))
	}

	// the same for a mention, and for a slot whose profile is claude
	for _, c := range []struct{ doc, agent, command string }{
		{"{{ @codex 直して }}", "codex", "codex"},
		{"{{ code: A }}", "claude-code", "claude"},
		{"[>> 調べて実装 ]", "claude-code", "claude"}, // the recipe branch: the default agent
	} {
		got, _ := runSlot(t, c.doc, 4, "")
		if got.res.Problem == nil || got.res.Problem.Agent != c.agent || got.res.Problem.Command != c.command || got.res.NewContent != got.res.OldContent {
			t.Errorf("%s: result = %+v", c.doc, got.res)
		}
	}
	if len(calls()) != 0 {
		t.Errorf("ran %d", len(calls()))
	}

	// installing it makes the very next run go ahead: a cached "not found" must not stand in the way
	addFakeProgram(t, dir, "ollama")
	got, _ = runSlot(t, doc, cursor, "")
	if got.res.Status != "completed" || got.res.Problem != nil || len(calls()) != 1 || calls()[0].agent.Command != "ollama" {
		t.Errorf("after installing: %+v calls=%d", got.res, len(calls()))
	}
}

func TestRunSlotAgentAsync_ProgramCheckIsPerAgentAndSaysNothingAboutModels(t *testing.T) {
	dir := t.TempDir()
	absMissing := filepath.ToSlash(filepath.Join(dir, "no-such-agent"))
	absThere := filepath.Join(dir, "agent")
	if runtime.GOOS == "windows" {
		absThere += ".exe"
	}
	if err := os.WriteFile(absThere, []byte("x"), 0o755); err != nil {
		t.Fatal(err)
	}
	yamlText := "version: 2\nagents:\n  mine:\n    command: my-tool\n    args: [\"{instruction}\"]\n  empty:\n    command: \"\"\n" +
		"  rel:\n    command: ./tools/agent\n  abs:\n    command: " + absMissing + "\n  there:\n    command: " + filepath.ToSlash(absThere) + "\n"
	withAgentsFile(t, yamlText, "")
	fakePATH(t, "claude") // claude is installed, my-tool is not
	calls := stubSlotExecute(t, &slotagent.AgentExecutionResult{Output: "ran", RawOutput: "ran"})

	got, _ := runSlot(t, "{{ code: A }}", 5, "")
	if got.res.Status != "completed" || len(calls()) != 1 {
		t.Fatalf("an installed program runs: %+v", got.res)
	}
	got, _ = runSlot(t, "{{ @mine x }}", 4, "")
	if got.res.Problem == nil || got.res.Problem.Command != "my-tool" || len(calls()) != 1 {
		t.Errorf("a missing custom program: %+v calls=%d", got.res, len(calls()))
	}
	// a relative path with a folder in it cannot be judged from here (the run resolves it from the project folder): left to the run
	got, _ = runSlot(t, "{{ @rel x }}", 4, "")
	if got.res.Problem != nil {
		t.Errorf("a relative command path is not checked: %+v", got.res.Problem)
	}
	// an absolute path that is not there is missing, and one that is there is not
	got, _ = runSlot(t, "{{ @abs x }}", 4, "")
	if got.res.Problem == nil || got.res.Problem.Kind != slotagent.ProblemMissing || got.res.Problem.Command != absMissing {
		t.Errorf("an absolute path that does not exist: %+v", got.res)
	}
	got, _ = runSlot(t, "{{ @there x }}", 4, "")
	if got.res.Problem != nil {
		t.Errorf("an absolute path that exists: %+v", got.res.Problem)
	}
	// an agent with no command at all is the run's own error, as before (not a "program not found")
	got, _ = runSlot(t, "{{ @empty x }}", 4, "")
	if got.res.Problem != nil {
		t.Errorf("an agent without a command is not reported as a missing program: %+v", got.res.Problem)
	}
	// only the program is looked at: the message never speaks of models
	for _, m := range []string{slotagent.NewRunProblem(slotagent.ProblemMissing, "hermes", "ollama").Message} {
		if strings.Contains(strings.ToLower(m), "model") || strings.Contains(m, "モデル") {
			t.Errorf("the check must not claim anything about models: %q", m)
		}
	}
}
