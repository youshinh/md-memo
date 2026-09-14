package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"sync/atomic"
	"time"

	"md-memo/pkg/llm"
)

var codeBlockRegex = regexp.MustCompile("(?s)```(?:[a-zA-Z0-9_-]+)?\\s*\n?(.*?)\\s*```")

// CliValidationResult holds safety audit info about a CLI command.
type CliValidationResult struct {
	IsSafe    bool   `json:"isSafe"`
	IsWarning bool   `json:"isWarning"`
	IsBlocked bool   `json:"isBlocked"`
	Reason    string `json:"reason"`
	RiskLevel string `json:"riskLevel"` // "safe", "warning", "blocked"
}

// Highly destructive patterns that MUST BE BLOCKED unconditionally.
var blockedCliPatterns = []*regexp.Regexp{
	// Windows drive formatting / disk wiping
	regexp.MustCompile(`(?i)\bformat\s+[a-z]:`),
	regexp.MustCompile(`(?i)\bdiskpart\b`),
	// Unix root / home wipe: rm -rf / or rm -rf /* or rm -rf ~
	regexp.MustCompile(`(?i)\brm\s+-[a-z]*r[a-z]*f[a-z]*\s+.*(/|/\*|~|~\*)($|\s)`),
	regexp.MustCompile(`(?i)\brm\s+-[a-z]*f[a-z]*r[a-z]*\s+.*(/|/\*|~|~\*)($|\s)`),
	regexp.MustCompile(`(?i)\bmkfs\b`),
	regexp.MustCompile(`(?i)\bdd\s+if=.*of=/dev/(sd[a-z]|nvme|hd[a-z]|disk)`),
	// Fork bomb patterns
	regexp.MustCompile(`:\(\)\s*\{\s*:\|:&\s*\};:`),
	regexp.MustCompile(`(?i)%0\|%0`),
	// Root chmod
	regexp.MustCompile(`(?i)\bchmod\s+-[a-z]*R\s+777\s+/`),
	// Windows registry destructive deletes
	regexp.MustCompile(`(?i)\breg\s+delete\s+hk(lm|cr|u)\b`),
}

// Suspicious / high-impact operations that warrant an explicit user warning dialog.
var warningCliPatterns = []struct {
	pattern *regexp.Regexp
	reason  string
}{
	{
		pattern: regexp.MustCompile(`(?i)\b(shutdown|Stop-Computer|Restart-Computer)\b`),
		reason:  "システム終了・再起動の可能性があります (System power state change)",
	},
	{
		pattern: regexp.MustCompile(`(?i)\b(Remove-Item|rm|del|rmdir|rd)\b.*(-r|-Recurse|/s)`),
		reason:  "再帰的なファイル・フォルダ削除の可能性があります (Recursive file deletion)",
	},
	{
		pattern: regexp.MustCompile(`(?i)\b(del|erase)\s+/[fqs]`),
		reason:  "強制・一括ファイル削除の可能性があります (Batch file deletion)",
	},
	{
		pattern: regexp.MustCompile(`(?i)\b(drop\s+database|truncate\s+table)\b`),
		reason:  "データベースの破壊・全消去の可能性があります (Database drop/truncate)",
	},
	{
		pattern: regexp.MustCompile(`(?i)\b(ssh|telnet|ftp)\b`),
		reason:  "対話型セッションのため完了せずハングする可能性があります (Interactive remote shell)",
	},
	{
		pattern: regexp.MustCompile(`(?i)\b(nano|vim?|vi|pico)\b`),
		reason:  "対話型テキストエディタのためハングする可能性があります (Interactive text editor)",
	},
}

var gitCommitRegex = regexp.MustCompile(`(?i)\bgit\s+commit\b`)
var gitCommitMsgRegex = regexp.MustCompile(`(?i)\bgit\s+commit\b.*-[a-z]*m`)

