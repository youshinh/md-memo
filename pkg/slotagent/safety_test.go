package slotagent

import (
	"context"
	"encoding/json"
	"reflect"
	"strings"
	"testing"

	"gopkg.in/yaml.v3"
)

func boolPtr(b bool) *bool { return &b }

// The instruction is appended as the last argument only when no argument holds {instruction} and append_instruction is
// not false. PrepareCommand builds the command line without starting anything.
func TestPrepareCommand_AppendInstruction(t *testing.T) {
	cases := []struct {
		name   string
		args   []string
		append *bool
		want   []string
	}{
		{"no placeholder, unset: appended (the behaviour since the start)", []string{"run"}, nil, []string{"tool", "run", "do it"}},
		{"no placeholder, true: appended", []string{"run"}, boolPtr(true), []string{"tool", "run", "do it"}},
		{"no placeholder, false: not appended", []string{"run", "{file}"}, boolPtr(false), []string{"tool", "run", "/n.md"}},
		{"placeholder, false: the placeholder is still filled", []string{"-p", "{instruction}"}, boolPtr(false), []string{"tool", "-p", "do it"}},
		{"placeholder, unset: filled once, nothing appended", []string{"-p", "{instruction}"}, nil, []string{"tool", "-p", "do it"}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			def := AgentDef{Command: "tool", Args: c.args, AppendInstruction: c.append}
			cmd, err := PrepareCommand(context.Background(), def, "/n.md", "do it", "")
			if err != nil {
				t.Fatalf("PrepareCommand: %v", err)
			}
			if !reflect.DeepEqual(cmd.Args, c.want) {
				t.Errorf("args = %q, want %q", cmd.Args, c.want)
			}
		})
	}

	// An empty instruction is never appended (as before).
	cmd, err := PrepareCommand(context.Background(), AgentDef{Command: "tool", Args: []string{"run"}}, "", "  ", "")
	if err != nil || !reflect.DeepEqual(cmd.Args, []string{"tool", "run"}) {
		t.Errorf("empty instruction: args = %q, err = %v", cmd.Args, err)
	}
}

func TestAppendInstruction_ReadFromYAMLAndJSON(t *testing.T) {
	src := "version: 2\nagents:\n  files-only:\n    command: \"tool\"\n    args: [\"--note\", \"{file}\"]\n    append_instruction: false\n  plain:\n    command: \"tool\"\n    args: [\"run\"]\n"
	cfg, err := ParseAgentConfigFile([]byte(src), ".yaml")
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if p := cfg.Agents["files-only"].AppendInstruction; p == nil || *p {
		t.Errorf("append_instruction: false must be read as false, got %v", p)
	}
	if p := cfg.Agents["plain"].AppendInstruction; p != nil {
		t.Errorf("an absent append_instruction must stay unset, got %v", *p)
	}
	if cfg.Agents["files-only"].AppendsInstruction() || !cfg.Agents["plain"].AppendsInstruction() {
		t.Error("AppendsInstruction must follow the setting")
	}

	merged := MergeSlotConfig(`{"agents":{"a":{"command":"tool","args":["x"],"append_instruction":false}}}`)
	if p := merged.Agents["a"].AppendInstruction; p == nil || *p {
		t.Errorf("MergeSlotConfig must keep append_instruction, got %v", p)
	}

	// Written back (ImportAgentsConfigFile marshals the parsed config): false survives, unset stays absent.
	out, err := yaml.Marshal(cfg)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if n := strings.Count(string(out), "append_instruction"); n != 1 {
		t.Errorf("expected exactly one append_instruction in the written YAML, got %d:\n%s", n, out)
	}
	js, _ := json.Marshal(cfg.Agents["plain"])
	if strings.Contains(string(js), "append_instruction") {
		t.Errorf("an unset append_instruction must not be sent to the frontend: %s", js)
	}
}

