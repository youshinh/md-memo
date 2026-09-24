package speech

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"

	"md-memo/pkg/components"
	"md-memo/pkg/llm"
)

const (
	engineGemini        = "gemini"
	engineWhisperLocal  = "whisper-local"
	transcriptFileName  = "transcript"
	silencePeak         = 64 // of 32768, about -54 dBFS; below this a recording holds no speech
	minAutoThreads      = 2
	maxAutoThreads      = 8
	installHintSettings = "設定の音声入力からインストールしてください"
)

var ErrNotInstalled = errors.New("speech: local Whisper is not installed")

// notInstalledError carries a message meant for the user while still matching ErrNotInstalled.
type notInstalledError string

func (e notInstalledError) Error() string        { return string(e) }
func (e notInstalledError) Is(target error) bool { return target == ErrNotInstalled }

// PartStore is satisfied by *components.Manager.
type PartStore interface {
	Path(p components.Part) (string, bool)
}

// queryGeminiAudio is a var so tests can stub the network call.
var queryGeminiAudio = llm.QueryAudio

type Service struct {
	store    PartStore
	tempRoot string // "" = the OS temp dir
}

func NewService(store PartStore) *Service { return &Service{store: store} }

func (s *Service) Transcribe(ctx context.Context, cfg llm.VoiceConfig, audio []byte, mimeType string) (string, error) {
	return s.dispatch(ctx, cfg, audioInput{data: audio, mime: mimeType})
}

// TranscribeBase64 accepts a "data:...;base64," prefix like llm.QueryAudio does.
func (s *Service) TranscribeBase64(ctx context.Context, cfg llm.VoiceConfig, audioBase64, mimeType string) (string, error) {
	audioBase64 = strings.TrimSpace(audioBase64)
	if idx := strings.Index(audioBase64, ","); idx != -1 {
		if mimeType == "" {
			if head, ok := strings.CutPrefix(audioBase64[:idx], "data:"); ok {
				mimeType, _, _ = strings.Cut(head, ";")
			}
		}
		audioBase64 = strings.TrimSpace(audioBase64[idx+1:])
	}
	return s.dispatch(ctx, cfg, audioInput{b64: audioBase64, mime: mimeType})
}

// TranscribeFile leaves the file on disk for the local engine; only the Gemini path has to read it.
func (s *Service) TranscribeFile(ctx context.Context, cfg llm.VoiceConfig, path, mimeType string) (string, error) {
	return s.dispatch(ctx, cfg, audioInput{path: path, mime: mimeType})
}

func (s *Service) dispatch(ctx context.Context, cfg llm.VoiceConfig, in audioInput) (string, error) {
	if err := ctx.Err(); err != nil {
		return "", err
	}
	switch strings.ToLower(strings.TrimSpace(cfg.Engine)) {
	case "", engineGemini:
		return s.transcribeCloud(cfg, in)
	case engineWhisperLocal:
		text, err := s.transcribeLocal(ctx, cfg, in)
		if err == nil || !cfg.Whisper.CloudFallback || ctx.Err() != nil {
			return text, err
		}
		text, cerr := s.transcribeCloud(cfg, in)
		if cerr != nil {
			return "", fmt.Errorf("%w (Gemini での再試行も失敗しました: %v)", err, cerr)
		}
		return text, nil
	}
	return "", fmt.Errorf("不明な音声認識エンジンです: %q (指定できるのは gemini / whisper-local)", cfg.Engine)
}

func (s *Service) transcribeCloud(cfg llm.VoiceConfig, in audioInput) (string, error) {
	b64 := in.b64
	switch {
	case b64 != "":
	case in.path != "":
		raw, err := os.ReadFile(in.path)
		if err != nil {
			return "", fmt.Errorf("音声ファイルを読み取れません: %w", err)
		}
		b64 = base64.StdEncoding.EncodeToString(raw)
	default:
		b64 = base64.StdEncoding.EncodeToString(in.data)
	}
	mime := in.mime
	if mime == "" && in.path != "" {
		if head, err := in.head(); err == nil {
			mime = formatMIME(sniffFormat(head))
		}
	}
	return queryGeminiAudio(cfg.Prompt, b64, mime, cfg)
}

func (s *Service) transcribeLocal(ctx context.Context, cfg llm.VoiceConfig, in audioInput) (string, error) {
	w := cfg.Whisper
	exe, err := s.locateRuntime()
	if err != nil {
		return "", err
	}
	modelPath, err := s.locateModel(w)
	if err != nil {
		return "", err
	}
	info, err := ValidateModelFile(modelPath)
	if err != nil {
		return "", err
	}
	if in.b64 != "" {
		if in.data, err = decodeBase64(in.b64); err != nil {
			return "", err
		}
		in.b64 = ""
	}

	dir, err := os.MkdirTemp(s.tempRoot, "md-memo-speech-")
	if err != nil {
		return "", fmt.Errorf("作業用フォルダを作れません: %w", err)
	}
	defer os.RemoveAll(dir)

	wav, stats, err := prepareWAV(ctx, in, dir)
	if err != nil {
		return "", err
	}
	if stats.samples == 0 {
		return "", errors.New("音声データが空です")
	}
	// Whisper invents text ("ご視聴ありがとうございました" and the like) for silence.
	if stats.peak < silencePeak {
		return "", nil
	}

	job := whisperJob{
		model:     modelPath,
		wav:       wav,
		lang:      whisperLanguage(w.Language, info.Multilingual),
		threads:   w.Threads,
		outPrefix: filepath.Join(dir, transcriptFileName),
		prompt:    strings.TrimSpace(w.Prompt),
	}
	if job.threads <= 0 {
		job.threads = autoThreads(runtime.NumCPU())
	}
	if err := execWhisper(ctx, exe, job.args()); err != nil {
		return "", err
	}
	raw, err := os.ReadFile(job.outPrefix + ".txt")
	if err != nil {
		return "", fmt.Errorf("whisper-cli の出力を読み取れません: %w", err)
	}
	return cleanTranscript(string(raw)), nil
}

