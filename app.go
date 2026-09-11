package main

import (
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync/atomic"
	"time"

	"mdnotepad/pkg/dialog"
	"mdnotepad/pkg/encoding"
	"mdnotepad/pkg/llm"
	"mdnotepad/pkg/markdownutil"
)

// WebViewInstance represents any platform-specific webview window capable of dispatching JS evaluations.
type WebViewInstance interface {
	Dispatch(func())
	Eval(string)
}

// App provides Go methods callable from JS inside WebView.
type App struct {
	w           WebViewInstance
	isDestroyed int32
}

type FileResult struct {
	Path     string `json:"path"`
	Title    string `json:"title"`
	Content  string `json:"content"`
	Encoding string `json:"encoding"`
}

type SaveResult struct {
	Path    string `json:"path"`
	Title   string `json:"title"`
	Success bool   `json:"success"`
}

type FolderEntry struct {
	Path    string `json:"path"`
	RelPath string `json:"relPath"`
	Title   string `json:"title"`
	Snippet string `json:"snippet"`
}

func getConfigFilePath() string {
	configDir, err := os.UserConfigDir()
	if err != nil {
		configDir = "."
	}
	appDir := filepath.Join(configDir, "md-memo")
	_ = os.MkdirAll(appDir, 0755)
	return filepath.Join(appDir, "config.json")
}

// TrimMemory releases OS memory and triggers process working set compression
func (a *App) TrimMemory() error {
	trimProcessWorkingSet()
	return nil
}

// CloseWindow requests the host window to close and destroy itself
func (a *App) CloseWindow() error {
	atomic.StoreInt32(&a.isDestroyed, 1)
	if a.w != nil {
		a.w.Dispatch(func() {
			if closer, ok := a.w.(interface{ Destroy() }); ok {
				closer.Destroy()
			}
		})
	}
	return nil
}

// OpenExternal safely opens a validated HTTP/HTTPS URL in the user's default external browser.
func (a *App) OpenExternal(targetURL string) error {
	u, err := url.Parse(targetURL)
	if err != nil {
		return fmt.Errorf("URLの解析に失敗しました: %w", err)
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return fmt.Errorf("許可されていないURLスキームです: %s", u.Scheme)
	}

	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "windows":
		cmd = exec.Command("rundll32", "url.dll,FileProtocolHandler", u.String())
	case "darwin":
		cmd = exec.Command("open", u.String())
	default:
		cmd = exec.Command("xdg-open", u.String())
	}
	return cmd.Start()
}

// GetConfig reads configuration from the persistent local JSON file in AppData / ~/.config.
func (a *App) GetConfig() (string, error) {
	path := getConfigFilePath()
	data, err := os.ReadFile(path)
	if err != nil {
		return "", nil // No config saved yet
	}
	return string(data), nil
}

// SaveConfig saves configuration to the persistent local JSON file in AppData / ~/.config.
func (a *App) SaveConfig(configJSON string) (bool, error) {
	path := getConfigFilePath()
	if err := os.WriteFile(path, []byte(configJSON), 0600); err != nil {
		return false, fmt.Errorf("設定ファイルの書き込みに失敗しました: %w", err)
	}
	return true, nil
}

func getSessionFilePath() string {
	configDir, err := os.UserConfigDir()
	if err != nil {
		configDir = "."
	}
	appDir := filepath.Join(configDir, "md-memo")
	_ = os.MkdirAll(appDir, 0755)
	return filepath.Join(appDir, "session.json")
}

// GetSession reads the saved session (open tabs, unsaved buffer) from session.json in AppData / ~/.config.
func (a *App) GetSession() (string, error) {
	path := getSessionFilePath()
	data, err := os.ReadFile(path)
	if err != nil {
		return "", nil // No session saved yet
	}
	return string(data), nil
}

// SaveSession saves the current session (open tabs, unsaved buffer) to session.json in AppData / ~/.config.
func (a *App) SaveSession(sessionJSON string) (bool, error) {
	path := getSessionFilePath()
	if err := os.WriteFile(path, []byte(sessionJSON), 0600); err != nil {
		return false, fmt.Errorf("セッションファイルの書き込みに失敗しました: %w", err)
	}
	return true, nil
}

