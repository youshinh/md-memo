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

// DefaultVoiceModel is used when the voice config names no model.
const DefaultVoiceModel = "gemini-3.5-transcribe"

// Values of VoiceConfig.APIStyle. Auto picks one from the model name.
const (
	VoiceStyleAuto            = "auto"
	VoiceStyleInteractions    = "interactions"
	VoiceStyleGenerateContent = "generateContent"
)

// maxCustomVocabulary is the API's cap on transcription_config.custom_vocabulary.
const maxCustomVocabulary = 1000

// VoiceConfig defines LLM API configuration for voice transcription (Gemini only).
type VoiceConfig struct {
	BaseURL          string   `json:"baseUrl"`
	APIKey           string   `json:"apiKey"`
	Model            string   `json:"model"`
	APIStyle         string   `json:"apiStyle"`         // "auto" (or empty), "interactions" or "generateContent"
	Prompt           string   `json:"prompt"`           // generateContent style only
	LanguageCodes    []string `json:"languageCodes"`    // BCP-47 hints (interactions style); empty = auto-detect
	Mode             string   `json:"mode"`             // "smart" (or empty) or "verbatim" (interactions style)
	CustomVocabulary []string `json:"customVocabulary"` // terms to bias recognition toward (interactions style)
	Timeout          int      `json:"timeout"`          // seconds; 0 uses the package default client timeout
}

// voiceRequest is what every API style receives, already validated and normalised by QueryAudio.
type voiceRequest struct {
	baseURL     string // bare Gemini host, no trailing slash or version
	model       string
	prompt      string // caller's prompt, may be empty
	audioBase64 string
	mimeType    string
	cfg         VoiceConfig
	client      *http.Client
}

type voiceStyleFunc func(r voiceRequest) (string, error)

// voiceStyleFor is the pluggable part: supporting another transcription API means one more
// VoiceStyle* value, one more case here and one more voiceStyleFunc; QueryAudio's callers do
// not change.
func voiceStyleFor(style string) voiceStyleFunc {
	switch style {
	case VoiceStyleInteractions:
		return queryVoiceInteractions
	case VoiceStyleGenerateContent:
		return queryVoiceGenerateContent
	}
	return nil
}

// resolveVoiceStyle turns VoiceConfig.APIStyle (and, for auto, the model name) into one of the
// concrete VoiceStyle* values.
func resolveVoiceStyle(apiStyle, model string) (string, error) {
	switch strings.ToLower(strings.TrimSpace(apiStyle)) {
	case "", VoiceStyleAuto:
		if strings.Contains(strings.ToLower(model), "transcribe") {
			return VoiceStyleInteractions, nil
		}
		return VoiceStyleGenerateContent, nil
	case VoiceStyleInteractions:
		return VoiceStyleInteractions, nil
	case strings.ToLower(VoiceStyleGenerateContent):
		return VoiceStyleGenerateContent, nil
	}
	return "", errNotConfigured(fmt.Sprintf("不明な音声API形式です: %q (指定できるのは auto / interactions / generateContent)", apiStyle))
}

// isLiveVoiceModel reports whether model is a Live API (streaming) model, which cannot take a
// recorded clip.
func isLiveVoiceModel(model string) bool {
	tokens := strings.FieldsFunc(strings.ToLower(model), func(r rune) bool {
		return r == '-' || r == '.' || r == '/' || r == '_'
	})
	for _, tok := range tokens {
		if tok == "live" {
			return true
		}
	}
	return false
}

