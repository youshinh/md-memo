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

// The vision key belongs to the vision host: voice gets it only while it talks to that same host.
func TestResolveVoiceConfig_KeyIsLentOnlyToTheSameHost(t *testing.T) {
	vision := VisionConfig{BaseURL: "https://generativelanguage.googleapis.com", APIKey: "GOOGLEKEY"}
	for _, c := range []struct {
		name    string
		voice   VoiceConfig
		vision  VisionConfig
		wantKey string
	}{
		{"another host gets no key", VoiceConfig{BaseURL: "https://stt.selfhosted.example/v1"}, vision, ""},
		{"an own key is kept whatever the host", VoiceConfig{BaseURL: "https://stt.selfhosted.example/v1", APIKey: "own"}, vision, "own"},
		{"same host, other path and case", VoiceConfig{BaseURL: "HTTPS://Generativelanguage.googleapis.com/v1beta"}, vision, "GOOGLEKEY"},
		{"empty voice URL follows vision, so the key follows too", VoiceConfig{}, vision, "GOOGLEKEY"},
		{"both empty is the default Gemini host", VoiceConfig{}, VisionConfig{APIKey: "GOOGLEKEY"}, "GOOGLEKEY"},
		{"voice default Gemini host, vision somewhere else", VoiceConfig{BaseURL: "https://generativelanguage.googleapis.com"}, VisionConfig{BaseURL: "http://localhost:11434", APIKey: "OLLAMAKEY"}, ""},
		{"credentials in the URL do not make another host", VoiceConfig{BaseURL: "https://u:p@generativelanguage.googleapis.com"}, vision, "GOOGLEKEY"},
		{"another port is another host", VoiceConfig{BaseURL: "https://generativelanguage.googleapis.com:8443"}, vision, ""},
	} {
		if got := ResolveVoiceConfig(c.voice, c.vision); got.APIKey != c.wantKey {
			t.Errorf("%s: key = %q, want %q", c.name, got.APIKey, c.wantKey)
		}
	}
}

func TestResolveVoiceConfig_NothingConfiguredStaysEmpty(t *testing.T) {
	got := ResolveVoiceConfig(VoiceConfig{}, VisionConfig{})
	if got.APIKey != "" {
		t.Errorf("no key anywhere must stay empty (QueryAudio then reports it), got %q", got.APIKey)
	}
}