// validateCliCommand inspects command syntax for safety before execution.
func validateCliCommand(cmdStr string) CliValidationResult {
	trimmed := strings.TrimSpace(cmdStr)
	if trimmed == "" {
		return CliValidationResult{
			IsSafe:    false,
			IsWarning: false,
			IsBlocked: true,
			Reason:    "コマンドが空です (Empty command)",
			RiskLevel: "blocked",
		}
	}

	// 1. Check blocked patterns (Strict safety wall)
	for _, p := range blockedCliPatterns {
		if p.MatchString(trimmed) {
			return CliValidationResult{
				IsSafe:    false,
				IsWarning: false,
				IsBlocked: true,
				Reason:    "重大なシステム破壊を引き起こす可能性があるためブロックされました (Blocked dangerous command)",
				RiskLevel: "blocked",
			}
		}
	}

	// 2. Check warning patterns
	for _, item := range warningCliPatterns {
		if item.pattern.MatchString(trimmed) {
			return CliValidationResult{
				IsSafe:    false,
				IsWarning: true,
				IsBlocked: false,
				Reason:    item.reason,
				RiskLevel: "warning",
			}
		}
	}

	// Special check for git commit without -m
	if gitCommitRegex.MatchString(trimmed) && !gitCommitMsgRegex.MatchString(trimmed) {
		return CliValidationResult{
			IsSafe:    false,
			IsWarning: true,
			IsBlocked: false,
			Reason:    "対話型エディタが起動しハングする可能性があります (Interactive git commit)",
			RiskLevel: "warning",
		}
	}

	return CliValidationResult{
		IsSafe:    true,
		IsWarning: false,
		IsBlocked: false,
		Reason:    "",
		RiskLevel: "safe",
	}
}

// cleanGeneratedCliCommand strips markdown blocks, backticks, leading prompts ($ or >),
// and extra whitespace to extract a clean, executable single/multi-line command string.
func cleanGeneratedCliCommand(raw string) string {
	str := strings.TrimSpace(raw)

	// Check for fenced code blocks ```...```
	matches := codeBlockRegex.FindStringSubmatch(str)
	if len(matches) > 1 {
		str = strings.TrimSpace(matches[1])
	} else {
		// If wrapped in single backticks
		if strings.HasPrefix(str, "`") && strings.HasSuffix(str, "`") && len(str) >= 2 {
			str = strings.TrimSpace(strings.Trim(str, "`"))
		}
	}

	lines := strings.Split(str, "\n")
	var cleanedLines []string
	for _, l := range lines {
		trimmed := strings.TrimSpace(l)
		if trimmed == "" {
			continue
		}
		// Strip common shell prompt prefixes: "$ ", "> ", "% "
		if strings.HasPrefix(trimmed, "$ ") {
			trimmed = strings.TrimSpace(trimmed[2:])
		} else if strings.HasPrefix(trimmed, "> ") {
			trimmed = strings.TrimSpace(trimmed[2:])
		} else if strings.HasPrefix(trimmed, "% ") {
			trimmed = strings.TrimSpace(trimmed[2:])
		}
		cleanedLines = append(cleanedLines, trimmed)
	}

	return strings.Join(cleanedLines, "\n")
}

// CliContextMeta contains local execution metadata passed to CLI generator.
type CliContextMeta struct {
	AppDir   string `json:"appDir"`
	FilePath string `json:"filePath"`
	FileDir  string `json:"fileDir"`
	FileName string `json:"fileName"`
}

