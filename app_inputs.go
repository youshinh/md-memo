package main

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"os/exec"
	pathpkg "path"
	"path/filepath"
	"runtime"
	"strings"
	"sync/atomic"
	"time"

	"md-memo/pkg/appdir"
	"md-memo/pkg/llm"
	"md-memo/pkg/procutil"
)

// inputsNow lets tests pin the timestamp used for asset/voice-cache file names.
var inputsNow = time.Now

// inputsQueryAudio is llm.QueryAudio behind a variable so tests never reach the network.
var inputsQueryAudio = llm.QueryAudio

// inputsStartProcess launches an external command fire-and-forget (Start, never Wait) so
// tests can stub it instead of really spawning explorer.exe / rundll32 / xdg-open.
var inputsStartProcess = func(name string, args ...string) error {
	cmd := exec.Command(name, args...)
	procutil.HideWindow(cmd)
	return cmd.Start()
}

const maxAssetBytes = 25 * 1024 * 1024

var assetExtWhitelist = map[string]bool{
	"png": true, "jpg": true, "jpeg": true, "gif": true, "webp": true,
	"webm": true, "ogg": true, "m4a": true, "mp3": true, "wav": true,
	"pdf": true, "txt": true, "md": true,
}

// AssetResult is returned by every call that writes (or moves) a file into an "assets" folder.
type AssetResult struct {
	AbsPath string `json:"absPath"`
	RelPath string `json:"relPath"` // "./assets/<name>" when baseDir was given, else ""
	FileURL string `json:"fileUrl"`
}

// inputsAppDir is <appdir>/, the same md-memo config folder GenerateImageAsync and
// getSessionFilePath already fall back to.
func inputsAppDir() (string, error) {
	configDir, err := appdir.ConfigDir()
	if err != nil {
		return "", fmt.Errorf("アプリデータフォルダの解決に失敗しました: %w", err)
	}
	return filepath.Join(configDir, "md-memo"), nil
}

// resolveAssetRoot decides the folder assets are written under: baseDir when given (absolute
// or made absolute), else the app data dir. hasBaseDir also drives whether AssetResult.RelPath
// is populated.
func resolveAssetRoot(baseDir string) (root string, hasBaseDir bool, err error) {
	if strings.TrimSpace(baseDir) != "" {
		abs, err := filepath.Abs(baseDir)
		if err != nil {
			return "", false, fmt.Errorf("フォルダの解決に失敗しました: %w", err)
		}
		return abs, true, nil
	}
	dir, err := inputsAppDir()
	if err != nil {
		return "", false, err
	}
	return dir, false, nil
}

// decodeCappedBase64 strips an optional "data:...;base64," prefix, rejects an implausibly
// large encoded string before decoding (so a hostile caller cannot force a huge allocation),
// then strictly decodes and enforces capBytes on the decoded size.
func decodeCappedBase64(s string, capBytes int) ([]byte, error) {
	if strings.HasPrefix(s, "data:") {
		if idx := strings.Index(s, ","); idx != -1 {
			s = s[idx+1:]
		}
	}
	s = strings.TrimSpace(s)

	maxEncodedLen := ((capBytes+2)/3)*4 + 8
	if len(s) > maxEncodedLen {
		return nil, fmt.Errorf("ファイルサイズが上限を超えています")
	}

	data, err := base64.StdEncoding.DecodeString(s)
	if err != nil {
		return nil, fmt.Errorf("Base64デコードに失敗しました: %w", err)
	}
	if len(data) > capBytes {
		return nil, fmt.Errorf("ファイルサイズが上限を超えています")
	}
	return data, nil
}

// uniqueAssetPath returns an absolute path (and its base name) for base(+ "." +ext) inside
// dir, appending -2, -3, ... on collision. ext is passed without a leading dot; an empty ext
// leaves the name without one.
func uniqueAssetPath(dir, base, ext string) (absPath, name string) {
	nameFor := func(b string) string {
		if ext == "" {
			return b
		}
		return b + "." + ext
	}
	name = nameFor(base)
	absPath = filepath.Join(dir, name)
	if _, err := os.Stat(absPath); err != nil {
		return absPath, name
	}
	for i := 2; ; i++ {
		candidate := nameFor(fmt.Sprintf("%s-%d", base, i))
		p := filepath.Join(dir, candidate)
		if _, err := os.Stat(p); err != nil {
			return p, candidate
		}
	}
}

