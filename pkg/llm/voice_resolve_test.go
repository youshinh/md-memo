package llm

import "testing"

func TestResolveVoiceConfig_FillsCredentialsFromVision(t *testing.T) {
	got := ResolveVoiceConfig(
		VoiceConfig{Model: "gemini-3.5-transcribe"},
		VisionConfig{BaseURL: "https://generativelanguage.googleapis.com", APIKey: "vision-key"},
	)
	if got.APIKey != "vision-key" || got.BaseURL != "https://generativelanguage.googleapis.com" {
		t.Errorf("credentials should come from vision, got %+v", got)
	}
	if got.Model != "gemini-3.5-transcribe" {
		t.Errorf("model must be kept, got %q", got.Model)
	}
	if got.Prompt != DefaultVoicePrompt || got.Timeout != DefaultVoiceTimeoutSec {
		t.Errorf("prompt/timeout defaults not applied: %+v", got)
	}
}

func TestResolveVoiceConfig_VoiceSettingsWin(t *testing.T) {
	got := ResolveVoiceConfig(
		VoiceConfig{APIKey: "voice-key", BaseURL: "https://voice", Prompt: "p", Timeout: 5},
		VisionConfig{APIKey: "vision-key", BaseURL: "https://vision"},
	)
	if got.APIKey != "voice-key" || got.BaseURL != "https://voice" || got.Prompt != "p" || got.Timeout != 5 {
		t.Errorf("explicit voice settings must not be overridden, got %+v", got)
	}
}

func TestResolveVoiceConfig_NothingConfiguredStaysEmpty(t *testing.T) {
	got := ResolveVoiceConfig(VoiceConfig{}, VisionConfig{})
	if got.APIKey != "" {
		t.Errorf("no key anywhere must stay empty (QueryAudio then reports it), got %q", got.APIKey)
	}
}
