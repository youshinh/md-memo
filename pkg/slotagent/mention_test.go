package slotagent

import (
	"context"
	"encoding/json"
	"os/exec"
	"reflect"
	"runtime"
	"sort"
	"strings"
	"testing"

	"gopkg.in/yaml.v3"
)

func TestResolveAgentName(t *testing.T) {
	cfg := DefaultSlotConfig()
	cases := []struct {
		in   string
		want string
		ok   bool
	}{
		{"claude-code", "claude-code", true},
		{"claude", "claude-code", true},
		{"CC", "claude-code", true},
		{"Claude-Code", "claude-code", true},
		{"@claude", "claude-code", true},
		{"antigravity", "agy", true},
		{"Gemini", "agy", true},
		{"agy", "agy", true},
		{"hermes", "hermes", true},
		{"codex", "codex", true},
		{"code-review", "", false},
		{"llm", "", false},
		{"", "", false},
		{"   ", "", false},
		{"@", "", false},
	}
	for _, c := range cases {
		got, ok := ResolveAgentName(cfg, c.in)
		if got != c.want || ok != c.ok {
			t.Errorf("ResolveAgentName(%q) = (%q, %v), want (%q, %v)", c.in, got, ok, c.want, c.ok)
		}
	}
}

func TestResolveAgentName_KeyBeatsAliasAndIsDeterministic(t *testing.T) {
	cfg := SlotConfig{Agents: map[string]AgentDef{
		"zeta":   {Command: "z", Aliases: []string{"dup", "shared", "x"}},
		"alpha":  {Command: "a", Aliases: []string{"dup"}},
		"shared": {Command: "s"},
		"Mixed":  {Command: "m"},
		"mixed":  {Command: "m2"},
	}}
	// Map iteration order is random; repeat so an order-dependent implementation would flake.
	for i := 0; i < 50; i++ {
		check := func(in, want string) {
			t.Helper()
			got, ok := ResolveAgentName(cfg, in)
			if !ok || got != want {
				t.Fatalf("ResolveAgentName(%q) = (%q, %v), want %q", in, got, ok, want)
			}
		}
		check("shared", "shared") // an agent key beats another agent's alias
		check("x", "zeta")
		check("dup", "alpha")   // same alias on two agents: smallest key wins
		check("mixed", "mixed") // exact key match first
		check("Mixed", "Mixed")
		check("MIXED", "Mixed") // case-insensitive key match: smallest key wins
	}
}

func TestParseSlots_AtMentionResolvesAgentBeforeSkill(t *testing.T) {
	cfg := DefaultSlotConfig()
	doc := "{{ @claude 調べて }}\n{{ @CC: fix it }}\n{{ @antigravity }}\n{{ @claude-code x }}\n{{ @code-review y }}\n[? @gemini z ]\n"
	slots := ParseSlots(doc, cfg)
	if len(slots) != 6 {
		t.Fatalf("expected 6 slots, got %d", len(slots))
	}

	type want struct {
		agent, skill, mode, instr, role string
	}
	wants := []want{
		{"claude-code", "", OutputModeBelow, "調べて", "@claude"},
		{"claude-code", "", OutputModeBelow, "fix it", "@CC"},
		{"agy", "", OutputModeBelow, "", "@antigravity"},
		{"claude-code", "", OutputModeBelow, "x", "@claude-code"},
		{"", "code-review", OutputModeReplace, "y", "@code-review"},
		{"agy", "", OutputModeBelow, "z", "@gemini"},
	}
	for i, w := range wants {
		s := slots[i]
		if s.AgentName != w.agent || s.SkillName != w.skill || s.OutputMode != w.mode || s.Instruction != w.instr || s.Role != w.role {
			t.Errorf("slot %d = {agent:%q skill:%q mode:%q instr:%q role:%q}, want %+v", i, s.AgentName, s.SkillName, s.OutputMode, s.Instruction, s.Role, w)
		}
	}
	if slots[5].Profile == nil || slots[5].Profile.Name != "research" {
		t.Errorf("the delimiter profile must still be reported for a mention slot, got %+v", slots[5].Profile)
	}
}

