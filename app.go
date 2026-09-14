package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"runtime/debug"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"md-memo/pkg/dialog"
	"md-memo/pkg/encoding"
	"md-memo/pkg/llm"
	"md-memo/pkg/markdownutil"
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
	cliCancels  sync.Map // reqID -> context.CancelFunc
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

// CommandResult represents the output from executing an external CLI filter.
type CommandResult struct {
	Output   string `json:"output"`
	Error    string `json:"error"`
	ExitCode int    `json:"exitCode"`
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
	debug.FreeOSMemory()
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

// ExportConfig exports current settings to a user-chosen JSON file using native save file dialog.
func (a *App) ExportConfig(configJSON string) (bool, error) {
	path, err := dialog.SaveFileDialog("設定をエクスポート", "md-memo-config.json")
	if err != nil {
		return false, fmt.Errorf("ファイルダイアログエラー: %w", err)
	}
	if path == "" {
		return false, nil // User cancelled
	}
	if err := os.WriteFile(path, []byte(configJSON), 0600); err != nil {
		return false, fmt.Errorf("設定ファイルのエクスポートに失敗しました: %w", err)
	}
	return true, nil
}

// ImportConfig imports settings from a user-chosen JSON file using native open file dialog.
func (a *App) ImportConfig() (string, error) {
	path, err := dialog.OpenFileDialog("設定をインポート")
	if err != nil {
		return "", fmt.Errorf("ファイルダイアログエラー: %w", err)
	}
	if path == "" {
		return "", nil // User cancelled
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return "", fmt.Errorf("設定ファイルの読み込みに失敗しました: %w", err)
	}
	content, _, err := encoding.DetectAndDecode(data)
	if err != nil {
		return "", fmt.Errorf("設定ファイルのデコードに失敗しました: %w", err)
	}
	return content, nil
}

var (
	psRangeRegex    = regexp.MustCompile(`\b\d+\.\.\d+\b`)
	psVerbNounRegex = regexp.MustCompile(`(?i)\b(Get|Set|New|Remove|Test|Start|Stop|Restart|Invoke|Write|Read|Clear|Copy|Move|Rename|Select|Measure)-[A-Za-z]+\b`)
)

// isPowerShellSyntax returns true if the command appears to use PowerShell-specific syntax or cmdlets.
func isPowerShellSyntax(cmdStr string) bool {
	trimmed := strings.TrimSpace(cmdStr)
	lower := strings.ToLower(trimmed)

	if strings.HasPrefix(lower, "powershell") || strings.HasPrefix(lower, "pwsh") {
		return true
	}

	psKeywords := []string{
		"$_", "$psitem", "$true", "$false", "$null",
		"$(", "${",
		"foreach-object", "where-object", "select-object", "measure-object",
		"sort-object", "group-object", "compare-object",
		"get-content", "set-content", "out-string", "out-file", "out-null",
		"test-connection", "test-path", "test-netconnection",
		"invoke-webrequest", "invoke-restmethod", "invoke-expression",
		"| %", "| ?", "| %{", "| ?{",
	}
	for _, kw := range psKeywords {
		if strings.Contains(lower, kw) {
			return true
		}
	}

	if psRangeRegex.MatchString(trimmed) {
		return true
	}
	if psVerbNounRegex.MatchString(trimmed) {
		return true
	}
	if strings.Contains(trimmed, "{") && strings.Contains(trimmed, "}") {
		return true
	}

	return false
}

func runSingleShell(ctx context.Context, shellType, trimmed, input string) (string, string, int, error) {
	var cmd *exec.Cmd
	if runtime.GOOS == "windows" {
		if shellType == "powershell" {
			shellExe := "powershell.exe"
			if p, lookErr := exec.LookPath("pwsh.exe"); lookErr == nil && p != "" {
				shellExe = p
			}
			psScript := "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; " + trimmed
			cmd = exec.CommandContext(ctx, shellExe, "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", psScript)
		} else {
			cmd = exec.CommandContext(ctx, "cmd.exe", "/c", trimmed)
		}
	} else {
		cmd = exec.CommandContext(ctx, "sh", "-c", trimmed)
	}

	setupCmdProcessTreeKill(cmd)
	setCmdWindowFlags(cmd)
	cmd.Stdin = strings.NewReader(input)
	var stdoutBuf, stderrBuf strings.Builder
	cmd.Stdout = &stdoutBuf
	cmd.Stderr = &stderrBuf

	err := cmd.Run()
	exitCode := 0
	stderr := strings.TrimSpace(stderrBuf.String())
	stdout := stdoutBuf.String()

	if err != nil {
		if ctx.Err() == context.Canceled {
			exitCode = 130
			stderr = "Command was cancelled by user"
		} else if ctx.Err() == context.DeadlineExceeded {
			exitCode = 124
			stderr = "Command timed out (30s limit exceeded)"
		} else if exitErr, ok := err.(*exec.ExitError); ok {
			exitCode = exitErr.ExitCode()
		} else {
			exitCode = 1
		}
		if stderr == "" {
			stderr = err.Error()
		}
	}
	return stdout, stderr, exitCode, err
}

func executeCli(ctx context.Context, trimmed, input string) (*CommandResult, error) {
	if runtime.GOOS != "windows" {
		stdout, stderr, exitCode, err := runSingleShell(ctx, "sh", trimmed, input)
		return &CommandResult{Output: stdout, Error: stderr, ExitCode: exitCode}, err
	}

	preferPS := isPowerShellSyntax(trimmed)
	primaryShell := "cmd"
	fallbackShell := "powershell"
	if preferPS {
		primaryShell = "powershell"
		fallbackShell = "cmd"
	}

	stdout, stderr, exitCode, err := runSingleShell(ctx, primaryShell, trimmed, input)
	if err == nil && exitCode == 0 {
		return &CommandResult{Output: stdout, Error: stderr, ExitCode: 0}, nil
	}

	if ctx.Err() != nil {
		return &CommandResult{Output: stdout, Error: stderr, ExitCode: exitCode}, err
	}

	shouldFallback := false
	if primaryShell == "cmd" {
		lowerErr := strings.ToLower(stderr)
		if strings.Contains(lowerErr, "not recognized") ||
			strings.Contains(stderr, "認識されていません") ||
			strings.Contains(lowerErr, "syntax of the command is incorrect") ||
			strings.Contains(stderr, "構文が誤っています") ||
			strings.Contains(lowerErr, "cannot find the file specified") ||
			strings.Contains(stderr, "指定されたファイルが見つかりません") {
			shouldFallback = true
		}
	}

	if shouldFallback {
		fbStdout, fbStderr, fbExitCode, fbErr := runSingleShell(ctx, fallbackShell, trimmed, input)
		if fbErr == nil && fbExitCode == 0 {
			return &CommandResult{Output: fbStdout, Error: fbStderr, ExitCode: 0}, nil
		}
		if fbStdout != "" || fbExitCode == 0 {
			return &CommandResult{Output: fbStdout, Error: fbStderr, ExitCode: fbExitCode}, fbErr
		}
	}

	return &CommandResult{Output: stdout, Error: stderr, ExitCode: exitCode}, err
}

// RunCommandFilter executes an external command with input fed into standard input and returns stdout/stderr.
func (a *App) RunCommandFilter(cmdStr string, input string) (*CommandResult, error) {
	trimmed := strings.TrimSpace(cmdStr)
	if trimmed == "" {
		return &CommandResult{ExitCode: 1, Error: "コマンドが指定されていません"}, nil
	}

	val := validateCliCommand(trimmed)
	if val.IsBlocked {
		return &CommandResult{ExitCode: 126, Error: val.Reason}, nil
	}

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	return executeCli(ctx, trimmed, input)
}

func setupCmdProcessTreeKill(cmd *exec.Cmd) {
	if runtime.GOOS == "windows" {
		cmd.Cancel = func() error {
			if cmd.Process != nil && cmd.Process.Pid > 0 {
				killCmd := exec.Command("taskkill", "/PID", strconv.Itoa(cmd.Process.Pid), "/T", "/F")
				return killCmd.Run()
			}
			return nil
		}
	}
}

// RunCommandFilterAsync executes an external command in a background goroutine and dispatches the result to webview.
func (a *App) RunCommandFilterAsync(reqID, cmdStr, input string) {
	go func() {
		trimmed := strings.TrimSpace(cmdStr)
		if trimmed == "" {
			a.dispatchCliResult(reqID, &CommandResult{ExitCode: 1, Error: "コマンドが指定されていません"}, nil)
			return
		}

		val := validateCliCommand(trimmed)
		if val.IsBlocked {
			a.dispatchCliResult(reqID, &CommandResult{ExitCode: 126, Error: val.Reason}, nil)
			return
		}

		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		a.cliCancels.Store(reqID, cancel)
		defer func() {
			cancel()
			a.cliCancels.Delete(reqID)
		}()

		res, err := executeCli(ctx, trimmed, input)
		if atomic.LoadInt32(&a.isDestroyed) != 0 {
			return
		}

		a.dispatchCliResult(reqID, res, err)
	}()
}

func (a *App) dispatchCliResult(reqID string, res *CommandResult, err error) {
	if atomic.LoadInt32(&a.isDestroyed) != 0 || a.w == nil {
		return
	}
	resJSON, _ := json.Marshal(res)
	errStr := ""
	if err != nil && res.Error == "" {
		errStr = err.Error()
	}
	errJSON, _ := json.Marshal(errStr)

	a.w.Dispatch(func() {
		if atomic.LoadInt32(&a.isDestroyed) == 0 {
			js := fmt.Sprintf("if (window.__onCliFilterResult) { window.__onCliFilterResult(%q, %s, %s); }", reqID, string(resJSON), string(errJSON))
			a.w.Eval(js)
		}
	})
}

// CancelCommandFilter cancels a running CLI filter command by its request ID.
func (a *App) CancelCommandFilter(reqID string) {
	if val, ok := a.cliCancels.Load(reqID); ok {
		if cancel, ok := val.(context.CancelFunc); ok {
			cancel()
		}
		a.cliCancels.Delete(reqID)
	}
}

// UpdateGlobalShortcut dynamically updates OS-level global shortcut for summoning window.
func (a *App) UpdateGlobalShortcut(shortcutStr string) (bool, error) {
	ok := updateGlobalHotKeyNative(shortcutStr)
	return ok, nil
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