var reservedWindowsBaseNames = map[string]bool{
	"CON": true, "PRN": true, "AUX": true, "NUL": true,
	"COM1": true, "COM2": true, "COM3": true, "COM4": true, "COM5": true,
	"COM6": true, "COM7": true, "COM8": true, "COM9": true,
	"LPT1": true, "LPT2": true, "LPT3": true, "LPT4": true, "LPT5": true,
	"LPT6": true, "LPT7": true, "LPT8": true, "LPT9": true,
}

// sanitizeAssetFileName turns an arbitrary (possibly hostile) file name into one safe to join
// under an assets folder: directory components are stripped (so ".." and absolute paths can
// never escape it), control characters and the Windows-reserved characters are removed,
// trailing dots/spaces are trimmed, and a Windows-reserved device name is prefixed. An empty
// result becomes "file".
func sanitizeAssetFileName(name string) string {
	name = strings.ReplaceAll(name, "\\", "/")
	if idx := strings.LastIndex(name, "/"); idx != -1 {
		name = name[idx+1:]
	}

	var b strings.Builder
	for _, r := range name {
		if r < 0x20 || r == 0x7f {
			continue
		}
		switch r {
		case '<', '>', ':', '"', '/', '\\', '|', '?', '*':
			b.WriteRune('_')
		default:
			b.WriteRune(r)
		}
	}
	name = strings.TrimRight(b.String(), " .")

	if name == "" || name == "." || name == ".." {
		return "file"
	}

	base, ext := name, ""
	if idx := strings.LastIndex(name, "."); idx > 0 {
		base, ext = name[:idx], name[idx+1:]
	}
	if reservedWindowsBaseNames[strings.ToUpper(base)] {
		base = "_" + base
	}
	if ext == "" {
		return base
	}
	return base + "." + ext
}

// SaveAsset writes a base64 payload into <root>/assets/YYYY-MM-DD-HHmmss.<ext>, where root is
// baseDir when non-empty, else the app data dir.
func (a *App) SaveAsset(baseDir, ext, dataBase64 string) (*AssetResult, error) {
	ext = strings.ToLower(strings.TrimPrefix(ext, "."))
	if !assetExtWhitelist[ext] {
		return nil, fmt.Errorf("許可されていない拡張子です: %s", ext)
	}

	data, err := decodeCappedBase64(dataBase64, maxAssetBytes)
	if err != nil {
		return nil, err
	}

	root, hasBaseDir, err := resolveAssetRoot(baseDir)
	if err != nil {
		return nil, err
	}
	assetsDir := filepath.Join(root, "assets")
	if err := os.MkdirAll(assetsDir, 0755); err != nil {
		return nil, fmt.Errorf("assetsフォルダの作成に失敗しました: %w", err)
	}

	base := inputsNow().Format("2006-01-02-150405")
	absPath, name := uniqueAssetPath(assetsDir, base, ext)
	if err := os.WriteFile(absPath, data, 0644); err != nil {
		return nil, fmt.Errorf("ファイルの保存に失敗しました: %w", err)
	}

	result := &AssetResult{AbsPath: absPath, FileURL: FileURLFromPath(absPath)}
	if hasBaseDir {
		result.RelPath = "./assets/" + name
	}
	return result, nil
}

// ImportAssetFile is SaveAsset's drag&drop counterpart: it keeps a sanitized version of the
// original file name (no extension whitelist) instead of stamping a timestamp.
func (a *App) ImportAssetFile(baseDir, fileName, dataBase64 string) (*AssetResult, error) {
	data, err := decodeCappedBase64(dataBase64, maxAssetBytes)
	if err != nil {
		return nil, err
	}

	sanitized := sanitizeAssetFileName(fileName)
	base, ext := sanitized, ""
	if idx := strings.LastIndex(sanitized, "."); idx > 0 {
		base, ext = sanitized[:idx], sanitized[idx+1:]
	}

	root, hasBaseDir, err := resolveAssetRoot(baseDir)
	if err != nil {
		return nil, err
	}
	assetsDir := filepath.Join(root, "assets")
	if err := os.MkdirAll(assetsDir, 0755); err != nil {
		return nil, fmt.Errorf("assetsフォルダの作成に失敗しました: %w", err)
	}

	absPath, name := uniqueAssetPath(assetsDir, base, ext)
	if err := os.WriteFile(absPath, data, 0644); err != nil {
		return nil, fmt.Errorf("ファイルの保存に失敗しました: %w", err)
	}

	result := &AssetResult{AbsPath: absPath, FileURL: FileURLFromPath(absPath)}
	if hasBaseDir {
		result.RelPath = "./assets/" + name
	}
	return result, nil
}

