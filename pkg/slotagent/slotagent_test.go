package slotagent

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestDefaultConfig(t *testing.T) {
	cfg := DefaultSlotConfig()
	if cfg.Version != 2 {
		t.Fatalf("expected version 2, got %d", cfg.Version)
	}
	if cfg.DefaultAgent != "claude-code" {
		t.Fatalf("expected default agent claude-code, got %s", cfg.DefaultAgent)
	}
	if cfg.TimeoutSeconds != 180 {
		t.Fatalf("expected timeout 180, got %d", cfg.TimeoutSeconds)
	}
	if len(cfg.SlotProfiles) < 4 {
		t.Fatalf("expected at least 4 slot profiles, got %d", len(cfg.SlotProfiles))
	}
	if len(cfg.Recipes) < 1 {
		t.Fatalf("expected at least 1 recipe, got %d", len(cfg.Recipes))
	}
}

func TestMergeSlotConfig(t *testing.T) {
	raw := `{"version":2,"default_agent":"hermes","timeout_seconds":60}`
	cfg := MergeSlotConfig(raw)
	if cfg.DefaultAgent != "hermes" {
		t.Fatalf("expected merged agent hermes, got %s", cfg.DefaultAgent)
	}
	if cfg.TimeoutSeconds != 60 {
		t.Fatalf("expected timeout 60, got %d", cfg.TimeoutSeconds)
	}
	// Fallback profiles should still be populated
	if len(cfg.SlotProfiles) == 0 {
		t.Fatalf("expected default slot profiles to be populated")
	}
}

func TestParseSlots_BasicAndInline(t *testing.T) {
	cfg := DefaultSlotConfig()

	// 1. Inline slot
	content1 := "- メモリ: {{ memory }}"
	slots1 := ParseSlots(content1, cfg)
	if len(slots1) != 1 {
		t.Fatalf("expected 1 slot, got %d", len(slots1))
	}
	if !slots1[0].IsInline {
		t.Errorf("expected slot to be inline")
	}
	if slots1[0].Instruction != "memory" {
		t.Errorf("expected instruction 'memory', got %q", slots1[0].Instruction)
	}

	// 2. Block slot
	content2 := "# Title\n\n{{ code: func main() }}\n\nEnd"
	slots2 := ParseSlots(content2, cfg)
	if len(slots2) != 1 {
		t.Fatalf("expected 1 slot, got %d", len(slots2))
	}
	if slots2[0].IsInline {
		t.Errorf("expected slot to be block (not inline)")
	}
	if slots2[0].Role != "code" {
		t.Errorf("expected role 'code', got %q", slots2[0].Role)
	}
	if slots2[0].Instruction != "func main()" {
		t.Errorf("expected instruction 'func main()', got %q", slots2[0].Instruction)
	}

	// 3. Alternative delimiters: [?, 【?, [!, [>>
	content3 := `
[? search quantum computing ]
【? 日本語の要約 】
[! セキュリティ脆弱性の検証 !]
[>> パイプライン実行 ]
`
	slots3 := ParseSlots(content3, cfg)
	if len(slots3) != 4 {
		t.Fatalf("expected 4 slots, got %d", len(slots3))
	}
	if slots3[0].OpenDelimiter != "[?" || slots3[0].CloseDelim != "]" {
		t.Errorf("slot 0 delimiters mismatch: %v", slots3[0])
	}
	if slots3[1].OpenDelimiter != "【?" || slots3[1].CloseDelim != "】" {
		t.Errorf("slot 1 delimiters mismatch: %v", slots3[1])
	}
	if slots3[2].OpenDelimiter != "[!" || slots3[2].CloseDelim != "!]" {
		t.Errorf("slot 2 delimiters mismatch: %v", slots3[2])
	}
	if slots3[3].Type != "recipe" || slots3[3].OpenDelimiter != "[>>" {
		t.Errorf("slot 3 recipe mismatch: %v", slots3[3])
	}
}

