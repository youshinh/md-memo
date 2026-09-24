package main

import (
	"encoding/json"
	"strings"
	"time"

	"md-memo/pkg/llm"
)

// quickCaptureLLMQuery is llm.Query behind a variable so tests never reach a real model.
var quickCaptureLLMQuery = llm.Query

// quickCaptureLLMTimeout bounds how long AI Send waits for the model before saving the text as
// typed: a capture must never be lost or held up indefinitely by a slow or unreachable model.
const quickCaptureLLMTimeout = 30 * time.Second

// quickCaptureLLMSettings is what AI Send needs from config.json: the same "text" model that the
// editor's AI correction (Alt+C) uses, the UI language, and the general.aiCorrection switch.
type quickCaptureLLMSettings struct {
	Cfg      llm.Config
	Japanese bool
	Enabled  bool
}

// parseQuickCaptureLLMSettings reads those keys from config.json's contents. AI correction is on
// unless general.aiCorrection is explicitly false, matching the settings checkbox's default.
func parseQuickCaptureLLMSettings(configJSON string) quickCaptureLLMSettings {
	var raw struct {
		Text    llm.Config `json:"text"`
		General struct {
			Language     string `json:"language"`
			AICorrection *bool  `json:"aiCorrection"`
		} `json:"general"`
	}
	if configJSON != "" {
		_ = json.Unmarshal([]byte(configJSON), &raw)
	}
	return quickCaptureLLMSettings{
		Cfg:      raw.Text,
		Japanese: raw.General.Language == "ja",
		Enabled:  raw.General.AICorrection == nil || *raw.General.AICorrection,
	}
}

// containsJapanese reports whether s has any kana or CJK ideograph (the same ranges the editor's
// AI correction uses to pick the Japanese prompt).
func containsJapanese(s string) bool {
	for _, r := range s {
		if (r >= 0x4E00 && r <= 0x9FA0) || (r >= 0x3041 && r <= 0x3093) || (r >= 0x30A1 && r <= 0x30F6) {
			return true
		}
	}
	return false
}

// buildQuickCaptureCorrectionPrompt is the editor's AI-correction prompt (app.js
// triggerAICorrection), so AI Send corrects text exactly the way Alt+C does.
func buildQuickCaptureCorrectionPrompt(text string, japanese bool) string {
	if japanese {
		return "以下のテキストの誤字・脱字・打ち間違い・変換ミス・文脈エラーを自然に修正し、修正後のテキストのみを出力してください。挨拶・解説・前置き・引用符などは一切含めず、修正後の本文のみを直接出力してください。\n\n【対象テキスト】:\n" + text
	}
	return "Fix all typos, spelling errors, grammar mistakes, and accidental keystrokes in the following text. Output ONLY the corrected text without any greetings, explanations, markdown quotes, or conversational filler.\n\n[Text]:\n" + text
}

// stripThinkBlocks removes <think>...</think> reasoning blocks; an unterminated one drops
// everything from its start.
func stripThinkBlocks(s string) string {
	for {
		start := strings.Index(s, "<think>")
		if start < 0 {
			return s
		}
		end := strings.Index(s[start:], "</think>")
		if end < 0 {
			return s[:start]
		}
		s = s[:start] + s[start+end+len("</think>"):]
	}
}

func trimPrefixFold(s, prefix string) string {
	if len(s) >= len(prefix) && strings.EqualFold(s[:len(prefix)], prefix) {
		return strings.TrimSpace(s[len(prefix):])
	}
	return s
}

// cleanQuickCaptureCorrection strips what models wrap around a correction - reasoning blocks,
// "Corrected text:" style lead-ins, a surrounding code fence, and surrounding quotes - mirroring
// the editor's cleanAICorrectionResult so both paths return the same text.
func cleanQuickCaptureCorrection(raw string) string {
	s := strings.TrimSpace(stripThinkBlocks(raw))
	for _, p := range []string{
		"Here is the corrected text:",
		"Corrected text:",
		"Corrected version:",
		"Here's the corrected text:",
		"修正後のテキスト：", "修正後のテキスト:",
		"修正結果：", "修正結果:",
		"修正後：", "修正後:",
	} {
		s = trimPrefixFold(s, p)
	}

	if strings.HasPrefix(s, "```") {
		lines := strings.Split(s, "\n")
		if len(lines) >= 2 && strings.TrimSpace(lines[len(lines)-1]) == "```" {
			lang := strings.ToLower(strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(lines[0]), "```")))
			if lang == "" || lang == "text" || lang == "markdown" || lang == "md" {
				s = strings.TrimSpace(strings.Join(lines[1:len(lines)-1], "\n"))
			}
		}
	}

	s = strings.TrimSpace(s)
	if (strings.HasPrefix(s, `"`) && strings.HasSuffix(s, `"`) && len(s) >= 2) ||
		(strings.HasPrefix(s, "「") && strings.HasSuffix(s, "」") && len(s) >= len("「」")) {
		s = strings.TrimSpace(string([]rune(s)[1 : len([]rune(s))-1]))
	}
	return s
}

