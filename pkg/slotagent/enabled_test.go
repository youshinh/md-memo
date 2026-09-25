package slotagent

import (
	"encoding/json"
	"reflect"
	"sort"
	"strings"
	"testing"

	"gopkg.in/yaml.v3"
)

func keysOf(agents map[string]AgentDef) []string {
	keys := make([]string, 0, len(agents))
	for k := range agents {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

func mustParse(t *testing.T, src, ext string) SlotConfig {
	t.Helper()
	cfg, err := ParseAgentConfigFile([]byte(src), ext)
	if err != nil {
		t.Fatalf("parse failed: %v\n%s", err, src)
	}
	return cfg
}

// Deleting an agent from agents.yaml is not disabling it: complementSlotConfig puts a built-in agent the file does not
// mention back. Switching it off (either spelling, any case) is the way to remove it for good.
func TestDisable_DeleteVsDisable_BothSpellings(t *testing.T) {
	all := []string{"agy", "claude-code", "codex", "hermes"}
	withoutAgy := []string{"claude-code", "codex", "hermes"}
	cases := []struct {
		name, src, ext string
		wantAgents     []string
		wantDisabled   []string
	}{
		{"deleted: the default comes back", "version: 2\nagents:\n  claude-code:\n    command: claude\n", ".yaml", all, nil},
		{"enabled: false", "version: 2\nagents:\n  agy:\n    enabled: false\n", ".yaml", withoutAgy, []string{"agy"}},
		{"enabled: false on a full definition", "version: 2\nagents:\n  agy:\n    command: agy\n    args: [\"-p\", \"{instruction}\"]\n    enabled: false\n", ".yaml", withoutAgy, []string{"agy"}},
		{"disabled_agents", "version: 2\ndisabled_agents: [agy]\n", ".yaml", withoutAgy, []string{"agy"}},
		{"disabled_agents, block style and other case", "version: 2\ndisabled_agents:\n  - AGY\n", ".yaml", withoutAgy, []string{"agy"}},
		{"both spellings, one agent", "version: 2\ndisabled_agents: [agy]\nagents:\n  agy:\n    command: agy\n    enabled: false\n", ".yaml", withoutAgy, []string{"agy"}},
		{"both spellings, two agents", "version: 2\ndisabled_agents: [hermes]\nagents:\n  agy:\n    enabled: false\n", ".yaml", []string{"claude-code", "codex"}, []string{"agy", "hermes"}},
		{"enabled: true does not beat the list", "version: 2\ndisabled_agents: [agy]\nagents:\n  agy:\n    command: agy\n    enabled: true\n", ".yaml", withoutAgy, []string{"agy"}},
		{"enabled: true is the default", "version: 2\nagents:\n  agy:\n    command: agy\n    enabled: true\n", ".yaml", all, nil},
		{"a custom agent", "version: 2\nagents:\n  mine:\n    command: m\n  old:\n    command: o\n    enabled: false\n", ".yaml", []string{"agy", "claude-code", "codex", "hermes", "mine"}, []string{"old"}},
		{"json", `{"version":2,"agents":{"agy":{"enabled":false}},"disabled_agents":["codex"]}`, ".json", []string{"claude-code", "hermes"}, []string{"agy", "codex"}},
		{"markdown", "# agents\n\n```yaml\nversion: 2\ndisabled_agents: [agy]\n```\n", ".md", withoutAgy, []string{"agy"}},
		{"an unknown key is only listed", "version: 2\ndisabled_agents: [nobody]\n", ".yaml", all, []string{"nobody"}},
		{"blank entries are ignored", "version: 2\ndisabled_agents: [\"\", \"  \"]\n", ".yaml", all, nil},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			cfg := mustParse(t, c.src, c.ext)
			if got := keysOf(cfg.Agents); !reflect.DeepEqual(got, c.wantAgents) {
				t.Errorf("agents = %v, want %v", got, c.wantAgents)
			}
			if !reflect.DeepEqual(cfg.DisabledAgents, c.wantDisabled) {
				t.Errorf("disabled = %v, want %v", cfg.DisabledAgents, c.wantDisabled)
			}
			for k, def := range cfg.Agents {
				if !def.IsEnabled() {
					t.Errorf("%s is disabled but still listed", k)
				}
			}
		})
	}
}

