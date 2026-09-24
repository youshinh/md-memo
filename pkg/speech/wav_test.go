package speech

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"math"
	"math/rand"
	"os"
	"path/filepath"
	"testing"
	"testing/iotest"
)

func TestConvertJunkChunkBeforeFmtStereo44k(t *testing.T) {
	// the layout Windows' MediaTranscoder produces
	wav := makeWAV(wavOpts{channels: 2, rate: 44100, bits: 16, junkBefore: 28}, tone(44100, 2, 1000, 0.5, 1))
	got := convertBytes(t, wav)
	if n := len(got); n < 15990 || n > 16010 {
		t.Fatalf("got %d samples for one second, want about 16000", n)
	}
	mid := got[1000 : len(got)-1000]
	if zc := zeroCrossings(mid); math.Abs(float64(zc)-2*float64(len(mid))/16) > 4 {
		t.Errorf("1 kHz tone has %d zero crossings over %d samples", zc, len(mid))
	}
	if r, want := rmsOf(mid), 0.5/math.Sqrt2*32767; math.Abs(r-want) > want*0.03 {
		t.Errorf("rms %.0f, want about %.0f", r, want)
	}
}

func TestConvertSampleFormats(t *testing.T) {
	// left 0.5, right 0.25 -> mono 0.375; a mono file just keeps its value
	cases := []struct {
		name string
		o    wavOpts
		tol  float64
	}{
		{"pcm8", wavOpts{bits: 8}, 300},
		{"pcm16", wavOpts{bits: 16}, 2},
		{"pcm24", wavOpts{bits: 24}, 2},
		{"pcm32", wavOpts{bits: 32}, 2},
		{"float32", wavOpts{tag: 3, bits: 32}, 2},
		{"float64", wavOpts{tag: 3, bits: 64}, 2},
		{"extensible pcm24", wavOpts{tag: 0xFFFE, subTag: 1, bits: 24}, 2},
		{"extensible float32", wavOpts{tag: 0xFFFE, subTag: 3, bits: 32}, 2},
	}
	for _, c := range cases {
		for _, ch := range []int{1, 2, 3} {
			t.Run(fmt.Sprintf("%s/%dch", c.name, ch), func(t *testing.T) {
				o := c.o
				o.channels, o.rate = ch, 16000
				var samples []float64
				want := 0.5
				vals := []float64{0.5, 0.25, 0.25}
				switch ch {
				case 2:
					want = 0.375
				case 3:
					want = 1.0 / 3
				}
				for i := 0; i < 200; i++ {
					samples = append(samples, vals[:ch]...)
				}
				got := convertBytes(t, makeWAV(o, samples))
				if len(got) != 200 {
					t.Fatalf("got %d samples, want 200", len(got))
				}
				for _, v := range got {
					if math.Abs(float64(v)-want*32768) > c.tol {
						t.Fatalf("sample %d, want %.0f (+-%.0f)", v, want*32768, c.tol)
					}
				}
			})
		}
	}
}

func TestConvertStreamedDataSizes(t *testing.T) {
	samples := tone(16000, 1, 440, 0.4, 0.5)
	want := convertBytes(t, makeWAV(wavOpts{rate: 16000, bits: 16}, samples))
	if len(want) != 8000 {
		t.Fatalf("reference has %d samples", len(want))
	}
	for name, size := range map[string]uint32{
		"zero":             0,
		"0xFFFFFFFF":       0xFFFFFFFF,
		"larger than file": 1 << 30,
	} {
		t.Run(name, func(t *testing.T) {
			got := convertBytes(t, makeWAV(wavOpts{rate: 16000, bits: 16, dataSize: u32(size)}, samples))
			if len(got) != len(want) {
				t.Fatalf("got %d samples, want %d", len(got), len(want))
			}
		})
	}
	t.Run("RF64", func(t *testing.T) {
		got := convertBytes(t, makeWAV(wavOpts{rate: 16000, bits: 16, magic: "RF64", dataSize: u32(0xFFFFFFFF)}, samples))
		if len(got) != len(want) {
			t.Fatalf("got %d samples, want %d", len(got), len(want))
		}
	})
}