func TestParseSlots_ASTBypass(t *testing.T) {
	cfg := DefaultSlotConfig()

	// TC-03: Code blocks and inline code should be completely excluded from slot execution
	content := "" +
		"# Test Code Bypass\n\n" +
		"Inline code: `{{ inline_code }}` should be ignored.\n\n" +
		"```go\n" +
		"func main() {\n" +
		"    {{ code_in_block }}\n" +
		"}\n" +
		"```\n\n" +
		"Link: [link text](https://example.com/{{ id }})\n\n" +
		"Valid slot:\n" +
		"{{ valid_slot }}\n"

	slots := ParseSlots(content, cfg)
	if len(slots) != 1 {
		t.Fatalf("expected exactly 1 valid slot (bypassing code/link), got %d", len(slots))
	}
	if slots[0].Instruction != "valid_slot" {
		t.Errorf("expected instruction 'valid_slot', got %q", slots[0].Instruction)
	}
}

func TestParseSlots_ResearchUrls(t *testing.T) {
	cfg := DefaultSlotConfig()

	// 1. URL directly adjacent to closing bracket
	doc1 := "[? research: https://youshinh.github.io/md-memo/]"
	slots1 := ParseSlots(doc1, cfg)
	if len(slots1) != 1 {
		t.Fatalf("expected 1 slot for doc1, got %d", len(slots1))
	}
	if slots1[0].Role != "research" {
		t.Errorf("expected role 'research', got %q", slots1[0].Role)
	}
	if slots1[0].Instruction != "https://youshinh.github.io/md-memo/" {
		t.Errorf("expected instruction 'https://youshinh.github.io/md-memo/', got %q", slots1[0].Instruction)
	}

	// 2. URL with trailing space before closing bracket
	doc2 := "[? research: https://youshinh.github.io/md-memo ]"
	slots2 := ParseSlots(doc2, cfg)
	if len(slots2) != 1 {
		t.Fatalf("expected 1 slot for doc2, got %d", len(slots2))
	}
	if slots2[0].Instruction != "https://youshinh.github.io/md-memo" {
		t.Errorf("expected instruction 'https://youshinh.github.io/md-memo', got %q", slots2[0].Instruction)
	}

	// 3. Natural Japanese prompt
	doc3 := "[? research: 今日の天気 ]"
	slots3 := ParseSlots(doc3, cfg)
	if len(slots3) != 1 {
		t.Fatalf("expected 1 slot for doc3, got %d", len(slots3))
	}
	if slots3[0].Instruction != "今日の天気" {
		t.Errorf("expected instruction '今日の天気', got %q", slots3[0].Instruction)
	}
}

func TestApprovalGates(t *testing.T) {
	// TC-07: Human approval gate detection
	content := "" +
		"Step 1 output\n" +
		"- [ ] 次のステップ（コード生成）を実行する // approve\n" +
		"Some other notes\n" +
		"- [x] 次のステップ（テスト作成）を実行する // approve\n"

	gates := FindApprovalGates(content)
	if len(gates) != 2 {
		t.Fatalf("expected 2 approval gates, got %d", len(gates))
	}
	if gates[0].IsApproved {
		t.Errorf("gate 0 should NOT be approved")
	}
	if !gates[1].IsApproved {
		t.Errorf("gate 1 should BE approved")
	}
	if !strings.Contains(gates[0].StepDesc, "コード生成") {
		t.Errorf("gate 0 step desc mismatch: %q", gates[0].StepDesc)
	}
}

