package llm

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strings"
	"time"
)

// Config represents standard text LLM connection options.
type Config struct {
	BaseURL      string  `json:"baseUrl"`      // e.g. http://localhost:11434, http://localhost:1234/v1, https://api.openai.com/v1
	Model        string  `json:"model"`        // e.g. qwen2.5:latest, gpt-4o-mini
	SystemPrompt string  `json:"systemPrompt"` // optional
	Temperature  float64 `json:"temperature"`  // default 0.7
	APIKey       string  `json:"apiKey"`       // required for OpenAI/Gemini/Claude, optional for Ollama/LM Studio
}

// VisionConfig defines LLM API configuration for vision OCR (Gemini or OpenAI).
type VisionConfig struct {
	BaseURL      string `json:"baseUrl"`      // e.g. https://generativelanguage.googleapis.com
	Model        string `json:"model"`        // e.g. gemini-2.5-flash
	APIKey       string `json:"apiKey"`       // required for Gemini / OpenAI
	Prompt       string `json:"prompt"`       // Custom prompt for image OCR/markdown conversion
	SystemPrompt string `json:"systemPrompt"` // Optional system prompt
}

// AutocompleteConfig defines LLM configuration for inline real-time autocompletion.
type AutocompleteConfig struct {
	BaseURL   string `json:"baseUrl"`   // e.g. http://localhost:11434, http://localhost:1234/v1, https://api.openai.com/v1, https://generativelanguage.googleapis.com
	Model     string `json:"model"`     // e.g. qwen2.5:latest, google/gemma-4-12b-qat, gemini-flash-lite-latest
	APIKey    string `json:"apiKey"`    // Optional for local (LM Studio/Ollama), required for Gemini/OpenAI
	MaxTokens int    `json:"maxTokens"` // default: 30
	Enabled   bool   `json:"enabled"`   // default: true
	DelayMs   int    `json:"delayMs"`   // default: 500
}

// ImageGenConfig defines LLM API configuration for image generation (Gemini / Imagen).
type ImageGenConfig struct {
	BaseURL     string `json:"baseUrl"`     // e.g. https://generativelanguage.googleapis.com
	Model       string `json:"model"`       // e.g. gemini-2.5-flash-image, imagen-3.0-generate-002, imagen-4.0-generate-001
	APIKey      string `json:"apiKey"`      // required for Gemini
	AspectRatio string `json:"aspectRatio"` // e.g. 16:9, 1:1, 4:3, default: 16:9
}

var client = &http.Client{
	Timeout: 120 * time.Second,
}

var fastClient = &http.Client{
	Timeout: 30 * time.Second,
}

var reThinkTags = regexp.MustCompile(`(?s)<think>.*?</think>`)

func buildGeminiURL(baseURL, model, apiKey string) string {
	baseURL = strings.TrimRight(baseURL, "/")
	baseURL = strings.TrimSuffix(baseURL, "/v1beta")
	baseURL = strings.TrimSuffix(baseURL, "/v1")
	if baseURL == "" {
		baseURL = "https://generativelanguage.googleapis.com"
	}
	model = strings.TrimPrefix(model, "models/")
	if model == "" {
		model = "gemini-flash-lite-latest"
	}
	return fmt.Sprintf("%s/v1beta/models/%s:generateContent?key=%s", baseURL, model, apiKey)
}

func buildOpenAIURL(baseURL, endpoint string) string {
	url := strings.TrimRight(baseURL, "/")
	url = strings.TrimSuffix(url, "/chat/completions")
	url = strings.TrimSuffix(url, "/completions")
	if !strings.HasSuffix(url, "/v1") {
		url = url + "/v1"
	}
	return url + "/" + endpoint
}

// Query sends a prompt to the configured LLM endpoint and returns the generated text.
func Query(prompt string, cfg Config) (string, error) {
	baseURL := strings.TrimRight(cfg.BaseURL, "/")
	model := cfg.Model
	if model == "" {
		model = "qwen2.5:latest"
	}

	isGemini := strings.Contains(baseURL, "googleapis.com") || strings.Contains(model, "gemini")
	if isGemini {
		if baseURL == "" {
			baseURL = "https://generativelanguage.googleapis.com"
		}
		return queryGeminiText(baseURL, model, prompt, cfg)
	}

	isOpenAI := strings.Contains(baseURL, "/v1") || strings.Contains(baseURL, ":1234") || strings.Contains(baseURL, ":8080") || cfg.APIKey != "" || strings.Contains(baseURL, "openai.com") || strings.Contains(baseURL, "groq.com") || strings.Contains(baseURL, "together.xyz")

	if isOpenAI {
		return queryOpenAI(baseURL, model, prompt, cfg)
	}

	resp, err := queryOllama(baseURL, model, prompt, cfg)
	if err == nil {
		return resp, nil
	}

	if fallbackResp, fallbackErr := queryOpenAI(baseURL, model, prompt, cfg); fallbackErr == nil {
		return fallbackResp, nil
	}

	return "", err
}