// The disabled agent's aliases go with it: nothing resolves to it, its default aliases are free, and another agent can
// claim them.
func TestDisable_AliasesAreFreed(t *testing.T) {
	cfg := mustParse(t, "version: 2\ndisabled_agents: [agy]\n", ".yaml")
	for _, name := range []string{"agy", "gemini", "antigravity", "@Gemini"} {
		if key, ok := ResolveAgentName(cfg, name); ok {
			t.Errorf("ResolveAgentName(%q) = %q, want nothing", name, key)
		}
	}
	if key, ok := ResolveAgentName(cfg, "cc"); !ok || key != "claude-code" {
		t.Errorf("the other default aliases must stay: cc -> (%q, %v)", key, ok)
	}

	cfg = mustParse(t, "version: 2\nagents:\n  agy:\n    enabled: false\n  mine:\n    command: m\n    aliases: [gemini]\n", ".yaml")
	if key, ok := ResolveAgentName(cfg, "gemini"); !ok || key != "mine" {
		t.Errorf("a freed alias can be claimed by another agent: (%q, %v)", key, ok)
	}
	if key, ok := ResolveAgentName(cfg, "antigravity"); ok {
		t.Errorf("antigravity must be free, got %q", key)
	}
}

func TestDisable_DefaultAgentFallsBackInAStableOrder(t *testing.T) {
	cases := []struct {
		name, disabled, def, wantDefault, wantWas string
	}{
		{"default stays when enabled", "[agy]", "claude-code", "claude-code", ""},
		{"a disabled default: the first enabled in the fixed order", "[claude-code]", "claude-code", "hermes", "claude-code"},
		{"the next in the order", "[claude-code, hermes]", "claude-code", "codex", "claude-code"},
		{"and the next", "[claude-code, hermes, codex]", "hermes", "agy", "hermes"},
		{"a default written in another case", "[agy]", "AGY", "claude-code", "agy"},
		{"default_agent that is not disabled but unknown: unchanged", "[agy]", "nobody", "nobody", ""},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			cfg := mustParse(t, "version: 2\ndefault_agent: "+c.def+"\ndisabled_agents: "+c.disabled+"\n", ".yaml")
			if cfg.DefaultAgent != c.wantDefault || cfg.DefaultAgentDisabled != c.wantWas {
				t.Errorf("default = %q (was %q), want %q (was %q)", cfg.DefaultAgent, cfg.DefaultAgentDisabled, c.wantDefault, c.wantWas)
			}
		})
	}

	// After the built-in order: the other agents by key.
	cfg := mustParse(t, "version: 2\ndefault_agent: claude-code\ndisabled_agents: [claude-code, hermes, codex, agy]\nagents:\n  zed:\n    command: z\n  abe:\n    command: a\n", ".yaml")
	if cfg.DefaultAgent != "abe" || !reflect.DeepEqual(keysOf(cfg.Agents), []string{"abe", "zed"}) {
		t.Errorf("default = %q agents = %v", cfg.DefaultAgent, keysOf(cfg.Agents))
	}

	// A default that names nothing usable would fall back to the built-in claude-code: not when that is disabled.
	cfg = mustParse(t, "version: 2\ndefault_agent: gone\ndisabled_agents: [claude-code]\n", ".yaml")
	if cfg.DefaultAgent != "hermes" {
		t.Errorf("an unknown default with claude-code disabled = %q, want the first enabled agent", cfg.DefaultAgent)
	}
	if cfg.DefaultAgentDisabled != "" {
		t.Errorf("that is not a disabled default: %q", cfg.DefaultAgentDisabled)
	}
}