// QueryAudio transcribes one recorded clip with Gemini and returns the text. Which of Gemini's
// two request shapes is used follows VoiceConfig.APIStyle: the Interactions API for
// gemini-3.5-transcribe style models, generateContent (an inline_data audio part plus a prompt)
// for general models. prompt is ignored by the Interactions style, which has no free-form prompt.
// Only Gemini speaks these shapes, so a non-Gemini configuration is rejected up front.
func QueryAudio(prompt, audioBase64, mimeType string, cfg VoiceConfig) (string, error) {
	baseURL := strings.TrimRight(cfg.BaseURL, "/")
	model := cfg.Model
	if model == "" {
		model = DefaultVoiceModel
	}
	if DetectProvider(baseURL, model, cfg.APIKey) != ProviderGemini {
		return "", errNotConfigured("voice transcription needs a Gemini model")
	}
	if cfg.APIKey == "" {
		return "", errNotConfigured("Gemini API Keyが設定されていません")
	}
	style, err := resolveVoiceStyle(cfg.APIStyle, model)
	if err != nil {
		return "", err
	}
	if isLiveVoiceModel(model) {
		return "", errNotConfigured(fmt.Sprintf("%s はLive API(ストリーミング)用のモデルで、録音済みの音声は文字起こしできません。モデルに %s を指定してください", model, DefaultVoiceModel))
	}

	if idx := strings.Index(audioBase64, ","); idx != -1 {
		audioBase64 = audioBase64[idx+1:]
	}
	audioBase64 = strings.TrimSpace(audioBase64)

	if mimeType == "" {
		mimeType = "audio/webm"
	}
	mimeType = stripMIMEParams(mimeType)

	httpClient := client
	if cfg.Timeout > 0 {
		httpClient = &http.Client{Timeout: time.Duration(cfg.Timeout) * time.Second}
	}

	return voiceStyleFor(style)(voiceRequest{
		baseURL:     geminiAPIBase(baseURL),
		model:       model,
		prompt:      prompt,
		audioBase64: audioBase64,
		mimeType:    mimeType,
		cfg:         cfg,
		client:      httpClient,
	})
}

// stripMIMEParams drops parameters such as ";codecs=opus" that MediaRecorder appends.
func stripMIMEParams(mimeType string) string {
	if idx := strings.Index(mimeType, ";"); idx != -1 {
		mimeType = mimeType[:idx]
	}
	return strings.TrimSpace(mimeType)
}

// interactionsAudioMIME maps the types browsers, phones and Go's sniffer report onto the ones
// the Interactions API lists. Anything unrecognised passes through for the API to judge.
func interactionsAudioMIME(mimeType string) string {
	switch strings.ToLower(mimeType) {
	case "video/webm":
		return "audio/webm"
	case "application/ogg":
		return "audio/ogg"
	case "audio/mp4", "audio/x-m4a":
		return "audio/m4a"
	case "audio/x-wav", "audio/wave", "audio/vnd.wave":
		return "audio/wav"
	case "audio/x-aac":
		return "audio/aac"
	case "audio/x-flac":
		return "audio/flac"
	}
	return mimeType
}

// postJSON POSTs payload to url and decodes a 200 response into out. A non-200 response becomes
// the same "Gemini APIエラー" error every Gemini call in this package reports.
func (r voiceRequest) postJSON(url string, header map[string]string, payload, out interface{}) error {
	bodyBytes, err := json.Marshal(payload)
	if err != nil {
		return err
	}

	req, err := http.NewRequest("POST", url, bytes.NewReader(bodyBytes))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	for k, v := range header {
		req.Header.Set(k, v)
	}

	res, err := r.client.Do(req)
	if err != nil {
		return fmt.Errorf("Gemini接続エラー: %w", err)
	}
	defer res.Body.Close()

	if res.StatusCode != http.StatusOK {
		respBody, _ := io.ReadAll(res.Body)
		return fmt.Errorf("Gemini APIエラー (%d): %s", res.StatusCode, string(respBody))
	}
	return json.NewDecoder(res.Body).Decode(out)
}