func TestConvertChunkLayouts(t *testing.T) {
	samples := tone(16000, 1, 440, 0.4, 0.25)
	want := convertBytes(t, makeWAV(wavOpts{rate: 16000, bits: 16}, samples))
	t.Run("odd sized chunk is padded", func(t *testing.T) {
		got := convertBytes(t, makeWAV(wavOpts{rate: 16000, bits: 16, oddChunk: true, junkBefore: 5}, samples))
		if !equalInt16(got, want) {
			t.Fatal("audio differs after skipping odd-sized chunks")
		}
	})
	t.Run("trailing LIST is not audio", func(t *testing.T) {
		got := convertBytes(t, makeWAV(wavOpts{rate: 16000, bits: 16, trailingList: true}, samples))
		if !equalInt16(got, want) {
			t.Fatalf("got %d samples, want %d identical ones", len(got), len(want))
		}
	})
	t.Run("truncated final frame is dropped", func(t *testing.T) {
		wav := makeWAV(wavOpts{channels: 2, rate: 16000, bits: 16}, tone(16000, 2, 440, 0.4, 0.25))
		got := convertBytes(t, wav[:len(wav)-3])
		if len(got) != 4000-1 {
			t.Fatalf("got %d samples, want 3999", len(got))
		}
	})
}

func TestConvertRejectsBadWAV(t *testing.T) {
	good := makeWAV(wavOpts{rate: 16000, bits: 16}, tone(16000, 1, 440, 0.4, 0.1))
	cases := map[string][]byte{
		"not riff":      []byte("this is not a wav file at all"),
		"no data chunk": good[:20+16],
		"empty":         nil,
	}
	for name, raw := range cases {
		out := filepath.Join(t.TempDir(), "o.wav")
		if _, err := convertWAV(context.Background(), bytes.NewReader(raw), out); err == nil {
			t.Errorf("%s: expected an error", name)
		}
	}

	adpcm := makeWAV(wavOpts{tag: 2, rate: 16000, bits: 16}, tone(16000, 1, 440, 0.4, 0.1))
	_, err := convertWAV(context.Background(), bytes.NewReader(adpcm), filepath.Join(t.TempDir(), "o.wav"))
	if !errors.Is(err, errUnsupportedWAV) {
		t.Errorf("ADPCM: got %v, want errUnsupportedWAV", err)
	}
	_, err = convertWAV(context.Background(), bytes.NewReader([]byte("RIFFxxxxAVI ")), filepath.Join(t.TempDir(), "o.wav"))
	if !errors.Is(err, errNotWAV) {
		t.Errorf("RIFF AVI: got %v, want errNotWAV", err)
	}
}

func TestConvertHonoursCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	wav := makeWAV(wavOpts{rate: 16000, bits: 16}, tone(16000, 1, 440, 0.4, 0.1))
	if _, err := convertWAV(ctx, bytes.NewReader(wav), filepath.Join(t.TempDir(), "o.wav")); !errors.Is(err, context.Canceled) {
		t.Fatalf("got %v, want context.Canceled", err)
	}
}

func TestResampleToneKeepsFrequencyAndAmplitude(t *testing.T) {
	for _, rate := range []int{8000, 11025, 22050, 32000, 44100, 48000, 96000} {
		for _, freq := range []float64{300, 1000, 3000, 6000} {
			if freq > float64(rate)*0.4 { // the source itself could not hold it
				continue
			}
			t.Run(fmt.Sprintf("%dHz/%.0fHz", rate, freq), func(t *testing.T) {
				wav := makeWAV(wavOpts{channels: 2, rate: rate, bits: 16}, tone(rate, 2, freq, 0.5, 1))
				got := convertBytes(t, wav)
				if len(got) < 15990 || len(got) > 16010 {
					t.Fatalf("got %d samples, want about 16000", len(got))
				}
				mid := got[1000 : len(got)-1000]
				wantZC := 2 * freq * float64(len(mid)) / 16000
				if zc := zeroCrossings(mid); math.Abs(float64(zc)-wantZC) > 4 {
					t.Errorf("%d zero crossings, want about %.0f", zc, wantZC)
				}
				if r, want := rmsOf(mid), 0.5/math.Sqrt2*32767; math.Abs(r-want) > want*0.05 {
					t.Errorf("rms %.0f, want about %.0f", r, want)
				}
			})
		}
	}
}

