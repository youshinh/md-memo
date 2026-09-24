package speech

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestSniffFormat(t *testing.T) {
	for name, tc := range map[string]struct {
		head []byte
		want string
	}{
		"wav":            {[]byte("RIFF\x24\x00\x00\x00WAVEfmt "), fmtWAV},
		"rf64":           {[]byte("RF64\xff\xff\xff\xffWAVEds64"), fmtWAV},
		"avi is not wav": {[]byte("RIFF\x24\x00\x00\x00AVI LIST"), ""},
		"mp3 id3":        {[]byte("ID3\x04\x00\x00\x00\x00\x00\x00"), fmtMP3},
		"mp3 frame":      {[]byte{0xFF, 0xFB, 0x90, 0x00, 0, 0, 0, 0}, fmtMP3},
		"mp3 mpeg2":      {[]byte{0xFF, 0xF3, 0x90, 0x00}, fmtMP3},
		"aac adts":       {[]byte{0xFF, 0xF1, 0x50, 0x80, 0, 0}, fmtAAC},
		"aac adts mpeg2": {[]byte{0xFF, 0xF9, 0x50, 0x80}, fmtAAC},
		"reserved layer": {[]byte{0xFF, 0xE1, 0x00, 0x00}, ""},
		"m4a":            {[]byte("\x00\x00\x00\x20ftypM4A \x00\x00\x00\x00"), fmtM4A},
		"mp4":            {[]byte("\x00\x00\x00\x18ftypmp42\x00\x00\x00\x00"), fmtM4A},
		"ogg":            {[]byte("OggS\x00\x02\x00\x00"), fmtOGG},
		"flac":           {[]byte("fLaC\x00\x00\x00\x22"), fmtFLAC},
		"webm":           {[]byte{0x1A, 0x45, 0xDF, 0xA3, 0x9F, 0x42, 0x86, 0x81}, fmtWebM},
		"wma":            {[]byte{0x30, 0x26, 0xB2, 0x75, 0x8E, 0x66, 0xCF, 0x11, 0xA6, 0xD9}, fmtWMA},
		"text":           {[]byte("hello, this is text"), ""},
		"short":          {[]byte{0xFF}, ""},
		"empty":          {nil, ""},
	} {
		if got := sniffFormat(tc.head); got != tc.want {
			t.Errorf("%s: sniffFormat = %q, want %q", name, got, tc.want)
		}
	}
}

func TestFormatFromMIME(t *testing.T) {
	for mime, want := range map[string]string{
		"audio/wav": fmtWAV, "audio/x-wav": fmtWAV, "audio/mpeg": fmtMP3, "audio/mp4": fmtM4A, "audio/x-m4a": fmtM4A,
		"audio/webm;codecs=opus": fmtWebM, "AUDIO/OGG": fmtOGG, "audio/flac": fmtFLAC, "audio/aac": fmtAAC,
		"": "", "application/octet-stream": "",
	} {
		if got := formatFromMIME(mime); got != want {
			t.Errorf("formatFromMIME(%q) = %q, want %q", mime, got, want)
		}
	}
}

type transcodeCall struct {
	in      string
	content []byte
}

func stubTranscoder(t *testing.T, calls *[]transcodeCall, result func(out string) error) {
	t.Helper()
	runTranscoder = func(_ context.Context, in, out string) error {
		content, _ := os.ReadFile(in)
		*calls = append(*calls, transcodeCall{in, content})
		return result(out)
	}
}

func windowsStyleWAV() []byte {
	return makeWAV(wavOpts{channels: 2, rate: 44100, bits: 16, junkBefore: 28}, tone(44100, 2, 800, 0.5, 1))
}

func TestPrepareWAVBytesNeedNoExternalTool(t *testing.T) {
	newTestEnv(t) // any process launch fails the test
	dir := t.TempDir()
	wav := makeWAV(wavOpts{channels: 2, rate: 48000, bits: 16}, tone(48000, 2, 500, 0.5, 1))
	out, stats, err := prepareWAV(context.Background(), audioInput{data: wav, mime: "audio/wav"}, dir)
	if err != nil {
		t.Fatal(err)
	}
	if out != filepath.Join(dir, "audio16k.wav") || stats.samples < 15990 || stats.samples > 16010 || stats.peak < 10000 {
		t.Errorf("out %s stats %+v", out, stats)
	}
	if got := readOutputWAV(t, out); int64(len(got)) != stats.samples {
		t.Errorf("file holds %d samples, stats say %d", len(got), stats.samples)
	}
}