// correctQuickCaptureWithLLM asks the model to fix text and returns the cleaned result. On any
// failure - error, empty answer, or timeout - it returns text unchanged, so AI Send can never lose
// what was typed (the same rollback rule as the editor's AI correction).
func correctQuickCaptureWithLLM(text string, cfg llm.Config, japanese bool, timeout time.Duration) string {
	prompt := buildQuickCaptureCorrectionPrompt(text, japanese || containsJapanese(text))

	type result struct {
		out string
		err error
	}
	ch := make(chan result, 1)
	go func() {
		out, err := quickCaptureLLMQuery(prompt, cfg)
		ch <- result{out, err}
	}()

	select {
	case r := <-ch:
		if r.err != nil {
			return text
		}
		if cleaned := cleanQuickCaptureCorrection(r.out); cleaned != "" {
			return cleaned
		}
	case <-time.After(timeout):
	}
	return text
}

// correctQuickCaptureText is the App-level entry point used by AI Send: it applies the user's
// configured model (starting a local Ollama first if that is what they use), or returns text
// unchanged when AI correction is switched off or no model is configured.
func (a *App) correctQuickCaptureText(text string) string {
	cfgStr, _ := a.GetConfig()
	s := parseQuickCaptureLLMSettings(cfgStr)
	if !s.Enabled || s.Cfg.BaseURL == "" {
		return text
	}
	if llm.IsOllamaURL(s.Cfg.BaseURL) && !llm.CheckOllamaHealth(s.Cfg.BaseURL) {
		_ = a.EnsureOllamaRunning(6 * time.Second)
	}
	return correctQuickCaptureWithLLM(text, s.Cfg, s.Japanese, quickCaptureLLMTimeout)
}

// quickCaptureAccent returns the popup's accent and accent-hover colors (R, G, B) for one of
// md-memo's color themes - the same values as --accent-color / --accent-hover in
// frontend/css/style.css, so the native popup follows whichever theme the main window uses.
// Unknown or empty theme names fall back to the default (olive).
func quickCaptureAccent(theme string) (accent, hover [3]uint8) {
	switch theme {
	case "blue":
		return [3]uint8{0x00, 0x7a, 0xcc}, [3]uint8{0x1f, 0x8a, 0xd2}
	case "forest":
		return [3]uint8{0x2e, 0x66, 0x56}, [3]uint8{0x3d, 0x80, 0x6d}
	case "charcoal":
		return [3]uint8{0x50, 0x50, 0x50}, [3]uint8{0x66, 0x66, 0x66}
	default:
		return [3]uint8{0x55, 0x6b, 0x2f}, [3]uint8{0x6b, 0x84, 0x3d}
	}
}

// parseQuickCaptureTheme extracts general.theme from config.json's contents, returning "olive"
// (md-memo's own default) when the key is missing or the JSON is unreadable.
func parseQuickCaptureTheme(configJSON string) string {
	var raw struct {
		General struct {
			Theme string `json:"theme"`
		} `json:"general"`
	}
	if configJSON != "" {
		_ = json.Unmarshal([]byte(configJSON), &raw)
	}
	if raw.General.Theme == "" {
		return "olive"
	}
	return raw.General.Theme
}

// formatQuickCaptureEntry builds the note body for the quick-capture popup's
// "整形して送信" (send with formatting) action. When a foreground-window title
// was captured before the popup opened, it is recorded as a context line so the
// scrap remembers what the user was looking at when they wrote it.
//
// Both inputs are trimmed first. An empty title yields the trimmed text as-is
// (which may itself be empty). A non-empty title always produces a context
// line; if the text is empty, the context line is returned alone rather than
// with a trailing blank line.
func formatQuickCaptureEntry(text, foregroundTitle string) string {
	trimmedText := strings.TrimSpace(text)
	trimmedTitle := strings.TrimSpace(foregroundTitle)

	if trimmedTitle == "" {
		return trimmedText
	}

	contextLine := "> [context: " + trimmedTitle + "]"
	if trimmedText == "" {
		return contextLine
	}
	return contextLine + "\n" + trimmedText
}