func TestParseSlots_UnknownMentionStaysSkill(t *testing.T) {
	cfg := DefaultSlotConfig()
	slots := ParseSlots("{{ @llm 要約して }}", cfg)
	if len(slots) != 1 {
		t.Fatalf("expected 1 slot, got %d", len(slots))
	}
	s := slots[0]
	if s.SkillName != "llm" || s.AgentName != "" || s.OutputMode != OutputModeReplace {
		t.Errorf("unknown @name must stay a skill mention in replace mode, got skill=%q agent=%q mode=%q", s.SkillName, s.AgentName, s.OutputMode)
	}
}

func TestParseSlots_LegacyFormsStayReplaceMode(t *testing.T) {
	cfg := DefaultSlotConfig()
	doc := "{{ 普通のスロット }}\n{{ code: func main() }}\n[>> @claude 深掘り ]\n"
	slots := ParseSlots(doc, cfg)
	if len(slots) != 3 {
		t.Fatalf("expected 3 slots, got %d", len(slots))
	}
	for i, s := range slots {
		if s.OutputMode != OutputModeReplace {
			t.Errorf("slot %d: legacy form must be replace mode, got %q", i, s.OutputMode)
		}
		if s.AgentName != "" {
			t.Errorf("slot %d: legacy form must not carry an agent name, got %q", i, s.AgentName)
		}
	}
	// A recipe keeps its own pipeline semantics: an @mention inside it is not an agent task.
	if slots[2].Type != "recipe" || slots[2].SkillName != "claude" {
		t.Errorf("recipe slot changed: type=%q skill=%q", slots[2].Type, slots[2].SkillName)
	}
}

func TestParseSlots_RunMarkerLineBelowTaskIsHarmless(t *testing.T) {
	cfg := DefaultSlotConfig()
	doc := "- {{ @claude 調べて }}\n<!-- md-memo:run ab12 -->\n次の行\n"
	slots := ParseSlots(doc, cfg)
	if len(slots) != 1 {
		t.Fatalf("expected 1 slot, got %d", len(slots))
	}
	s := slots[0]
	if s.AgentName != "claude-code" || s.RawContent != "@claude 調べて" {
		t.Errorf("unexpected slot: %+v", s)
	}
	if doc[s.StartOffset:s.EndOffset] != "{{ @claude 調べて }}" {
		t.Errorf("slot range wrong: %q", doc[s.StartOffset:s.EndOffset])
	}
}

func TestParseSlots_IgnoresSlotsInsideResultBlocks(t *testing.T) {
	cfg := DefaultSlotConfig()
	doc := "{{ @claude 調べて }}\n" +
		"<!-- md-memo:res ab12 -->\n" +
		"出力例: {{ この中は無視 }} と [? これも ]\n" +
		"<!-- /md-memo:res -->\n" +
		"{{ 本物 }}\n"
	slots := ParseSlots(doc, cfg)
	if len(slots) != 2 {
		t.Fatalf("expected 2 slots (result block excluded), got %d: %+v", len(slots), slots)
	}
	if slots[0].AgentName != "claude-code" || slots[1].Instruction != "本物" {
		t.Errorf("unexpected slots: %+v", slots)
	}
}

func TestParseSlots_UnterminatedResultBlockDoesNotHideSlots(t *testing.T) {
	cfg := DefaultSlotConfig()
	doc := "<!-- md-memo:res ab12 -->\n結果\n{{ まだ有効 }}\n"
	slots := ParseSlots(doc, cfg)
	if len(slots) != 1 || slots[0].Instruction != "まだ有効" {
		t.Fatalf("an unterminated result block must not swallow the rest of the note, got %+v", slots)
	}
}

func TestDefaultSlotConfig_AgentAliases(t *testing.T) {
	agents := DefaultSlotConfig().Agents
	want := map[string][]string{
		"claude-code": {"claude", "cc"},
		"agy":         {"antigravity", "gemini"},
		"hermes":      nil,
		"codex":       nil,
	}
	for k, aliases := range want {
		if !reflect.DeepEqual(agents[k].Aliases, aliases) {
			t.Errorf("agent %q aliases = %v, want %v", k, agents[k].Aliases, aliases)
		}
	}
}

