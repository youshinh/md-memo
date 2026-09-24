package speech

import (
	"bytes"
	"context"
	"io"
	"math"
	"path/filepath"
	"runtime"
	"testing"
)

// repeatReader serves total bytes made of block repeated, so an hour of audio needs no memory.
type repeatReader struct {
	block     []byte
	remaining int64
	pos       int
}

func (r *repeatReader) Read(p []byte) (int, error) {
	if r.remaining <= 0 {
		return 0, io.EOF
	}
	n := 0
	for n < len(p) && r.remaining > 0 {
		c := copy(p[n:], r.block[r.pos:])
		if int64(c) > r.remaining {
			c = int(r.remaining)
		}
		n += c
		r.remaining -= int64(c)
		r.pos = (r.pos + c) % len(r.block)
	}
	return n, nil
}

// streamedTone is a 441 Hz stereo 16-bit WAV of the given length whose data size is left at
// 0xFFFFFFFF, as a streaming writer would.
func streamedTone(seconds int, rate int) io.Reader {
	header := makeWAV(wavOpts{channels: 2, rate: rate, bits: 16, junkBefore: 28, dataSize: u32(0xFFFFFFFF)}, nil)
	oneSecond := encodeSamples(wavOpts{bits: 16}, tone(rate, 2, 441, 0.5, 1))
	return io.MultiReader(bytes.NewReader(header), &repeatReader{block: oneSecond, remaining: int64(seconds) * int64(len(oneSecond))})
}

func TestConvertLongRecordingStreams(t *testing.T) {
	const minutes = 4
	var before, after runtime.MemStats
	runtime.ReadMemStats(&before)
	out := filepath.Join(t.TempDir(), "long.wav")
	stats, err := convertWAV(context.Background(), streamedTone(minutes*60, 44100), out)
	if err != nil {
		t.Fatal(err)
	}
	runtime.ReadMemStats(&after)

	if want := int64(minutes * 60 * 16000); math.Abs(float64(stats.samples-want)) > 4 {
		t.Fatalf("got %d samples, want about %d", stats.samples, want)
	}
	inputBytes := uint64(minutes * 60 * 44100 * 4)
	if alloc := after.TotalAlloc - before.TotalAlloc; alloc > inputBytes/3 {
		t.Errorf("allocated %d MB converting %d MB of audio; the input is not being streamed", alloc>>20, inputBytes>>20)
	}
	got := readOutputWAV(t, out)
	if r, want := rmsOf(got[16000:len(got)-16000]), 0.5/math.Sqrt2*32767; math.Abs(r-want) > want*0.03 {
		t.Errorf("rms %.0f, want about %.0f", r, want)
	}
}

func BenchmarkConvertOneHour44k(b *testing.B) {
	for i := 0; i < b.N; i++ {
		out := filepath.Join(b.TempDir(), "hour.wav")
		if _, err := convertWAV(context.Background(), streamedTone(3600, 44100), out); err != nil {
			b.Fatal(err)
		}
	}
}

func BenchmarkConvertOneHour48k(b *testing.B) {
	for i := 0; i < b.N; i++ {
		out := filepath.Join(b.TempDir(), "hour.wav")
		if _, err := convertWAV(context.Background(), streamedTone(3600, 48000), out); err != nil {
			b.Fatal(err)
		}
	}
}
