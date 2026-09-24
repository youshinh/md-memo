package speech

import (
	"context"
	"encoding/base64"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strconv"
	"strings"
	"testing"
	"time"

	"md-memo/pkg/llm"
)

func speechWAV() []byte {
	return makeWAV(wavOpts{channels: 2, rate: 44100, bits: 16, junkBefore: 28}, tone(44100, 2, 500, 0.5, 1))
}

func TestGeminiEnginePassesThrough(t *testing.T) {
	for _, engine := range []string{"", "gemini", " Gemini "} {
		t.Run("engine "+engine, func(t *testing.T) {
			e := newTestEnv(t)
			cfg := llm.VoiceConfig{Engine: engine, Prompt: "P", APIKey: "K", Model: "m"}
			audio := []byte("some audio bytes")
			got, err := e.svc.Transcribe(context.Background(), cfg, audio, "audio/webm;codecs=opus")
			if err != nil || got != "gemini text" {
				t.Fatalf("got %q, %v", got, err)
			}
			want := []geminiCall{{"P", base64.StdEncoding.EncodeToString(audio), "audio/webm;codecs=opus", cfg}}
			if !reflect.DeepEqual(e.gemini.calls, want) {
				t.Fatalf("gemini calls: %+v", e.gemini.calls)
			}
			if len(e.whisper.calls) != 0 {
				t.Error("whisper must not run for the Gemini engine")
			}
		})
	}
}

func TestGeminiEngineBase64AndFile(t *testing.T) {
	e := newTestEnv(t)
	cfg := llm.VoiceConfig{Prompt: "P"}

	if _, err := e.svc.TranscribeBase64(context.Background(), cfg, "data:audio/webm;codecs=opus;base64,QUJD", ""); err != nil {
		t.Fatal(err)
	}
	if _, err := e.svc.TranscribeBase64(context.Background(), cfg, " QUJD ", "audio/ogg"); err != nil {
		t.Fatal(err)
	}
	if _, err := e.svc.TranscribeBase64(context.Background(), cfg, "data:audio/webm;base64,QUJD", "audio/wav"); err != nil {
		t.Fatal(err)
	}
	wav := makeWAV(wavOpts{rate: 16000, bits: 16}, tone(16000, 1, 440, 0.5, 0.1))
	path := filepath.Join(t.TempDir(), "memo.wav")
	os.WriteFile(path, wav, 0o644)
	if _, err := e.svc.TranscribeFile(context.Background(), cfg, path, ""); err != nil {
		t.Fatal(err)
	}
	if _, err := e.svc.TranscribeFile(context.Background(), cfg, path, "audio/x-wav"); err != nil {
		t.Fatal(err)
	}

	want := []struct{ b64, mime string }{
		{"QUJD", "audio/webm"},
		{"QUJD", "audio/ogg"},
		{"QUJD", "audio/wav"},
		{base64.StdEncoding.EncodeToString(wav), "audio/wav"},
		{base64.StdEncoding.EncodeToString(wav), "audio/x-wav"},
	}
	if len(e.gemini.calls) != len(want) {
		t.Fatalf("%d gemini calls, want %d", len(e.gemini.calls), len(want))
	}
	for i, w := range want {
		if c := e.gemini.calls[i]; c.b64 != w.b64 || c.mime != w.mime {
			t.Errorf("call %d: got (%.10s, %s), want (%.10s, %s)", i, c.b64, c.mime, w.b64, w.mime)
		}
	}

	if _, err := e.svc.TranscribeFile(context.Background(), cfg, filepath.Join(t.TempDir(), "gone.wav"), ""); err == nil {
		t.Error("a missing file must be an error")
	}
}

func TestGeminiErrorsPropagate(t *testing.T) {
	e := newTestEnv(t)
	e.gemini.err = errors.New("Gemini APIエラー (403)")
	if _, err := e.svc.Transcribe(context.Background(), llm.VoiceConfig{}, []byte("x"), "audio/wav"); err == nil || !strings.Contains(err.Error(), "403") {
		t.Fatalf("got %v", err)
	}
}