func TestDisable_AllDisabled(t *testing.T) {
	cfg := mustParse(t, "version: 2\ndisabled_agents: [claude-code, hermes, codex, agy]\n", ".yaml")
	if len(cfg.Agents) != 0 || cfg.DefaultAgent != "" || cfg.DefaultAgentDisabled != "claude-code" {
		t.Fatalf("agents=%v default=%q was=%q", keysOf(cfg.Agents), cfg.DefaultAgent, cfg.DefaultAgentDisabled)
	}
	if !reflect.DeepEqual(cfg.DisabledAgents, []string{"agy", "claude-code", "codex", "hermes"}) {
		t.Errorf("disabled = %v", cfg.DisabledAgents)
	}
	// Nothing to pick: every path says "none enabled" (no crash, no built-in claude-code), and a mention says disabled.
	for _, target := range []*SlotMatch{nil, {Type: "slot"}, {Type: "recipe"}, {Type: "slot", DisabledAgent: "agy"}} {
		p := RunProblemFor(cfg, target)
		if p == nil {
			t.Fatalf("target %+v: no problem", target)
		}
		want := ProblemNoneEnabled
		if target != nil && target.DisabledAgent != "" {
			want = ProblemDisabled
		}
		if p.Kind != want {
			t.Errorf("target %+v: kind %q, want %q", target, p.Kind, want)
		}
		if key, def := RunAgentFor(cfg, target); def.Command != "" {
			t.Errorf("target %+v: RunAgentFor started %s (%q)", target, key, def.Command)
		}
	}
	if !strings.Contains(RunProblemFor(cfg, nil).Message, "No agent is enabled") {
		t.Errorf("message = %q", RunProblemFor(cfg, nil).Message)
	}

	// Same through the page's JSON (MergeSlotConfig), and a custom agent alone keeps working.
	page := MergeSlotConfig(`{"agents":{"a":{"command":"x","enabled":false}},"disabled_agents":["b"],"default_agent":"a"}`)
	if len(page.Agents) != 0 || !reflect.DeepEqual(page.DisabledAgents, []string{"a", "b"}) || page.DefaultAgent != "" {
		t.Errorf("page config: agents=%v disabled=%v default=%q", keysOf(page.Agents), page.DisabledAgents, page.DefaultAgent)
	}
	one := mustParse(t, "version: 2\ndefault_agent: claude-code\ndisabled_agents: [claude-code, hermes, codex, agy]\nagents:\n  mine:\n    command: m\n", ".yaml")
	if one.DefaultAgent != "mine" {
		t.Errorf("the only enabled agent becomes the default, got %q", one.DefaultAgent)
	}
	if p := RunProblemFor(one, &SlotMatch{Type: "recipe"}); p != nil {
		t.Errorf("a recipe runs the only enabled agent: %+v", p)
	}
}

// The config the page sends back (MergeSlotConfig) carries the same switches: JSON with disabled_agents, per-agent
// enabled, and a finalised config sent again.
func TestDisable_ConfigFromThePage(t *testing.T) {
	cases := []struct {
		name, raw    string
		wantAgents   []string
		wantDisabled []string
		wantDefault  string
	}{
		{"disabled_agents", `{"agents":{"claude-code":{"command":"claude"},"agy":{"command":"agy"}},"disabled_agents":["agy"]}`, []string{"claude-code"}, []string{"agy"}, "claude-code"},
		{"enabled false", `{"agents":{"claude-code":{"command":"claude"},"agy":{"command":"agy","enabled":false}}}`, []string{"claude-code"}, []string{"agy"}, "claude-code"},
		{"a disabled default", `{"default_agent":"agy","agents":{"claude-code":{"command":"claude"},"agy":{"command":"agy"}},"disabled_agents":["agy"]}`, []string{"claude-code"}, []string{"agy"}, "claude-code"},
		{"nothing disabled: as before", `{"agents":{"claude-code":{"command":"claude"}}}`, []string{"claude-code"}, nil, "claude-code"},
		{"no agents: the built-ins minus the listed", `{"disabled_agents":["hermes"]}`, []string{"agy", "claude-code", "codex"}, []string{"hermes"}, "claude-code"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			cfg := MergeSlotConfig(c.raw)
			if got := keysOf(cfg.Agents); !reflect.DeepEqual(got, c.wantAgents) {
				t.Errorf("agents = %v, want %v", got, c.wantAgents)
			}
			if !reflect.DeepEqual(cfg.DisabledAgents, c.wantDisabled) {
				t.Errorf("disabled = %v, want %v", cfg.DisabledAgents, c.wantDisabled)
			}
			if cfg.DefaultAgent != c.wantDefault {
				t.Errorf("default = %q, want %q", cfg.DefaultAgent, c.wantDefault)
			}
		})
	}

	// A finalised config sent back and merged again is the same config (the page does this on every run).
	first := mustParse(t, "version: 2\ndefault_agent: agy\ndisabled_agents: [agy, hermes]\n", ".yaml")
	wire, err := json.Marshal(first)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(wire), `"disabled_agents":["agy","hermes"]`) {
		t.Errorf("disabled_agents must be on the wire: %s", wire)
	}
	again := MergeSlotConfig(string(wire))
	if !reflect.DeepEqual(keysOf(again.Agents), keysOf(first.Agents)) || !reflect.DeepEqual(again.DisabledAgents, first.DisabledAgents) || again.DefaultAgent != first.DefaultAgent {
		t.Errorf("round trip changed the config: %v %v %q vs %v %v %q", keysOf(again.Agents), again.DisabledAgents, again.DefaultAgent, keysOf(first.Agents), first.DisabledAgents, first.DefaultAgent)
	}
	if strings.Contains(string(wire), "DefaultAgentDisabled") || strings.Contains(string(wire), `"enabled"`) {
		t.Errorf("only disabled_agents goes on the wire: %s", wire)
	}
	// finalizeAgents on a finalised config does not lose the note about the default.
	if second := FinalizeAgents(first); second.DefaultAgentDisabled != "agy" || second.DefaultAgent != first.DefaultAgent {
		t.Errorf("second pass: default = %q (was %q)", second.DefaultAgent, second.DefaultAgentDisabled)
	}
}

