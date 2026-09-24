package main

import (
	"errors"
	"strings"
	"testing"
	"time"

	"md-memo/pkg/llm"
)

func TestFormatQuickCaptureEntry(t *testing.T) {
	tests := []struct {
		name            string
		text            string
		foregroundTitle string
		want            string
	}{
		{
			name:            "empty foreground title returns text unchanged",
			text:            "buy milk",
			foregroundTitle: "",
			want:            "buy milk",
		},
		{
			name:            "non-empty foreground title adds context line",
			text:            "buy milk",
			foregroundTitle: "Chrome - Amazon.co.jp",
			want:            "> [context: Chrome - Amazon.co.jp]\nbuy milk",
		},
		{
			name:            "leading and trailing whitespace on text is trimmed",
			text:            "  buy milk  \n",
			foregroundTitle: "",
			want:            "buy milk",
		},
		{
			name:            "leading and trailing whitespace on title is trimmed",
			text:            "buy milk",
			foregroundTitle: "  Chrome  ",
			want:            "> [context: Chrome]\nbuy milk",
		},
		{
			name:            "whitespace-only text with a title returns the context line alone",
			text:            "   ",
			foregroundTitle: "Chrome",
			want:            "> [context: Chrome]",
		},
		{
			name:            "whitespace-only text and title returns an empty string",
			text:            "   ",
			foregroundTitle: "   ",
			want:            "",
		},
		{
			name:            "both empty returns an empty string",
			text:            "",
			foregroundTitle: "",
			want:            "",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := formatQuickCaptureEntry(tt.text, tt.foregroundTitle)
			if got != tt.want {
				t.Errorf("formatQuickCaptureEntry(%q, %q) = %q, want %q", tt.text, tt.foregroundTitle, got, tt.want)
			}
		})
	}
}

func TestQuickCaptureAccent(t *testing.T) {
	tests := []struct {
		theme      string
		wantAccent [3]uint8
		wantHover  [3]uint8
	}{
		{"olive", [3]uint8{0x55, 0x6b, 0x2f}, [3]uint8{0x6b, 0x84, 0x3d}},
		{"blue", [3]uint8{0x00, 0x7a, 0xcc}, [3]uint8{0x1f, 0x8a, 0xd2}},
		{"forest", [3]uint8{0x2e, 0x66, 0x56}, [3]uint8{0x3d, 0x80, 0x6d}},
		{"charcoal", [3]uint8{0x50, 0x50, 0x50}, [3]uint8{0x66, 0x66, 0x66}},
		{"", [3]uint8{0x55, 0x6b, 0x2f}, [3]uint8{0x6b, 0x84, 0x3d}},
		{"no-such-theme", [3]uint8{0x55, 0x6b, 0x2f}, [3]uint8{0x6b, 0x84, 0x3d}},
	}
	for _, tt := range tests {
		accent, hover := quickCaptureAccent(tt.theme)
		if accent != tt.wantAccent || hover != tt.wantHover {
			t.Errorf("quickCaptureAccent(%q) = %v, %v; want %v, %v", tt.theme, accent, hover, tt.wantAccent, tt.wantHover)
		}
	}
}

func TestParseQuickCaptureLLMSettings(t *testing.T) {
	s := parseQuickCaptureLLMSettings(`{"text":{"baseUrl":"http://h/v1","model":"m","apiKey":"k"},"general":{"language":"ja"}}`)
	if s.Cfg.BaseURL != "http://h/v1" || s.Cfg.Model != "m" || s.Cfg.APIKey != "k" {
		t.Errorf("text config not parsed: %+v", s.Cfg)
	}
	if !s.Japanese || !s.Enabled {
		t.Errorf("want Japanese and Enabled (aiCorrection unset means on), got %+v", s)
	}

	off := parseQuickCaptureLLMSettings(`{"general":{"aiCorrection":false}}`)
	if off.Enabled {
		t.Error("aiCorrection=false must disable AI Send correction")
	}
	on := parseQuickCaptureLLMSettings(`{"general":{"aiCorrection":true,"language":"en"}}`)
	if !on.Enabled || on.Japanese {
		t.Errorf("aiCorrection=true, language=en: got %+v", on)
	}
	if bad := parseQuickCaptureLLMSettings(`{oops`); !bad.Enabled || bad.Cfg.BaseURL != "" {
		t.Errorf("invalid JSON should give defaults (enabled, no model), got %+v", bad)
	}
}

func TestContainsJapanese(t *testing.T) {
	for text, want := range map[string]bool{
		"テスト ping":    true,
		"ひらがな":        true,
		"漢字":          true,
		"plain ascii": false,
		"":            false,
	} {
		if got := containsJapanese(text); got != want {
			t.Errorf("containsJapanese(%q) = %v, want %v", text, got, want)
		}
	}
}

func TestBuildQuickCaptureCorrectionPrompt(t *testing.T) {
	ja := buildQuickCaptureCorrectionPrompt("テスト", true)
	if !strings.Contains(ja, "誤字・脱字") || !strings.HasSuffix(ja, "【対象テキスト】:\nテスト") {
		t.Errorf("Japanese prompt malformed: %q", ja)
	}
	en := buildQuickCaptureCorrectionPrompt("teh cat", false)
	if !strings.Contains(en, "Fix all typos") || !strings.HasSuffix(en, "[Text]:\nteh cat") {
		t.Errorf("English prompt malformed: %q", en)
	}
}