// FileURLFromPath renders an absolute filesystem path as a correctly percent-encoded
// file:// URL on both Windows (drive letters, backslashes) and Unix.
func FileURLFromPath(abs string) string {
	slashed := filepath.ToSlash(abs)
	u := url.URL{Scheme: "file"}
	if strings.HasPrefix(slashed, "//") {
		// UNC path: //server/share/... -> file://server/share/...
		rest := strings.TrimPrefix(slashed, "//")
		parts := strings.SplitN(rest, "/", 2)
		u.Host = parts[0]
		if len(parts) > 1 {
			u.Path = "/" + parts[1]
		} else {
			u.Path = "/"
		}
	} else {
		if !strings.HasPrefix(slashed, "/") {
			slashed = "/" + slashed
		}
		u.Path = slashed
	}
	return u.String()
}

// hasURLScheme reports the scheme prefix of target, if any, taking care not to mistake a
// Windows drive letter ("C:\...") for one.
func hasURLScheme(target string) (scheme string, ok bool) {
	idx := strings.Index(target, ":")
	if idx <= 0 {
		return "", false
	}
	if idx == 1 {
		c := target[0]
		if (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') {
			return "", false // drive letter, not a scheme
		}
	}
	scheme = target[:idx]
	for _, r := range scheme {
		if !((r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || r == '+' || r == '-' || r == '.') {
			return "", false
		}
	}
	return strings.ToLower(scheme), true
}

// pathFromFileURL is FileURLFromPath's inverse: it turns a file:// URL back into a native path.
func pathFromFileURL(raw string) (string, error) {
	u, err := url.Parse(raw)
	if err != nil {
		return "", fmt.Errorf("URLの解析に失敗しました: %w", err)
	}
	if !strings.EqualFold(u.Scheme, "file") {
		return "", fmt.Errorf("file: URLではありません")
	}
	p := u.Path
	if u.Host != "" && !strings.EqualFold(u.Host, "localhost") {
		p = "//" + u.Host + p
	}
	if len(p) >= 3 && p[0] == '/' && p[2] == ':' {
		p = p[1:] // "/C:/..." -> "C:/..."
	}
	return filepath.FromSlash(p), nil
}

// resolveTargetPath accepts a file:// URL, an absolute path, or a path relative to baseDir,
// and rejects every other URL scheme.
func resolveTargetPath(target, baseDir string) (string, error) {
	target = strings.TrimSpace(target)
	if target == "" {
		return "", fmt.Errorf("パスが空です")
	}

	if scheme, ok := hasURLScheme(target); ok {
		if scheme != "file" {
			return "", fmt.Errorf("許可されていないスキームです: %s", scheme)
		}
		return pathFromFileURL(target)
	}

	if !filepath.IsAbs(target) {
		if strings.TrimSpace(baseDir) == "" {
			return "", fmt.Errorf("相対パスの基準フォルダがありません")
		}
		target = filepath.Join(baseDir, target)
	}
	// Markdown link targets are percent-encoded when they hold spaces or parentheses; a file
	// whose real name contains a literal "%20" still wins because it is checked first.
	if _, err := os.Stat(target); err != nil {
		if decoded, uerr := url.PathUnescape(target); uerr == nil && decoded != target {
			if _, serr := os.Stat(decoded); serr == nil {
				return decoded, nil
			}
		}
	}
	return target, nil
}

func openCommandFor(goos, path string) (string, []string) {
	switch goos {
	case "windows":
		return "rundll32", []string{"url.dll,FileProtocolHandler", path}
	case "darwin":
		return "open", []string{path}
	default:
		return "xdg-open", []string{path}
	}
}

func revealCommandFor(goos, path string) (string, []string) {
	switch goos {
	case "windows":
		return "explorer.exe", []string{"/select," + path}
	case "darwin":
		return "open", []string{"-R", path}
	default:
		return "xdg-open", []string{pathpkg.Dir(path)}
	}
}

// OpenPath opens target (a file:// URL, an absolute path, or a baseDir-relative path) with the
// OS default application. The target must exist.
func (a *App) OpenPath(target, baseDir string) error {
	p, err := resolveTargetPath(target, baseDir)
	if err != nil {
		return err
	}
	abs, err := filepath.Abs(p)
	if err != nil {
		return fmt.Errorf("パスの解決に失敗しました: %w", err)
	}
	if _, err := os.Stat(abs); err != nil {
		return fmt.Errorf("ファイルが見つかりません: %w", err)
	}
	name, args := openCommandFor(runtime.GOOS, abs)
	return inputsStartProcess(name, args...)
}

// RevealPath shows target selected in the OS file browser (Explorer/Finder). The target must
// exist.
func (a *App) RevealPath(target, baseDir string) error {
	p, err := resolveTargetPath(target, baseDir)
	if err != nil {
		return err
	}
	abs, err := filepath.Abs(p)
	if err != nil {
		return fmt.Errorf("パスの解決に失敗しました: %w", err)
	}
	if _, err := os.Stat(abs); err != nil {
		return fmt.Errorf("ファイルが見つかりません: %w", err)
	}
	name, args := revealCommandFor(runtime.GOOS, abs)
	return inputsStartProcess(name, args...)
}

const voiceCacheSubdir = "voice_cache"

func voiceCacheDir() (string, error) {
	root, err := inputsAppDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(root, voiceCacheSubdir), nil
}

// resolveVoiceCachePath makes cachePath absolute (relative to the voice cache dir when it
// isn't already absolute) and verifies, after resolving symlinks where the target exists, that
// it still lives inside the voice cache dir. This is the traversal guard required for every
// cache-path argument accepted from the frontend.
func resolveVoiceCachePath(cachePath string) (string, error) {
	if strings.TrimSpace(cachePath) == "" {
		return "", fmt.Errorf("キャッシュパスが空です")
	}
	dir, err := voiceCacheDir()
	if err != nil {
		return "", err
	}
	absDir, err := filepath.Abs(filepath.Clean(dir))
	if err != nil {
		return "", fmt.Errorf("キャッシュフォルダの解決に失敗しました: %w", err)
	}

	clean := filepath.Clean(cachePath)
	absPath := clean
	if !filepath.IsAbs(absPath) {
		absPath = filepath.Join(absDir, absPath)
	}
	absPath, err = filepath.Abs(absPath)
	if err != nil {
		return "", fmt.Errorf("キャッシュパスの解決に失敗しました: %w", err)
	}

	checkDir := absDir
	if resolved, err := filepath.EvalSymlinks(absPath); err == nil {
		absPath = resolved
	}
	if resolved, err := filepath.EvalSymlinks(absDir); err == nil {
		checkDir = resolved
	}

	rel, err := filepath.Rel(checkDir, absPath)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return "", fmt.Errorf("不正なキャッシュパスです")
	}
	return absPath, nil
}