// Nothing switched off: the config is exactly what it was, with no disabled_agents field.
func TestDisable_NothingDisabledChangesNothing(t *testing.T) {
	cfg := DefaultSlotConfig()
	if !reflect.DeepEqual(FinalizeAgents(cfg), cfg) {
		t.Errorf("finalising the defaults changed them")
	}
	if MergeSlotConfig("").DisabledAgents != nil {
		t.Errorf("no disabled agents on the default config")
	}
	raw, _ := json.Marshal(DefaultSlotConfig())
	if strings.Contains(string(raw), "disabled_agents") {
		t.Errorf("an unused disabled_agents must not be sent: %s", raw)
	}
}

// Finalising copies: the caller's agents map keeps its entries.
func TestDisable_DoesNotModifyItsInput(t *testing.T) {
	cfg := DefaultSlotConfig()
	cfg.DisabledAgents = []string{"agy"}
	out := finalizeAgents(cfg, false)
	if _, ok := cfg.Agents["agy"]; !ok {
		t.Errorf("the input map lost agy")
	}
	if _, ok := out.Agents["agy"]; ok {
		t.Errorf("the result still has agy")
	}
}

// ImportAgentsConfigFile writes the parsed config back: with ParseAgentConfigFileForSave the disabled definition
// survives the round trip and is still disabled when the copy is read again.
func TestDisable_ForSaveKeepsTheDefinition(t *testing.T) {
	src := "version: 2\nagents:\n  mine:\n    command: my-cli\n    args: [\"{instruction}\"]\n    enabled: false\n  agy:\n    command: agy\n"
	saved, err := ParseAgentConfigFileForSave([]byte(src), ".yaml")
	if err != nil {
		t.Fatal(err)
	}
	mine, ok := saved.Agents["mine"]
	if !ok || mine.Command != "my-cli" || mine.IsEnabled() {
		t.Fatalf("mine = %+v (present %v): the definition must stay, marked disabled", mine, ok)
	}
	out, err := yaml.Marshal(&saved)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(out), "enabled: false") {
		t.Errorf("the written copy must say enabled: false:\n%s", out)
	}
	read := mustParse(t, string(out), ".yaml")
	if _, ok := read.Agents["mine"]; ok || !reflect.DeepEqual(read.DisabledAgents, []string{"mine"}) {
		t.Errorf("read back: agents=%v disabled=%v", keysOf(read.Agents), read.DisabledAgents)
	}
	// and the normal parse of the same text drops it
	plain := mustParse(t, src, ".yaml")
	if _, ok := plain.Agents["mine"]; ok {
		t.Errorf("ParseAgentConfigFile must not list a disabled agent")
	}
}

