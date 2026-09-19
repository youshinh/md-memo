package slotagent

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"gopkg.in/yaml.v3"
)

// ParseAgentConfigFile parses configuration bytes in YAML, JSON, or Markdown (with embedded code fence).
// It automatically detects the format if ext is empty, and safely falls back or complements with defaults.
func ParseAgentConfigFile(content []byte, ext string) (SlotConfig, error) {
	trimmed := strings.TrimSpace(string(content))
	if trimmed == "" {
		return DefaultSlotConfig(), nil
	}

	normExt := strings.ToLower(strings.TrimPrefix(ext, "."))

	// If Markdown, extract embedded code block (yaml, yml, or json)
	if normExt == "md" || normExt == "markdown" || strings.HasPrefix(trimmed, "#") || strings.Contains(trimmed, "```") {
		extracted, detectedFormat := extractMarkdownCodeBlock(trimmed)
		if extracted != "" {
			trimmed = extracted
			if detectedFormat != "" {
				normExt = detectedFormat
			}
		}
	}

	var parsed SlotConfig
	var parseErr error

	// Try JSON first if extension says so or starts with '{'
	if normExt == "json" || (normExt == "" && strings.HasPrefix(trimmed, "{")) {
		if err := json.Unmarshal([]byte(trimmed), &parsed); err == nil {
			return complementSlotConfig(parsed), nil
		} else {
			parseErr = err
		}
	}

	// Try YAML (YAML is a superset of JSON, handles comments, and is the primary format)
	if err := yaml.Unmarshal([]byte(trimmed), &parsed); err == nil {
		if parsed.Version > 0 || len(parsed.Agents) > 0 || len(parsed.SlotProfiles) > 0 {
			return complementSlotConfig(parsed), nil
		}
	} else if parseErr == nil {
		parseErr = err
	}

	// If both failed, return error with context
	if parseErr != nil {
		return DefaultSlotConfig(), fmt.Errorf("設定ファイルの構文解析に失敗しました: %w", parseErr)
	}

	return complementSlotConfig(parsed), nil
}

// extractMarkdownCodeBlock searches for ```yaml, ```yml, or ```json blocks in a markdown string.
func extractMarkdownCodeBlock(md string) (string, string) {
	yamlRe := regexp.MustCompile("(?s)```(?:yaml|yml)\\r?\\n(.*?)\\r?\\n```")
	if m := yamlRe.FindStringSubmatch(md); len(m) > 1 {
		return strings.TrimSpace(m[1]), "yaml"
	}

	jsonRe := regexp.MustCompile("(?s)```json\\r?\\n(.*?)\\r?\\n```")
	if m := jsonRe.FindStringSubmatch(md); len(m) > 1 {
		return strings.TrimSpace(m[1]), "json"
	}

	// Plain code fence containing "version:" or "agents:"
	plainRe := regexp.MustCompile("(?s)```\\r?\\n(.*?)\\r?\\n```")
	matches := plainRe.FindAllStringSubmatch(md, -1)
	for _, m := range matches {
		if len(m) > 1 {
			content := strings.TrimSpace(m[1])
			if strings.Contains(content, "agents:") || strings.Contains(content, "slot_profiles:") {
				return content, "yaml"
			}
		}
	}

	return "", ""
}

// complementSlotConfig fills in default values for zero or missing fields.
func complementSlotConfig(parsed SlotConfig) SlotConfig {
	defaultCfg := DefaultSlotConfig()

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
		// Ensure default essential agents exist if not overridden
		for k, v := range defaultCfg.Agents {
			if _, exists := parsed.Agents[k]; !exists {
				parsed.Agents[k] = v
			}
		}
	}
	if len(parsed.SlotProfiles) == 0 {
		parsed.SlotProfiles = defaultCfg.SlotProfiles
	}
	if len(parsed.Recipes) == 0 {
		parsed.Recipes = defaultCfg.Recipes
	}

	return parsed
}