func TestPrepareCommand(t *testing.T) {
	agentDef := AgentDef{
		Command: "claude",
		Args:    []string{"--file", "{file}", "--prompt", "{instruction}"},
	}

	ctx := context.Background()
	cmd, err := PrepareCommand(ctx, agentDef, "/path/to/note.md", "analyze this", "system rules")
	if err != nil {
		t.Fatalf("PrepareCommand failed: %v", err)
	}

	expectedArgs := []string{"claude", "--file", "/path/to/note.md", "--prompt", "system rules\n\nTask: analyze this"}
	if len(cmd.Args) != len(expectedArgs) {
		t.Fatalf("expected %d args, got %d: %v", len(expectedArgs), len(cmd.Args), cmd.Args)
	}
	for i := range expectedArgs {
		if cmd.Args[i] != expectedArgs[i] {
			t.Errorf("arg[%d] expected %q, got %q", i, expectedArgs[i], cmd.Args[i])
		}
	}
}

func TestHoverPeekBuffer(t *testing.T) {
	buf := &HoverPeekBuffer{}
	if buf.Get() != "" {
		t.Errorf("expected empty initial peek")
	}
	buf.Set("line 1")
	if buf.Get() != "line 1" {
		t.Errorf("expected 'line 1', got %q", buf.Get())
	}
	buf.Set("line 2\n")
	if buf.Get() != "line 2" {
		t.Errorf("expected 'line 2', got %q", buf.Get())
	}
	buf.Set("   ") // Whitespace should not overwrite with empty
	if buf.Get() != "line 2" {
		t.Errorf("expected 'line 2' to be preserved, got %q", buf.Get())
	}
}

func TestRunner_CancellationAndTimeout(t *testing.T) {
	runner := NewRunner()

	// Short timeout simulation
	reqID := "req-test-timeout"
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()

	agentDef := AgentDef{
		Command: "powershell",
		Args:    []string{"-NoProfile", "-Command", "Start-Sleep -Seconds 5"},
	}

	res := runner.Execute(ctx, reqID, agentDef, "", "sleep", "")
	if !res.TimedOut && res.ExitCode == 0 {
		t.Errorf("expected command to timeout or cancel, got exitCode=%d", res.ExitCode)
	}
	if !strings.Contains(res.ErrorMsg, "タイムアウト") && !strings.Contains(res.ErrorMsg, "キャンセル") {
		t.Logf("Exit output/error: %s (ExitCode: %d)", res.ErrorMsg, res.ExitCode)
	}
}

func TestFindProjectRoot(t *testing.T) {
	tempDir := t.TempDir()

	// Structure:
	// tempDir/
	//   agents.yaml
	//   sub1/
	//     sub2/
	//       note.md
	subDir := filepath.Join(tempDir, "sub1", "sub2")
	if err := os.MkdirAll(subDir, 0755); err != nil {
		t.Fatalf("failed to create subDir: %v", err)
	}
	noteFile := filepath.Join(subDir, "note.md")
	if err := os.WriteFile(noteFile, []byte("# Test Note"), 0644); err != nil {
		t.Fatalf("failed to write note: %v", err)
	}

	// 1. Without root marker: returns directory containing the file (sub2)
	root1 := FindProjectRoot(noteFile)
	if root1 != subDir {
		t.Errorf("expected %s, got %s", subDir, root1)
	}

	// 2. With agents.yaml in tempDir
	yamlPath := filepath.Join(tempDir, "agents.yaml")
	if err := os.WriteFile(yamlPath, []byte("version: 2"), 0644); err != nil {
		t.Fatalf("failed to write agents.yaml: %v", err)
	}
	root2 := FindProjectRoot(noteFile)
	if root2 != tempDir {
		t.Errorf("expected root %s, got %s", tempDir, root2)
	}

	// 3. With skills directory closer in sub1
	skillsDir := filepath.Join(tempDir, "sub1", "skills")
	if err := os.MkdirAll(skillsDir, 0755); err != nil {
		t.Fatalf("failed to create skillsDir: %v", err)
	}
	root3 := FindProjectRoot(noteFile)
	expectedSub1 := filepath.Join(tempDir, "sub1")
	if root3 != expectedSub1 {
		t.Errorf("expected closer root %s, got %s", expectedSub1, root3)
	}
}