func TestShellAppendHazard(t *testing.T) {
	cases := []struct {
		def  AgentDef
		want string
	}{
		{AgentDef{Command: "powershell", Args: []string{"-NoProfile"}}, "powershell"},
		{AgentDef{Command: `C:\Windows\System32\WindowsPowerShell\v1.0\PowerShell.EXE`, Args: nil}, "powershell"},
		{AgentDef{Command: "/usr/bin/pwsh"}, "pwsh"},
		{AgentDef{Command: "cmd.exe", Args: []string{"/c", "type"}}, "cmd"},
		{AgentDef{Command: "bash", Args: []string{"-c", "echo"}}, "bash"},
		{AgentDef{Command: "zsh"}, "zsh"},
		{AgentDef{Command: "sh"}, "sh"},
		// Not a listed shell, but a command switch: flagged all the same (conservative).
		{AgentDef{Command: "python3", Args: []string{"-c", "import sys"}}, "-c"},
		{AgentDef{Command: "wsl", Args: []string{"-e", "bash", "-Command"}}, "-Command"},
		{AgentDef{Command: "cmdtool", Args: []string{"/C"}}, "/C"},
		// The instruction goes where the user put it, or nowhere: nothing is appended, nothing is flagged.
		{AgentDef{Command: "powershell", Args: []string{"-Command", "Write-Output {instruction}"}}, ""},
		{AgentDef{Command: "bash", Args: []string{"-c", "echo"}, AppendInstruction: boolPtr(false)}, ""},
		// Not a shell.
		{AgentDef{Command: "claude", Args: []string{"-p", "{instruction}"}}, ""},
		{AgentDef{Command: "ollama", Args: []string{"run", "hermes3"}}, ""},
		{AgentDef{Command: "bashful", Args: []string{"--cool"}}, ""},
	}
	for _, c := range cases {
		if got := ShellAppendHazard(c.def); got != c.want {
			t.Errorf("ShellAppendHazard(%q %q append=%v) = %q, want %q", c.def.Command, c.def.Args, c.def.AppendInstruction, got, c.want)
		}
	}
}

// The built-in definitions that replace the retired ones.
var replacementDefaults = map[string]AgentDef{
	"claude-code": {Command: "claude", Args: []string{"-p", "対象ノート: {file}\n指示: {instruction}"}},
	"hermes":      {Command: "ollama", Args: []string{"run", "hermes3", "{instruction}"}},
	"codex":       {Command: "codex", Args: []string{"exec", "{instruction}"}},
	"agy":         {Command: "agy", Args: []string{"-p", "対象ノート: {file}\n指示: {instruction}"}},
}

func TestFindAgentIssues_OutdatedDefaults(t *testing.T) {
	// Today's built-in agents are never reported.
	if got := FindAgentIssues(DefaultSlotConfig().Agents); len(got) != 0 {
		t.Fatalf("the built-in definitions must not be reported, got %+v", got)
	}
	if got := findAgentIssues(replacementDefaults, replacementDefaults); len(got) != 0 {
		t.Fatalf("the replacement definitions must not be reported, got %+v", got)
	}

	current := replacementDefaults
	agents := map[string]AgentDef{
		"claude-code": {Command: "claude", Args: []string{"--file", "{file}", "--prompt", "{instruction}"}, Description: "mine"},
		"codex":       {Command: "codex", Args: []string{"--execute", "--file", "{file}"}},
		"agy":         {Command: "agy", Args: []string{"-p", "対象ノート: {file}\n指示: {instruction}", "--dangerously-skip-permissions"}},
		// The template's agy, copied under another key: reported by what it is, under the user's key.
		"gemini-cli": {Command: " agy ", Args: []string{"-p", "{instruction}", "--dangerously-skip-permissions"}},
		// Changed by the user (one more argument): theirs, not reported.
		"claude-tuned": {Command: "claude", Args: []string{"--file", "{file}", "--prompt", "{instruction}", "--verbose"}},
		"hermes":       current["hermes"],
	}
	got := findAgentIssues(agents, current)
	want := []struct{ agent, detail string }{{"agy", "agy"}, {"claude-code", "claude-code"}, {"codex", "codex"}, {"gemini-cli", "agy"}}
	if len(got) != len(want) {
		t.Fatalf("got %d issues, want %d: %+v", len(got), len(want), got)
	}
	for i, w := range want {
		is := got[i]
		if is.Agent != w.agent || is.Kind != IssueOutdatedDefault || is.Detail != w.detail {
			t.Errorf("issue %d = %+v, want %s / %s", i, is, w.agent, w.detail)
			continue
		}
		s := current[w.detail]
		if is.Suggested == nil || is.Suggested.Command != s.Command || !reflect.DeepEqual(is.Suggested.Args, s.Args) {
			t.Errorf("issue %d suggests %+v, want today's %s definition %+v", i, is.Suggested, w.detail, s)
		}
	}
}