func TestUnknownEngine(t *testing.T) {
	e := newTestEnv(t)
	_, err := e.svc.Transcribe(context.Background(), llm.VoiceConfig{Engine: "azure"}, []byte("x"), "audio/wav")
	if err == nil || !strings.Contains(err.Error(), "azure") || !strings.Contains(err.Error(), "whisper-local") {
		t.Fatalf("got %v", err)
	}
	if len(e.gemini.calls)+len(e.whisper.calls) != 0 {
		t.Error("nothing should run for an unknown engine")
	}
}

func TestLocalNotInstalled(t *testing.T) {
	t.Run("runtime missing", func(t *testing.T) {
		e := newTestEnv(t)
		delete(e.store, runtimeCatalogPart().ID)
		_, err := e.svc.Transcribe(context.Background(), localCfg(), speechWAV(), "audio/wav")
		if !errors.Is(err, ErrNotInstalled) || !strings.Contains(err.Error(), "設定") || !strings.Contains(err.Error(), "実行ファイル") {
			t.Fatalf("got %v", err)
		}
		if len(e.whisper.calls)+len(e.gemini.calls) != 0 {
			t.Error("nothing should run")
		}
		e.assertTempClean(t)
	})
	t.Run("model missing", func(t *testing.T) {
		e := newTestEnv(t)
		delete(e.store, DefaultWhisperModelID())
		_, err := e.svc.Transcribe(context.Background(), localCfg(), speechWAV(), "audio/wav")
		if !errors.Is(err, ErrNotInstalled) || !strings.Contains(err.Error(), "kotoba") {
			t.Fatalf("got %v", err)
		}
	})
	t.Run("nil store", func(t *testing.T) {
		newTestEnv(t)
		_, err := NewService(nil).Transcribe(context.Background(), localCfg(), speechWAV(), "audio/wav")
		if !errors.Is(err, ErrNotInstalled) {
			t.Fatalf("got %v", err)
		}
	})
	t.Run("cloud fallback", func(t *testing.T) {
		e := newTestEnv(t)
		e.store = fakeStore{}
		e.svc.store = e.store
		cfg := localCfg()
		cfg.Whisper.CloudFallback = true
		got, err := e.svc.Transcribe(context.Background(), cfg, []byte("raw"), "audio/webm")
		if err != nil || got != "gemini text" {
			t.Fatalf("got %q, %v", got, err)
		}
		if len(e.gemini.calls) != 1 || e.gemini.calls[0].b64 != base64.StdEncoding.EncodeToString([]byte("raw")) || e.gemini.calls[0].mime != "audio/webm" {
			t.Errorf("gemini calls: %+v", e.gemini.calls)
		}
	})
	t.Run("both fail", func(t *testing.T) {
		e := newTestEnv(t)
		e.store = fakeStore{}
		e.svc.store = e.store
		e.gemini.err = errors.New("Gemini APIエラー (500)")
		cfg := localCfg()
		cfg.Whisper.CloudFallback = true
		_, err := e.svc.Transcribe(context.Background(), cfg, []byte("raw"), "audio/webm")
		if !errors.Is(err, ErrNotInstalled) || !strings.Contains(err.Error(), "500") {
			t.Fatalf("got %v", err)
		}
	})
}

func TestUnsupportedPlatform(t *testing.T) {
	e := newTestEnv(t)
	hostPlatform = func() string { return "linux/amd64" }
	_, err := e.svc.Transcribe(context.Background(), localCfg(), speechWAV(), "audio/wav")
	if err == nil || errors.Is(err, ErrNotInstalled) || !strings.Contains(err.Error(), "対応していません") {
		t.Fatalf("got %v", err)
	}
	cfg := localCfg()
	cfg.Whisper.CloudFallback = true
	if got, err := e.svc.Transcribe(context.Background(), cfg, []byte("x"), "audio/webm"); err != nil || got != "gemini text" {
		t.Fatalf("fallback: got %q, %v", got, err)
	}
}