func TestLoadEnvFile(t *testing.T) {
	tempDir := t.TempDir()
	envPath := filepath.Join(tempDir, ".env")
	envContent := `
# Comment line
ANTHROPIC_API_KEY=sk-ant-test12345
OPENAI_API_KEY="sk-proj-quoted-test"
SINGLE_QUOTED='single-quoted-val'
export EXPORTED_VAR=exported-val
WITH_COMMENT=val_before_comment # inline comment
EMPTY_KEY=
`
	if err := os.WriteFile(envPath, []byte(envContent), 0644); err != nil {
		t.Fatalf("failed to write .env: %v", err)
	}

	envMap, err := LoadEnvFile(envPath)
	if err != nil {
		t.Fatalf("LoadEnvFile failed: %v", err)
	}

	if envMap["ANTHROPIC_API_KEY"] != "sk-ant-test12345" {
		t.Errorf("expected sk-ant-test12345, got %q", envMap["ANTHROPIC_API_KEY"])
	}
	if envMap["OPENAI_API_KEY"] != "sk-proj-quoted-test" {
		t.Errorf("expected sk-proj-quoted-test, got %q", envMap["OPENAI_API_KEY"])
	}
	if envMap["SINGLE_QUOTED"] != "single-quoted-val" {
		t.Errorf("expected single-quoted-val, got %q", envMap["SINGLE_QUOTED"])
	}
	if envMap["EXPORTED_VAR"] != "exported-val" {
		t.Errorf("expected exported-val, got %q", envMap["EXPORTED_VAR"])
	}
	if envMap["WITH_COMMENT"] != "val_before_comment" {
		t.Errorf("expected val_before_comment, got %q", envMap["WITH_COMMENT"])
	}
}

func TestMergeProcessEnv(t *testing.T) {
	baseEnv := []string{
		"PATH=/usr/bin",
		"USER=testuser",
		"OPENAI_API_KEY=old-key",
	}
	envMap := map[string]string{
		"OPENAI_API_KEY":    "new-key",
		"ANTHROPIC_API_KEY": "ant-key",
	}

	merged := MergeProcessEnv(baseEnv, envMap)
	mergedMap := make(map[string]string)
	for _, item := range merged {
		parts := strings.SplitN(item, "=", 2)
		if len(parts) == 2 {
			mergedMap[parts[0]] = parts[1]
		}
	}

	if mergedMap["PATH"] != "/usr/bin" {
		t.Errorf("PATH overwritten: %q", mergedMap["PATH"])
	}
	if mergedMap["USER"] != "testuser" {
		t.Errorf("USER overwritten: %q", mergedMap["USER"])
	}
	if mergedMap["OPENAI_API_KEY"] != "new-key" {
		t.Errorf("OPENAI_API_KEY not updated: %q", mergedMap["OPENAI_API_KEY"])
	}
	if mergedMap["ANTHROPIC_API_KEY"] != "ant-key" {
		t.Errorf("ANTHROPIC_API_KEY not set: %q", mergedMap["ANTHROPIC_API_KEY"])
	}
}

func TestExtractSkillInstruction(t *testing.T) {
	raw := `---
name: code-review
description: Comprehensive security and quality review
author: Antigravity
---

# Code Review Skill
Please review the code carefully focusing on:
1. Vulnerabilities
2. Performance
`
	extracted := ExtractSkillInstruction(raw)
	expectedPrefix := "# Code Review Skill"
	if !strings.HasPrefix(extracted, expectedPrefix) {
		t.Errorf("expected body starting with %q, got %q", expectedPrefix, extracted)
	}
	if strings.Contains(extracted, "description: Comprehensive") {
		t.Errorf("frontmatter was not stripped from instruction")
	}

	// Without frontmatter
	noFrontmatter := "Just a direct instruction"
	if ExtractSkillInstruction(noFrontmatter) != noFrontmatter {
		t.Errorf("unexpected strip on plain text")
	}
}