func TestPrepareWAVUsesSystemTranscoderForCompressedFormats(t *testing.T) {
	newTestEnv(t)
	var calls []transcodeCall
	stubTranscoder(t, &calls, func(out string) error { return os.WriteFile(out, windowsStyleWAV(), 0o644) })
	mp3 := append([]byte("ID3\x04\x00\x00\x00\x00\x00\x00"), []byte("pretend this is an mp3")...)

	t.Run("bytes get a file with the sniffed extension", func(t *testing.T) {
		calls = nil
		dir := t.TempDir()
		// the mime is wrong on purpose: the magic bytes win
		out, stats, err := prepareWAV(context.Background(), audioInput{data: mp3, mime: "audio/webm"}, dir)
		if err != nil || stats.samples < 15990 || stats.samples > 16010 {
			t.Fatalf("stats %+v, err %v", stats, err)
		}
		readOutputWAV(t, out)
		if len(calls) != 1 || filepath.Ext(calls[0].in) != ".mp3" || string(calls[0].content) != string(mp3) {
			t.Fatalf("transcoder calls: %+v", calls)
		}
		if _, err := os.Stat(filepath.Join(dir, "decoded.wav")); !os.IsNotExist(err) {
			t.Error("the intermediate WAV should be removed right away")
		}
	})
	t.Run("a file with the right extension is not copied", func(t *testing.T) {
		calls = nil
		src := filepath.Join(t.TempDir(), "memo.MP3")
		os.WriteFile(src, mp3, 0o644)
		if _, _, err := prepareWAV(context.Background(), audioInput{path: src}, t.TempDir()); err != nil {
			t.Fatal(err)
		}
		if len(calls) != 1 || calls[0].in != src {
			t.Fatalf("transcoder should read the original: %+v", calls)
		}
	})
	t.Run("a file with the wrong extension is copied", func(t *testing.T) {
		calls = nil
		src := filepath.Join(t.TempDir(), "memo.dat")
		os.WriteFile(src, mp3, 0o644)
		dir := t.TempDir()
		if _, _, err := prepareWAV(context.Background(), audioInput{path: src}, dir); err != nil {
			t.Fatal(err)
		}
		if len(calls) != 1 || calls[0].in != filepath.Join(dir, "input.mp3") || string(calls[0].content) != string(mp3) {
			t.Fatalf("transcoder calls: %+v", calls)
		}
	})
	t.Run("mime is the fallback when the bytes are not recognised", func(t *testing.T) {
		calls = nil
		if _, _, err := prepareWAV(context.Background(), audioInput{data: []byte("no magic here"), mime: "audio/webm;codecs=opus"}, t.TempDir()); err != nil {
			t.Fatal(err)
		}
		if len(calls) != 1 || filepath.Ext(calls[0].in) != ".webm" {
			t.Fatalf("transcoder calls: %+v", calls)
		}
	})
}

func TestPrepareWAVFallsBackToFFmpeg(t *testing.T) {
	webm := []byte{0x1A, 0x45, 0xDF, 0xA3, 1, 2, 3, 4, 5}
	ffmpegWAV := makeWAV(wavOpts{rate: 16000, bits: 16}, tone(16000, 1, 600, 0.5, 1))

	for name, transcoderErr := range map[string]error{
		"transcoder cannot decode it": errors.New("cannot transcode: InputContainsUnsupportedFormat"),
		"no transcoder on this OS":    errNoTranscoder,
	} {
		t.Run(name, func(t *testing.T) {
			newTestEnv(t)
			var tcalls []transcodeCall
			stubTranscoder(t, &tcalls, func(string) error { return transcoderErr })
			lookPath = func(name string) (string, error) {
				if name != "ffmpeg" {
					t.Errorf("looked up %q", name)
				}
				return `C:\tools\ffmpeg.exe`, nil
			}
			var gotExe, gotIn string
			execFFmpeg = func(_ context.Context, exe, in, out string) error {
				gotExe, gotIn = exe, in
				return os.WriteFile(out, ffmpegWAV, 0o644)
			}
			out, stats, err := prepareWAV(context.Background(), audioInput{data: webm}, t.TempDir())
			if err != nil || stats.samples != 16000 {
				t.Fatalf("stats %+v, err %v", stats, err)
			}
			readOutputWAV(t, out)
			if gotExe != `C:\tools\ffmpeg.exe` || filepath.Ext(gotIn) != ".webm" {
				t.Errorf("ffmpeg got exe %q in %q", gotExe, gotIn)
			}
		})
	}
}

func TestFFmpegArgs(t *testing.T) {
	got := strings.Join(ffmpegArgs("in.webm", "out.wav"), " ")
	for _, want := range []string{"-y", "-i in.webm", "-ar 16000", "-ac 1", "-c:a pcm_s16le"} {
		if !strings.Contains(got, want) {
			t.Errorf("args %q lack %q", got, want)
		}
	}
	if !strings.HasSuffix(got, " out.wav") {
		t.Errorf("the output file must come last: %q", got)
	}
	if strings.Contains(got, "hide_banner") {
		t.Errorf("old ffmpeg builds reject -hide_banner: %q", got)
	}
}