// GetStartupFile checks if a file path was passed via command line arguments (e.g. file association double-click).
func (a *App) GetStartupFile() (*FileResult, error) {
	for _, arg := range os.Args[1:] {
		if strings.HasPrefix(arg, "-") {
			continue
		}
		cleanPath := strings.Trim(arg, "\"")
		cleanPath = strings.Trim(cleanPath, "'")
		if cleanPath == "" {
			continue
		}
		if info, err := os.Stat(cleanPath); err == nil && !info.IsDir() {
			absPath, err := filepath.Abs(cleanPath)
			if err != nil {
				absPath = cleanPath
			}
			raw, err := os.ReadFile(absPath)
			if err != nil {
				return nil, fmt.Errorf("起動ファイルの読み込みに失敗しました: %w", err)
			}
			content, enc, err := encoding.DetectAndDecode(raw)
			if err != nil {
				return nil, fmt.Errorf("起動ファイルの文字コードデコードに失敗しました: %w", err)
			}
			return &FileResult{
				Path:     absPath,
				Title:    filepath.Base(absPath),
				Content:  content,
				Encoding: enc,
			}, nil
		}
	}
	return nil, nil
}

// OpenFile opens a native platform file dialog and reads text files (Markdown, JSON, YAML, code).
func (a *App) OpenFile() (*FileResult, error) {
	path, err := dialog.OpenFileDialog("ファイルを開く")
	if err != nil {
		return nil, fmt.Errorf("ファイルダイアログエラー: %w", err)
	}
	if path == "" {
		return nil, nil // User cancelled
	}

	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("ファイルの読み込みに失敗しました: %w", err)
	}

	content, enc, err := encoding.DetectAndDecode(raw)
	if err != nil {
		return nil, fmt.Errorf("文字コードのデコードに失敗しました: %w", err)
	}

	title := filepath.Base(path)
	return &FileResult{
		Path:     path,
		Title:    title,
		Content:  content,
		Encoding: enc,
	}, nil
}

// ReadFileByPath reads a specific file directly by path without displaying a dialog.
func (a *App) ReadFileByPath(path string) (*FileResult, error) {
	if path == "" {
		return nil, fmt.Errorf("パスが空です")
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("ファイルの読み込みに失敗しました: %w", err)
	}
	content, enc, err := encoding.DetectAndDecode(raw)
	if err != nil {
		return nil, fmt.Errorf("文字コードのデコードに失敗しました: %w", err)
	}
	return &FileResult{
		Path:     path,
		Title:    filepath.Base(path),
		Content:  content,
		Encoding: enc,
	}, nil
}

// OpenFolder opens a folder dialog and returns selected directory path.
func (a *App) OpenFolder() (string, error) {
	return dialog.OpenFolderDialog("メモフォルダを選択")
}

// ScanFolderFiles scans a folder for markdown and text files with strict timeout, depth limits, and safety boundaries.
func (a *App) ScanFolderFiles(rootPath string) ([]FolderEntry, error) {
	if rootPath == "" {
		return nil, nil
	}
	cleanRoot := filepath.Clean(rootPath)
	info, err := os.Stat(cleanRoot)
	if err != nil || !info.IsDir() {
		return nil, fmt.Errorf("指定されたフォルダにアクセスできません: %w", err)
	}

	var entries []FolderEntry
	validExts := map[string]bool{
		".md": true, ".markdown": true, ".txt": true,
	}

	startTime := time.Now()
	timeout := 2500 * time.Millisecond
	totalScannedFiles := 0
	const maxEntries = 300
	const maxScannedFiles = 1500
	const maxDepth = 3

	// Normalized clean root for depth comparison
	cleanRootSlash := filepath.ToSlash(cleanRoot)
	rootDepth := len(strings.Split(strings.Trim(cleanRootSlash, "/"), "/"))

	_ = filepath.Walk(cleanRoot, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return nil
		}

		// Check timeout & quota
		if time.Since(startTime) > timeout || len(entries) >= maxEntries || totalScannedFiles >= maxScannedFiles {
			return filepath.SkipDir
		}

		// Depth calculation
		currentSlash := filepath.ToSlash(path)
		currentDepth := len(strings.Split(strings.Trim(currentSlash, "/"), "/")) - rootDepth
		if currentDepth > maxDepth {
			if info.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}

		if info.IsDir() {
			name := strings.ToLower(info.Name())
			if strings.HasPrefix(name, ".") && name != "." {
				return filepath.SkipDir
			}
			// Skip heavy or system directories
			if name == "node_modules" || name == ".git" || name == "appdata" || name == "vendor" ||
				name == "$recycle.bin" || name == "system volume information" || name == "windows" {
				return filepath.SkipDir
			}
			return nil
		}

		totalScannedFiles++
		ext := strings.ToLower(filepath.Ext(path))
		if !validExts[ext] {
			return nil
		}

		rel, _ := filepath.Rel(cleanRoot, path)
		title := info.Name()
		snippet := ""

		// Read up to 2KB to extract first heading or first non-empty line
		f, err := os.Open(path)
		if err == nil {
			buf := make([]byte, 2048)
			n, _ := f.Read(buf)
			f.Close()
			if n > 0 {
				text, _, _ := encoding.DetectAndDecode(buf[:n])
				lines := strings.Split(text, "\n")
				for _, line := range lines {
					trimmed := strings.TrimSpace(line)
					if trimmed != "" {
						if strings.HasPrefix(trimmed, "#") {
							title = strings.TrimSpace(strings.TrimLeft(trimmed, "#"))
						} else if snippet == "" {
							snippet = trimmed
						}
					}
					if snippet != "" && title != info.Name() {
						break
					}
				}
				if snippet == "" && len(lines) > 0 {
					snippet = strings.TrimSpace(lines[0])
				}
			}
		}

		entries = append(entries, FolderEntry{
			Path:    path,
			RelPath: filepath.ToSlash(rel),
			Title:   title,
			Snippet: snippet,
		})

		return nil
	})

	return entries, nil
}