func TestParseSlots_MentionOfADisabledAgent(t *testing.T) {
	cfg := mustParse(t, "version: 2\ndisabled_agents: [agy]\nagents:\n  mine:\n    command: m\n    aliases: [agy]\n", ".yaml")
	doc := "{{ @agy fix }}\n{{ @AGY: fix }}\n{{ @gemini x }}\n{{ @antigravity }}\n{{ @claude y }}\n[>> @agy ]\n[? @agy z ]\n"
	slots := ParseSlots(doc, cfg)
	if len(slots) != 7 {
		t.Fatalf("slots = %d: %+v", len(slots), slots)
	}
	for i, want := range []string{"agy", "agy", "", "", "", "", "agy"} {
		if slots[i].DisabledAgent != want {
			t.Errorf("slot %d (%q): DisabledAgent = %q, want %q", i, slots[i].RawContent, slots[i].DisabledAgent, want)
		}
	}
	// A disabled key is an agent mention: not a skill, not another agent, and the result would go below the line.
	for _, i := range []int{0, 1, 6} {
		s := slots[i]
		if s.SkillName != "" || s.AgentName != "" || s.OutputMode != OutputModeBelow {
			t.Errorf("slot %d: skill=%q agent=%q mode=%q", i, s.SkillName, s.AgentName, s.OutputMode)
		}
	}
	if slots[0].Instruction != "fix" || slots[1].Instruction != "fix" {
		t.Errorf("instructions: %q %q", slots[0].Instruction, slots[1].Instruction)
	}
	// The freed aliases are ordinary names again: skills (gemini, antigravity), or another agent's alias.
	if slots[2].SkillName != "gemini" || slots[3].SkillName != "antigravity" {
		t.Errorf("freed aliases: %q %q", slots[2].SkillName, slots[3].SkillName)
	}
	if slots[4].AgentName != "claude-code" {
		t.Errorf("@claude = %q", slots[4].AgentName)
	}
	// A recipe never takes the mention form
	if slots[5].Type != "recipe" || slots[5].DisabledAgent != "" {
		t.Errorf("recipe: %+v", slots[5])
	}
	// The disabled key beats the alias another agent gave itself (never "another agent").
	if key, _ := RunAgentFor(cfg, &slots[0]); key != "agy" {
		t.Errorf("RunAgentFor = %q", key)
	}
	p := RunProblemFor(cfg, &slots[0])
	if p == nil || p.Kind != ProblemDisabled || p.Agent != "agy" {
		t.Fatalf("problem = %+v", p)
	}
	if !strings.HasPrefix(p.Message, `Agent "agy" is disabled in agents.yaml (enabled: false)`) {
		t.Errorf("message = %q", p.Message)
	}
	if !strings.Contains(p.Message, "エージェント") {
		t.Errorf("the Japanese sentence follows: %q", p.Message)
	}
}

func TestRunProblemFor_ProfilesAndDefaults(t *testing.T) {
	cfg := mustParse(t, "version: 2\ndisabled_agents: [hermes]\n", ".yaml")
	// the built-in 【? 】 profile writes with hermes
	writing := &SlotMatch{Type: "slot", Profile: &SlotProfile{TriggerOpen: "【?", TriggerClose: "】", Agent: "hermes"}}
	key, def := RunAgentFor(cfg, writing)
	if key != "hermes" || def.Command != "" {
		t.Errorf("a profile that names a disabled agent must not run another one: %s %+v", key, def)
	}
	p := RunProblemFor(cfg, writing)
	if p == nil || p.Kind != ProblemDisabled || p.Agent != "hermes" {
		t.Errorf("problem = %+v", p)
	}
	// unknown (not disabled) profile agent: the default agent, as before
	unknown := &SlotMatch{Type: "slot", Profile: &SlotProfile{Agent: "nobody"}}
	if k, d := RunAgentFor(cfg, unknown); k != "claude-code" || d.Command != "claude" {
		t.Errorf("unknown profile agent: %s %+v", k, d)
	}
	if RunProblemFor(cfg, unknown) != nil {
		t.Errorf("an unknown profile agent falls back to the default agent, as before")
	}
	// recipes and gates use the default agent, which is enabled by construction
	for _, target := range []*SlotMatch{nil, {Type: "recipe"}} {
		if p := RunProblemFor(cfg, target); p != nil {
			t.Errorf("target %+v: %+v", target, p)
		}
	}
	// an agent that is enabled but has no command is the run's business, not a disabled agent
	broken := mustParse(t, "version: 2\nagents:\n  broken:\n    command: \"\"\n", ".yaml")
	if p := RunProblemFor(broken, &SlotMatch{Type: "slot", AgentName: "broken"}); p != nil {
		t.Errorf("no-command agent: %+v", p)
	}
	// the built-in fallback is never the disabled claude-code
	gone := mustParse(t, "version: 2\ndefault_agent: claude-code\ndisabled_agents: [claude-code]\n", ".yaml")
	gone.DefaultAgent = "" // as a config that names no default
	if k, d := RunAgentFor(gone, &SlotMatch{Type: "slot"}); k != "" || d.Command != "" {
		t.Errorf("fallback to a disabled claude-code: %s %+v", k, d)
	}
}

