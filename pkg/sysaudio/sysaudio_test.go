package sysaudio

import (
	"encoding/binary"
	"math"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestMixerSumsSaturatesAndPads(t *testing.T) {
	m := NewMixer(2)
	m.Push(0, []int16{100, 200, 30000, -30000})
	m.Push(1, []int16{1, 2, 30000, -30000})
	got := m.Mix(6) // source 0 has 4, source 1 has 4: the last two are silence
	want := []int16{101, 202, 32767, -32768, 0, 0}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("sample %d = %d, want %d (all: %v)", i, got[i], want[i], got)
		}
	}
	if m.Pushed(0) != 4 || m.Pushed(1) != 4 {
		t.Fatalf("pushed counters: %d %d", m.Pushed(0), m.Pushed(1))
	}
}

func TestMixerGainAndNoPushIsSilence(t *testing.T) {
	m := NewMixer(2, 0.5, 1)
	m.Push(0, []int16{1000})
	got := m.Mix(2)
	if got[0] != 500 || got[1] != 0 {
		t.Fatalf("got %v", got)
	}
	if z := m.Mix(3); z[0] != 0 || z[2] != 0 {
		t.Fatalf("an empty mixer must give silence, got %v", z)
	}
}

func TestMixerBacklogSkipsAhead(t *testing.T) {
	m := NewMixer(1)
	big := make([]int16, SampleRate*4)
	for i := range big {
		big[i] = int16(i % 1000)
	}
	m.Push(0, big)
	m.Mix(SampleRate / 10)
	m.mu.Lock()
	left := len(m.queues[0])
	m.mu.Unlock()
	if left != keepBacklog {
		t.Fatalf("a source running far ahead should be trimmed to %d samples, has %d", keepBacklog, left)
	}
}

func TestSegmentWriterRollsAndHeadersAreValid(t *testing.T) {
	dir := t.TempDir()
	w, err := NewSegmentWriter(dir, "rec", 1) // one second per file
	if err != nil {
		t.Fatal(err)
	}
	samples := make([]int16, SampleRate*5/2) // 2.5 s -> 3 files
	for i := range samples {
		samples[i] = int16(i % 3000)
	}
	if err := w.Write(samples[:1234]); err != nil {
		t.Fatal(err)
	}
	if err := w.Write(samples[1234:]); err != nil {
		t.Fatal(err)
	}
	files, err := w.Close()
	if err != nil {
		t.Fatal(err)
	}
	if len(files) != 3 {
		t.Fatalf("want 3 segments, got %v", files)
	}
	total := 0
	for i, f := range files {
		if filepath.Base(f) != []string{"rec_001.wav", "rec_002.wav", "rec_003.wav"}[i] {
			t.Fatalf("file name %q", f)
		}
		b, err := os.ReadFile(f)
		if err != nil {
			t.Fatal(err)
		}
		if string(b[0:4]) != "RIFF" || string(b[8:16]) != "WAVEfmt " || string(b[36:40]) != "data" {
			t.Fatalf("%s: not a WAV header", f)
		}
		dataBytes := int(binary.LittleEndian.Uint32(b[40:]))
		if dataBytes != len(b)-44 {
			t.Fatalf("%s: data size %d but %d bytes follow the header", f, dataBytes, len(b)-44)
		}
		if int(binary.LittleEndian.Uint32(b[4:])) != 36+dataBytes {
			t.Fatalf("%s: RIFF size wrong", f)
		}
		if binary.LittleEndian.Uint32(b[24:]) != SampleRate || binary.LittleEndian.Uint16(b[22:]) != 1 || binary.LittleEndian.Uint16(b[34:]) != 16 {
			t.Fatalf("%s: format fields", f)
		}
		total += dataBytes / 2
	}
	if total != len(samples) {
		t.Fatalf("wrote %d samples, files hold %d", len(samples), total)
	}
	// the first sample of the second file continues the sequence
	b, _ := os.ReadFile(files[1])
	if got := int16(binary.LittleEndian.Uint16(b[44:])); got != samples[SampleRate] {
		t.Fatalf("second file starts with %d, want %d", got, samples[SampleRate])
	}
}

func TestConverterDownmixesAndResamples(t *testing.T) {
	// 48 kHz stereo float: a 1 kHz sine, left = right. Expect 16 kHz mono with the same pitch and about the same level.
	const rate = 48000
	frames := rate // one second
	data := make([]byte, frames*2*4)
	for i := 0; i < frames; i++ {
		v := float32(0.5 * math.Sin(2*math.Pi*1000*float64(i)/rate))
		bits := math.Float32bits(v)
		for ch := 0; ch < 2; ch++ {
			binary.LittleEndian.PutUint32(data[(i*2+ch)*4:], bits)
		}
	}
	c := NewConverter(Format{Channels: 2, Rate: rate, Bits: 32, Float: true})
	var out []int16
	// feed in odd-sized packets to exercise the carried state
	for off := 0; off < frames; {
		n := 997
		if off+n > frames {
			n = frames - off
		}
		out = append(out, c.Convert(data[off*8:(off+n)*8], n)...)
		off += n
	}
	if len(out) < SampleRate-5 || len(out) > SampleRate+1 {
		t.Fatalf("want about %d samples, got %d", SampleRate, len(out))
	}
	if lv := Level(out); lv < 0.3 || lv > 0.4 { // 0.5 amplitude sine has RMS 0.354
		t.Fatalf("level %f", lv)
	}
	// 1 kHz at 16 kHz is 16 samples per period: zero crossings (upwards) should be about 1000
	up := 0
	for i := 1; i < len(out); i++ {
		if out[i-1] < 0 && out[i] >= 0 {
			up++
		}
	}
	if up < 990 || up > 1010 {
		t.Fatalf("pitch is off: %d rising zero crossings in a second", up)
	}
}