func TestLocalTranscribeBuildsWhisperCommand(t *testing.T) {
	e := newTestEnv(t)
	var samples int
	var peak int16
	e.whisper.handler = func(ctx context.Context, exe string, args []string) error {
		wav := readOutputWAV(t, argAfter(args, "-f"))
		samples = len(wav)
		for _, v := range wav {
			peak = max(peak, v)
		}
		return writeTranscript("  お疲れ様です。 \n\n明日の会議は3時からです。\n")(ctx, exe, args)
	}

	got, err := e.svc.Transcribe(context.Background(), localCfg(), speechWAV(), "audio/wav")
	if err != nil {
		t.Fatal(err)
	}
	if got != "お疲れ様です。\n明日の会議は3時からです。" {
		t.Errorf("text %q", got)
	}
	if len(e.whisper.calls) != 1 || e.whisper.exe[0] != e.exe {
		t.Fatalf("whisper runs: %v with %v", e.whisper.calls, e.whisper.exe)
	}
	args := e.whisper.calls[0]
	work := filepath.Dir(argAfter(args, "-f"))
	if filepath.Dir(work) != e.tempRoot {
		t.Errorf("work dir %q is not inside the temp root %q", work, e.tempRoot)
	}
	want := []string{"-m", e.model, "-f", filepath.Join(work, "audio16k.wav"), "-l", "ja", "-t", "3", "-otxt", "-of", filepath.Join(work, "transcript"), "-np"}
	if !reflect.DeepEqual(args, want) {
		t.Errorf("args\n got %q\nwant %q", args, want)
	}
	if samples < 15990 || samples > 16010 || peak < 10000 {
		t.Errorf("whisper was handed %d samples with peak %d", samples, peak)
	}
	if len(e.gemini.calls) != 0 {
		t.Error("Gemini must not be called when the local engine works")
	}
	e.assertTempClean(t)
}

func TestLocalTranscribeOptions(t *testing.T) {
	run := func(t *testing.T, e *testEnv, w llm.WhisperSettings) []string {
		t.Helper()
		e.whisper.calls = nil
		if _, err := e.svc.Transcribe(context.Background(), llm.VoiceConfig{Engine: "whisper-local", Whisper: w}, speechWAV(), "audio/wav"); err != nil {
			t.Fatal(err)
		}
		if len(e.whisper.calls) != 1 {
			t.Fatalf("%d whisper runs", len(e.whisper.calls))
		}
		return e.whisper.calls[0]
	}

	t.Run("prompt only when set", func(t *testing.T) {
		e := newTestEnv(t)
		if a := run(t, e, llm.WhisperSettings{Threads: 4}); strings.Contains(strings.Join(a, " "), "--prompt") {
			t.Errorf("no prompt was set: %q", a)
		}
		if a := run(t, e, llm.WhisperSettings{Threads: 4, Prompt: "   "}); strings.Contains(strings.Join(a, " "), "--prompt") {
			t.Errorf("a blank prompt was passed: %q", a)
		}
		a := run(t, e, llm.WhisperSettings{Threads: 4, Prompt: " md-memo、Gemini "})
		if n := len(a); n < 2 || a[n-2] != "--prompt" || a[n-1] != "md-memo、Gemini" {
			t.Errorf("prompt args: %q", a)
		}
	})
	t.Run("language", func(t *testing.T) {
		e := newTestEnv(t)
		for lang, want := range map[string]string{"": "auto", "auto": "auto", " AUTO ": "auto", "en": "en", "JA": "ja", "de": "de"} {
			if got := argAfter(run(t, e, llm.WhisperSettings{Language: lang}), "-l"); got != want {
				t.Errorf("language %q -> -l %q, want %q", lang, got, want)
			}
		}
	})
	t.Run("threads", func(t *testing.T) {
		e := newTestEnv(t)
		if got := argAfter(run(t, e, llm.WhisperSettings{Threads: 5}), "-t"); got != "5" {
			t.Errorf("-t %q, want 5", got)
		}
		want := strconv.Itoa(autoThreads(runtime.NumCPU()))
		for _, n := range []int{0, -3} {
			if got := argAfter(run(t, e, llm.WhisperSettings{Threads: n}), "-t"); got != want {
				t.Errorf("threads %d -> -t %q, want %q", n, got, want)
			}
		}
	})
	t.Run("english-only model is told en", func(t *testing.T) {
		e := newTestEnv(t)
		writeModel(t, e.model, 51864)
		if got := argAfter(run(t, e, llm.WhisperSettings{Language: "ja"}), "-l"); got != "en" {
			t.Errorf("-l %q, want en", got)
		}
	})
	t.Run("catalog model", func(t *testing.T) {
		e := newTestEnv(t)
		other := filepath.Join(filepath.Dir(e.model), "small.bin")
		writeModel(t, other, 51865)
		e.store["small-q5_1"] = other
		if got := argAfter(run(t, e, llm.WhisperSettings{Model: "small-q5_1"}), "-m"); got != other {
			t.Errorf("-m %q, want %q", got, other)
		}
	})
	t.Run("custom-url model", func(t *testing.T) {
		e := newTestEnv(t)
		w := llm.WhisperSettings{Model: "custom-url", CustomURL: "https://example.com/m.bin", CustomSHA256: "AB"}
		other := filepath.Join(filepath.Dir(e.model), "custom.bin")
		writeModel(t, other, 51866)
		e.store[CustomURLPart(w.CustomURL, w.CustomSHA256).ID] = other
		if got := argAfter(run(t, e, w), "-m"); got != other {
			t.Errorf("-m %q, want %q", got, other)
		}
	})
	t.Run("custom-path model", func(t *testing.T) {
		e := newTestEnv(t)
		other := filepath.Join(t.TempDir(), "my-model.bin")
		writeModel(t, other, 51866)
		if got := argAfter(run(t, e, llm.WhisperSettings{Model: "custom-path", ModelPath: other}), "-m"); got != other {
			t.Errorf("-m %q, want %q", got, other)
		}
	})
}

