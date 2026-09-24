package speech

import (
	"bytes"
	"context"
	"encoding/binary"
	"math"
	"os"
	"path/filepath"
	"testing"

	"md-memo/pkg/components"
	"md-memo/pkg/llm"
)

type wavOpts struct {
	tag          uint16 // 1 = PCM, 3 = float, 0xFFFE = extensible
	subTag       uint16 // extensible only
	channels     int
	rate         int
	bits         int
	junkBefore   int  // size of a JUNK chunk placed before fmt
	oddChunk     bool // a 3-byte chunk (plus pad byte) between fmt and data
	trailingList bool // a LIST chunk after data
	dataSize     *uint32
	magic        string // "RIFF" (default) or "RF64"
}

func u32(v uint32) *uint32 { return &v }

func chunk(id string, body []byte) []byte {
	out := append([]byte(id), 0, 0, 0, 0)
	binary.LittleEndian.PutUint32(out[4:], uint32(len(body)))
	out = append(out, body...)
	if len(body)&1 == 1 {
		out = append(out, 0)
	}
	return out
}

func encodeSamples(o wavOpts, samples []float64) []byte {
	var b bytes.Buffer
	le := binary.LittleEndian
	for _, v := range samples {
		v = math.Max(-1, math.Min(1, v))
		switch {
		case o.tag == 3 || (o.tag == 0xFFFE && o.subTag == 3):
			if o.bits == 64 {
				binary.Write(&b, le, math.Float64bits(v))
			} else {
				binary.Write(&b, le, math.Float32bits(float32(v)))
			}
		case o.bits == 8:
			b.WriteByte(byte(math.Round(v*127) + 128))
		case o.bits == 16:
			binary.Write(&b, le, int16(math.Round(v*32767)))
		case o.bits == 24:
			n := int32(math.Round(v * 8388607))
			b.Write([]byte{byte(n), byte(n >> 8), byte(n >> 16)})
		case o.bits == 32:
			binary.Write(&b, le, int32(math.Round(v*2147483647)))
		}
	}
	return b.Bytes()
}

func makeWAV(o wavOpts, samples []float64) []byte {
	if o.channels == 0 {
		o.channels = 1
	}
	if o.tag == 0 {
		o.tag = 1
	}
	le := binary.LittleEndian
	fmtBody := make([]byte, 16)
	le.PutUint16(fmtBody[0:], o.tag)
	le.PutUint16(fmtBody[2:], uint16(o.channels))
	le.PutUint32(fmtBody[4:], uint32(o.rate))
	le.PutUint32(fmtBody[8:], uint32(o.rate*o.channels*o.bits/8))
	le.PutUint16(fmtBody[12:], uint16(o.channels*o.bits/8))
	le.PutUint16(fmtBody[14:], uint16(o.bits))
	if o.tag == 0xFFFE {
		ext := make([]byte, 24)
		le.PutUint16(ext[0:], 22)
		le.PutUint16(ext[2:], uint16(o.bits))
		le.PutUint32(ext[4:], 3)
		le.PutUint16(ext[8:], o.subTag)
		copy(ext[10:], []byte{0x00, 0x00, 0x00, 0x00, 0x10, 0x00, 0x80, 0x00, 0x00, 0xAA, 0x00, 0x38, 0x9B, 0x71})
		fmtBody = append(fmtBody, ext...)
	}

	data := encodeSamples(o, samples)
	magic := o.magic
	if magic == "" {
		magic = "RIFF"
	}
	var body bytes.Buffer
	body.WriteString("WAVE")
	if o.junkBefore > 0 {
		body.Write(chunk("JUNK", make([]byte, o.junkBefore)))
	}
	body.Write(chunk("fmt ", fmtBody))
	if o.oddChunk {
		body.Write(chunk("abcd", []byte{1, 2, 3}))
	}
	dataChunk := append([]byte("data"), 0, 0, 0, 0)
	size := uint32(len(data))
	if o.dataSize != nil {
		size = *o.dataSize
	}
	le.PutUint32(dataChunk[4:], size)
	body.Write(dataChunk)
	body.Write(data)
	if o.trailingList {
		body.Write(chunk("LIST", []byte("INFOISFT\x05\x00\x00\x00Lavf\x00")))
	}

	out := append([]byte(magic), 0, 0, 0, 0)
	le.PutUint32(out[4:], uint32(body.Len()))
	return append(out, body.Bytes()...)
}

// tone returns interleaved samples of a sine that is identical on every channel.
func tone(rate, channels int, freq, amp, seconds float64) []float64 {
	n := int(float64(rate) * seconds)
	out := make([]float64, 0, n*channels)
	for i := 0; i < n; i++ {
		v := amp * math.Sin(2*math.Pi*freq*float64(i)/float64(rate))
		for c := 0; c < channels; c++ {
			out = append(out, v)
		}
	}
	return out
}

func readOutputWAV(t *testing.T, path string) []int16 {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if len(raw) < wavHeaderSize {
		t.Fatalf("output is %d bytes, shorter than a header", len(raw))
	}
	le := binary.LittleEndian
	if string(raw[0:4]) != "RIFF" || string(raw[8:16]) != "WAVEfmt " || string(raw[36:40]) != "data" {
		t.Fatalf("output is not a canonical WAV: % x", raw[:44])
	}
	if le.Uint32(raw[16:]) != 16 || le.Uint16(raw[20:]) != 1 || le.Uint16(raw[22:]) != 1 ||
		le.Uint32(raw[24:]) != 16000 || le.Uint32(raw[28:]) != 32000 || le.Uint16(raw[32:]) != 2 || le.Uint16(raw[34:]) != 16 {
		t.Fatalf("output is not 16 kHz mono 16-bit PCM: % x", raw[:44])
	}
	dataLen := int(le.Uint32(raw[40:]))
	if dataLen != len(raw)-wavHeaderSize || int(le.Uint32(raw[4:])) != len(raw)-8 {
		t.Fatalf("header sizes are wrong: data %d riff %d file %d", dataLen, le.Uint32(raw[4:]), len(raw))
	}
	out := make([]int16, dataLen/2)
	for i := range out {
		out[i] = int16(le.Uint16(raw[wavHeaderSize+2*i:]))
	}
	return out
}