func voiceCacheIDFromReqID(reqID string) string {
	if idx := strings.LastIndex(reqID, "_"); idx != -1 {
		return reqID[idx+1:]
	}
	return reqID
}

// saveVoiceCache persists a failed transcription's audio so the user can retry, keep, or
// discard it later.
func saveVoiceCache(reqID, audioBase64 string) (string, error) {
	data, err := decodeCappedBase64(audioBase64, maxAssetBytes)
	if err != nil {
		return "", err
	}
	dir, err := voiceCacheDir()
	if err != nil {
		return "", err
	}
	if err := os.MkdirAll(dir, 0755); err != nil {
		return "", fmt.Errorf("voice_cacheフォルダの作成に失敗しました: %w", err)
	}

	name := inputsNow().Format("2006-01-02-150405") + "_" + voiceCacheIDFromReqID(reqID) + ".webm"
	path := filepath.Join(dir, name)
	if err := os.WriteFile(path, data, 0600); err != nil {
		return "", fmt.Errorf("音声キャッシュの保存に失敗しました: %w", err)
	}
	return path, nil
}

// dispatchVoiceResult invokes window.__onVoiceResult(reqID, text, err, cachePath), following
// the same Dispatch+Eval pattern as dispatchMobileDropEvent.
func (a *App) dispatchVoiceResult(reqID, text, errMsg, cachePath string) {
	if a.w == nil {
		return
	}
	reqJSON, _ := json.Marshal(reqID)
	textJSON, _ := json.Marshal(text)
	errJSON, _ := json.Marshal(errMsg)
	cacheJSON, _ := json.Marshal(cachePath)
	js := fmt.Sprintf("if (window.__onVoiceResult) { window.__onVoiceResult(%s, %s, %s, %s); }",
		string(reqJSON), string(textJSON), string(errJSON), string(cacheJSON))
	a.w.Dispatch(func() {
		if atomic.LoadInt32(&a.isDestroyed) == 0 {
			a.w.Eval(js)
		}
	})
}