func TestFindSkillInstruction(t *testing.T) {
	tempDir := t.TempDir()

	// 1. Create skills/code-review/SKILL.md
	skillDir := filepath.Join(tempDir, "skills", "code-review")
	if err := os.MkdirAll(skillDir, 0755); err != nil {
		t.Fatalf("failed to create skillDir: %v", err)
	}
	skillFile := filepath.Join(skillDir, "SKILL.md")
	skillContent := `---
name: code-review
---
Perform a thorough code review.
`
	if err := os.WriteFile(skillFile, []byte(skillContent), 0644); err != nil {
		t.Fatalf("failed to write skill: %v", err)
	}

	info, err := FindSkillInstruction(tempDir, "code-review")
	if err != nil {
		t.Fatalf("FindSkillInstruction failed: %v", err)
	}
	if info.Name != "code-review" {
		t.Errorf("expected name 'code-review', got %q", info.Name)
	}
	if info.Instruction != "Perform a thorough code review." {
		t.Errorf("expected instruction, got %q", info.Instruction)
	}

	// 2. Lookup with @ prefix
	info2, err := FindSkillInstruction(tempDir, "@code-review")
	if err != nil {
		t.Fatalf("FindSkillInstruction with @ failed: %v", err)
	}
	if info2.Name != "code-review" {
		t.Errorf("expected name 'code-review', got %q", info2.Name)
	}

	// 3. Missing skill returns error
	_, errMissing := FindSkillInstruction(tempDir, "non-existent")
	if errMissing == nil {
		t.Fatalf("expected error for non-existent skill")
	}
}

func TestParseSlots_SkillSyntax(t *testing.T) {
	cfg := DefaultSlotConfig()

	content := `
1. Colon syntax: {{@code-review: app.go をレビュー}}
2. Space syntax: {{@translate この段落を英訳}}
3. Standalone syntax: {{@adversarial}}
4. Bracket syntax: [?@search 最新のGoリリース情報]
`
	slots := ParseSlots(content, cfg)
	if len(slots) != 4 {
		t.Fatalf("expected 4 slots, got %d", len(slots))
	}

	// 1. Colon syntax
	if slots[0].SkillName != "code-review" {
		t.Errorf("expected skillName 'code-review', got %q", slots[0].SkillName)
	}
	if slots[0].Instruction != "app.go をレビュー" {
		t.Errorf("expected instruction 'app.go をレビュー', got %q", slots[0].Instruction)
	}
	if slots[0].Role != "@code-review" {
		t.Errorf("expected role '@code-review', got %q", slots[0].Role)
	}

	// 2. Space syntax
	if slots[1].SkillName != "translate" {
		t.Errorf("expected skillName 'translate', got %q", slots[1].SkillName)
	}
	if slots[1].Instruction != "この段落を英訳" {
		t.Errorf("expected instruction 'この段落を英訳', got %q", slots[1].Instruction)
	}

	// 3. Standalone syntax
	if slots[2].SkillName != "adversarial" {
		t.Errorf("expected skillName 'adversarial', got %q", slots[2].SkillName)
	}
	if slots[2].Instruction != "" {
		t.Errorf("expected empty instruction, got %q", slots[2].Instruction)
	}

	// 4. Bracket syntax
	if slots[3].SkillName != "search" {
		t.Errorf("expected skillName 'search', got %q", slots[3].SkillName)
	}
	if slots[3].Instruction != "最新のGoリリース情報" {
		t.Errorf("expected instruction '最新のGoリリース情報', got %q", slots[3].Instruction)
	}
}