func decodeBase64(s string) ([]byte, error) {
	raw, err := base64.StdEncoding.DecodeString(s)
	if err != nil {
		var rawErr error
		if raw, rawErr = base64.RawStdEncoding.DecodeString(strings.TrimRight(s, "=")); rawErr != nil {
			return nil, errors.New("音声データ(base64)を読み取れません")
		}
	}
	return raw, nil
}

func autoThreads(cpus int) int { return min(max(cpus/2, minAutoThreads), maxAutoThreads) }

// An English-only model ignores -l anyway (whisper-cli just warns), so say "en" outright.
func whisperLanguage(lang string, multilingual bool) string {
	lang = strings.ToLower(strings.TrimSpace(lang))
	switch {
	case !multilingual:
		return "en"
	case lang == "":
		return "auto"
	}
	return lang
}

func isEnglish(lang string) bool {
	lang = strings.ToLower(strings.TrimSpace(lang))
	return lang == "en" || lang == "english"
}

// cleanTranscript joins the segments one per line, dropping whisper's marker for silence.
func cleanTranscript(raw string) string {
	raw = strings.ToValidUTF8(strings.TrimPrefix(raw, "\xef\xbb\xbf"), "")
	var lines []string
	for _, line := range strings.Split(raw, "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.EqualFold(line, "[BLANK_AUDIO]") {
			continue
		}
		lines = append(lines, line)
	}
	return strings.Join(lines, "\n")
}

func (s *Service) partPath(p components.Part) (string, bool) {
	if s == nil || s.store == nil {
		return "", false
	}
	path, ok := s.store.Path(p)
	return path, ok && path != ""
}

func (s *Service) locateRuntime() (string, error) {
	rt, ok := RuntimePart()
	if !ok {
		return "", fmt.Errorf("この環境(%s)ではローカル音声認識に対応していません(Windows 64bit のみ)", hostPlatform())
	}
	if path, ok := s.partPath(rt); ok {
		return path, nil
	}
	return "", notInstalledError("ローカル音声認識の実行ファイルが未インストールです。" + installHintSettings)
}

// locateModel returns the model file to use. A missing download is a notInstalledError; a setting
// that names nothing usable is a plain error.
func (s *Service) locateModel(w llm.WhisperSettings) (string, error) {
	id := effectiveModelID(w)
	if id == modelCustomPath {
		path := strings.TrimSpace(w.ModelPath)
		if path == "" {
			return "", errors.New("モデルファイルのパスが指定されていません")
		}
		if st, err := os.Stat(path); err != nil || st.IsDir() {
			return "", fmt.Errorf("モデルファイルが見つかりません: %s", path)
		}
		return path, nil
	}
	part, ok := ResolveModelPart(w)
	if !ok {
		if id == modelCustomURL {
			return "", errors.New("カスタムモデルの URL が指定されていません")
		}
		return "", fmt.Errorf("不明なモデルです: %s", id)
	}
	if path, ok := s.partPath(part); ok {
		return path, nil
	}
	return "", notInstalledError(fmt.Sprintf("音声認識モデル「%s」が未インストールです。%s", part.Title, installHintSettings))
}

type LocalStatus struct {
	Supported        bool   `json:"supported"`
	RuntimeInstalled bool   `json:"runtimeInstalled"`
	ModelID          string `json:"modelId"`
	ModelInstalled   bool   `json:"modelInstalled"`
	ModelPath        string `json:"modelPath"`
	Multilingual     bool   `json:"multilingual"`
	ModelWarning     string `json:"modelWarning"`
	Ready            bool   `json:"ready"`
	Reason           string `json:"reason"`
}

// LocalStatus reports what the settings screen needs to know: whether Transcribe would run the
// local engine now and, when it would not, why. It reads at most one small file header.
func (s *Service) LocalStatus(cfg llm.VoiceConfig) LocalStatus {
	w := cfg.Whisper
	st := LocalStatus{ModelID: effectiveModelID(w)}
	var reason string

	if rt, ok := RuntimePart(); !ok {
		reason = "この環境ではローカル音声認識に対応していません(Windows 64bit のみ)"
	} else {
		st.Supported = true
		if _, st.RuntimeInstalled = s.partPath(rt); !st.RuntimeInstalled {
			reason = "ローカル音声認識の実行ファイルが未インストールです"
		}
	}

	path, err := s.locateModel(w)
	if err != nil {
		if reason == "" {
			reason = err.Error()
		}
	} else {
		st.ModelInstalled, st.ModelPath = true, path
		if info, verr := ValidateModelFile(path); verr != nil {
			st.ModelWarning = verr.Error()
			if reason == "" {
				reason = st.ModelWarning
			}
		} else {
			st.Multilingual = info.Multilingual
			if !info.Multilingual && !isEnglish(w.Language) {
				st.ModelWarning = "このモデルは英語専用です。日本語などは認識できません。多言語モデルか kotoba-whisper を選んでください"
			}
		}
	}
	st.Ready, st.Reason = reason == "", reason
	return st
}