func TestSlotConfigJSONFieldNames(t *testing.T) {
	def := AgentDef{Command: "c", Aliases: []string{"a"}}
	b, _ := json.Marshal(def)
	var m map[string]any
	_ = json.Unmarshal(b, &m)
	if _, ok := m["aliases"]; !ok {
		t.Errorf("AgentDef must marshal an \"aliases\" key, got %s", b)
	}
	if b, _ := json.Marshal(AgentDef{Command: "c"}); strings.Contains(string(b), "aliases") {
		t.Errorf("AgentDef without aliases must omit the key, got %s", b)
	}

	sn := SnippetDef{ID: "i", Label: "l", Kind: "llm", Trigger: "/t", Body: "b", OS: "win", Agent: "claude-code"}
	b, _ = json.Marshal(sn)
	m = map[string]any{}
	_ = json.Unmarshal(b, &m)
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	if got, want := strings.Join(keys, ","), "agent,body,id,kind,label,os,trigger"; got != want {
		t.Errorf("SnippetDef JSON keys = %s, want %s", got, want)
	}

	cfgJSON, _ := json.Marshal(DefaultSlotConfig())
	var top map[string]json.RawMessage
	_ = json.Unmarshal(cfgJSON, &top)
	if string(top["snippets"]) != "[]" {
		t.Errorf("SlotConfig must always marshal snippets as an array, got %s", top["snippets"])
	}
}

const aliasSnippetYAML = `
version: 2
default_agent: claude-code
agents:
  claude-code:
    command: "claude"
    args: ["--prompt", "{instruction}"]
    aliases: [claude, cc, "クロード"]
  mybot:
    command: "mybot"
    aliases:
      - bot
snippets:
  - id: weekly
    label: "今週の振り返り"
    kind: llm
    trigger: "/weekly"
    body: "このメモを3点に要約: ${selection}"
  - id: disk
    label: "Disk free"
    kind: command
    os: win
    body: "Get-PSDrive -PSProvider FileSystem"
  - id: tests
    label: "Run tests"
    kind: agent
    agent: claude-code
    body: |
      テストを実行して
      失敗した箇所を要約して
`

func TestParseAgentConfigFile_AliasesAndSnippets(t *testing.T) {
	cfg, err := ParseAgentConfigFile([]byte(aliasSnippetYAML), ".yaml")
	if err != nil {
		t.Fatalf("parse failed: %v", err)
	}
	if got := cfg.Agents["claude-code"].Aliases; !reflect.DeepEqual(got, []string{"claude", "cc", "クロード"}) {
		t.Errorf("claude-code aliases = %v", got)
	}
	if got := cfg.Agents["mybot"].Aliases; !reflect.DeepEqual(got, []string{"bot"}) {
		t.Errorf("mybot aliases = %v", got)
	}
	if len(cfg.Snippets) != 3 {
		t.Fatalf("expected 3 snippets, got %d", len(cfg.Snippets))
	}
	s0 := cfg.Snippets[0]
	if s0.ID != "weekly" || s0.Label != "今週の振り返り" || s0.Kind != "llm" || s0.Trigger != "/weekly" || s0.Body != "このメモを3点に要約: ${selection}" {
		t.Errorf("snippet 0 = %+v", s0)
	}
	if s1 := cfg.Snippets[1]; s1.Kind != "command" || s1.OS != "win" || s1.Body != "Get-PSDrive -PSProvider FileSystem" {
		t.Errorf("snippet 1 = %+v", s1)
	}
	if s2 := cfg.Snippets[2]; s2.Kind != "agent" || s2.Agent != "claude-code" || strings.TrimSpace(s2.Body) != "テストを実行して\n失敗した箇所を要約して" {
		t.Errorf("snippet 2 = %+v", s2)
	}

	// Resolution goes through the user's own aliases, including a non-ASCII one.
	if got, ok := ResolveAgentName(cfg, "クロード"); !ok || got != "claude-code" {
		t.Errorf("ResolveAgentName(クロード) = (%q, %v)", got, ok)
	}
	if got, ok := ResolveAgentName(cfg, "BOT"); !ok || got != "mybot" {
		t.Errorf("ResolveAgentName(BOT) = (%q, %v)", got, ok)
	}
}

