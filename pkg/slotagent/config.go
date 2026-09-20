package slotagent

import (
	"encoding/json"
)

// AgentDef represents the CLI execution configuration for an external AI agent.
type AgentDef struct {
	Command     string   `json:"command" yaml:"command"`
	Args        []string `json:"args" yaml:"args"`
	Description string   `json:"description" yaml:"description"`
}

// SlotProfile defines a syntax delimiter pair mapped to a default agent and instruction.
type SlotProfile struct {
	TriggerOpen       string `json:"trigger_open" yaml:"trigger_open"`
	TriggerClose      string `json:"trigger_close" yaml:"trigger_close"`
	Name              string `json:"name" yaml:"name"`
	Agent             string `json:"agent" yaml:"agent"`
	SystemInstruction string `json:"system_instruction" yaml:"system_instruction"`
}

// Recipe defines a multi-step sequential or self-refining agent pipeline.
type Recipe struct {
	TriggerOpen          string   `json:"trigger_open" yaml:"trigger_open"`
	TriggerClose         string   `json:"trigger_close" yaml:"trigger_close"`
	Name                 string   `json:"name" yaml:"name"`
	Description          string   `json:"description" yaml:"description"`
	Steps                []string `json:"steps" yaml:"steps"`
	RequiresApprovalStep int      `json:"requires_approval_step" yaml:"requires_approval_step"`
	SelfRefine           bool     `json:"self_refine" yaml:"self_refine"`
}

// SlotConfig holds the complete configuration conforming to spec v2.2.0.
type SlotConfig struct {
	Version             int                 `json:"version" yaml:"version"`
	DefaultAgent        string              `json:"default_agent" yaml:"default_agent"`
	TimeoutSeconds      int                 `json:"timeout_seconds" yaml:"timeout_seconds"`
	HoverPeekEnabled    bool                `json:"hover_peek_enabled" yaml:"hover_peek_enabled"`
	GhostDiffDurationMs int                 `json:"ghost_diff_duration_ms" yaml:"ghost_diff_duration_ms"`
	Agents              map[string]AgentDef `json:"agents" yaml:"agents"`
	SlotProfiles        []SlotProfile       `json:"slot_profiles" yaml:"slot_profiles"`
	Recipes             []Recipe            `json:"recipes" yaml:"recipes"`
}

// DefaultSlotConfig returns the default slot agent configuration per spec v2.2.0.
func DefaultSlotConfig() SlotConfig {
	return SlotConfig{
		Version:             2,
		DefaultAgent:        "claude-code",
		TimeoutSeconds:      180,
		HoverPeekEnabled:    true,
		GhostDiffDurationMs: 4000,
		Agents: map[string]AgentDef{
			"claude-code": {
				Command:     "claude",
				Args:        []string{"--file", "{file}", "--prompt", "{instruction}"},
				Description: "Claude Code (高知能・CLI操作・Web調査)",
			},
			"hermes": {
				Command:     "ollama",
				Args:        []string{"run", "hermes3", "{instruction}"},
				Description: "Hermes 3 (完全ローカル・機密保護)",
			},
			"codex": {
				Command:     "codex",
				Args:        []string{"--execute", "--file", "{file}"},
				Description: "Codex (高速コード補完・リファクタリング)",
			},
			"agy": {
				Command:     "agy",
				Args:        []string{"-p", "対象ノート: {file}\n指示: {instruction}", "--dangerously-skip-permissions"},
				Description: "Google Antigravity 2.0 (自律リポジトリ開発)",
			},
		},
		SlotProfiles: []SlotProfile{
			{
				TriggerOpen:       "{{",
				TriggerClose:      "}}",
				Name:              "code",
				Agent:             "claude-code",
				SystemInstruction: "前置きや挨拶を一切省き、そのまま動くコードブロックのみを出力してください。",
			},
			{
				TriggerOpen:       "[?",
				TriggerClose:      "]",
				Name:              "research",
				Agent:             "claude-code",
				SystemInstruction: "Web検索を行い、客観的な数値と一次ソースURLを併記して簡潔に回答してください。",
			},
			{
				TriggerOpen:       "【?",
				TriggerClose:      "】",
				Name:              "writing",
				Agent:             "hermes",
				SystemInstruction: "外部通信を行わず、論理的で分かりやすいビジネス日本語の箇条書きに整形してください。",
			},
			{
				TriggerOpen:       "[!",
				TriggerClose:      "!]",
				Name:              "adversarial",
				Agent:             "claude-code",
				SystemInstruction: "甘口の肯定を排し、潜在的リスク、セキュリティ脆弱性、ボトルネックを3点指摘してください。",
			},
		},
		Recipes: []Recipe{
			{
				TriggerOpen:  "[>>",
				TriggerClose: "]",
				Name:         "deep-research-and-code",
				Description:  "Web調査 -> リスク反証 -> 実装コード生成",
				Steps: []string{
					"Web検索ツールを用いて最新の公式仕様とベストプラクティスを調査する",
					"調査結果に基づき、潜在的な移行リスクと破壊的変更を指摘する",
					"上記を踏まえ、完全なGoコードを生成する",
				},
				RequiresApprovalStep: 2,
				SelfRefine:           true,
			},
		},
	}
}

// MergeSlotConfig parses a full config.json string and extracts SlotConfig,
// filling in defaults for any missing fields.
func MergeSlotConfig(rawJSON string) SlotConfig {
	defaultCfg := DefaultSlotConfig()
	if rawJSON == "" {
		return defaultCfg
	}

	var parsed SlotConfig
	_ = json.Unmarshal([]byte(rawJSON), &parsed)

	if parsed.Version <= 0 {
		parsed.Version = defaultCfg.Version
	}
	if parsed.DefaultAgent == "" {
		parsed.DefaultAgent = defaultCfg.DefaultAgent
	}
	if parsed.TimeoutSeconds <= 0 {
		parsed.TimeoutSeconds = defaultCfg.TimeoutSeconds
	}
	if parsed.GhostDiffDurationMs <= 0 {
		parsed.GhostDiffDurationMs = defaultCfg.GhostDiffDurationMs
	}
	if parsed.Agents == nil || len(parsed.Agents) == 0 {
		parsed.Agents = defaultCfg.Agents
	}
	if len(parsed.SlotProfiles) == 0 {
		parsed.SlotProfiles = defaultCfg.SlotProfiles
	}
	if len(parsed.Recipes) == 0 {
		parsed.Recipes = defaultCfg.Recipes
	}

	return parsed
}