func TestFindAgentIssues_ShellAppend(t *testing.T) {
	agents := map[string]AgentDef{
		"ps":      {Command: "powershell", Args: []string{"-NoProfile", "-Command"}},
		"ps-safe": {Command: "powershell", Args: []string{"-NoProfile", "-File", "run.ps1", "{file}"}, AppendInstruction: boolPtr(false)},
		"ps-own":  {Command: "powershell", Args: []string{"-Command", "Get-Content {file}; '{instruction}'"}},
	}
	got := FindAgentIssues(agents)
	if len(got) != 1 || got[0].Agent != "ps" || got[0].Kind != IssueShellAppend || got[0].Detail != "powershell" || got[0].Suggested != nil {
		t.Fatalf("issues = %+v, want one shell-append issue for ps", got)
	}
}

func TestRunAgentFor(t *testing.T) {
	cfg := DefaultSlotConfig()
	cfg.Agents["writer"] = AgentDef{Command: "writer-cli", Args: []string{"{instruction}"}}
	cfg.Agents["broken"] = AgentDef{Command: ""}
	profile := func(agent string) *SlotProfile {
		return &SlotProfile{TriggerOpen: "{{", TriggerClose: "}}", Agent: agent}
	}

	cases := []struct {
		name    string
		cfg     SlotConfig
		target  *SlotMatch
		wantKey string
		wantCmd string
	}{
		{"@agent", cfg, &SlotMatch{Type: "slot", AgentName: "agy", Profile: profile("writer")}, "agy", "agy"},
		{"@agent without a command is not swapped", cfg, &SlotMatch{Type: "slot", AgentName: "broken"}, "broken", ""},
		{"the profile's agent", cfg, &SlotMatch{Type: "slot", Profile: profile("writer")}, "writer", "writer-cli"},
		{"an unknown profile agent falls back to the default", cfg, &SlotMatch{Type: "slot", Profile: profile("nobody")}, "claude-code", "claude"},
		{"a profile agent without a command falls back to the default", cfg, &SlotMatch{Type: "slot", Profile: profile("broken")}, "claude-code", "claude"},
		{"no profile: the default", cfg, &SlotMatch{Type: "slot"}, "claude-code", "claude"},
		{"a recipe: the default", cfg, &SlotMatch{Type: "recipe", Profile: profile("writer")}, "claude-code", "claude"},
		{"a resumed gate: the default", cfg, nil, "claude-code", "claude"},
	}
	for _, c := range cases {
		key, def := RunAgentFor(c.cfg, c.target)
		if key != c.wantKey || def.Command != c.wantCmd {
			t.Errorf("%s: got %s (%q), want %s (%q)", c.name, key, def.Command, c.wantKey, c.wantCmd)
		}
	}

	// A default agent that does not exist: the built-in claude-code.
	noDefault := DefaultSlotConfig()
	noDefault.DefaultAgent = "gone"
	noDefault.Agents["claude-code"] = AgentDef{Command: "someone-elses-claude"}
	for _, target := range []*SlotMatch{nil, {Type: "slot"}, {Type: "recipe"}} {
		key, def := RunAgentFor(noDefault, target)
		if key != "claude-code" || def.Command != DefaultSlotConfig().Agents["claude-code"].Command || !reflect.DeepEqual(def.Args, DefaultSlotConfig().Agents["claude-code"].Args) {
			t.Errorf("target %+v: got %s %+v, want the built-in claude-code", target, key, def)
		}
	}
}
