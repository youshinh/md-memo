package llm

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// VoiceConfig defines LLM API configuration for voice transcription (Gemini only).
type VoiceConfig struct {
	BaseURL string `json:"baseUrl"`
	APIKey  string `json:"apiKey"`
	Model   string `json:"model"`
	Prompt  string `json:"prompt"`
	Timeout int    `json:"timeout"` // seconds; 0 uses the package default client timeout
}

// QueryAudio sends an audio clip to Gemini's generateContent endpoint (an inline_data audio
// part, mirroring queryGeminiVision's image handling) and returns the transcribed text.
// Only Gemini speaks this shape, so a non-Gemini configuration is rejected up front.
func QueryAudio(prompt, audioBase64, mimeType string, cfg VoiceConfig) (string, error) {
	baseURL := strings.TrimRight(cfg.BaseURL, "/")
	model := cfg.Model
	if model == "" {
		model = "gemini-2.5-flash"
	}
	if DetectProvider(baseURL, model, cfg.APIKey) != ProviderGemini {
		return "", fmt.Errorf("voice transcription needs a Gemini model")
	}
	if cfg.APIKey == "" {
		return "", fmt.Errorf("Gemini API Keyが設定されていません")
	}
	if baseURL == "" {
		baseURL = "https://generativelanguage.googleapis.com"
	}

	if prompt == "" {
		prompt = cfg.Prompt
	}
	if prompt == "" {
		prompt = "この音声を正確に文字起こししてください。"
	}

	if idx := strings.Index(audioBase64, ","); idx != -1 {
		audioBase64 = audioBase64[idx+1:]
	}
	audioBase64 = strings.TrimSpace(audioBase64)

	if mimeType == "" {
		mimeType = "audio/webm"
	}
	if idx := strings.Index(mimeType, ";"); idx != -1 {
		mimeType = mimeType[:idx]
	}
	mimeType = strings.TrimSpace(mimeType)

	url := buildGeminiURL(baseURL, model, cfg.APIKey)

	payload := map[string]interface{}{
		"contents": []map[string]interface{}{
			{
				"parts": []map[string]interface{}{
					{"text": prompt},
					{
						"inline_data": map[string]string{
							"mime_type": mimeType,
							"data":      audioBase64,
						},
					},
				},
			},
		},
	}

	bodyBytes, err := json.Marshal(payload)
	if err != nil {
		return "", err
	}

	req, err := http.NewRequest("POST", url, bytes.NewReader(bodyBytes))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/json")

	httpClient := client
	if cfg.Timeout > 0 {
		httpClient = &http.Client{Timeout: time.Duration(cfg.Timeout) * time.Second}
	}

	res, err := httpClient.Do(req)
	if err != nil {
		return "", fmt.Errorf("Gemini接続エラー: %w", err)
	}
	defer res.Body.Close()

	if res.StatusCode != http.StatusOK {
		respBody, _ := io.ReadAll(res.Body)
		return "", fmt.Errorf("Gemini APIエラー (%d): %s", res.StatusCode, string(respBody))
	}

	var result struct {
		Candidates []struct {
			Content struct {
				Parts []struct {
					Text string `json:"text"`
				} `json:"parts"`
			} `json:"content"`
		} `json:"candidates"`
	}
	if err := json.NewDecoder(res.Body).Decode(&result); err != nil {
		return "", err
	}

	if len(result.Candidates) == 0 || len(result.Candidates[0].Content.Parts) == 0 {
		return "", fmt.Errorf("Geminiから空のレスポンスが返されました")
	}

	text := strings.TrimSpace(result.Candidates[0].Content.Parts[0].Text)
	if text == "" {
		return "", fmt.Errorf("文字起こし結果が空でした")
	}
	return text, nil
}