func TestLocalModelProblems(t *testing.T) {
	for name, tc := range map[string]struct {
		w    llm.WhisperSettings
		file func(t *testing.T) string
		want string
	}{
		"custom-path empty":      {llm.WhisperSettings{Model: "custom-path"}, nil, "パス"},
		"custom-path missing":    {llm.WhisperSettings{Model: "custom-path", ModelPath: "nope.bin"}, nil, "見つかりません"},
		"custom-path gguf":       {llm.WhisperSettings{Model: "custom-path"}, func(t *testing.T) string { return writeFile(t, "m.gguf", "GGUF\x03\x00\x00\x00\x00\x00\x00\x00") }, "GGUF"},
		"custom-url without url": {llm.WhisperSettings{Model: "custom-url"}, nil, "URL"},
		"unknown model":          {llm.WhisperSettings{Model: "large-v9"}, nil, "large-v9"},
		"broken default model":   {llm.WhisperSettings{}, func(t *testing.T) string { return "" }, "ggml"},
	} {
		t.Run(name, func(t *testing.T) {
			e := newTestEnv(t)
			w := tc.w
			if tc.file != nil {
				if p := tc.file(t); p != "" {
					w.ModelPath = p
				} else {
					os.WriteFile(e.model, []byte("not a model, sorry"), 0o644)
				}
			}
			_, err := e.svc.Transcribe(context.Background(), llm.VoiceConfig{Engine: "whisper-local", Whisper: w}, speechWAV(), "audio/wav")
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("got %v, want it to mention %q", err, tc.want)
			}
			if len(e.whisper.calls) != 0 {
				t.Error("whisper must not run without a usable model")
			}
			e.assertTempClean(t)
		})
	}
}

func writeFile(t *testing.T, name, content string) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), name)
	if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	return p
}