func queryGeminiText(baseURL, model, prompt string, cfg Config) (string, error) {
	if cfg.APIKey == "" {
		return "", fmt.Errorf("Gemini API Keyが設定されていません")
	}
	url := buildGeminiURL(baseURL, model, cfg.APIKey)

	parts := []map[string]interface{}{}
	if cfg.SystemPrompt != "" {
		parts = append(parts, map[string]interface{}{
			"text": cfg.SystemPrompt + "\n\n" + prompt,
		})
	} else {
		parts = append(parts, map[string]interface{}{
			"text": prompt,
		})
	}

	payload := map[string]interface{}{
		"contents": []map[string]interface{}{
			{
				"parts": parts,
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

	res, err := client.Do(req)
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

	return strings.TrimSpace(result.Candidates[0].Content.Parts[0].Text), nil
}

// QueryAutocomplete generates a short, inline continuation for the given prefix using Local LLM (LM Studio / Ollama), Gemini, or OpenAI.
func QueryAutocomplete(prefix, suffix string, cfg AutocompleteConfig) (string, error) {
	baseURL := strings.TrimRight(cfg.BaseURL, "/")
	model := cfg.Model
	if model == "" {
		model = "qwen2.5:latest"
	}
	maxTokens := cfg.MaxTokens
	if maxTokens <= 0 || maxTokens > 250 {
		maxTokens = 30
	}

	// Trim prefix to last 1200 chars for low latency
	trimmedPrefix := prefix
	if len(trimmedPrefix) > 1200 {
		trimmedPrefix = trimmedPrefix[len(trimmedPrefix)-1200:]
	}

	isGemini := strings.Contains(baseURL, "googleapis.com") || strings.Contains(model, "gemini")
	if isGemini {
		if cfg.APIKey == "" {
			return "", fmt.Errorf("Gemini API Keyが設定されていません (設定画面で入力してください)")
		}
		return queryGeminiAutocomplete(baseURL, model, trimmedPrefix, maxTokens, cfg.APIKey)
	}

	isOpenAI := strings.Contains(baseURL, "/v1") || strings.Contains(baseURL, ":1234") || strings.Contains(baseURL, ":8080") || strings.Contains(baseURL, ":5000") || strings.Contains(baseURL, ":8000") || (cfg.APIKey != "" && !strings.Contains(baseURL, "localhost") && !strings.Contains(baseURL, "127.0.0.1")) || strings.Contains(baseURL, "openai.com") || strings.Contains(baseURL, "groq.com")
	if isOpenAI {
		return queryOpenAIAutocomplete(baseURL, model, trimmedPrefix, maxTokens, cfg.APIKey)
	}

	if baseURL == "" {
		baseURL = "http://localhost:11434"
	}

	resp, err := queryOllamaAutocomplete(baseURL, model, trimmedPrefix, maxTokens, cfg.APIKey)
	if err == nil && resp != "" {
		return resp, nil
	}

	// Fallback to OpenAI endpoint format only if baseURL did not explicitly fail
	if fallbackResp, fallbackErr := queryOpenAIAutocomplete(baseURL, model, trimmedPrefix, maxTokens, cfg.APIKey); fallbackErr == nil && fallbackResp != "" {
		return fallbackResp, nil
	}

	return resp, err
}

func queryGeminiAutocomplete(baseURL, model, prefix string, maxTokens int, apiKey string) (string, error) {
	url := buildGeminiURL(baseURL, model, apiKey)

	systemInstruction := "You are an inline code and text completion engine. Continue writing directly where the following text ends. Output ONLY the raw immediate next few words or code snippet. Do NOT wrap in code fences, do NOT repeat the input, and do NOT add commentary."
	promptText := fmt.Sprintf("%s\n\n[Text to continue]:\n%s", systemInstruction, prefix)

	payload := map[string]interface{}{
		"contents": []map[string]interface{}{
			{
				"parts": []map[string]interface{}{
					{"text": promptText},
				},
			},
		},
		"generationConfig": map[string]interface{}{
			"maxOutputTokens": maxTokens,
			"temperature":     0.2,
			"stopSequences":   []string{"\n\n", "```"},
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

	res, err := fastClient.Do(req)
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
		return "", nil
	}

	suggestion := result.Candidates[0].Content.Parts[0].Text
	suggestion = cleanSuggestion(suggestion, prefix)
	return suggestion, nil
}

// queryOpenAIAutocomplete attempts /v1/completions (Raw text completion) first for zero-thinking speed in LM Studio/Local LLMs,
// and falls back to /v1/chat/completions.
func queryOpenAIAutocomplete(baseURL, model, prefix string, maxTokens int, apiKey string) (string, error) {
	// 1. Try Raw Text Completion first (Standard in LM Studio, vLLM, llama.cpp, LocalAI)
	// Bypasses chat templates and reasoning loops completely!
	rawTextURL := buildOpenAIURL(baseURL, "completions")
	rawPayload := map[string]interface{}{
		"model":       model,
		"prompt":      prefix,
		"max_tokens":  maxTokens,
		"temperature": 0.1,
		"stop":        []string{"\n#", "\r\n#", "\n\n", "\r\n\r\n", "<think>", "</think>", "<thought>", "</thought>", "```", "<|endoftext|>", "<|im_end|>", "<end_of_turn>"},
	}
	rawBytes, _ := json.Marshal(rawPayload)
	reqRaw, err := http.NewRequest("POST", rawTextURL, bytes.NewReader(rawBytes))
	if err == nil {
		reqRaw.Header.Set("Content-Type", "application/json")
		if apiKey != "" {
			reqRaw.Header.Set("Authorization", "Bearer "+apiKey)
		}
		resRaw, errRaw := fastClient.Do(reqRaw)
		if errRaw == nil {
			defer resRaw.Body.Close()
			if resRaw.StatusCode == http.StatusOK {
				var compResult struct {
					Choices []struct {
						Text string `json:"text"`
					} `json:"choices"`
				}
				if json.NewDecoder(resRaw.Body).Decode(&compResult) == nil && len(compResult.Choices) > 0 {
					text := compResult.Choices[0].Text
					cleaned := cleanSuggestion(text, prefix)
					if cleaned != "" {
						return cleaned, nil
					}
				}
			}
		}
	}

	// 2. Fallback to Chat Completions (/v1/chat/completions)
	chatURL := buildOpenAIURL(baseURL, "chat/completions")
	promptText := fmt.Sprintf("/no_think\nDirect inline autocompletion. Do NOT output any thinking, planning, or reasoning. Output ONLY the raw next continuation words starting directly where the text ends:\n\n%s", prefix)

	messages := []map[string]string{
		{"role": "user", "content": promptText},
	}

	chatPayload := map[string]interface{}{
		"model":       model,
		"messages":    messages,
		"max_tokens":  maxTokens,
		"temperature": 0.1,
		"stop":        []string{"\n#", "\r\n#", "\n\n", "\r\n\r\n", "<think>", "</think>", "<thought>", "</thought>", "```", "<|endoftext|>", "<|im_end|>", "<end_of_turn>"},
		"reasoning":   "off",
		"chat_template_kwargs": map[string]interface{}{
			"enable_thinking": false,
		},
	}

	chatBytes, err := json.Marshal(chatPayload)
	if err != nil {
		return "", err
	}

	reqChat, err := http.NewRequest("POST", chatURL, bytes.NewReader(chatBytes))
	if err != nil {
		return "", err
	}
	reqChat.Header.Set("Content-Type", "application/json")
	if apiKey != "" {
		reqChat.Header.Set("Authorization", "Bearer "+apiKey)
	}

	resChat, err := fastClient.Do(reqChat)
	if err != nil {
		return "", fmt.Errorf("ローカルLLM/API接続エラー (%s): %w", baseURL, err)
	}
	defer resChat.Body.Close()

	if resChat.StatusCode != http.StatusOK {
		respBody, _ := io.ReadAll(resChat.Body)
		return "", fmt.Errorf("APIエラー (%d): %s", resChat.StatusCode, string(respBody))
	}

	var result struct {
		Choices []struct {
			Message struct {
				Content          string `json:"content"`
				ReasoningContent string `json:"reasoning_content"`
			} `json:"message"`
			Text string `json:"text"`
		} `json:"choices"`
	}
	if err := json.NewDecoder(resChat.Body).Decode(&result); err != nil {
		return "", err
	}

	if len(result.Choices) == 0 {
		return "", nil
	}

	rawContent := result.Choices[0].Message.Content
	// If content is empty but model put output in reasoning_content or text
	if strings.TrimSpace(rawContent) == "" {
		if strings.TrimSpace(result.Choices[0].Text) != "" {
			rawContent = result.Choices[0].Text
		} else if strings.TrimSpace(result.Choices[0].Message.ReasoningContent) != "" {
			rContent := result.Choices[0].Message.ReasoningContent
			lines := strings.Split(rContent, "\n")
			for i := len(lines) - 1; i >= 0; i-- {
				l := strings.TrimSpace(lines[i])
				if l != "" && !strings.HasPrefix(l, "*") && !strings.HasPrefix(l, "-") && !strings.HasPrefix(l, "Input") && !strings.HasPrefix(l, "Task") && !strings.HasPrefix(l, "Constraints") && !strings.HasPrefix(l, "Context") && !strings.Contains(l, "thinking process") {
					rawContent = l
					break
				}
			}
		}
	}

	return cleanSuggestion(rawContent, prefix), nil
}

func queryOllamaAutocomplete(baseURL, model, prefix string, maxTokens int, apiKey string) (string, error) {
	systemPrompt := "You are a code and text inline autocompletion assistant. Continue writing directly where the text ends. Output ONLY the raw next few words or code snippet. Do NOT include markdown code fences, do NOT repeat the prompt, and do NOT output greetings or commentary."

	url := fmt.Sprintf("%s/api/generate", strings.TrimRight(baseURL, "/"))
	payload := map[string]interface{}{
		"model":  model,
		"prompt": prefix,
		"system": systemPrompt,
		"stream": false,
		"options": map[string]interface{}{
			"num_predict": maxTokens,
			"temperature": 0.2,
			"stop":        []string{"\n#", "\r\n#", "\n\n", "\r\n\r\n", "<think>", "</think>", "<thought>", "</thought>", "```", "<|endoftext|>", "<|im_end|>", "<end_of_turn>"},
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
	if apiKey != "" {
		req.Header.Set("Authorization", "Bearer "+apiKey)
	}

	res, err := fastClient.Do(req)
	if err != nil {
		return "", fmt.Errorf("Ollama接続エラー (%s): %w", baseURL, err)
	}
	defer res.Body.Close()

	if res.StatusCode != http.StatusOK {
		respBody, _ := io.ReadAll(res.Body)
		return "", fmt.Errorf("Ollama APIエラー (%d): %s", res.StatusCode, string(respBody))
	}

	var result struct {
		Response string `json:"response"`
	}
	if err := json.NewDecoder(res.Body).Decode(&result); err != nil {
		return "", err
	}

	return cleanSuggestion(result.Response, prefix), nil
}

func cleanSuggestion(suggestion, prefix string) string {
	// If suggestion contains <think>, cut off everything starting from <think>
	if idx := strings.Index(suggestion, "<think>"); idx != -1 {
		suggestion = suggestion[:idx]
	}
	if idx := strings.Index(suggestion, "<thought>"); idx != -1 {
		suggestion = suggestion[:idx]
	}

	// Strip <think>...</think> tags if any
	suggestion = reThinkTags.ReplaceAllString(suggestion, "")

	// Remove isolated </think>, </thought>, <think>, <thought>
	suggestion = strings.ReplaceAll(suggestion, "</think>", "")
	suggestion = strings.ReplaceAll(suggestion, "</thought>", "")
	suggestion = strings.ReplaceAll(suggestion, "<think>", "")
	suggestion = strings.ReplaceAll(suggestion, "<thought>", "")

	// Strip common thinking intro phrases
	for _, intro := range []string{
		"Here's a thinking process:",
		"Here is a thinking process:",
		"Thinking Process:",
		"Thought Process:",
		"Thought:",
	} {
		if strings.HasPrefix(strings.TrimSpace(suggestion), intro) {
			idx := strings.Index(suggestion, intro)
			suggestion = suggestion[idx+len(intro):]
		}
	}

	suggestion = strings.TrimPrefix(suggestion, "```markdown")
	suggestion = strings.TrimPrefix(suggestion, "```")
	suggestion = strings.TrimSuffix(suggestion, "```")

	// If suggestion accidentally repeats the prefix or last line of prefix, strip it
	lines := strings.Split(prefix, "\n")
	if len(lines) > 0 {
		lastLine := strings.TrimSpace(lines[len(lines)-1])
		if lastLine != "" && strings.HasPrefix(strings.TrimSpace(suggestion), lastLine) {
			idx := strings.Index(suggestion, lastLine)
			if idx != -1 {
				suggestion = suggestion[idx+len(lastLine):]
			}
		}
	}

	// Remove common conversational preambles if any
	for _, preamble := range []string{
		"Here is the continuation:",
		"Continuation:",
		"以下は続きです:",
		"続き:",
		"Next:",
		"Result:",
	} {
		if strings.HasPrefix(strings.TrimSpace(suggestion), preamble) {
			idx := strings.Index(suggestion, preamble)
			suggestion = suggestion[idx+len(preamble):]
		}
	}

	// If suggestion contains markdown header or double newline, cut off everything after the immediate continuation
	if idx := strings.Index(suggestion, "\n#"); idx != -1 {
		suggestion = suggestion[:idx]
	}
	if idx := strings.Index(suggestion, "\r\n#"); idx != -1 {
		suggestion = suggestion[:idx]
	}
	if idx := strings.Index(suggestion, "\n\n"); idx != -1 {
		suggestion = suggestion[:idx]
	}

	return strings.TrimRight(suggestion, " \t\r\n")
}

// QueryVision sends an image with a prompt to a vision-capable LLM (Gemini or OpenAI Vision).
func QueryVision(prompt string, imageBase64 string, mimeType string, cfg VisionConfig) (string, error) {
	if prompt == "" {
		prompt = "この画像の内容（テキスト、図、表、コードなど）を忠実かつ構造化されたマークダウン形式で書き起こしてください。"
	}
	if mimeType == "" {
		mimeType = "image/png"
	}
	if idx := strings.Index(imageBase64, ","); idx != -1 {
		imageBase64 = imageBase64[idx+1:]
	}
	imageBase64 = strings.TrimSpace(imageBase64)

	baseURL := strings.TrimRight(cfg.BaseURL, "/")
	model := cfg.Model
	if model == "" {
		model = "gemini-flash-lite-latest"
	}

	isGemini := strings.Contains(baseURL, "googleapis.com") || strings.Contains(model, "gemini") || baseURL == ""

	if isGemini {
		if baseURL == "" {
			baseURL = "https://generativelanguage.googleapis.com"
		}
		return queryGeminiVision(baseURL, model, prompt, imageBase64, mimeType, cfg)
	}

	return queryOpenAIVision(baseURL, model, prompt, imageBase64, mimeType, cfg)
}

func queryGeminiVision(baseURL, model, prompt, imageBase64, mimeType string, cfg VisionConfig) (string, error) {
	if cfg.APIKey == "" {
		return "", fmt.Errorf("Gemini API Keyが設定されていません")
	}
	url := buildGeminiURL(baseURL, model, cfg.APIKey)

	payload := map[string]interface{}{
		"contents": []map[string]interface{}{
			{
				"parts": []map[string]interface{}{
					{
						"text": prompt,
					},
					{
						"inline_data": map[string]string{
							"mime_type": mimeType,
							"data":      imageBase64,
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

	res, err := client.Do(req)
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

	return strings.TrimSpace(result.Candidates[0].Content.Parts[0].Text), nil
}

func queryOpenAIVision(baseURL, model, prompt, imageBase64, mimeType string, cfg VisionConfig) (string, error) {
	url := buildOpenAIURL(baseURL, "chat/completions")

	dataURL := fmt.Sprintf("data:%s;base64,%s", mimeType, imageBase64)

	messages := []map[string]interface{}{
		{
			"role": "user",
			"content": []map[string]interface{}{
				{
					"type": "text",
					"text": prompt,
				},
				{
					"type": "image_url",
					"image_url": map[string]string{
						"url": dataURL,
					},
				},
			},
		},
	}

	payload := map[string]interface{}{
		"model":    model,
		"messages": messages,
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
	if cfg.APIKey != "" {
		req.Header.Set("Authorization", "Bearer "+cfg.APIKey)
	}

	res, err := client.Do(req)
	if err != nil {
		return "", fmt.Errorf("Vision API接続エラー: %w", err)
	}
	defer res.Body.Close()

	if res.StatusCode != http.StatusOK {
		respBody, _ := io.ReadAll(res.Body)
		return "", fmt.Errorf("Vision APIエラー (%d): %s", res.StatusCode, string(respBody))
	}

	var result struct {
		Choices []struct {
			Message struct {
				Role    string `json:"role"`
				Content string `json:"content"`
			} `json:"message"`
		} `json:"choices"`
	}
	if err := json.NewDecoder(res.Body).Decode(&result); err != nil {
		return "", err
	}

	if len(result.Choices) == 0 {
		return "", fmt.Errorf("Vision APIから空のレスポンスが返されました")
	}

	return strings.TrimSpace(result.Choices[0].Message.Content), nil
}

func queryOllama(baseURL, model, prompt string, cfg Config) (string, error) {
	url := fmt.Sprintf("%s/api/generate", strings.TrimRight(baseURL, "/"))
	payload := map[string]interface{}{
		"model":  model,
		"prompt": prompt,
		"stream": false,
	}
	if cfg.SystemPrompt != "" {
		payload["system"] = cfg.SystemPrompt
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
	if cfg.APIKey != "" {
		req.Header.Set("Authorization", "Bearer "+cfg.APIKey)
	}

	res, err := client.Do(req)
	if err != nil {
		return "", fmt.Errorf("Ollama接続エラー: %w", err)
	}
	defer res.Body.Close()

	if res.StatusCode != http.StatusOK {
		respBody, _ := io.ReadAll(res.Body)
		return "", fmt.Errorf("Ollama APIエラー (%d): %s", res.StatusCode, string(respBody))
	}

	var result struct {
		Response string `json:"response"`
		Done     bool   `json:"done"`
	}
	if err := json.NewDecoder(res.Body).Decode(&result); err != nil {
		return "", err
	}

	return strings.TrimSpace(result.Response), nil
}

func queryOpenAI(baseURL, model, prompt string, cfg Config) (string, error) {
	url := buildOpenAIURL(baseURL, "chat/completions")

	messages := []map[string]string{}
	if cfg.SystemPrompt != "" {
		messages = append(messages, map[string]string{
			"role":    "system",
			"content": cfg.SystemPrompt,
		})
	}
	messages = append(messages, map[string]string{
		"role":    "user",
		"content": prompt,
	})

	payload := map[string]interface{}{
		"model":    model,
		"messages": messages,
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
	if cfg.APIKey != "" {
		req.Header.Set("Authorization", "Bearer "+cfg.APIKey)
	}

	res, err := client.Do(req)
	if err != nil {
		return "", fmt.Errorf("OpenAI API接続エラー: %w", err)
	}
	defer res.Body.Close()

	if res.StatusCode != http.StatusOK {
		respBody, _ := io.ReadAll(res.Body)
		return "", fmt.Errorf("OpenAI APIエラー (%d): %s", res.StatusCode, string(respBody))
	}

	var result struct {
		Choices []struct {
			Message struct {
				Role    string `json:"role"`
				Content string `json:"content"`
			} `json:"message"`
		} `json:"choices"`
	}
	if err := json.NewDecoder(res.Body).Decode(&result); err != nil {
		return "", err
	}

	if len(result.Choices) == 0 {
		return "", fmt.Errorf("empty choices from LLM")
	}

	return strings.TrimSpace(result.Choices[0].Message.Content), nil
}

// GenerateImage calls Gemini image generation (gemini-3.1-flash-lite-image / imagen-3) and returns raw image bytes and mimeType.
func GenerateImage(prompt string, cfg ImageGenConfig) ([]byte, string, error) {
	if cfg.APIKey == "" {
		return nil, "", fmt.Errorf("Gemini API Keyが設定されていません")
	}
	baseURL := strings.TrimRight(cfg.BaseURL, "/")
	if baseURL == "" {
		baseURL = "https://generativelanguage.googleapis.com"
	}
	model := cfg.Model
	if model == "" {
		model = "gemini-3.1-flash-lite-image"
	}
	aspectRatio := cfg.AspectRatio
	if aspectRatio == "" {
		aspectRatio = "16:9"
	}

	// 1. If Imagen model is requested, use :predict endpoint
	if strings.HasPrefix(model, "imagen-") {
		return generateImagen(baseURL, model, prompt, cfg.APIKey)
	}

	// 2. Default: Gemini generateContent with responseModalities / responseFormat image
	return generateGeminiImage(baseURL, model, prompt, aspectRatio, cfg.APIKey)
}

func generateGeminiImage(baseURL, model, prompt, aspectRatio, apiKey string) ([]byte, string, error) {
	url := fmt.Sprintf("%s/v1beta/models/%s:generateContent?key=%s", baseURL, strings.TrimPrefix(model, "models/"), apiKey)

	payload := map[string]interface{}{
		"contents": []map[string]interface{}{
			{
				"parts": []map[string]interface{}{
					{"text": prompt},
				},
			},
		},
		"generationConfig": map[string]interface{}{
			"responseModalities": []string{"IMAGE", "TEXT"},
			"responseFormat": map[string]interface{}{
				"image": map[string]interface{}{
					"aspectRatio": aspectRatio,
				},
			},
		},
	}

	bodyBytes, err := json.Marshal(payload)
	if err != nil {
		return nil, "", err
	}

	req, err := http.NewRequest("POST", url, bytes.NewReader(bodyBytes))
	if err != nil {
		return nil, "", err
	}
	req.Header.Set("Content-Type", "application/json")

	res, err := client.Do(req)
	if err != nil {
		return nil, "", fmt.Errorf("Gemini Image API接続エラー: %w", err)
	}
	defer res.Body.Close()

	if res.StatusCode != http.StatusOK {
		respBody, _ := io.ReadAll(res.Body)
		return nil, "", fmt.Errorf("Gemini Image APIエラー (%d): %s", res.StatusCode, string(respBody))
	}

	var result struct {
		Candidates []struct {
			Content struct {
				Parts []struct {
					Text       string `json:"text"`
					InlineData *struct {
						MimeType string `json:"mimeType"`
						Data     string `json:"data"`
					} `json:"inlineData"`
				} `json:"parts"`
			} `json:"content"`
		} `json:"candidates"`
	}

	if err := json.NewDecoder(res.Body).Decode(&result); err != nil {
		return nil, "", err
	}

	if len(result.Candidates) > 0 {
		for _, part := range result.Candidates[0].Content.Parts {
			if part.InlineData != nil && part.InlineData.Data != "" {
				mime := part.InlineData.MimeType
				if mime == "" {
					mime = "image/png"
				}
				data := part.InlineData.Data
				return []byte(data), mime, nil
			}
		}
	}

	return nil, "", fmt.Errorf("Geminiから画像データが返されませんでした")
}

func generateImagen(baseURL, model, prompt, apiKey string) ([]byte, string, error) {
	url := fmt.Sprintf("%s/v1beta/models/%s:predict?key=%s", baseURL, strings.TrimPrefix(model, "models/"), apiKey)

	payload := map[string]interface{}{
		"instances": []map[string]interface{}{
			{"prompt": prompt},
		},
		"parameters": map[string]interface{}{
			"sampleCount": 1,
		},
	}

	bodyBytes, err := json.Marshal(payload)
	if err != nil {
		return nil, "", err
	}

	req, err := http.NewRequest("POST", url, bytes.NewReader(bodyBytes))
	if err != nil {
		return nil, "", err
	}
	req.Header.Set("Content-Type", "application/json")

	res, err := client.Do(req)
	if err != nil {
		return nil, "", fmt.Errorf("Imagen API接続エラー: %w", err)
	}
	defer res.Body.Close()

	if res.StatusCode != http.StatusOK {
		respBody, _ := io.ReadAll(res.Body)
		return nil, "", fmt.Errorf("Imagen APIエラー (%d): %s", res.StatusCode, string(respBody))
	}

	var result struct {
		Predictions []struct {
			BytesBase64Encoded string `json:"bytesBase64Encoded"`
			MimeType           string `json:"mimeType"`
		} `json:"predictions"`
	}

	if err := json.NewDecoder(res.Body).Decode(&result); err != nil {
		return nil, "", err
	}

	if len(result.Predictions) > 0 && result.Predictions[0].BytesBase64Encoded != "" {
		mime := result.Predictions[0].MimeType
		if mime == "" {
			mime = "image/png"
		}
		return []byte(result.Predictions[0].BytesBase64Encoded), mime, nil
	}

	return nil, "", fmt.Errorf("Imagenから画像データが返されませんでした")
}