func convertBytes(t *testing.T, wav []byte) []int16 {
	t.Helper()
	out := filepath.Join(t.TempDir(), "out.wav")
	if _, err := convertWAV(context.Background(), bytes.NewReader(wav), out); err != nil {
		t.Fatalf("convertWAV: %v", err)
	}
	return readOutputWAV(t, out)
}

func rmsOf(s []int16) float64 {
	if len(s) == 0 {
		return 0
	}
	var sum float64
	for _, v := range s {
		sum += float64(v) * float64(v)
	}
	return math.Sqrt(sum / float64(len(s)))
}

func zeroCrossings(s []int16) int {
	n := 0
	for i := 1; i < len(s); i++ {
		if (s[i-1] < 0) != (s[i] < 0) {
			n++
		}
	}
	return n
}

type fakeStore map[string]string

func (f fakeStore) Path(p components.Part) (string, bool) {
	v, ok := f[p.ID]
	return v, ok
}

type fakeWhisper struct {
	calls   [][]string
	exe     []string
	handler func(ctx context.Context, exe string, args []string) error
}

// testEnv stubs every package var that touches the OS and returns a Service that is ready to run
// the local engine against fake files.
type testEnv struct {
	svc      *Service
	store    fakeStore
	tempRoot string
	whisper  *fakeWhisper
	gemini   *fakeGemini
	exe      string
	model    string
}

type fakeGemini struct {
	calls []geminiCall
	text  string
	err   error
}

type geminiCall struct {
	prompt, b64, mime string
	cfg               llm.VoiceConfig
}

func writeModel(t *testing.T, path string, vocab int32) {
	t.Helper()
	b := make([]byte, 64)
	binary.LittleEndian.PutUint32(b, ggmlMagic)
	binary.LittleEndian.PutUint32(b[4:], uint32(vocab))
	if err := os.WriteFile(path, b, 0o644); err != nil {
		t.Fatal(err)
	}
}

func newTestEnv(t *testing.T) *testEnv {
	t.Helper()
	root := t.TempDir()
	e := &testEnv{
		store:    fakeStore{},
		tempRoot: filepath.Join(root, "tmp"),
		whisper:  &fakeWhisper{},
		gemini:   &fakeGemini{text: "gemini text"},
		exe:      filepath.Join(root, "runtime", "whisper-cli.exe"),
		model:    filepath.Join(root, "models", "model.bin"),
	}
	for _, d := range []string{e.tempRoot, filepath.Dir(e.exe), filepath.Dir(e.model)} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	writeModel(t, e.model, 51866)

	e.whisper.handler = writeTranscript("こんにちは。\n")
	oldPlatform, oldWhisper, oldGemini := hostPlatform, execWhisper, queryGeminiAudio
	oldLook, oldTranscoder, oldFFmpeg := lookPath, runTranscoder, execFFmpeg
	hostPlatform = func() string { return "windows/amd64" }
	execWhisper = func(ctx context.Context, exe string, args []string) error {
		e.whisper.exe = append(e.whisper.exe, exe)
		e.whisper.calls = append(e.whisper.calls, append([]string(nil), args...))
		return e.whisper.handler(ctx, exe, args)
	}
	queryGeminiAudio = func(prompt, b64, mime string, cfg llm.VoiceConfig) (string, error) {
		e.gemini.calls = append(e.gemini.calls, geminiCall{prompt, b64, mime, cfg})
		return e.gemini.text, e.gemini.err
	}
	lookPath = func(string) (string, error) { return "", os.ErrNotExist }
	runTranscoder = func(context.Context, string, string) error {
		t.Error("the system transcoder must not run in this test")
		return errNoTranscoder
	}
	execFFmpeg = func(context.Context, string, string, string) error {
		t.Error("ffmpeg must not run in this test")
		return os.ErrNotExist
	}
	t.Cleanup(func() {
		hostPlatform, execWhisper, queryGeminiAudio = oldPlatform, oldWhisper, oldGemini
		lookPath, runTranscoder, execFFmpeg = oldLook, oldTranscoder, oldFFmpeg
	})

	rt := runtimeCatalogPart()
	e.store[rt.ID] = e.exe
	def, _ := ResolveModelPart(llm.WhisperSettings{})
	e.store[def.ID] = e.model
	e.svc = &Service{store: e.store, tempRoot: e.tempRoot}
	return e
}

// writeTranscript makes a fake whisper-cli that writes text to the -of prefix.
func writeTranscript(text string) func(context.Context, string, []string) error {
	return func(_ context.Context, _ string, args []string) error {
		return os.WriteFile(argAfter(args, "-of")+".txt", []byte(text), 0o644)
	}
}

func argAfter(args []string, flag string) string {
	for i, a := range args {
		if a == flag && i+1 < len(args) {
			return args[i+1]
		}
	}
	return ""
}

func (e *testEnv) assertTempClean(t *testing.T) {
	t.Helper()
	entries, err := os.ReadDir(e.tempRoot)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 0 {
		t.Errorf("temp files left behind: %v", entries)
	}
}

func localCfg() llm.VoiceConfig {
	return llm.VoiceConfig{Engine: engineWhisperLocal, Whisper: llm.WhisperSettings{Language: "ja", Threads: 3}}
}