func TestResampleAttenuatesAboveNyquist(t *testing.T) {
	// Anything above 8 kHz must be filtered out, not folded back into the speech band.
	for _, c := range []struct {
		rate int
		freq float64
	}{{44100, 9000}, {44100, 10000}, {44100, 15000}, {48000, 9500}, {48000, 12000}, {48000, 20000}, {96000, 30000}} {
		t.Run(fmt.Sprintf("%dHz/%.0fHz", c.rate, c.freq), func(t *testing.T) {
			got := convertBytes(t, makeWAV(wavOpts{channels: 2, rate: c.rate, bits: 16}, tone(c.rate, 2, c.freq, 0.5, 1)))
			mid := got[1000 : len(got)-1000]
			in := 0.5 / math.Sqrt2 * 32767
			if r := rmsOf(mid); r > in*0.01 {
				t.Errorf("rms %.1f is %.1f%% of the input (%.0f); it aliased", r, 100*r/in, in)
			}
		})
	}
}

func TestResampleUnusualRate(t *testing.T) {
	got := convertBytes(t, makeWAV(wavOpts{rate: 44117, bits: 16}, tone(44117, 1, 1000, 0.5, 2)))
	if math.Abs(float64(len(got))-32000) > 40 {
		t.Fatalf("got %d samples, want about 32000", len(got))
	}
	mid := got[1000 : len(got)-1000]
	if zc := zeroCrossings(mid); math.Abs(float64(zc)-2*1000*float64(len(mid))/16000) > 8 {
		t.Errorf("%d zero crossings", zc)
	}
}

func TestResamplerBlockSizeDoesNotMatter(t *testing.T) {
	rng := rand.New(rand.NewSource(7))
	in := make([]float32, 30000)
	for i := range in {
		in[i] = float32(0.4*math.Sin(float64(i)*0.05)+0.3*math.Sin(float64(i)*0.9)) + float32(rng.Float64()-0.5)*0.1
	}
	for _, rate := range []int{44100, 48000, 22050, 8000} {
		oneShot := newResampler(rate, targetRate)
		want := oneShot.finish(oneShot.push(in, nil))
		for _, block := range []int{1, 7, 100, 441, 4096, 30000} {
			r := newResampler(rate, targetRate)
			var got []float32
			for i := 0; i < len(in); i += block {
				got = r.push(in[i:min(i+block, len(in))], got)
			}
			got = r.finish(got)
			if len(got) != len(want) {
				t.Fatalf("%d Hz, block %d: %d samples, want %d", rate, block, len(got), len(want))
			}
			for i := range got {
				if math.Abs(float64(got[i]-want[i])) > 1e-6 {
					t.Fatalf("%d Hz, block %d: sample %d is %v, want %v", rate, block, i, got[i], want[i])
				}
			}
		}
	}
}

func TestConvertReaderChunkingDoesNotMatter(t *testing.T) {
	wav := makeWAV(wavOpts{channels: 2, rate: 44100, bits: 24, junkBefore: 16}, tone(44100, 2, 700, 0.6, 0.6))
	dir := t.TempDir()
	a, b := filepath.Join(dir, "a.wav"), filepath.Join(dir, "b.wav")
	if _, err := convertWAV(context.Background(), bytes.NewReader(wav), a); err != nil {
		t.Fatal(err)
	}
	if _, err := convertWAV(context.Background(), iotest.OneByteReader(bytes.NewReader(wav)), b); err != nil {
		t.Fatal(err)
	}
	rawA, _ := os.ReadFile(a)
	rawB, _ := os.ReadFile(b)
	if !bytes.Equal(rawA, rawB) {
		t.Fatal("output depends on how the reader delivers bytes")
	}
}

func TestResamplerIdentityRatePassesThrough(t *testing.T) {
	samples := tone(16000, 1, 500, 0.5, 0.25)
	wav := makeWAV(wavOpts{rate: 16000, bits: 16}, samples)
	got := convertBytes(t, wav)
	for i, v := range got {
		if want := math.Round(samples[i] * 32767); math.Abs(float64(v)-want) > 1 {
			t.Fatalf("sample %d is %d, want %.0f", i, v, want)
		}
	}
}

func TestAutoThreads(t *testing.T) {
	for cpus, want := range map[int]int{1: 2, 2: 2, 4: 2, 6: 3, 8: 4, 16: 8, 32: 8, 128: 8} {
		if got := autoThreads(cpus); got != want {
			t.Errorf("autoThreads(%d) = %d, want %d", cpus, got, want)
		}
	}
}

func equalInt16(a, b []int16) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}