// FindAgentConfigFile searches for an external agent configuration file across standard locations.
// Search order:
// 1. {scrapDir}/.md-memo/agents.yaml (.yml, .md, .json)
// 2. {UserConfigDir}/md-memo/agents.yaml (.yml, .md, .json)
func FindAgentConfigFile(scrapDir string) string {
	candidates := make([]string, 0, 8)

	if scrapDir != "" {
		memoDir := filepath.Join(scrapDir, ".md-memo")
		candidates = append(candidates,
			filepath.Join(memoDir, "agents.yaml"),
			filepath.Join(memoDir, "agents.yml"),
			filepath.Join(memoDir, "agents.md"),
			filepath.Join(memoDir, "agents.json"),
		)
	}

	configDir, err := os.UserConfigDir()
	if err == nil && configDir != "" {
		appDir := filepath.Join(configDir, "md-memo")
		candidates = append(candidates,
			filepath.Join(appDir, "agents.yaml"),
			filepath.Join(appDir, "agents.yml"),
			filepath.Join(appDir, "agents.md"),
			filepath.Join(appDir, "agents.json"),
		)
	}

	for _, p := range candidates {
		if fi, err := os.Stat(p); err == nil && !fi.IsDir() {
			return p
		}
	}

	return ""
}

// GetDefaultAgentConfigPath returns the canonical path where the global agents.yaml should reside.
func GetDefaultAgentConfigPath() string {
	configDir, err := os.UserConfigDir()
	if err != nil || configDir == "" {
		configDir = "."
	}
	return filepath.Join(configDir, "md-memo", "agents.yaml")
}

// GenerateDefaultAgentsYAML generates a beautifully formatted, highly commented YAML configuration.
// It includes explicit rules and instructions for AI coding agents (Claude Code, Codex, Antigravity, Aider, etc.)
// to edit and extend safely without syntax errors or hallucination.
func GenerateDefaultAgentsYAML() string {
	return `# ==============================================================================
# MD-Memo 自律AIエージェント＆スロット連携 設定ファイル (agents.yaml)
# Version: 2 (Specification v2.2.0-aligned)
# ==============================================================================
#
# 【AIコーディングエージェント（Claude Code, Codex, Antigravity, Hermes等）への編集指示】
# ------------------------------------------------------------------------------
# あなたがこのファイルを読み書き・修正・追加する際は、以下のルールを厳守してください:
#
# 1. プレースホルダー規則 (Placeholders):
#    - "{instruction}" : ユーザーがスロット内に記述したプロンプト・指示に置換されます。(必須)
#    - "{file}"        : 現在アクティブなMarkdownノートの絶対パスに置換されます。
#    - args リスト内に "{instruction}" または "{file}" を必ず含めてください。
#
# 2. スロット構文の区切り文字規則 (Delimiter Rules):
#    - trigger_open / trigger_close は Markdown 標準構文（#、*、- 等）と衝突しない
#      ユニークな記号ペアを指定してください。(例: "{{", "}}", "[?", "]", "【?", "】")
#
# 3. 承認ゲート規則 (Human Approval Gates):
#    - レシピ (recipes) の multi-step 実行で危険な操作（git push, rm, DB変更等）を伴う場合は、
#      requires_approval_step にステップ番号（1-indexed）を指定してください。
#      エディタ内に "- [ ]" チェックボックスが挿入され、ユーザーが承認するまでサスペンドします。
#
# 4. 文字コード: 必ず UTF-8 (BOMなし) で保存してください。
# ==============================================================================

version: 2
default_agent: claude-code
timeout_seconds: 180
hover_peek_enabled: true
ghost_diff_duration_ms: 4000

# ------------------------------------------------------------------------------
# 1. エージェントCLI定義 (Agents)
#    OSのターミナル/シェルから実行可能なコマンドと引数を定義します。
# ------------------------------------------------------------------------------
agents:
  claude-code:
    command: "claude"
    args:
      - "--file"
      - "{file}"
      - "--prompt"
      - "{instruction}"
    description: "Claude Code (高知能・自律CLI操作・Web調査・コーディング)"

  hermes:
    command: "ollama"
    args:
      - "run"
      - "hermes3"
      - "{instruction}"
    description: "Hermes 3 (完全ローカル・機密保護・オフライン実行)"

  codex:
    command: "codex"
    args:
      - "--execute"
      - "--file"
      - "{file}"
    description: "Codex CLI (高速コード補完・リファクタリング)"

  agy:
    command: "agy"
    args:
      - "-p"
      - "{instruction}"
      - "--dangerously-skip-permissions"
    description: "Google Antigravity 2.0 (自律リポジトリ開発・検証駆動)"

# ------------------------------------------------------------------------------
# 2. スロットプロファイル定義 (Slot Profiles)
#    ノート本文中の特定デリミタ記号を検知し、対応するエージェントへルーティングします。
# ------------------------------------------------------------------------------
slot_profiles:
  - trigger_open: "{{"
    trigger_close: "}}"
    name: "code"
    agent: "claude-code"
    system_instruction: "前置きや挨拶を一切省き、そのまま動くコードブロックのみを出力してください。"

  - trigger_open: "[?"
    trigger_close: "]"
    name: "research"
    agent: "claude-code"
    system_instruction: "Web検索を行い、客観的な数値と一次ソースURLを併記して簡潔に回答してください。"

  - trigger_open: "【?"
    trigger_close: "】"
    name: "writing"
    agent: "hermes"
    system_instruction: "外部通信を行わず、論理的で分かりやすいビジネス日本語の箇条書きに整形してください。"

  - trigger_open: "[!"
    trigger_close: "!]"
    name: "adversarial"
    agent: "claude-code"
    system_instruction: "甘口の肯定を排し、潜在的リスク、セキュリティ脆弱性、ボトルネックを3点指摘してください。"

# ------------------------------------------------------------------------------
# 3. パイプラインレシピ定義 (Recipes)
#    複数のステップを順次実行し、Document as State で自己改善ループを回す高度な設定です。
# ------------------------------------------------------------------------------
recipes:
  - trigger_open: "[>>"
    trigger_close: "]"
    name: "deep-research-and-code"
    description: "Web調査 -> リスク反証 -> 実装コード生成"
    steps:
      - "Web検索ツールを用いて最新の公式仕様とベストプラクティスを調査する"
      - "調査結果に基づき、潜在的な移行リスクと破壊的変更を指摘する"
      - "上記を踏まえ、完全なGo/TypeScriptコードを生成する"
    requires_approval_step: 2
    self_refine: true
`
}