func TestParseAgentConfigFile_SnippetsFromJSONAndMarkdown(t *testing.T) {
	jsonSrc := `{"version":2,"snippets":[{"id":"a","label":"A","kind":"text","body":"x"}],"agents":{"z":{"command":"z","aliases":["zz"]}}}`
	cfg, err := ParseAgentConfigFile([]byte(jsonSrc), ".json")
	if err != nil {
		t.Fatalf("json parse failed: %v", err)
	}
	if len(cfg.Snippets) != 1 || cfg.Snippets[0].ID != "a" || cfg.Snippets[0].Kind != "text" {
		t.Errorf("json snippets = %+v", cfg.Snippets)
	}
	if !reflect.DeepEqual(cfg.Agents["z"].Aliases, []string{"zz"}) {
		t.Errorf("json aliases = %v", cfg.Agents["z"].Aliases)
	}

	md := "# agents\n\n```yaml\n" + strings.TrimSpace(aliasSnippetYAML) + "\n```\n"
	cfg2, err := ParseAgentConfigFile([]byte(md), ".md")
	if err != nil {
		t.Fatalf("markdown parse failed: %v", err)
	}
	if len(cfg2.Snippets) != 3 {
		t.Errorf("markdown snippets = %d, want 3", len(cfg2.Snippets))
	}
}

func TestParseAgentConfigFile_NoSnippetsIsEmptyNotNil(t *testing.T) {
	cfg, err := ParseAgentConfigFile([]byte("version: 2\ndefault_agent: hermes\n"), ".yaml")
	if err != nil {
		t.Fatalf("parse failed: %v", err)
	}
	if cfg.Snippets == nil || len(cfg.Snippets) != 0 {
		t.Errorf("Snippets must be an empty non-nil slice, got %#v", cfg.Snippets)
	}
	if got := MergeSlotConfig(""); got.Snippets == nil {
		t.Errorf("MergeSlotConfig(\"\") must keep Snippets non-nil")
	}
	if got := MergeSlotConfig(`{"default_agent":"hermes"}`); got.Snippets == nil {
		t.Errorf("MergeSlotConfig with no snippets must keep Snippets non-nil")
	}
}

func TestParseAgentConfigFile_OldAgentsFileKeepsDefaultAliases(t *testing.T) {
	// A file written before aliases existed: claude-code is redefined without any aliases.
	old := "version: 2\nagents:\n  claude-code:\n    command: \"claude\"\n    args: [\"--prompt\", \"{instruction}\"]\n  agy:\n    command: \"agy\"\n"
	cfg, err := ParseAgentConfigFile([]byte(old), ".yaml")
	if err != nil {
		t.Fatalf("parse failed: %v", err)
	}
	if got := cfg.Agents["claude-code"].Aliases; !reflect.DeepEqual(got, []string{"claude", "cc"}) {
		t.Errorf("old claude-code entry must inherit default aliases, got %v", got)
	}
	if got := cfg.Agents["agy"].Aliases; !reflect.DeepEqual(got, []string{"antigravity", "gemini"}) {
		t.Errorf("old agy entry must inherit default aliases, got %v", got)
	}
	// Agents the file never mentioned come from the defaults, aliases included.
	if got := cfg.Agents["hermes"]; got.Command == "" || len(got.Aliases) != 0 {
		t.Errorf("hermes = %+v", got)
	}
	// The whole path works: @claude resolves against the loaded file.
	if got, ok := ResolveAgentName(cfg, "claude"); !ok || got != "claude-code" {
		t.Errorf("ResolveAgentName(claude) = (%q, %v)", got, ok)
	}
}