func TestLocalSilenceAndEmptyOutput(t *testing.T) {
	quiet := func(peak float64) []byte {
		return makeWAV(wavOpts{rate: 16000, bits: 16}, tone(16000, 1, 300, peak, 1))
	}
	t.Run("digital silence never reaches whisper", func(t *testing.T) {
		e := newTestEnv(t)
		got, err := e.svc.Transcribe(context.Background(), localCfg(), makeWAV(wavOpts{rate: 44100, bits: 16, channels: 2}, make([]float64, 44100*2*2)), "audio/wav")
		if err != nil || got != "" {
			t.Fatalf("got %q, %v", got, err)
		}
		if len(e.whisper.calls) != 0 {
			t.Error("whisper ran on silence")
		}
		e.assertTempClean(t)
	})
	t.Run("a very faint hum is silence too", func(t *testing.T) {
		e := newTestEnv(t)
		if got, err := e.svc.Transcribe(context.Background(), localCfg(), quiet(0.0015), "audio/wav"); err != nil || got != "" || len(e.whisper.calls) != 0 {
			t.Fatalf("got %q, %v, %d whisper runs", got, err, len(e.whisper.calls))
		}
	})
	t.Run("quiet speech still runs", func(t *testing.T) {
		e := newTestEnv(t)
		if got, err := e.svc.Transcribe(context.Background(), localCfg(), quiet(0.01), "audio/wav"); err != nil || got == "" || len(e.whisper.calls) != 1 {
			t.Fatalf("got %q, %v, %d whisper runs", got, err, len(e.whisper.calls))
		}
	})
	for name, text := range map[string]string{"empty file": "", "blank marker": "[BLANK_AUDIO]\n", "whitespace": " \n\n"} {
		t.Run(name, func(t *testing.T) {
			e := newTestEnv(t)
			e.whisper.handler = writeTranscript(text)
			if got, err := e.svc.Transcribe(context.Background(), localCfg(), speechWAV(), "audio/wav"); err != nil || got != "" {
				t.Fatalf("got %q, %v", got, err)
			}
		})
	}
	t.Run("BOM and CRLF", func(t *testing.T) {
		e := newTestEnv(t)
		e.whisper.handler = writeTranscript("\xef\xbb\xbfこんにちは。\r\nさようなら。\r\n")
		if got, err := e.svc.Transcribe(context.Background(), localCfg(), speechWAV(), "audio/wav"); err != nil || got != "こんにちは。\nさようなら。" {
			t.Fatalf("got %q, %v", got, err)
		}
	})
	t.Run("empty audio", func(t *testing.T) {
		e := newTestEnv(t)
		empty := makeWAV(wavOpts{rate: 16000, bits: 16}, nil)
		if _, err := e.svc.Transcribe(context.Background(), localCfg(), empty, "audio/wav"); err == nil || !strings.Contains(err.Error(), "空") {
			t.Fatalf("got %v", err)
		}
		if _, err := e.svc.Transcribe(context.Background(), localCfg(), nil, "audio/wav"); err == nil {
			t.Fatal("nil audio must be an error")
		}
		e.assertTempClean(t)
	})
}

func TestLocalFailures(t *testing.T) {
	t.Run("whisper exits with an error", func(t *testing.T) {
		e := newTestEnv(t)
		e.whisper.handler = func(context.Context, string, []string) error {
			return errors.New("whisper-cli が失敗しました: exit status 3")
		}
		_, err := e.svc.Transcribe(context.Background(), localCfg(), speechWAV(), "audio/wav")
		if err == nil || !strings.Contains(err.Error(), "exit status 3") {
			t.Fatalf("got %v", err)
		}
		if len(e.gemini.calls) != 0 {
			t.Error("no fallback was requested")
		}
		e.assertTempClean(t)
	})
	t.Run("whisper fails and fallback is on", func(t *testing.T) {
		e := newTestEnv(t)
		e.whisper.handler = func(context.Context, string, []string) error { return errors.New("boom") }
		cfg := localCfg()
		cfg.Whisper.CloudFallback = true
		got, err := e.svc.Transcribe(context.Background(), cfg, speechWAV(), "audio/wav")
		if err != nil || got != "gemini text" || len(e.gemini.calls) != 1 {
			t.Fatalf("got %q, %v, %d gemini calls", got, err, len(e.gemini.calls))
		}
		e.assertTempClean(t)
	})
	t.Run("whisper writes no output", func(t *testing.T) {
		e := newTestEnv(t)
		e.whisper.handler = func(context.Context, string, []string) error { return nil }
		if _, err := e.svc.Transcribe(context.Background(), localCfg(), speechWAV(), "audio/wav"); err == nil {
			t.Fatal("expected an error")
		}
	})
	t.Run("unreadable audio", func(t *testing.T) {
		e := newTestEnv(t)
		runTranscoder = func(context.Context, string, string) error { return errNoTranscoder }
		if _, err := e.svc.Transcribe(context.Background(), localCfg(), []byte("neither audio nor anything else"), "audio/webm"); err == nil || !strings.Contains(err.Error(), "読み取れません") {
			t.Fatalf("got %v", err)
		}
		if len(e.whisper.calls) != 0 {
			t.Error("whisper must not run")
		}
		e.assertTempClean(t)
	})
}