// buildCliGeneratorPrompt prepares system instructions and user prompt for CLI command generation with contextual variables.
func buildCliGeneratorPrompt(osType, userReq string, meta ...CliContextMeta) (string, string) {
	sysPrompt := fmt.Sprintf(`You are a concise command-line expert generator for %s.
Your sole job is to translate the user's natural language request into a single executable shell command or script pipeline.
Rules:
1. Output ONLY the raw executable command inside a single markdown code block or as pure text.
2. Do NOT provide explanations, conversational text, introductions, or apologies.
3. Make sure the command runs safely and natively on %s.
4. Output should write standard output to stdout without interactive input prompts if possible.
5. NEVER generate system-wiping or destructive commands (like formatting drives or recursive root deletions).`, osType, osType)

	var contextLines []string
	if len(meta) > 0 {
		m := meta[0]
		if m.FilePath != "" {
			contextLines = append(contextLines, fmt.Sprintf("- Active File Path: %s", m.FilePath))
		}
		if m.FileDir != "" {
			contextLines = append(contextLines, fmt.Sprintf("- Active File Directory: %s", m.FileDir))
		}
		if m.FileName != "" {
			contextLines = append(contextLines, fmt.Sprintf("- Active File Name: %s", m.FileName))
		}
		if m.AppDir != "" {
			contextLines = append(contextLines, fmt.Sprintf("- Application Working Directory: %s", m.AppDir))
		}
	}

	userPrompt := ""
	if len(contextLines) > 0 {
		userPrompt = fmt.Sprintf("Local Environment Variables & Context:\n%s\n\nTranslate this request into an executable command:\n%s", strings.Join(contextLines, "\n"), userReq)
	} else {
		userPrompt = fmt.Sprintf("Translate this request into an executable command:\n%s", userReq)
	}

	return sysPrompt, userPrompt
}

// GenerateCliCommandAsync translates natural language instructions into an OS shell command using configured LLM.
func (a *App) GenerateCliCommandAsync(reqID, userReq, configJSON, contextJSON string) {
	go func() {
		var cfg llm.Config
		_ = json.Unmarshal([]byte(configJSON), &cfg)

		var meta CliContextMeta
		if contextJSON != "" {
			_ = json.Unmarshal([]byte(contextJSON), &meta)
		}

		// Ensure AppDir is filled if empty
		if meta.AppDir == "" {
			if exePath, err := os.Executable(); err == nil {
				meta.AppDir = filepath.Dir(exePath)
			}
		}

		osType := "Windows (PowerShell / cmd)"
		if runtime.GOOS == "darwin" {
			osType = "macOS (zsh / bash)"
		} else if runtime.GOOS == "linux" {
			osType = "Linux (bash)"
		}

		sysPrompt, prompt := buildCliGeneratorPrompt(osType, userReq, meta)
		cfg.SystemPrompt = sysPrompt
		if cfg.Temperature <= 0 {
			cfg.Temperature = 0.2 // Lower temperature for accurate CLI syntax
		}

		if llm.IsOllamaURL(cfg.BaseURL) && !llm.CheckOllamaHealth(cfg.BaseURL) {
			_ = a.EnsureOllamaRunning(6 * time.Second)
		}

		rawResp, err := llm.Query(prompt, cfg)
		if atomic.LoadInt32(&a.isDestroyed) != 0 {
			return
		}

		cleanedCmd := ""
		errMsg := ""
		valResult := CliValidationResult{IsSafe: true, RiskLevel: "safe"}

		if err != nil {
			errMsg = err.Error()
		} else {
			cleanedCmd = cleanGeneratedCliCommand(rawResp)
			if cleanedCmd == "" {
				errMsg = "No command could be generated from the prompt."
			} else {
				valResult = validateCliCommand(cleanedCmd)
			}
		}

		cmdJSON, _ := json.Marshal(cleanedCmd)
		errJSON, _ := json.Marshal(errMsg)
		valJSON, _ := json.Marshal(valResult)

		if a.w != nil {
			a.w.Dispatch(func() {
				if atomic.LoadInt32(&a.isDestroyed) == 0 {
					js := fmt.Sprintf("if (window.__onCliCommandGenerated) { window.__onCliCommandGenerated(%q, %s, %s, %s); }", reqID, string(cmdJSON), string(errJSON), string(valJSON))
					a.w.Eval(js)
				}
			})
		}
	}()
}

// ValidateCliCommandRPC allows frontend to validate any manually typed CLI command before execution.
func (a *App) ValidateCliCommand(cmdStr string) (*CliValidationResult, error) {
	res := validateCliCommand(cmdStr)
	return &res, nil
}
