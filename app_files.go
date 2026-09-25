package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync/atomic"
	"time"

	"md-memo/pkg/appdir"
	"md-memo/pkg/dialog"
	"md-memo/pkg/encoding"
	"md-memo/pkg/markdownutil"
)

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

// validateExternalURL parses targetURL and allows only the http, https and vscode schemes.
// Kept separate from OpenExternal so tests can check validation without launching anything.
func validateExternalURL(targetURL string) (*url.URL, error) {
	u, err := url.Parse(targetURL)
	if err != nil {
		return nil, fmt.Errorf("URLの解析に失敗しました: %w", err)
	}
	if u.Scheme != "http" && u.Scheme != "https" && u.Scheme != "vscode" {
		return nil, fmt.Errorf("許可されていないURLスキームです: %s", u.Scheme)
	}
	return u, nil
}

// externalOpenCommandFor returns the external-command name and arguments used to open target
// (a URL or file path) with the OS default handler on goos. Extracted from OpenExternal so a
// Windows `go test` run can exercise the darwin/linux branches directly; tests must not
// actually execute the returned command.
func externalOpenCommandFor(goos, target string) (name string, args []string) {
	switch goos {
	case "windows":
		return "rundll32", []string{"url.dll,FileProtocolHandler", target}
	case "darwin":
		return "open", []string{target}
	default:
		return "xdg-open", []string{target}
	}
}

// OpenExternal safely opens a validated HTTP/HTTPS URL in the user's default external browser.
func (a *App) OpenExternal(targetURL string) error {
	u, err := validateExternalURL(targetURL)
	if err != nil {
		return err
	}

	name, args := externalOpenCommandFor(runtime.GOOS, u.String())
	cmd := exec.Command(name, args...)
	setCmdWindowFlags(cmd)
	return cmd.Start()
}

func getSessionFilePath() string {
	configDir, err := appdir.ConfigDir()
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
//
// On macOS a file opened from Finder arrives as an Apple Event instead (OpenFromOS, app_openfiles.go);
// the paths that arrived before this call are taken here, so the page shows them as its first tab.
// Calling it also tells the queue that start-up is over: later paths go straight to a new tab.
func (a *App) GetStartupFile() (*FileResult, error) {
	fromOS := a.osOpen.claim()

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
			// A file on the command line wins; anything the OS also handed over opens as a tab.
			a.openWhenUIReady(fromOS...)
			return &FileResult{
				Path:     absPath,
				Title:    filepath.Base(absPath),
				Content:  content,
				Encoding: enc,
			}, nil
		}
	}

	// No command-line file: the first readable path the OS handed over is the start-up file, the
	// rest open as tabs behind it.
	var first *FileResult
	var rest []string
	for _, p := range fromOS {
		if first == nil {
			if res, err := readNoteFile(p); err == nil {
				first = res
				continue
			}
			continue // unreadable or gone: nothing to show
		}
		rest = append(rest, p)
	}
	a.openWhenUIReady(rest...)
	return first, nil
}

// errIsDirectory is what readNoteFile returns for a folder; test it with errors.Is.
var errIsDirectory = errors.New("is a directory")

// readNoteFile reads a file to open in a tab and decodes it (UTF-8 with or without a BOM, else
// Shift_JIS). It is the one reader behind the file the OS asked us to open (GetStartupFile), a path
// handed to the running instance (OpenPathInNewTab) and the RPC method tab.new. A missing file is an
// error for which errors.Is(err, fs.ErrNotExist) holds, a folder one for which errors.Is(err,
// errIsDirectory) holds.
func readNoteFile(path string) (*FileResult, error) {
	absPath, err := filepath.Abs(path)
	if err != nil {
		absPath = path
	}
	info, err := os.Stat(absPath)
	if err != nil {
		return nil, err
	}
	if info.IsDir() {
		return nil, fmt.Errorf("%w: %s", errIsDirectory, absPath)
	}
	raw, err := os.ReadFile(absPath)
	if err != nil {
		return nil, err
	}
	content, enc, err := encoding.DetectAndDecode(raw)
	if err != nil {
		return nil, err
	}
	return &FileResult{
		Path:     absPath,
		Title:    filepath.Base(absPath),
		Content:  content,
		Encoding: enc,
	}, nil
}

// buildOpenInNewTabJS renders the JS call that asks the already-loaded UI to show a file in a
// new tab. Every value goes through json.Marshal, so a path or a document containing quotes,
// backslashes, newlines or non-BMP characters cannot break out of the expression.
//
// It is separated from OpenPathInNewTab (which does the I/O) purely so the escaping can be
// unit tested.
func buildOpenInNewTabJS(title, content, path string) string {
	titleJSON, _ := json.Marshal(title)
	contentJSON, _ := json.Marshal(content)
	pathJSON, _ := json.Marshal(path)
	return fmt.Sprintf("window.__mdMemoRPC && window.__mdMemoRPC.newTab(%s, %s, %s);",
		string(titleJSON), string(contentJSON), string(pathJSON))
}

// OpenPathInNewTab reads path and asks the running UI to display it in a new tab.
//
// It is the already-running counterpart of GetStartupFile: `md-memo notes.md` launched while
// an instance exists hands the absolute path over via the "open" IPC action instead of
// starting a second process (which on macOS really did start a second process, and on
// Windows was blocked by the single-instance mutex with the file silently dropped).
func (a *App) OpenPathInNewTab(path string) error {
	if strings.TrimSpace(path) == "" {
		return fmt.Errorf("開くファイルのパスが空です")
	}

	file, err := readNoteFile(path)
	if err != nil {
		switch {
		case errors.Is(err, fs.ErrNotExist):
			return fmt.Errorf("ファイルが見つかりません: %w", err)
		case errors.Is(err, errIsDirectory):
			return fmt.Errorf("ディレクトリは開けません: %w", err)
		}
		return fmt.Errorf("ファイルの読み込みに失敗しました: %w", err)
	}

	if a.w == nil || atomic.LoadInt32(&a.isDestroyed) != 0 {
		return fmt.Errorf("webview is not running")
	}

	js := buildOpenInNewTabJS(file.Title, file.Content, file.Path)
	a.dispatchEval(js)
	return nil
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

	a.TriggerGitSync()

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

	a.TriggerGitSync()

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