func TestParseAgentConfigFile_ExplicitAliasesWinOverDefaults(t *testing.T) {
	src := "version: 2\nagents:\n  claude-code:\n    command: \"claude\"\n    aliases: []\n  agy:\n    command: \"agy\"\n    aliases: [ag]\n"
	cfg, err := ParseAgentConfigFile([]byte(src), ".yaml")
	if err != nil {
		t.Fatalf("parse failed: %v", err)
	}
	if got := cfg.Agents["claude-code"].Aliases; got == nil || len(got) != 0 {
		t.Errorf("explicit empty aliases must stay empty, got %#v", got)
	}
	if _, ok := ResolveAgentName(cfg, "claude"); ok {
		t.Errorf("@claude must not resolve once the user emptied aliases")
	}
	if got := cfg.Agents["agy"].Aliases; !reflect.DeepEqual(got, []string{"ag"}) {
		t.Errorf("explicit agy aliases = %v", got)
	}
}

func TestFillDefaultAliases_DoesNotStealNamesInUse(t *testing.T) {
	// "cc" is another agent's key and "claude" is another agent's explicit alias.
	src := "version: 2\nagents:\n  claude-code:\n    command: \"claude\"\n  cc:\n    command: \"cc\"\n  mine:\n    command: \"m\"\n    aliases: [Claude]\n"
	cfg, err := ParseAgentConfigFile([]byte(src), ".yaml")
	if err != nil {
		t.Fatalf("parse failed: %v", err)
	}
	if got := cfg.Agents["claude-code"].Aliases; len(got) != 0 {
		t.Errorf("default aliases already used elsewhere must not be added, got %v", got)
	}
	if got, ok := ResolveAgentName(cfg, "cc"); !ok || got != "cc" {
		t.Errorf("cc must keep resolving to the agent named cc, got (%q, %v)", got, ok)
	}
	if got, ok := ResolveAgentName(cfg, "claude"); !ok || got != "mine" {
		t.Errorf("an explicit alias must win over a default one, got (%q, %v)", got, ok)
	}
}

func TestMergeSlotConfig_AliasesAndSnippetsFromJSON(t *testing.T) {
	raw := `{"default_agent":"claude-code","agents":{"claude-code":{"command":"claude","args":[]}},"snippets":[{"id":"s","label":"S","kind":"llm","body":"b"}]}`
	cfg := MergeSlotConfig(raw)
	if got := cfg.Agents["claude-code"].Aliases; !reflect.DeepEqual(got, []string{"claude", "cc"}) {
		t.Errorf("aliases missing from the JSON must be filled from the defaults, got %v", got)
	}
	if len(cfg.Snippets) != 1 || cfg.Snippets[0].ID != "s" {
		t.Errorf("snippets = %+v", cfg.Snippets)
	}

	raw2 := `{"agents":{"claude-code":{"command":"claude","aliases":["only"]}}}`
	if got := MergeSlotConfig(raw2).Agents["claude-code"].Aliases; !reflect.DeepEqual(got, []string{"only"}) {
		t.Errorf("explicit JSON aliases must be kept as is, got %v", got)
	}
}

func TestGenerateDefaultAgentsYAML_DocumentsAliasesAndSnippets(t *testing.T) {
	tpl := GenerateDefaultAgentsYAML()
	for _, want := range []string{"aliases:", "snippets:", "{{ @claude", "${selection}"} {
		if !strings.Contains(tpl, want) {
			t.Errorf("generated agents.yaml should mention %q", want)
		}
	}

	// The commented example must be a valid snippets block once uncommented.
	lines := strings.Split(tpl, "\n")
	start := -1
	for i, l := range lines {
		if l == "# snippets:" {
			start = i
			break
		}
	}
	if start == -1 {
		t.Fatal("commented \"# snippets:\" example not found")
	}
	var block []string
	for _, l := range lines[start:] {
		if !strings.HasPrefix(l, "# ") {
			break
		}
		block = append(block, l[2:])
	}
	cfg, err := ParseAgentConfigFile([]byte("version: 2\n"+strings.Join(block, "\n")+"\n"), ".yaml")
	if err != nil {
		t.Fatalf("uncommented example does not parse: %v", err)
	}
	kinds := map[string]bool{}
	for _, s := range cfg.Snippets {
		if s.ID == "" || s.Body == "" {
			t.Errorf("example snippet without id/body: %+v", s)
		}
		kinds[s.Kind] = true
	}
	for _, k := range []string{"llm", "agent", "command", "text"} {
		if !kinds[k] {
			t.Errorf("example should show a %q snippet, got kinds %v", k, kinds)
		}
	}

	// The template on its own (nothing uncommented) must not define snippets and must keep
	// the default aliases through the loader.
	plain, err := ParseAgentConfigFile([]byte(tpl), ".yaml")
	if err != nil {
		t.Fatalf("template does not parse: %v", err)
	}
	if len(plain.Snippets) != 0 {
		t.Errorf("template must not define snippets by itself, got %+v", plain.Snippets)
	}
	if got := plain.Agents["claude-code"].Aliases; !reflect.DeepEqual(got, []string{"claude", "cc"}) {
		t.Errorf("template claude-code aliases = %v", got)
	}
}

