// Package sysaudio records the microphone and the sound playing on this PC (a Zoom call, a video) at the same time and
// mixes them into one 16 kHz mono 16-bit WAV, written to disk in segments so that a long meeting never has to fit in
// memory. The capture itself is Windows-only (WASAPI, see wasapi_windows.go); everything else here is portable and tested
// without a sound card: the mixer, the WAV segment writer and the converter from a device format to 16 kHz mono.
package sysaudio

import (
	"encoding/binary"
	"fmt"
	"os"
	"path/filepath"
	"sync"
)

// SampleRate is the rate of everything this package writes: what speech-to-text engines want, and small.
const SampleRate = 16000

const (
	// A source that runs faster than the wall clock (or delivered a burst) can pile up; past maxBacklog it skips ahead so
	// the two sources cannot drift apart by more than a second or so.
	maxBacklog  = SampleRate * 3 / 2
	keepBacklog = SampleRate / 2
)

// Mixer sums several sources into one stream. Each source pushes whatever it has whenever it has it; Mix(n) takes the next n
// samples of every source (a source that has less is padded with silence, which is exactly right for a loopback capture that
// delivers nothing while nothing plays) and adds them with saturation.
type Mixer struct {
	mu     sync.Mutex
	queues [][]int16
	pushed []int64
	gain   []float64
}

// NewMixer makes a mixer for n sources. gain (1.0 = unchanged) is applied to each source before adding.
func NewMixer(n int, gain ...float64) *Mixer {
	m := &Mixer{queues: make([][]int16, n), pushed: make([]int64, n), gain: make([]float64, n)}
	for i := range m.gain {
		m.gain[i] = 1
		if i < len(gain) && gain[i] > 0 {
			m.gain[i] = gain[i]
		}
	}
	return m
}

// Push appends samples of source src.
func (m *Mixer) Push(src int, samples []int16) {
	if len(samples) == 0 {
		return
	}
	m.mu.Lock()
	m.queues[src] = append(m.queues[src], samples...)
	m.pushed[src] += int64(len(samples))
	m.mu.Unlock()
}

// Pushed is how many samples source src has delivered in total (to tell "no microphone audio at all" from "a quiet room").
func (m *Mixer) Pushed(src int) int64 {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.pushed[src]
}

// Mix returns the next n mixed samples.
func (m *Mixer) Mix(n int) []int16 {
	out := make([]int16, n)
	if n <= 0 {
		return out
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	acc := make([]float64, n)
	for s, q := range m.queues {
		take := n
		if len(q) < take {
			take = len(q)
		}
		for i := 0; i < take; i++ {
			acc[i] += float64(q[i]) * m.gain[s]
		}
		q = q[take:]
		if len(q) > maxBacklog {
			q = q[len(q)-keepBacklog:]
		}
		// Do not keep growing the old backing array.
		if len(q) == 0 {
			q = nil
		}
		m.queues[s] = q
	}
	for i, v := range acc {
		switch {
		case v > 32767:
			out[i] = 32767
		case v < -32768:
			out[i] = -32768
		default:
			out[i] = int16(v)
		}
	}
	return out
}

// SegmentWriter writes 16 kHz mono 16-bit samples as WAV files of at most maxSeconds each (name_001.wav, name_002.wav, ...).
// Only the open segment is held open; a finished one is complete and valid on disk.
type SegmentWriter struct {
	dir        string
	prefix     string
	maxSamples int

	idx   int
	f     *os.File
	n     int
	files []string
	total int64
}

// NewSegmentWriter creates the directory if needed.
func NewSegmentWriter(dir, prefix string, maxSeconds int) (*SegmentWriter, error) {
	if maxSeconds <= 0 {
		maxSeconds = 240
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	return &SegmentWriter{dir: dir, prefix: prefix, maxSamples: maxSeconds * SampleRate}, nil
}

// Write appends samples, starting a new segment when the current one is full.
func (w *SegmentWriter) Write(samples []int16) error {
	for len(samples) > 0 {
		if w.f == nil {
			if err := w.open(); err != nil {
				return err
			}
		}
		room := w.maxSamples - w.n
		chunk := samples
		if len(chunk) > room {
			chunk = samples[:room]
		}
		buf := make([]byte, len(chunk)*2)
		for i, v := range chunk {
			binary.LittleEndian.PutUint16(buf[i*2:], uint16(v))
		}
		if _, err := w.f.Write(buf); err != nil {
			return err
		}
		w.n += len(chunk)
		w.total += int64(len(chunk))
		samples = samples[len(chunk):]
		if w.n >= w.maxSamples {
			if err := w.finish(); err != nil {
				return err
			}
		}
	}
	return nil
}

// Close finishes the open segment and returns every file written, in order.
func (w *SegmentWriter) Close() ([]string, error) {
	err := w.finish()
	return append([]string(nil), w.files...), err
}

// Files is what has been written so far (the open segment included).
func (w *SegmentWriter) Files() []string { return append([]string(nil), w.files...) }

// Seconds is the length written so far.
func (w *SegmentWriter) Seconds() float64 { return float64(w.total) / SampleRate }

func (w *SegmentWriter) open() error {
	w.idx++
	path := filepath.Join(w.dir, fmt.Sprintf("%s_%03d.wav", w.prefix, w.idx))
	f, err := os.OpenFile(path, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	if _, err := f.Write(wavHeader(0)); err != nil {
		f.Close()
		return err
	}
	w.f, w.n = f, 0
	w.files = append(w.files, path)
	return nil
}

func (w *SegmentWriter) finish() error {
	if w.f == nil {
		return nil
	}
	f := w.f
	w.f = nil
	dataBytes := uint32(w.n * 2)
	_, seekErr := f.Seek(0, 0)
	var werr error
	if seekErr == nil {
		_, werr = f.Write(wavHeader(dataBytes))
	}
	cerr := f.Close()
	for _, e := range []error{seekErr, werr, cerr} {
		if e != nil {
			return e
		}
	}
	w.n = 0
	return nil
}

// wavHeader is the 44-byte header of a PCM, mono, 16-bit, 16 kHz WAV whose data chunk holds dataBytes bytes.
func wavHeader(dataBytes uint32) []byte {
	h := make([]byte, 44)
	copy(h[0:], "RIFF")
	binary.LittleEndian.PutUint32(h[4:], 36+dataBytes)
	copy(h[8:], "WAVEfmt ")
	binary.LittleEndian.PutUint32(h[16:], 16)
	binary.LittleEndian.PutUint16(h[20:], 1) // PCM
	binary.LittleEndian.PutUint16(h[22:], 1) // mono
	binary.LittleEndian.PutUint32(h[24:], SampleRate)
	binary.LittleEndian.PutUint32(h[28:], SampleRate*2)
	binary.LittleEndian.PutUint16(h[32:], 2)
	binary.LittleEndian.PutUint16(h[34:], 16)
	copy(h[36:], "data")
	binary.LittleEndian.PutUint32(h[40:], dataBytes)
	return h
}
