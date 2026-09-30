package sysaudio

import (
	"errors"
	"fmt"
	"sync"
	"time"
)

// Source delivers 16 kHz mono samples through push until Stop. Start must return quickly (the capture runs in its own
// goroutine) and report a setup failure (no such device) as an error.
type Source interface {
	Name() string
	// ExpectAudio is true when a healthy source always delivers samples (a microphone does, even in a silent room) and false for
	// one that delivers nothing while nothing plays (a loopback capture), so "nothing arrived" is only a warning for the former.
	ExpectAudio() bool
	Start(push func([]int16)) error
	Stop()
}

// Options says what to record and where to put it.
type Options struct {
	Dir            string
	Prefix         string
	SegmentSeconds int // the longest single file (default 240 s: four minutes are about 7.7 MB, small enough to send whole)
}

// Result is what a finished recording left behind.
type Result struct {
	Files    []string // WAV segments in order
	Seconds  float64
	Warnings []string // plain sentences for the person (a source that delivered nothing, a device that went away)
}

// Recorder pulls the sources together on a wall-clock beat and writes the mix to disk.
type Recorder struct {
	opts    Options
	sources []Source
	gains   []float64
	now     func() time.Time
	tick    time.Duration
	hold    time.Duration

	mixer *Mixer
	w     *SegmentWriter

	mu       sync.Mutex
	started  time.Time
	written  int64 // samples written
	stop     chan struct{}
	done     chan struct{}
	finished bool
	warnings []string
	failed   error
	live     []string // names of the sources that started
}

// ErrNothingToRecord is returned when no source could be started.
var ErrNothingToRecord = errors.New("no audio source could be started")

// NewRecorder prepares a recording of the given sources (index = mixer input). gains are optional per-source gains.
func NewRecorder(opts Options, sources []Source, gains ...float64) (*Recorder, error) {
	if len(sources) == 0 {
		return nil, ErrNothingToRecord
	}
	w, err := NewSegmentWriter(opts.Dir, opts.Prefix, opts.SegmentSeconds)
	if err != nil {
		return nil, err
	}
	return &Recorder{
		opts: opts, sources: sources, gains: gains, now: time.Now,
		tick: 100 * time.Millisecond, hold: 400 * time.Millisecond,
		mixer: NewMixer(len(sources), gains...), w: w,
		stop: make(chan struct{}), done: make(chan struct{}),
	}, nil
}

// Start starts every source. A source that fails to start is dropped with a warning; if none starts, the recording does not
// begin and the error says why.
func (r *Recorder) Start() error {
	var started []int
	var errs []error
	for i, s := range r.sources {
		i := i
		if err := s.Start(func(samples []int16) { r.mixer.Push(i, samples) }); err != nil {
			errs = append(errs, fmt.Errorf("%s: %w", s.Name(), err))
			r.warn(fmt.Sprintf("%s: %v", s.Name(), err))
			continue
		}
		started = append(started, i)
		r.live = append(r.live, s.Name())
	}
	if len(started) == 0 {
		return errors.Join(errs...)
	}
	r.mu.Lock()
	r.started = r.now()
	r.mu.Unlock()
	go r.loop()
	return nil
}

// Started is the names of the sources that are recording (a source that failed to start is left out).
func (r *Recorder) Started() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]string(nil), r.live...)
}

// Warnings so far (a copy).
func (r *Recorder) Warnings() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]string(nil), r.warnings...)
}

func (r *Recorder) warn(msg string) {
	r.mu.Lock()
	r.warnings = append(r.warnings, msg)
	r.mu.Unlock()
}

// Seconds recorded so far.
func (r *Recorder) Seconds() float64 {
	r.mu.Lock()
	defer r.mu.Unlock()
	return float64(r.written) / SampleRate
}

func (r *Recorder) loop() {
	defer close(r.done)
	t := time.NewTicker(r.tick)
	defer t.Stop()
	for {
		select {
		case <-r.stop:
			return
		case <-t.C:
			r.writeUpTo(r.now().Sub(r.started) - r.hold)
		}
	}
}

// writeUpTo mixes and writes until `elapsed` of audio exists.
func (r *Recorder) writeUpTo(elapsed time.Duration) {
	if elapsed <= 0 {
		return
	}
	want := int64(elapsed.Seconds() * SampleRate)
	r.mu.Lock()
	n := int(want - r.written)
	r.mu.Unlock()
	if n <= 0 {
		return
	}
	if err := r.w.Write(r.mixer.Mix(n)); err != nil {
		r.mu.Lock()
		if r.failed == nil {
			r.failed = err
		}
		r.mu.Unlock()
		return
	}
	r.mu.Lock()
	r.written += int64(n)
	r.mu.Unlock()
}

// Stop ends the recording, flushes what is pending and returns the files. It is safe to call twice.
func (r *Recorder) Stop() (Result, error) {
	r.mu.Lock()
	if r.finished {
		r.mu.Unlock()
		return r.result(), r.failed
	}
	r.finished = true
	started := !r.started.IsZero()
	r.mu.Unlock()

	for _, s := range r.sources {
		s.Stop()
	}
	if started {
		close(r.stop)
		<-r.done
		r.writeUpTo(r.now().Sub(r.started)) // everything up to now, no hold-back
	}
	for i, s := range r.sources {
		if started && s.ExpectAudio() && r.mixer.Pushed(i) == 0 {
			r.warn(fmt.Sprintf("%s: no audio arrived", s.Name()))
		}
	}
	_, err := r.w.Close()
	r.mu.Lock()
	if r.failed == nil {
		r.failed = err
	}
	failed := r.failed
	r.mu.Unlock()
	return r.result(), failed
}

func (r *Recorder) result() Result {
	r.mu.Lock()
	defer r.mu.Unlock()
	return Result{Files: r.w.Files(), Seconds: float64(r.written) / SampleRate, Warnings: append([]string(nil), r.warnings...)}
}
