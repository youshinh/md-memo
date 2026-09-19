package slotagent

import (
	"strings"
	"testing"
)

func TestParseAgentConfigFile_YAML(t *testing.T) {
	yamlStr := `
version: 2
default_agent: custom-agent
timeout_seconds: 60
agents:
  custom-agent:
    command: "my-cli"
    args:
      - "--prompt"
      - "{instruction}"
    description: "Custom AI CLI"
slot_profiles:
  - trigger_open: "<<"
    trigger_close: ">>"
    name: "fast-code"
    agent: "custom-agent"
    system_instruction: "Output only code."
`
	cfg, err := ParseAgentConfigFile([]byte(yamlStr), ".yaml")
	if err != nil {
		t.Fatalf("unexpected error parsing YAML: %v", err)
	}

	if cfg.DefaultAgent != "custom-agent" {
		t.Errorf("expected default_agent 'custom-agent', got '%s'", cfg.DefaultAgent)
	}
	if cfg.TimeoutSeconds != 60 {
		t.Errorf("expected timeout_seconds 60, got %d", cfg.TimeoutSeconds)
	}
	if def, ok := cfg.Agents["custom-agent"]; !ok || def.Command != "my-cli" {
		t.Errorf("expected custom-agent command 'my-cli', got '%v'", def)
	}
	if len(cfg.SlotProfiles) == 0 || cfg.SlotProfiles[0].TriggerOpen != "<<" {
		t.Errorf("expected slot profile '<<', got %v", cfg.SlotProfiles)
	}
}

func TestParseAgentConfigFile_JSON(t *testing.T) {
	jsonStr := `{
		"version": 2,
		"default_agent": "hermes",
		"timeout_seconds": 120
	}`

	cfg, err := ParseAgentConfigFile([]byte(jsonStr), ".json")
	if err != nil {
		t.Fatalf("unexpected error parsing JSON: %v", err)
	}

	if cfg.DefaultAgent != "hermes" {
		t.Errorf("expected default_agent 'hermes', got '%s'", cfg.DefaultAgent)
	}
	if cfg.TimeoutSeconds != 120 {
		t.Errorf("expected timeout_seconds 120, got %d", cfg.TimeoutSeconds)
	}
	// Defaults should be complemented
	if _, ok := cfg.Agents["claude-code"]; !ok {
		t.Errorf("expected claude-code to be complemented in default agents")
	}
}

func TestParseAgentConfigFile_Markdown(t *testing.T) {
	mdStr := `# Agent Configurations for MD-Memo

Here is the configuration for our team agents:

` + "```yaml" + `
version: 2
default_agent: agy
timeout_seconds: 300
agents:
  agy:
    command: "agy"
    args:
      - "exec"
      - "--file"
      - "{file}"
    description: "Antigravity Agent"
` + "```" + `

Please do not modify outside code fence.
`

	cfg, err := ParseAgentConfigFile([]byte(mdStr), ".md")
	if err != nil {
		t.Fatalf("unexpected error parsing Markdown: %v", err)
	}

	if cfg.DefaultAgent != "agy" {
		t.Errorf("expected default_agent 'agy', got '%s'", cfg.DefaultAgent)
	}
	if cfg.TimeoutSeconds != 300 {
		t.Errorf("expected timeout_seconds 300, got %d", cfg.TimeoutSeconds)
	}
}

func TestGenerateDefaultAgentsYAML_Roundtrip(t *testing.T) {
	generatedYAML := GenerateDefaultAgentsYAML()
	if !strings.Contains(generatedYAML, "claude-code") {
		t.Fatalf("expected generated YAML to contain 'claude-code'")
	}
	if !strings.Contains(generatedYAML, "{instruction}") {
		t.Fatalf("expected generated YAML to contain placeholder guidance '{instruction}'")
	}

	cfg, err := ParseAgentConfigFile([]byte(generatedYAML), ".yaml")
	if err != nil {
		t.Fatalf("failed to roundtrip parse generated YAML: %v", err)
	}

	if cfg.DefaultAgent != "claude-code" {
		t.Errorf("expected default_agent 'claude-code', got '%s'", cfg.DefaultAgent)
	}
	if len(cfg.Agents) < 4 {
		t.Errorf("expected at least 4 agents, got %d", len(cfg.Agents))
	}
	if len(cfg.SlotProfiles) < 4 {
		t.Errorf("expected at least 4 slot profiles, got %d", len(cfg.SlotProfiles))
	}
}

func TestGenerateDefaultAgentsMarkdown_Roundtrip(t *testing.T) {
	generatedMD := GenerateDefaultAgentsMarkdown()
	if !strings.Contains(generatedMD, "```yaml") {
		t.Fatalf("expected generated Markdown to contain yaml fence")
	}

	cfg, err := ParseAgentConfigFile([]byte(generatedMD), ".md")
	if err != nil {
		t.Fatalf("failed to parse generated Markdown: %v", err)
	}

	if cfg.DefaultAgent != "claude-code" {
		t.Errorf("expected default_agent 'claude-code', got '%s'", cfg.DefaultAgent)
	}
}