// queryVoiceGenerateContent is the general-model path: an inline_data audio part next to a
// transcription prompt, mirroring queryGeminiVision's image handling.
func queryVoiceGenerateContent(r voiceRequest) (string, error) {
	prompt := r.prompt
	if prompt == "" {
		prompt = r.cfg.Prompt
	}
	if prompt == "" {
		prompt = "この音声を正確に文字起こししてください。"
	}

	payload := map[string]interface{}{
		"contents": []map[string]interface{}{
			{
				"parts": []map[string]interface{}{
					{"text": prompt},
					{
						"inline_data": map[string]string{
							"mime_type": r.mimeType,
							"data":      r.audioBase64,
						},
					},
				},
			},
		},
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
	url := buildGeminiURL(r.baseURL, r.model, r.cfg.APIKey)
	if err := r.postJSON(url, nil, payload, &result); err != nil {
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

// cleanStringList trims, drops blanks and duplicates (keeping first-seen order) and caps the
// length at limit (0 = no cap). It returns nil for an empty result so the field can be omitted.
func cleanStringList(in []string, limit int) []string {
	var out []string
	seen := make(map[string]bool, len(in))
	for _, s := range in {
		s = strings.TrimSpace(s)
		if s == "" || seen[s] {
			continue
		}
		seen[s] = true
		out = append(out, s)
		if limit > 0 && len(out) == limit {
			break
		}
	}
	return out
}

// transcriptionMode renders VoiceConfig.Mode the way the API wants it: the bare string "smart",
// or the object {"type":"verbatim"}.
func transcriptionMode(mode string) (interface{}, error) {
	switch strings.ToLower(strings.TrimSpace(mode)) {
	case "", "smart":
		return "smart", nil
	case "verbatim":
		return map[string]string{"type": "verbatim"}, nil
	}
	return nil, errNotConfigured(fmt.Sprintf("不明な文字起こしモードです: %q (指定できるのは smart / verbatim)", mode))
}

// interactionResponse is the part of an Interactions API result that matters for transcription.
type interactionResponse struct {
	OutputText string          `json:"output_text"`
	Status     string          `json:"status"`
	Error      json.RawMessage `json:"error"`
	Steps      []struct {
		Type    string `json:"type"`
		Content []struct {
			Type string `json:"type"`
			Text string `json:"text"`
		} `json:"content"`
	} `json:"steps"`
}

// errorText extracts a readable message from the response's error member, "" when it is absent
// or empty.
func (ir interactionResponse) errorText() string {
	s := strings.TrimSpace(string(ir.Error))
	if s == "" || s == "null" || s == "{}" || s == `""` {
		return ""
	}
	var obj struct {
		Message string `json:"message"`
	}
	if json.Unmarshal(ir.Error, &obj) == nil && obj.Message != "" {
		return obj.Message
	}
	var str string
	if json.Unmarshal(ir.Error, &str) == nil && str != "" {
		return str
	}
	return s
}

// transcript returns the recognised text: the SDK-style top-level output_text when the body
// has one, else every text item of every model_output step, concatenated.
func (ir interactionResponse) transcript() string {
	if ir.OutputText != "" {
		return ir.OutputText
	}
	var sb strings.Builder
	for _, step := range ir.Steps {
		if step.Type != "model_output" {
			continue
		}
		for _, c := range step.Content {
			if c.Type == "text" {
				sb.WriteString(c.Text)
			}
		}
	}
	return sb.String()
}

// queryVoiceInteractions is the gemini-3.5-transcribe path (POST {base}/v1beta/interactions).
// store is always false: without it Google keeps every request and response, and these are the
// user's voice recordings.
func queryVoiceInteractions(r voiceRequest) (string, error) {
	mode, err := transcriptionMode(r.cfg.Mode)
	if err != nil {
		return "", err
	}
	tc := map[string]interface{}{"mode": mode}
	if codes := cleanStringList(r.cfg.LanguageCodes, 0); len(codes) > 0 {
		tc["language_codes"] = codes
	}
	if vocab := cleanStringList(r.cfg.CustomVocabulary, maxCustomVocabulary); len(vocab) > 0 {
		tc["custom_vocabulary"] = vocab
	}

	payload := map[string]interface{}{
		"model": strings.TrimPrefix(r.model, "models/"),
		"store": false,
		"input": []map[string]string{
			{
				"type":      "audio",
				"data":      r.audioBase64,
				"mime_type": interactionsAudioMIME(r.mimeType),
			},
		},
		"generation_config": map[string]interface{}{
			"transcription_config": tc,
		},
	}

	var result interactionResponse
	err = r.postJSON(r.baseURL+"/v1beta/interactions", map[string]string{"x-goog-api-key": r.cfg.APIKey}, payload, &result)
	if err != nil {
		return "", err
	}

	errText := result.errorText()
	incomplete := result.Status != "" && result.Status != "completed"
	if errText != "" || incomplete {
		msg := errText
		if msg == "" {
			msg = "文字起こしが完了しませんでした"
		}
		if incomplete {
			msg += " (status: " + result.Status + ")"
		}
		return "", fmt.Errorf("Gemini APIエラー: %s", msg)
	}

	raw := result.transcript()
	if raw == "" && len(result.Steps) == 0 {
		return "", errNoSpeech()
	}
	text := strings.TrimSpace(raw)
	if text == "" {
		return "", errNoSpeech()
	}
	return text, nil
}

// errNoSpeech is what a recording comes back as when the API accepted it ("completed") but found nothing to transcribe:
// there was no speech in the clip. Saying so points at the microphone instead of at the API.
func errNoSpeech() error {
	return fmt.Errorf("話し声が検出されませんでした(録音にほとんど音声が入っていません。マイクの選択と音量を確認してください)")
}