// GenerateDefaultAgentsMarkdown generates an AGENTS.md document containing explanation
// and an embedded executable YAML configuration code block.
func GenerateDefaultAgentsMarkdown() string {
	yamlContent := GenerateDefaultAgentsYAML()
	var sb strings.Builder
	sb.WriteString("# MD-Memo: 自律AIエージェント設定仕様書 (AGENTS.md)\n\n")
	sb.WriteString("このドキュメントは、**MD-Memo** の自律AIエージェント連携設定ファイル兼マニュアルです。\n")
	sb.WriteString("本ファイル内の ```yaml コードブロックを編集して MD-Memo にインポートするか、\n")
	sb.WriteString("`.md-memo/agents.yaml` として保存することで、任意のCLIエージェントを追加・カスタマイズできます。\n\n")
	sb.WriteString("---\n\n")
	sb.WriteString("## 編集ガイドライン（AIエージェント＆人間共通）\n\n")
	sb.WriteString("- **エージェント追加**: `agents` 配下にコマンド名と引数を定義します。\n")
	sb.WriteString("  `{instruction}` はユーザー入力、`{file}` はアクティブなノートのパスに置換されます。\n")
	sb.WriteString("- **スロット追加**: `slot_profiles` に開始記号（`trigger_open`）と終了記号（`trigger_close`）を登録します。\n")
	sb.WriteString("- **承認ゲート**: パイプラインで破壊的操作を伴う場合は `requires_approval_step` を設定してください。\n\n")
	sb.WriteString("---\n\n")
	sb.WriteString("## 設定データ (YAML)\n\n")
	sb.WriteString("```yaml\n")
	sb.WriteString(yamlContent)
	sb.WriteString("\n```\n")
	return sb.String()
}
