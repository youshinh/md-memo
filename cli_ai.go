package main

import (
	"encoding/json"
	"fmt"
	"regexp"
	"runtime"
	"strings"
	"sync/atomic"
	"time"

	"md-memo/pkg/llm"
)

var codeBlockRegex = regexp.MustCompile("(?s)```(?:[a-zA-Z0-9_-]+)?\\s*\n?(.*?)\\s*```")

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

// buildCliGeneratorPrompt prepares system instructions and user prompt for CLI command generation
func buildCliGeneratorPrompt(osType, userReq string) (string, string) {
	sysPrompt := fmt.Sprintf(`You are a concise command-line expert generator for %s.
Your sole job is to translate the user's natural language request into a single executable shell command or script pipeline.
Rules:
1. Output ONLY the raw executable command inside a single markdown code block or as pure text.
2. Do NOT provide explanations, conversational text, introductions, or apologies.
3. Make sure the command runs safely and natively on %s.
4. Output should write standard output to stdout without interactive input prompts if possible.`, osType, osType)

	userPrompt := fmt.Sprintf("Translate this request into an executable command:\n%s", userReq)
	return sysPrompt, userPrompt
}

// GenerateCliCommandAsync translates natural language instructions into an OS shell command using configured LLM.
func (a *App) GenerateCliCommandAsync(reqID, userReq, configJSON string) {
	go func() {
		var cfg llm.Config
		_ = json.Unmarshal([]byte(configJSON), &cfg)

		osType := "Windows (PowerShell / cmd)"
		if runtime.GOOS == "darwin" {
			osType = "macOS (zsh / bash)"
		} else if runtime.GOOS == "linux" {
			osType = "Linux (bash)"
		}

		sysPrompt, prompt := buildCliGeneratorPrompt(osType, userReq)
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
		if err != nil {
			errMsg = err.Error()
		} else {
			cleanedCmd = cleanGeneratedCliCommand(rawResp)
			if cleanedCmd == "" {
				errMsg = "No command could be generated from the prompt."
			}
		}

		cmdJSON, _ := json.Marshal(cleanedCmd)
		errJSON, _ := json.Marshal(errMsg)

		if a.w != nil {
			a.w.Dispatch(func() {
				if atomic.LoadInt32(&a.isDestroyed) == 0 {
					js := fmt.Sprintf("if (window.__onCliCommandGenerated) { window.__onCliCommandGenerated(%q, %s, %s); }", reqID, string(cmdJSON), string(errJSON))
					a.w.Eval(js)
				}
			})
		}
	}()
}
