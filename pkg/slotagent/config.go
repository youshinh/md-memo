package slotagent

import (
	"encoding/json"
)

// AgentDef represents the CLI execution configuration for an external AI agent.
type AgentDef struct {
	Command     string   `json:"command" yaml:"command"`
	Args        []string `json:"args" yaml:"args"`
	Description string   `json:"description" yaml:"description"`
	// Aliases are extra names accepted after "@" in a slot ({{ @claude ... }}), besides the
	// agents key itself. Compared case-insensitively.
	Aliases []string `json:"aliases,omitempty" yaml:"aliases,omitempty"`
	// AppendInstruction: when no argument holds "{instruction}", the instruction is added as the last argument
	// (nil or true, the behaviour since the start) or not at all (false). See AppendsInstruction.
	AppendInstruction *bool `json:"append_instruction,omitempty" yaml:"append_instruction,omitempty"`
	// Enabled: false switches the agent off (nil or true: on, the behaviour since the start). A disabled agent is left
	// out of the config every consumer sees (finalizeAgents), is never chosen and is never added back from the built-in
	// defaults; a run that names it says so (RunProblemFor). Same effect as listing its key under disabled_agents.
	Enabled *bool `json:"enabled,omitempty" yaml:"enabled,omitempty"`
}

// SnippetDef is a user-defined task/command template carried through to the frontend as is.
// Kind is one of llm|agent|command|text; the frontend owns the semantics and validation.
type SnippetDef struct {
	ID      string `json:"id" yaml:"id"`
	Label   string `json:"label" yaml:"label"`
	Kind    string `json:"kind" yaml:"kind"`
	Trigger string `json:"trigger,omitempty" yaml:"trigger,omitempty"`
	Body    string `json:"body" yaml:"body"`
	OS      string `json:"os,omitempty" yaml:"os,omitempty"`
	Agent   string `json:"agent,omitempty" yaml:"agent,omitempty"`
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
	Snippets            []SnippetDef        `json:"snippets" yaml:"snippets,omitempty"`
	// DisabledAgents lists agents (by key) that are switched off, besides those with enabled: false; both spellings
	// mean the same and are merged. On a finalised config (finalizeAgents) Agents no longer holds them and this is the
	// sorted list of their keys, kept on the wire so the page can say "disabled in agents.yaml" instead of "unknown".
	DisabledAgents []string `json:"disabled_agents,omitempty" yaml:"disabled_agents,omitempty"`
	// DefaultAgentDisabled is the disabled agent default_agent named, when DefaultAgent had to fall back to another one
	// (reported as the default-disabled agent issue). Derived, never read from a file and never sent.
	DefaultAgentDisabled string `json:"-" yaml:"-"`
}

// DefaultSlotConfig returns the default slot agent configuration per spec v2.2.0.
//
// The agents are kept identical in three places: here, the frontend default in frontend/js/slot_agent.js and the
// agents.yaml template in loader.go (tests/agent_defaults_parity_test.mjs and TestDefaultAgentsTemplateMatchesDefaults
// check it). Definitions shipped before are listed in legacyAgentDefaults (safety.go), so a user copy is reported.
// None of them skips the CLI's permission prompts. Not run on the maintainer's machine: claude -p (Claude Code's print
// mode, as reported by the maintainer), agy -p and codex exec (both listed by their --help, see
// skills/md-memo/references/setup-guide.md).
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
				Args:        []string{"-p", "対象ノート: {file}\n指示: {instruction}"},
				Description: "Claude Code (高知能・CLI操作・Web調査)",
				Aliases:     []string{"claude", "cc"},
			},
			"hermes": {
				Command:     "ollama",
				Args:        []string{"run", "hermes3", "{instruction}"},
				Description: "Hermes 3 (完全ローカル・機密保護)",
			},
			"codex": {
				Command:     "codex",
				Args:        []string{"exec", "{instruction}"},
				Description: "Codex (高速コード補完・リファクタリング)",
			},
			"agy": {
				Command:     "agy",
				Args:        []string{"-p", "対象ノート: {file}\n指示: {instruction}"},
				Description: "Google Antigravity 2.0 (自律リポジトリ開発)",
				Aliases:     []string{"antigravity", "gemini"},
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
		Snippets: []SnippetDef{},
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
	} else {
		fillDefaultAliases(parsed.Agents)
	}
	if len(parsed.SlotProfiles) == 0 {
		parsed.SlotProfiles = defaultCfg.SlotProfiles
	}
	if len(parsed.Recipes) == 0 {
		parsed.Recipes = defaultCfg.Recipes
	}
	if parsed.Snippets == nil {
		parsed.Snippets = []SnippetDef{}
	}

	return finalizeAgents(parsed, false)
}