func TestPrepareWAVUnreadableFormat(t *testing.T) {
	webm := []byte{0x1A, 0x45, 0xDF, 0xA3, 1, 2, 3, 4, 5}
	failing := func(t *testing.T) {
		var calls []transcodeCall
		stubTranscoder(t, &calls, func(string) error { return errors.New("cannot transcode: unsupported") })
	}

	t.Run("no ffmpeg", func(t *testing.T) {
		newTestEnv(t)
		failing(t)
		_, _, err := prepareWAV(context.Background(), audioInput{data: webm}, t.TempDir())
		if err == nil || !strings.Contains(err.Error(), "WEBM") || !strings.Contains(err.Error(), "読み取れません") || !strings.Contains(err.Error(), "ffmpeg をインストール") {
			t.Fatalf("got %v", err)
		}
	})
	t.Run("ffmpeg fails", func(t *testing.T) {
		newTestEnv(t)
		failing(t)
		lookPath = func(string) (string, error) { return "ffmpeg", nil }
		execFFmpeg = func(context.Context, string, string, string) error {
			return errors.New("ffmpeg が失敗しました: bad data")
		}
		_, _, err := prepareWAV(context.Background(), audioInput{data: webm}, t.TempDir())
		if err == nil || !strings.Contains(err.Error(), "WEBM") || !strings.Contains(err.Error(), "ffmpeg でも") || !strings.Contains(err.Error(), "bad data") {
			t.Fatalf("got %v", err)
		}
	})
	t.Run("ffmpeg writes something that is not a WAV", func(t *testing.T) {
		newTestEnv(t)
		failing(t)
		lookPath = func(string) (string, error) { return "ffmpeg", nil }
		execFFmpeg = func(_ context.Context, _, _, out string) error { return os.WriteFile(out, []byte("garbage"), 0o644) }
		if _, _, err := prepareWAV(context.Background(), audioInput{data: webm}, t.TempDir()); err == nil {
			t.Fatal("expected an error")
		}
	})
	t.Run("unknown format names the mime", func(t *testing.T) {
		newTestEnv(t)
		failing(t)
		_, _, err := prepareWAV(context.Background(), audioInput{data: []byte("who knows"), mime: "audio/x-weird"}, t.TempDir())
		if err == nil || !strings.Contains(err.Error(), "不明な形式") || !strings.Contains(err.Error(), "audio/x-weird") {
			t.Fatalf("got %v", err)
		}
	})
	t.Run("empty input", func(t *testing.T) {
		newTestEnv(t)
		for _, in := range []audioInput{{}, {data: []byte{}}} {
			if _, _, err := prepareWAV(context.Background(), in, t.TempDir()); err == nil || !strings.Contains(err.Error(), "空") {
				t.Errorf("got %v", err)
			}
		}
	})
	t.Run("missing file", func(t *testing.T) {
		newTestEnv(t)
		if _, _, err := prepareWAV(context.Background(), audioInput{path: filepath.Join(t.TempDir(), "gone.wav")}, t.TempDir()); err == nil {
			t.Fatal("expected an error")
		}
	})
	t.Run("corrupt wav is an error, not a detour", func(t *testing.T) {
		newTestEnv(t)
		wav := makeWAV(wavOpts{rate: 16000, bits: 16}, tone(16000, 1, 440, 0.5, 0.1))
		if _, _, err := prepareWAV(context.Background(), audioInput{data: wav[:30]}, t.TempDir()); err == nil {
			t.Fatal("expected an error")
		}
	})
}

func TestPrepareWAVSendsUnsupportedWAVCodecsToTheDecoders(t *testing.T) {
	newTestEnv(t)
	var calls []transcodeCall
	stubTranscoder(t, &calls, func(out string) error { return os.WriteFile(out, windowsStyleWAV(), 0o644) })
	adpcm := makeWAV(wavOpts{tag: 2, rate: 16000, bits: 16}, tone(16000, 1, 440, 0.5, 0.1))
	if _, _, err := prepareWAV(context.Background(), audioInput{data: adpcm}, t.TempDir()); err != nil {
		t.Fatal(err)
	}
	if len(calls) != 1 || filepath.Ext(calls[0].in) != ".wav" {
		t.Fatalf("transcoder calls: %+v", calls)
	}
}

func TestPrepareWAVStopsOnCancelledContext(t *testing.T) {
	newTestEnv(t)
	ctx, cancel := context.WithCancel(context.Background())
	runTranscoder = func(ctx context.Context, _, _ string) error {
		cancel()
		return ctx.Err()
	}
	lookPath = func(string) (string, error) {
		t.Error("ffmpeg must not be looked up after cancellation")
		return "", os.ErrNotExist
	}
	_, _, err := prepareWAV(ctx, audioInput{data: []byte("ID3\x04\x00\x00\x00\x00\x00\x00abc")}, t.TempDir())
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("got %v, want context.Canceled", err)
	}
}