func TestCleanQuickCaptureCorrection(t *testing.T) {
	tests := []struct {
		name string
		raw  string
		want string
	}{
		{"plain", "テスト ping 確認", "テスト ping 確認"},
		{"trims whitespace", "  fixed text \n", "fixed text"},
		{"think block", "<think>reasoning</think>fixed", "fixed"},
		{"unterminated think block", "kept<think>never closed", "kept"},
		{"english lead-in", "Corrected text: fixed", "fixed"},
		{"english lead-in any case", "here is the corrected text:\nfixed", "fixed"},
		{"japanese lead-in fullwidth colon", "修正後：直した", "直した"},
		{"japanese lead-in ascii colon", "修正結果: 直した", "直した"},
		{"code fence", "```\nfixed\n```", "fixed"},
		{"markdown fence", "```markdown\n# Title\n```", "# Title"},
		{"other-language fence kept", "```go\nx := 1\n```", "```go\nx := 1\n```"},
		{"double quotes", `"fixed"`, "fixed"},
		{"corner brackets", "「直した」", "直した"},
		{"lone quote kept", `"`, `"`},
		{"only reasoning", "<think>hmm</think>", ""},
	}
	for _, tt := range tests {
		if got := cleanQuickCaptureCorrection(tt.raw); got != tt.want {
			t.Errorf("%s: cleanQuickCaptureCorrection(%q) = %q, want %q", tt.name, tt.raw, got, tt.want)
		}
	}
}

func TestCorrectQuickCaptureWithLLM(t *testing.T) {
	orig := quickCaptureLLMQuery
	defer func() { quickCaptureLLMQuery = orig }()

	var gotPrompt string
	quickCaptureLLMQuery = func(prompt string, cfg llm.Config) (string, error) {
		gotPrompt = prompt
		return "Corrected text: テスト ping 確認 不通 IP", nil
	}
	got := correctQuickCaptureWithLLM("テスト　ping 確認　不通ip", llm.Config{}, false, time.Second)
	if got != "テスト ping 確認 不通 IP" {
		t.Errorf("corrected text = %q", got)
	}
	if !strings.Contains(gotPrompt, "【対象テキスト】") {
		t.Errorf("Japanese text should select the Japanese prompt even when the UI language is not ja, got %q", gotPrompt)
	}

	quickCaptureLLMQuery = func(string, llm.Config) (string, error) { return "", errors.New("connection refused") }
	if got := correctQuickCaptureWithLLM("keep me", llm.Config{}, false, time.Second); got != "keep me" {
		t.Errorf("model error must return the original text, got %q", got)
	}

	quickCaptureLLMQuery = func(string, llm.Config) (string, error) { return "<think>x</think>", nil }
	if got := correctQuickCaptureWithLLM("keep me", llm.Config{}, false, time.Second); got != "keep me" {
		t.Errorf("empty answer must return the original text, got %q", got)
	}

	quickCaptureLLMQuery = func(string, llm.Config) (string, error) {
		time.Sleep(300 * time.Millisecond)
		return "too late", nil
	}
	if got := correctQuickCaptureWithLLM("keep me", llm.Config{}, false, 30*time.Millisecond); got != "keep me" {
		t.Errorf("timeout must return the original text, got %q", got)
	}
}

func TestParseQuickCaptureShortcut(t *testing.T) {
	tests := []struct {
		name string
		json string
		want string
	}{
		{"configured value wins", `{"shortcuts":{"quickCapture":"Ctrl+Alt+J"}}`, "Ctrl+Alt+J"},
		{"value is trimmed", `{"shortcuts":{"quickCapture":"  Ctrl+Alt+J "}}`, "Ctrl+Alt+J"},
		{"explicitly empty means the user cleared it", `{"shortcuts":{"quickCapture":""}}`, ""},
		{"whitespace-only also means cleared", `{"shortcuts":{"quickCapture":"   "}}`, ""},
		{"missing key falls back to the default", `{"shortcuts":{"globalSummon":"Ctrl+Alt+M"}}`, defaultQuickCaptureShortcut},
		{"missing shortcuts section", `{"general":{}}`, defaultQuickCaptureShortcut},
		{"empty config", ``, defaultQuickCaptureShortcut},
		{"invalid json", `{oops`, defaultQuickCaptureShortcut},
	}
	for _, tt := range tests {
		if got := parseQuickCaptureShortcut(tt.json); got != tt.want {
			t.Errorf("%s: parseQuickCaptureShortcut(%q) = %q, want %q", tt.name, tt.json, got, tt.want)
		}
	}
	if defaultQuickCaptureShortcut != "Ctrl+Shift+Q" {
		t.Errorf("the default must match DEFAULT_SHORTCUTS_WIN.quickCapture in app.js, got %q", defaultQuickCaptureShortcut)
	}
}

func TestParseQuickCaptureTheme(t *testing.T) {
	tests := []struct {
		name string
		json string
		want string
	}{
		{"theme present", `{"general":{"theme":"blue"}}`, "blue"},
		{"theme missing", `{"general":{}}`, "olive"},
		{"general missing", `{"llm":{}}`, "olive"},
		{"empty input", ``, "olive"},
		{"invalid json", `{not json`, "olive"},
	}
	for _, tt := range tests {
		if got := parseQuickCaptureTheme(tt.json); got != tt.want {
			t.Errorf("%s: parseQuickCaptureTheme(%q) = %q, want %q", tt.name, tt.json, got, tt.want)
		}
	}
}