func TestLocalCancellation(t *testing.T) {
	t.Run("while whisper runs", func(t *testing.T) {
		e := newTestEnv(t)
		started := make(chan struct{})
		e.whisper.handler = func(ctx context.Context, _ string, _ []string) error {
			close(started)
			<-ctx.Done()
			return ctx.Err()
		}
		cfg := localCfg()
		cfg.Whisper.CloudFallback = true // a cancelled call must not be retried in the cloud
		ctx, cancel := context.WithCancel(context.Background())
		done := make(chan error, 1)
		go func() {
			_, err := e.svc.Transcribe(ctx, cfg, speechWAV(), "audio/wav")
			done <- err
		}()
		<-started
		cancel()
		select {
		case err := <-done:
			if !errors.Is(err, context.Canceled) {
				t.Fatalf("got %v, want context.Canceled", err)
			}
		case <-time.After(5 * time.Second):
			t.Fatal("Transcribe did not return after the context was cancelled")
		}
		if len(e.gemini.calls) != 0 {
			t.Error("Gemini was called after cancellation")
		}
		e.assertTempClean(t)
	})
	t.Run("before starting", func(t *testing.T) {
		e := newTestEnv(t)
		ctx, cancel := context.WithCancel(context.Background())
		cancel()
		for _, cfg := range []llm.VoiceConfig{localCfg(), {}} {
			if _, err := e.svc.Transcribe(ctx, cfg, speechWAV(), "audio/wav"); !errors.Is(err, context.Canceled) {
				t.Errorf("engine %q: got %v", cfg.Engine, err)
			}
		}
		if len(e.whisper.calls)+len(e.gemini.calls) != 0 {
			t.Error("nothing should run for a cancelled context")
		}
	})
}

func TestLocalBase64(t *testing.T) {
	e := newTestEnv(t)
	b64 := base64.StdEncoding.EncodeToString(speechWAV())
	for name, in := range map[string]string{
		"data uri":   "data:audio/wav;base64," + b64,
		"bare":       b64,
		"unpadded":   strings.TrimRight(b64, "="),
		"with lines": b64[:100] + "\r\n" + b64[100:],
	} {
		t.Run(name, func(t *testing.T) {
			got, err := e.svc.TranscribeBase64(context.Background(), localCfg(), in, "")
			if err != nil || got != "こんにちは。" {
				t.Fatalf("got %q, %v", got, err)
			}
		})
	}
	if _, err := e.svc.TranscribeBase64(context.Background(), localCfg(), "%%% not base64 %%%", ""); err == nil || !strings.Contains(err.Error(), "base64") {
		t.Errorf("got %v", err)
	}
	e.assertTempClean(t)
}