func TestRunProblemMessages(t *testing.T) {
	cases := []struct {
		p    *RunProblem
		want string
	}{
		{NewRunProblem(ProblemDisabled, "agy", ""), `Agent "agy" is disabled in agents.yaml (enabled: false)`},
		{NewRunProblem(ProblemNoneEnabled, "", ""), `No agent is enabled: every agent is disabled in agents.yaml (enabled: false)`},
		{NewRunProblem(ProblemMissing, "hermes", "ollama"), `Agent "hermes" needs "ollama", which was not found in PATH. Install it or choose another agent in agents.yaml.`},
		{NewRunProblem(ProblemMissing, "x", `C:\tools\x.exe`), `Agent "x" needs "C:\tools\x.exe", which was not found in PATH. Install it or choose another agent in agents.yaml.`},
	}
	for _, c := range cases {
		en, ja, ok := strings.Cut(c.p.Message, " / ")
		if !ok || en != c.want || ja == "" {
			t.Errorf("message = %q, want %q then a Japanese sentence", c.p.Message, c.want)
		}
	}
	raw, _ := json.Marshal(NewRunProblem(ProblemDisabled, "agy", ""))
	if string(raw) != `{"kind":"disabled","agent":"agy","message":"Agent \"agy\" is disabled in agents.yaml (enabled: false) / エージェント「agy」は agents.yaml で無効です (enabled: false)"}` {
		t.Errorf("wire form: %s", raw)
	}
}

func TestDisable_WireNames(t *testing.T) {
	raw, err := json.Marshal(AgentDef{Command: "x", Enabled: boolPtr(false)})
	if err != nil || !strings.Contains(string(raw), `"enabled":false`) {
		t.Errorf("AgentDef.enabled: %s %v", raw, err)
	}
	raw, _ = json.Marshal(AgentDef{Command: "x"})
	if strings.Contains(string(raw), "enabled") {
		t.Errorf("an unset enabled must not be written: %s", raw)
	}
	y, _ := yaml.Marshal(SlotConfig{DisabledAgents: []string{"agy"}})
	if !strings.Contains(string(y), "disabled_agents:") {
		t.Errorf("yaml: %s", y)
	}
}

// The template that "Open agents.yaml" writes explains the switches, and on its own disables nothing.
func TestTemplateDocumentsDisablingAgents(t *testing.T) {
	tpl := GenerateDefaultAgentsYAML()
	for _, want := range []string{"enabled: false", "disabled_agents", "gemini と antigravity は空きます", "claude-code, hermes, codex, agy の順"} {
		if !strings.Contains(tpl, want) {
			t.Errorf("the agents.yaml template should mention %q", want)
		}
	}
	cfg := mustParse(t, tpl, ".yaml")
	if cfg.DisabledAgents != nil || len(cfg.Agents) != 4 {
		t.Errorf("the template disables nothing by itself: %v %v", cfg.DisabledAgents, keysOf(cfg.Agents))
	}
	// the documented spelling works as documented
	doc := mustParse(t, "version: 2\ndisabled_agents: [agy, hermes]\n", ".yaml")
	if !reflect.DeepEqual(keysOf(doc.Agents), []string{"claude-code", "codex"}) {
		t.Errorf("agents = %v", keysOf(doc.Agents))
	}
}

// Nothing switched off is the case every user is in: finalising, and asking whether a name is a disabled agent, must not
// allocate (they run on every config build and on every @mention of a parse).
func TestDisable_NothingDisabledCostsNothing(t *testing.T) {
	cfg := DefaultSlotConfig()
	var sink SlotConfig
	if n := testing.AllocsPerRun(100, func() { sink = finalizeAgents(cfg, false) }); n != 0 {
		t.Errorf("finalizeAgents allocates %v times when nothing is disabled", n)
	}
	var key string
	var ok bool
	if n := testing.AllocsPerRun(100, func() { key, ok = cfg.DisabledAgentKey("@claude") }); n != 0 || ok || key != "" {
		t.Errorf("DisabledAgentKey: %v allocations, (%q, %v)", n, key, ok)
	}
	_ = sink
}