func TestSlotProfileExternalPrecedence(t *testing.T) {
	// Simulate agents.yaml specifying [? -> agy
	baseCfg := SlotConfig{
		DefaultAgent: "agy",
		SlotProfiles: []SlotProfile{
			{
				TriggerOpen:  "[?",
				TriggerClose: "]",
				Name:         "research",
				Agent:        "agy",
			},
		},
	}

	// Simulate frontend JS default override specifying [? -> claude-code
	override := SlotConfig{
		DefaultAgent: "claude-code",
		SlotProfiles: []SlotProfile{
			{
				TriggerOpen:  "[?",
				TriggerClose: "]",
				Name:         "research",
				Agent:        "claude-code",
			},
			{
				TriggerOpen:  "【?",
				TriggerClose: "】",
				Name:         "writing",
				Agent:        "hermes",
			},
		},
	}

	// Apply safe merge: external baseCfg must strictly take precedence for existing triggers
	existingTriggers := make(map[string]bool)
	for _, sp := range baseCfg.SlotProfiles {
		existingTriggers[sp.TriggerOpen] = true
	}
	for _, op := range override.SlotProfiles {
		if !existingTriggers[op.TriggerOpen] {
			baseCfg.SlotProfiles = append(baseCfg.SlotProfiles, op)
			existingTriggers[op.TriggerOpen] = true
		}
	}

	slots := ParseSlots("[? test prompt ]", baseCfg)
	if len(slots) != 1 {
		t.Fatalf("expected 1 slot, got %d", len(slots))
	}
	if slots[0].Profile == nil {
		t.Fatalf("expected profile to be non-nil")
	}
	if slots[0].Profile.Agent != "agy" {
		t.Errorf("expected slot agent to be 'agy' from agents.yaml, got %q", slots[0].Profile.Agent)
	}
}

func TestParseSlots_SkipExecutingPlaceholders(t *testing.T) {
	cfg := DefaultSlotConfig()

	// Text contains real slot and in-progress placeholders
	doc := `
今日の予定
買い物
散歩
{{ このメモの内容からアクションプランとタスクを立案 }}
{{ ⟳ 実行中... }}
{{ 実行中... }}
{{ (実行中...) }}
`
	slots := ParseSlots(doc, cfg)
	if len(slots) != 1 {
		t.Fatalf("expected exactly 1 actionable slot (excluding placeholders), got %d", len(slots))
	}
	if slots[0].Instruction != "このメモの内容からアクションプランとタスクを立案" {
		t.Errorf("unexpected slot instruction: %s", slots[0].Instruction)
	}
}

func TestPrepareCommand_InjectFileContext(t *testing.T) {
	// 1. When agent args do NOT contain {file}
	agentWithoutFile := AgentDef{
		Command: "agy",
		Args:    []string{"-p", "{instruction}", "--dangerously-skip-permissions"},
	}

	cmd, err := PrepareCommand(context.Background(), agentWithoutFile, "/path/to/note.md", "このメモを要約して", "")
	if err != nil {
		t.Fatalf("PrepareCommand failed: %v", err)
	}

	// Instruction must be augmented with note file context
	cmdStr := strings.Join(cmd.Args, " ")
	if !strings.Contains(cmdStr, "対象ノートファイル: /path/to/note.md") {
		t.Errorf("expected command to contain target file context, got: %s", cmdStr)
	}

	// 2. When agent args explicitly contain {file}
	agentWithFile := AgentDef{
		Command: "agy",
		Args:    []string{"-p", "対象ノート: {file}\n指示: {instruction}", "--dangerously-skip-permissions"},
	}

	cmd2, err := PrepareCommand(context.Background(), agentWithFile, "/path/to/note.md", "要約して", "")
	if err != nil {
		t.Fatalf("PrepareCommand with {file} failed: %v", err)
	}
	cmdStr2 := strings.Join(cmd2.Args, " ")
	if !strings.Contains(cmdStr2, "対象ノート: /path/to/note.md") {
		t.Errorf("expected command to replace {file} with actual path, got: %s", cmdStr2)
	}
}