// SaveFile writes text to the existing path using specified encoding (as-is original).
func (a *App) SaveFile(path, content, enc string) (*SaveResult, error) {
	if path == "" {
		return a.SaveFileAs(content, enc, "")
	}

	encoded, err := encoding.Encode(content, enc)
	if err != nil {
		return nil, fmt.Errorf("エンコードエラー: %w", err)
	}

	if err := os.WriteFile(path, encoded, 0644); err != nil {
		return nil, fmt.Errorf("ファイルの保存に失敗しました: %w", err)
	}

	return &SaveResult{
		Path:    path,
		Title:   filepath.Base(path),
		Success: true,
	}, nil
}

// SaveFileAs opens a native Save dialog and writes text (as-is original).
func (a *App) SaveFileAs(content, enc, defaultName string) (*SaveResult, error) {
	if defaultName == "" {
		defaultName = "無題.md"
	}

	path, err := dialog.SaveFileDialog("名前を付けて保存", defaultName)
	if err != nil {
		return nil, fmt.Errorf("保存ダイアログエラー: %w", err)
	}
	if path == "" {
		return nil, nil // User cancelled
	}

	encoded, err := encoding.Encode(content, enc)
	if err != nil {
		return nil, fmt.Errorf("エンコードエラー: %w", err)
	}

	if err := os.WriteFile(path, encoded, 0644); err != nil {
		return nil, fmt.Errorf("ファイルの保存に失敗しました: %w", err)
	}

	return &SaveResult{
		Path:    path,
		Title:   filepath.Base(path),
		Success: true,
	}, nil
}

// ExportPlainTextAs removes markdown formatting and exports clean plain text to a new file.
func (a *App) ExportPlainTextAs(content, enc, defaultName string) (*SaveResult, error) {
	if defaultName == "" {
		defaultName = "エクスポート.txt"
	}
	if filepath.Ext(defaultName) != ".txt" {
		defaultName = filepath.Base(defaultName) + ".txt"
	}

	path, err := dialog.SaveFileDialog("装飾なしテキストとしてエクスポート", defaultName)
	if err != nil {
		return nil, fmt.Errorf("エクスポートダイアログエラー: %w", err)
	}
	if path == "" {
		return nil, nil // User cancelled
	}

	plainText := markdownutil.StripMarkdown(content)
	encoded, err := encoding.Encode(plainText, enc)
	if err != nil {
		return nil, fmt.Errorf("エンコードエラー: %w", err)
	}

	if err := os.WriteFile(path, encoded, 0644); err != nil {
		return nil, fmt.Errorf("テキストエクスポートに失敗しました: %w", err)
	}

	return &SaveResult{
		Path:    path,
		Title:   filepath.Base(path),
		Success: true,
	}, nil
}

// QueryLLMAsync executes text LLM request in a background goroutine and dispatches result to webview.
func (a *App) QueryLLMAsync(reqID, prompt, configJSON string) {
	go func() {
		var cfg llm.Config
		_ = json.Unmarshal([]byte(configJSON), &cfg)

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
				configDir, _ := os.UserConfigDir()
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