func TestLocalTranscribeFileStreams(t *testing.T) {
	e := newTestEnv(t)
	const seconds = 25 * 60
	dataLen := seconds * 16000 * 2
	header := makeWAV(wavOpts{rate: 16000, bits: 16, dataSize: u32(uint32(dataLen))}, nil)
	path := filepath.Join(t.TempDir(), "long.wav")
	f, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	f.Write(header)
	block := make([]byte, 1<<20)
	for i := 0; i < len(block); i += 2 {
		block[i], block[i+1] = byte(i/2%200), 0x02 // a constant hum above the silence threshold
	}
	for written := 0; written < dataLen; written += len(block) {
		f.Write(block[:min(len(block), dataLen-written)])
	}
	f.Close()

	var before, after runtime.MemStats
	runtime.ReadMemStats(&before)
	got, err := e.svc.TranscribeFile(context.Background(), localCfg(), path, "audio/wav")
	runtime.ReadMemStats(&after)
	if err != nil || got != "こんにちは。" {
		t.Fatalf("got %q, %v", got, err)
	}
	if alloc := after.TotalAlloc - before.TotalAlloc; alloc > uint64(dataLen)/4 {
		t.Errorf("allocated %d MB for a %d MB file; the file is being read into memory", alloc>>20, dataLen>>20)
	}
	e.assertTempClean(t)
	if _, err := os.Stat(path); err != nil {
		t.Error("the caller's file must not be removed")
	}
}