func TestConverterIntegerFormats(t *testing.T) {
	// 16-bit mono at 16 kHz is passed through (resample ratio 1)
	c := NewConverter(Format{Channels: 1, Rate: SampleRate, Bits: 16})
	in := []int16{0, 1000, -1000, 20000, -20000, 5}
	data := make([]byte, len(in)*2)
	for i, v := range in {
		binary.LittleEndian.PutUint16(data[i*2:], uint16(v))
	}
	out := c.Convert(data, len(in))
	if len(out) < len(in)-1 {
		t.Fatalf("too short: %v", out)
	}
	for i := range out {
		if d := int(out[i]) - int(in[i]); d < -2 || d > 2 {
			t.Fatalf("sample %d = %d, want %d", i, out[i], in[i])
		}
	}
	if NewConverter(Format{Channels: 0, Rate: 48000, Bits: 16}) != nil {
		t.Fatal("a format without channels must be refused")
	}
}

type fakeSource struct {
	name   string
	expect bool
	fail   error
	push   func([]int16)
	stops  int
}

func (f *fakeSource) Name() string      { return f.name }
func (f *fakeSource) ExpectAudio() bool { return f.expect }
func (f *fakeSource) Start(p func([]int16)) error {
	if f.fail != nil {
		return f.fail
	}
	f.push = p
	return nil
}
func (f *fakeSource) Stop() { f.stops++ }

func TestRecorderMixesTwoSourcesOnAWallClock(t *testing.T) {
	dir := t.TempDir()
	mic := &fakeSource{name: "microphone", expect: true}
	sys := &fakeSource{name: "PC audio"}
	r, err := NewRecorder(Options{Dir: dir, Prefix: "meeting", SegmentSeconds: 240}, []Source{mic, sys})
	if err != nil {
		t.Fatal(err)
	}
	clock := time.Unix(1000, 0)
	r.now = func() time.Time { return clock }
	if err := r.Start(); err != nil {
		t.Fatal(err)
	}
	// 2 s of a constant 1000 from the mic, 1 s of a constant 500 from the system starting at t=1 s (nothing before)
	mic.push(constant(1000, 2*SampleRate))
	sys.push(constant(500, SampleRate)) // pushed "late": it fills the first second of the mix in this simple model
	clock = clock.Add(2 * time.Second)
	res, err := r.Stop()
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Files) != 1 {
		t.Fatalf("files: %v", res.Files)
	}
	if math.Abs(res.Seconds-2) > 0.01 {
		t.Fatalf("seconds %f", res.Seconds)
	}
	b, _ := os.ReadFile(res.Files[0])
	first := int16(binary.LittleEndian.Uint16(b[44:]))
	last := int16(binary.LittleEndian.Uint16(b[len(b)-2:]))
	if first != 1500 || last != 1000 {
		t.Fatalf("first=%d (want 1500: both sources), last=%d (want 1000: the system source has ended)", first, last)
	}
	if len(res.Warnings) != 0 {
		t.Fatalf("a loopback that said nothing is not a problem, and the mic did deliver: %v", res.Warnings)
	}
	if mic.stops != 1 || sys.stops != 1 {
		t.Fatalf("every source is stopped once: %d %d", mic.stops, sys.stops)
	}
	if _, err := r.Stop(); err != nil { // a second Stop is harmless
		t.Fatal(err)
	}
}

func TestRecorderWarnsWhenTheMicrophoneDeliversNothingButNotTheLoopback(t *testing.T) {
	mic := &fakeSource{name: "microphone", expect: true}
	sys := &fakeSource{name: "PC audio"}
	r, _ := NewRecorder(Options{Dir: t.TempDir(), Prefix: "x"}, []Source{mic, sys})
	clock := time.Unix(0, 0)
	r.now = func() time.Time { return clock }
	if err := r.Start(); err != nil {
		t.Fatal(err)
	}
	clock = clock.Add(time.Second)
	res, _ := r.Stop()
	if len(res.Warnings) != 1 || res.Warnings[0] != "microphone: no audio arrived" {
		t.Fatalf("warnings: %v", res.Warnings)
	}
}

func TestRecorderDropsASourceThatCannotStartAndFailsWhenNoneCan(t *testing.T) {
	bad := &fakeSource{name: "microphone", expect: true, fail: os.ErrNotExist}
	ok := &fakeSource{name: "PC audio"}
	r, _ := NewRecorder(Options{Dir: t.TempDir(), Prefix: "x"}, []Source{bad, ok})
	if err := r.Start(); err != nil {
		t.Fatalf("one working source is enough: %v", err)
	}
	if w := r.Warnings(); len(w) != 1 {
		t.Fatalf("the missing microphone must be reported: %v", w)
	}
	r.Stop()

	r2, _ := NewRecorder(Options{Dir: t.TempDir(), Prefix: "y"}, []Source{&fakeSource{name: "a", fail: os.ErrNotExist}})
	if err := r2.Start(); err == nil {
		t.Fatal("no source started: Start must fail")
	}
	if _, err := NewRecorder(Options{Dir: t.TempDir()}, nil); err == nil {
		t.Fatal("no sources: NewRecorder must fail")
	}
}

func constant(v int16, n int) []int16 {
	out := make([]int16, n)
	for i := range out {
		out[i] = v
	}
	return out
}
