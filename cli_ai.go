package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"md-memo/pkg/jev"
	"md-memo/pkg/llm"
)

// The three patterns below clean up what an LLM returns for the AI CLI bar. They are compiled on first
// use, not at start-up: most sessions never ask the AI CLI for a command.
var codeBlockRegex = sync.OnceValue(func() *regexp.Regexp {
	return regexp.MustCompile("(?s)```(?:[a-zA-Z0-9_-]+)?\\s*\n?(.*?)\\s*```")
})

var shellHeaderOnlyRegex = sync.OnceValue(func() *regexp.Regexp {
	return regexp.MustCompile(`(?i)^(powershell(\.exe)?|pwsh(\.exe)?|cmd(\.exe)?|bash|sh|zsh|shell|console|terminal):?$`)
})

var shellPrefixNonFlagRegex = sync.OnceValue(func() *regexp.Regexp {
	return regexp.MustCompile(`(?i)^(?:powershell|pwsh|bash|sh)\s+([^-/].*)$`)
})

// CliValidationResult holds safety audit info about a CLI command.
type CliValidationResult struct {
	IsSafe    bool   `json:"isSafe"`
	IsWarning bool   `json:"isWarning"`
	IsBlocked bool   `json:"isBlocked"`
	Reason    string `json:"reason"`
	RiskLevel string `json:"riskLevel"` // "safe", "warning", "blocked"
}

// validateCliCommand inspects command syntax for safety before execution. It is the reviewed-mode
// verdict of the shared guard (jev.VerifyCommand): the pattern block list, the deterministic AST
// guardrail and the confirmation-level warnings all live there, so this gate, `md-memo jev verify` and
// the hook runner cannot disagree about a command.
//
// Tiering on this path (the user reviews the command before it runs):
//   - disk-level destructive commands (mkfs, dd, wipefs, fdisk, ...)  -> blocked
//   - a plain rm, or a redirect into a system directory               -> warning (confirm dialog)
//   - unquoted variable expansion                                     -> not applied; it would reject
//     ordinary one-liners such as `for f in *.txt; do echo $f; done`
//
// Quick Actions (one-click execution) use the strict mode instead.
func validateCliCommand(cmdStr string) CliValidationResult {
	v := jev.VerifyCommand(cmdStr, jev.ModeReviewed, nil)
	switch v.Level {
	case jev.LevelBlock:
		return CliValidationResult{IsBlocked: true, Reason: v.Reason, RiskLevel: "blocked"}
	case jev.LevelWarn:
		return CliValidationResult{IsWarning: true, Reason: v.Reason, RiskLevel: "warning"}
	}
	return CliValidationResult{IsSafe: true, RiskLevel: "safe"}
}

// cleanGeneratedCliCommand strips markdown blocks, backticks, leading prompts ($ or >),
// standalone shell names (like 'powershell' or 'bash'), and extra whitespace to extract
// a clean, executable single/multi-line command string.
func cleanGeneratedCliCommand(raw string) string {
	str := strings.TrimSpace(raw)
	str = strings.ReplaceAll(str, "\r\n", "\n")

	// Check for fenced code blocks ```...```
	matches := codeBlockRegex().FindStringSubmatch(str)
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

	// Strip leading standalone shell names (e.g. "powershell\nNew-Item ...")
	for len(cleanedLines) > 1 && shellHeaderOnlyRegex().MatchString(cleanedLines[0]) {
		cleanedLines = cleanedLines[1:]
	}

	// If single line starts with "powershell <command>" without flags (e.g. "powershell New-Item ...")
	if len(cleanedLines) > 0 {
		if m := shellPrefixNonFlagRegex().FindStringSubmatch(cleanedLines[0]); len(m) > 1 {
			cleanedLines[0] = strings.TrimSpace(m[1])
		}
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

// cliGeneratorOSType returns the OS description the CLI generator prompt tells the LLM to
// target, given a runtime.GOOS value. Extracted so a Windows `go test` run can exercise the
// darwin/linux branches directly.
func cliGeneratorOSType(goos string) string {
	switch goos {
	case "darwin":
		return "macOS (zsh / bash)"
	case "linux":
		return "Linux (bash)"
	default:
		return "Windows (PowerShell / cmd)"
	}
}

// buildCliGeneratorPrompt prepares system instructions and user prompt for CLI command generation with contextual variables.
func buildCliGeneratorPrompt(osType, userReq string, meta ...CliContextMeta) (string, string) {
	sysPrompt := fmt.Sprintf(`You are a concise command-line expert generator for %s.
Your sole job is to translate the user's natural language request into a single executable shell command or script pipeline.
Rules:
1. Output ONLY the raw executable command inside a single markdown code block or as pure text.
2. Do NOT provide explanations, conversational text, introductions, or apologies.
3. Do NOT include shell names, language headers, or wrappers (such as "powershell", "pwsh", "cmd", "bash", "sh") on their own line or before the command. Output only the pure command itself.
4. Make sure the command runs safely and natively on %s.
5. Output should write standard output to stdout without interactive input prompts if possible.
6. If the command operates on piped standard input on Windows PowerShell, use '$input | ...' or pipable syntax.
7. NEVER generate system-wiping or destructive commands (like formatting drives or recursive root deletions).`, osType, osType)

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

		sysPrompt, prompt := buildCliGeneratorPrompt(cliGeneratorOSType(runtime.GOOS), userReq, meta)
		if strings.TrimSpace(cfg.SystemPrompt) != "" {
			cfg.SystemPrompt = sysPrompt + "\n\nUser Custom Instruction:\n" + strings.TrimSpace(cfg.SystemPrompt)
		} else {
			cfg.SystemPrompt = sysPrompt
		}
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

		js := fmt.Sprintf("if (window.__onCliCommandGenerated) { window.__onCliCommandGenerated(%q, %s, %s, %s); }", reqID, string(cmdJSON), string(errJSON), string(valJSON))
		a.dispatchEval(js)
	}()
}

// ValidateCliCommandRPC allows frontend to validate any manually typed CLI command before execution.
func (a *App) ValidateCliCommand(cmdStr string) (*CliValidationResult, error) {
	res := validateCliCommand(cmdStr)
	return &res, nil
}
