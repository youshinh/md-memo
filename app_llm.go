package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"time"

	"md-memo/pkg/appdir"
	"md-memo/pkg/llm"
)

// QueryLLMAsync executes text LLM request in a background goroutine and dispatches result to webview.
func (a *App) QueryLLMAsync(reqID, prompt, configJSON string) {
	go func() {
		var cfg llm.Config
		_ = json.Unmarshal([]byte(configJSON), &cfg)

		if llm.IsOllamaURL(cfg.BaseURL) && !llm.CheckOllamaHealth(cfg.BaseURL) {
			_ = a.EnsureOllamaRunning(6 * time.Second)
		}

		resp, err := llm.Query(prompt, cfg)
		if atomic.LoadInt32(&a.isDestroyed) != 0 {
			return
		}

		errStr := ""
		if err != nil {
			errStr = err.Error()
		}

		respJSON, _ := json.Marshal(resp)
		errJSON, _ := json.Marshal(errStr)

		if a.w != nil {
			a.w.Dispatch(func() {
				if atomic.LoadInt32(&a.isDestroyed) == 0 {
					js := fmt.Sprintf("if (window.__onLLMResult) { window.__onLLMResult(%q, %s, %s); }", reqID, string(respJSON), string(errJSON))
					a.w.Eval(js)
				}
			})
		}
	}()
}

// QueryVisionAsync executes Gemini Vision image transcription in a background goroutine.
func (a *App) QueryVisionAsync(reqID, prompt, imageBase64, mimeType, configJSON string) {
	go func() {
		var cfg llm.VisionConfig
		_ = json.Unmarshal([]byte(configJSON), &cfg)

		resp, err := llm.QueryVision(prompt, imageBase64, mimeType, cfg)
		if atomic.LoadInt32(&a.isDestroyed) != 0 {
			return
		}

		errStr := ""
		if err != nil {
			errStr = err.Error()
		}

		respJSON, _ := json.Marshal(resp)
		errJSON, _ := json.Marshal(errStr)

		if a.w != nil {
			a.w.Dispatch(func() {
				if atomic.LoadInt32(&a.isDestroyed) == 0 {
					js := fmt.Sprintf("if (window.__onLLMResult) { window.__onLLMResult(%q, %s, %s); }", reqID, string(respJSON), string(errJSON))
					a.w.Eval(js)
				}
			})
		}
	}()
}

// AutocompleteAsync executes local or cloud LLM completion in a fast background goroutine.
func (a *App) AutocompleteAsync(reqID string, prefix string, suffix string, configJSON string) {
	go func() {
		var cfg llm.AutocompleteConfig
		_ = json.Unmarshal([]byte(configJSON), &cfg)

		if !cfg.Enabled {
			return
		}

		if llm.IsOllamaURL(cfg.BaseURL) && !llm.CheckOllamaHealth(cfg.BaseURL) {
			_ = a.EnsureOllamaRunning(4 * time.Second)
		}

		suggestion, err := llm.QueryAutocomplete(prefix, suffix, cfg)
		if atomic.LoadInt32(&a.isDestroyed) != 0 {
			return
		}

		errMsg := ""
		if err != nil {
			errMsg = err.Error()
		}

		resJSON, _ := json.Marshal(suggestion)
		errJSON, _ := json.Marshal(errMsg)

		if a.w != nil {
			a.w.Dispatch(func() {
				if atomic.LoadInt32(&a.isDestroyed) == 0 {
					js := fmt.Sprintf("if (window.__onAutocompleteResult) { window.__onAutocompleteResult(%q, %s, %s); }", reqID, string(resJSON), string(errJSON))
					a.w.Eval(js)
				}
			})
		}
	}()
}

// GenerateImageAsync executes Gemini/Imagen image generation in background, saves image, and dispatches result.
func (a *App) GenerateImageAsync(reqID, prompt, configJSON, notePath string) {
	go func() {
		var cfg llm.ImageGenConfig
		_ = json.Unmarshal([]byte(configJSON), &cfg)

		data, mime, err := llm.GenerateImage(prompt, cfg)
		if atomic.LoadInt32(&a.isDestroyed) != 0 {
			return
		}

		errStr := ""
		imgMarkdown := ""

		if err != nil {
			errStr = err.Error()
		} else {
			// Save generated image to assets folder relative to notePath, or default AppData
			ext := ".png"
			if strings.Contains(mime, "jpeg") || strings.Contains(mime, "jpg") {
				ext = ".jpg"
			} else if strings.Contains(mime, "webp") {
				ext = ".webp"
			}

			fileName := fmt.Sprintf("diagram_%d%s", time.Now().UnixNano(), ext)
			var targetDir string
			var relMarkdownPath string

			if notePath != "" && filepath.IsAbs(notePath) {
				noteDir := filepath.Dir(notePath)
				targetDir = filepath.Join(noteDir, "assets")
				_ = os.MkdirAll(targetDir, 0755)
				relMarkdownPath = fmt.Sprintf("assets/%s", fileName)
			} else {
				configDir, _ := appdir.ConfigDir()
				if configDir == "" {
					configDir = "."
				}
				targetDir = filepath.Join(configDir, "md-memo", "assets")
				_ = os.MkdirAll(targetDir, 0755)
				relMarkdownPath = filepath.Join(targetDir, fileName)
			}

			fullPath := filepath.Join(targetDir, fileName)
			saveErr := os.WriteFile(fullPath, data, 0644)
			if saveErr != nil {
				errStr = fmt.Sprintf("画像の保存に失敗しました: %v", saveErr)
			} else {
				imgMarkdown = fmt.Sprintf("![Generated Diagram](%s)", filepath.ToSlash(relMarkdownPath))
			}
		}

		respJSON, _ := json.Marshal(imgMarkdown)
		errJSON, _ := json.Marshal(errStr)

		if a.w != nil {
			a.w.Dispatch(func() {
				if atomic.LoadInt32(&a.isDestroyed) == 0 {
					js := fmt.Sprintf("if (window.__onLLMResult) { window.__onLLMResult(%q, %s, %s); }", reqID, string(respJSON), string(errJSON))
					a.w.Eval(js)
				}
			})
		}
	}()
}

// DetectLLMProvider reports which wire protocol the given endpoint would be talked to with,
// using the exact same heuristic llm.Query itself applies. It performs no network I/O.
func (a *App) DetectLLMProvider(baseURL, apiKey string) string {
	return string(llm.DetectProvider(baseURL, "", apiKey))
}