// TranscribeAudioAsync transcribes audioBase64 via Gemini in the background. On failure it
// first saves the audio into voice_cache so the user does not lose the recording.
func (a *App) TranscribeAudioAsync(reqID, audioBase64, mimeType, voiceConfigJSON string) {
	go func() {
		var cfg llm.VoiceConfig
		_ = json.Unmarshal([]byte(voiceConfigJSON), &cfg)

		text, err := inputsQueryAudio(cfg.Prompt, audioBase64, mimeType, cfg)
		if atomic.LoadInt32(&a.isDestroyed) != 0 {
			return
		}
		if err != nil {
			cachePath, cacheErr := saveVoiceCache(reqID, audioBase64)
			if cacheErr != nil {
				cachePath = ""
			}
			a.dispatchVoiceResult(reqID, "", err.Error(), cachePath)
			return
		}
		a.dispatchVoiceResult(reqID, text, "", "")
	}()
}

// RetryVoiceCacheAsync re-attempts transcription of a previously cached recording; on success
// the cache file is deleted.
func (a *App) RetryVoiceCacheAsync(reqID, cachePath, voiceConfigJSON string) {
	go func() {
		safePath, err := resolveVoiceCachePath(cachePath)
		if err != nil {
			a.dispatchVoiceResult(reqID, "", err.Error(), cachePath)
			return
		}
		data, err := os.ReadFile(safePath)
		if err != nil {
			a.dispatchVoiceResult(reqID, "", fmt.Sprintf("キャッシュの読み込みに失敗しました: %v", err), cachePath)
			return
		}

		var cfg llm.VoiceConfig
		_ = json.Unmarshal([]byte(voiceConfigJSON), &cfg)
		audioBase64 := base64.StdEncoding.EncodeToString(data)

		text, err := inputsQueryAudio(cfg.Prompt, audioBase64, "audio/webm", cfg)
		if atomic.LoadInt32(&a.isDestroyed) != 0 {
			return
		}
		if err != nil {
			a.dispatchVoiceResult(reqID, "", err.Error(), cachePath)
			return
		}
		_ = os.Remove(safePath)
		a.dispatchVoiceResult(reqID, text, "", "")
	}()
}

// KeepVoiceCache moves a cached recording into <root>/assets/ instead of discarding it.
func (a *App) KeepVoiceCache(cachePath, baseDir string) (*AssetResult, error) {
	safePath, err := resolveVoiceCachePath(cachePath)
	if err != nil {
		return nil, err
	}
	data, err := os.ReadFile(safePath)
	if err != nil {
		return nil, fmt.Errorf("キャッシュの読み込みに失敗しました: %w", err)
	}

	root, hasBaseDir, err := resolveAssetRoot(baseDir)
	if err != nil {
		return nil, err
	}
	assetsDir := filepath.Join(root, "assets")
	if err := os.MkdirAll(assetsDir, 0755); err != nil {
		return nil, fmt.Errorf("assetsフォルダの作成に失敗しました: %w", err)
	}

	absPath, name := uniqueAssetPath(assetsDir, "voice_note", "webm")
	if err := os.WriteFile(absPath, data, 0644); err != nil {
		return nil, fmt.Errorf("ファイルの保存に失敗しました: %w", err)
	}
	_ = os.Remove(safePath)

	result := &AssetResult{AbsPath: absPath, FileURL: FileURLFromPath(absPath)}
	if hasBaseDir {
		result.RelPath = "./assets/" + name
	}
	return result, nil
}

// DiscardVoiceCache deletes a cached recording the user chose not to keep.
func (a *App) DiscardVoiceCache(cachePath string) error {
	safePath, err := resolveVoiceCachePath(cachePath)
	if err != nil {
		return err
	}
	if err := os.Remove(safePath); err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("キャッシュの削除に失敗しました: %w", err)
	}
	return nil
}