// echoAgent returns an agent whose stdout is text followed by trailing blank space.
func echoAgent(t *testing.T, text string) AgentDef {
	t.Helper()
	if runtime.GOOS == "windows" {
		exe, err := exec.LookPath("cmd.exe")
		if err != nil {
			t.Skipf("cmd.exe not available: %v", err)
		}
		return AgentDef{Command: exe, Args: []string{"/c", "echo", text}}
	}
	exe, err := exec.LookPath("sh")
	if err != nil {
		t.Skipf("sh not available: %v", err)
	}
	return AgentDef{Command: exe, Args: []string{"-c", "printf '%s\\n\\n' " + text}}
}

func TestRunner_Execute_RawOutputIsUntrimmed(t *testing.T) {
	runner := NewRunner()
	res := runner.Execute(context.Background(), "req-raw-output", echoAgent(t, "hello"), "", "", "")
	if res.ExitCode != 0 {
		t.Fatalf("agent failed: %+v", res)
	}
	if res.Output != "hello" {
		t.Errorf("Output must stay trimmed for legacy callers, got %q", res.Output)
	}
	if !strings.HasPrefix(res.RawOutput, "hello") || !strings.HasSuffix(res.RawOutput, "\n") {
		t.Errorf("RawOutput must keep the agent's trailing newline, got %q", res.RawOutput)
	}
	if strings.TrimSpace(res.RawOutput) != res.Output {
		t.Errorf("RawOutput %q and Output %q must differ only by surrounding whitespace", res.RawOutput, res.Output)
	}
}

// ImportAgentsConfigFile re-saves the parsed config with yaml.Marshal; the new fields must
// survive that round trip and stay out of the file when unused.
func TestSlotConfigYAMLRoundTripKeepsAliasesAndSnippets(t *testing.T) {
	cfg, err := ParseAgentConfigFile([]byte(aliasSnippetYAML), ".yaml")
	if err != nil {
		t.Fatalf("parse failed: %v", err)
	}
	out, err := yaml.Marshal(&cfg)
	if err != nil {
		t.Fatalf("marshal failed: %v", err)
	}
	again, err := ParseAgentConfigFile(out, ".yaml")
	if err != nil {
		t.Fatalf("re-parse failed: %v\n%s", err, out)
	}
	if !reflect.DeepEqual(again.Snippets, cfg.Snippets) {
		t.Errorf("snippets changed across the round trip:\n got %+v\nwant %+v", again.Snippets, cfg.Snippets)
	}
	if !reflect.DeepEqual(again.Agents["claude-code"].Aliases, cfg.Agents["claude-code"].Aliases) {
		t.Errorf("aliases changed across the round trip: %v vs %v", again.Agents["claude-code"].Aliases, cfg.Agents["claude-code"].Aliases)
	}

	plain, _ := yaml.Marshal(func() *SlotConfig {
		c := DefaultSlotConfig()
		c.Agents = map[string]AgentDef{"x": {Command: "x"}}
		return &c
	}())
	if strings.Contains(string(plain), "snippets") || strings.Contains(string(plain), "aliases") {
		t.Errorf("unused snippets/aliases must not be written out:\n%s", plain)
	}
}