func TestLocalStatus(t *testing.T) {
	cfg := func(w llm.WhisperSettings) llm.VoiceConfig {
		return llm.VoiceConfig{Engine: "whisper-local", Whisper: w}
	}

	t.Run("ready", func(t *testing.T) {
		e := newTestEnv(t)
		st := e.svc.LocalStatus(cfg(llm.WhisperSettings{Language: "ja"}))
		want := LocalStatus{Supported: true, RuntimeInstalled: true, ModelID: "kotoba-v2.0-q5_0", ModelInstalled: true, ModelPath: e.model, Multilingual: true, Ready: true}
		if st != want {
			t.Fatalf("got %+v\nwant %+v", st, want)
		}
	})
	t.Run("unsupported platform", func(t *testing.T) {
		e := newTestEnv(t)
		hostPlatform = func() string { return "darwin/arm64" }
		st := e.svc.LocalStatus(cfg(llm.WhisperSettings{}))
		if st.Supported || st.RuntimeInstalled || st.Ready || !strings.Contains(st.Reason, "対応していません") {
			t.Fatalf("got %+v", st)
		}
	})
	t.Run("runtime missing", func(t *testing.T) {
		e := newTestEnv(t)
		delete(e.store, runtimeCatalogPart().ID)
		st := e.svc.LocalStatus(cfg(llm.WhisperSettings{}))
		if !st.Supported || st.RuntimeInstalled || !st.ModelInstalled || st.Ready || !strings.Contains(st.Reason, "実行ファイル") {
			t.Fatalf("got %+v", st)
		}
	})
	t.Run("model missing", func(t *testing.T) {
		e := newTestEnv(t)
		delete(e.store, DefaultWhisperModelID())
		st := e.svc.LocalStatus(cfg(llm.WhisperSettings{Model: "kotoba-v2.0-q5_0"}))
		if !st.RuntimeInstalled || st.ModelInstalled || st.ModelPath != "" || st.Ready || !strings.Contains(st.Reason, "モデル") {
			t.Fatalf("got %+v", st)
		}
	})
	t.Run("everything missing reports the runtime first", func(t *testing.T) {
		e := newTestEnv(t)
		e.svc.store = fakeStore{}
		st := e.svc.LocalStatus(cfg(llm.WhisperSettings{}))
		if st.Ready || !strings.Contains(st.Reason, "実行ファイル") {
			t.Fatalf("got %+v", st)
		}
	})
	t.Run("nil store", func(t *testing.T) {
		newTestEnv(t)
		st := NewService(nil).LocalStatus(cfg(llm.WhisperSettings{}))
		if !st.Supported || st.RuntimeInstalled || st.ModelInstalled || st.Ready {
			t.Fatalf("got %+v", st)
		}
	})
	t.Run("custom-path", func(t *testing.T) {
		e := newTestEnv(t)
		good := filepath.Join(t.TempDir(), "good.bin")
		writeModel(t, good, 51866)
		st := e.svc.LocalStatus(cfg(llm.WhisperSettings{Model: "custom-path", ModelPath: good}))
		if st.ModelID != "custom-path" || !st.ModelInstalled || st.ModelPath != good || !st.Multilingual || !st.Ready || st.ModelWarning != "" {
			t.Fatalf("valid file: %+v", st)
		}

		bad := writeFile(t, "bad.bin", "GGUF\x03\x00\x00\x00\x00\x00\x00\x00")
		st = e.svc.LocalStatus(cfg(llm.WhisperSettings{Model: "custom-path", ModelPath: bad}))
		if !st.ModelInstalled || st.Ready || !strings.Contains(st.ModelWarning, "GGUF") || st.Reason != st.ModelWarning {
			t.Fatalf("invalid file: %+v", st)
		}

		st = e.svc.LocalStatus(cfg(llm.WhisperSettings{Model: "custom-path", ModelPath: filepath.Join(t.TempDir(), "gone.bin")}))
		if st.ModelInstalled || st.Ready || !strings.Contains(st.Reason, "見つかりません") {
			t.Fatalf("missing file: %+v", st)
		}
		st = e.svc.LocalStatus(cfg(llm.WhisperSettings{Model: "custom-path"}))
		if st.ModelInstalled || st.Ready || !strings.Contains(st.Reason, "パス") {
			t.Fatalf("empty path: %+v", st)
		}
	})
	t.Run("custom-url", func(t *testing.T) {
		e := newTestEnv(t)
		w := llm.WhisperSettings{Model: "custom-url", CustomURL: "https://example.com/m.bin"}
		if st := e.svc.LocalStatus(cfg(w)); st.ModelID != "custom-url" || st.ModelInstalled || st.Ready || !strings.Contains(st.Reason, "Custom model") {
			t.Fatalf("not downloaded: %+v", st)
		}
		e.store[CustomURLPart(w.CustomURL, "").ID] = e.model
		if st := e.svc.LocalStatus(cfg(w)); !st.ModelInstalled || !st.Ready {
			t.Fatalf("downloaded: %+v", st)
		}
		if st := e.svc.LocalStatus(cfg(llm.WhisperSettings{Model: "custom-url"})); st.Ready || !strings.Contains(st.Reason, "URL") {
			t.Fatalf("no url: %+v", st)
		}
	})
	t.Run("unknown model", func(t *testing.T) {
		e := newTestEnv(t)
		if st := e.svc.LocalStatus(cfg(llm.WhisperSettings{Model: "large-v9"})); st.Ready || st.ModelID != "large-v9" || !strings.Contains(st.Reason, "large-v9") {
			t.Fatalf("got %+v", st)
		}
	})
	t.Run("english-only model with a non-English language warns but stays ready", func(t *testing.T) {
		e := newTestEnv(t)
		writeModel(t, e.model, 51864)
		for _, lang := range []string{"ja", "", "auto"} {
			st := e.svc.LocalStatus(cfg(llm.WhisperSettings{Language: lang}))
			if st.Multilingual || !st.ModelInstalled || !st.Ready || !strings.Contains(st.ModelWarning, "英語専用") {
				t.Fatalf("language %q: %+v", lang, st)
			}
		}
		for _, lang := range []string{"en", "EN", "english"} {
			if st := e.svc.LocalStatus(cfg(llm.WhisperSettings{Language: lang})); st.ModelWarning != "" || !st.Ready {
				t.Fatalf("language %q: %+v", lang, st)
			}
		}
	})
	t.Run("broken downloaded model", func(t *testing.T) {
		e := newTestEnv(t)
		os.WriteFile(e.model, []byte("half a download"), 0o644)
		st := e.svc.LocalStatus(cfg(llm.WhisperSettings{}))
		if !st.ModelInstalled || st.Ready || st.ModelWarning == "" || st.Reason != st.ModelWarning {
			t.Fatalf("got %+v", st)
		}
	})
}

func TestNewServiceAcceptsPartStore(t *testing.T) {
	var _ PartStore = fakeStore{}
	if NewService(fakeStore{}) == nil {
		t.Fatal("NewService returned nil")
	}
}
