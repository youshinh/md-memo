// Package boundedbuf provides a memory-capped output accumulator for child process pipes.
//
// The problem it solves: a chatty agent CLI, or a filter command that prints a huge file,
// can otherwise grow an in-process strings.Builder / bytes.Buffer without any limit until
// the whole process is out of memory. The naive fix - stop reading the pipe - is worse,
// because the child then blocks forever on a full pipe and the run never finishes.
//
// Writer therefore always accepts (and discards) everything it is handed, so the producer
// keeps draining, but it only retains the first Cap bytes and then appends a single
// truncation marker. Write never returns a short count or an error, which also means it is
// safe to hand to io.Copy or to exec.Cmd.Stdout.
package boundedbuf

import (
	"sync"
	"unicode/utf8"
)

// TruncationMarker is appended exactly once when output exceeds the cap.
const TruncationMarker = "\n…(output truncated)"

// Writer accumulates at most cap bytes of output. It is safe for concurrent use, so the
// same Writer may back both stdout and stderr of a process.
type Writer struct {
	mu        sync.Mutex
	cap       int
	buf       []byte
	truncated bool
}

// New returns a Writer that retains at most capBytes bytes of payload (the truncation
// marker is appended on top of that). A non-positive capBytes disables retention entirely:
// everything is still drained, nothing is kept.
func New(capBytes int) *Writer {
	if capBytes < 0 {
		capBytes = 0
	}
	return &Writer{cap: capBytes}
}

// Write implements io.Writer. It always reports len(p) bytes written and a nil error, even
// once the cap is reached, so the producing goroutine (and the child process behind it) is
// never blocked or broken by the limit.
func (w *Writer) Write(p []byte) (int, error) {
	n := len(p)
	if n == 0 {
		return 0, nil
	}

	w.mu.Lock()
	defer w.mu.Unlock()

	if w.truncated {
		return n, nil
	}

	remaining := w.cap - len(w.buf)
	if remaining <= 0 {
		w.markTruncatedLocked()
		return n, nil
	}
	if n <= remaining {
		w.buf = append(w.buf, p...)
		return n, nil
	}

	w.buf = append(w.buf, trimPartialRune(p[:remaining])...)
	w.markTruncatedLocked()
	return n, nil
}

// WriteString is a convenience wrapper with the same contract as Write.
func (w *Writer) WriteString(s string) (int, error) {
	return w.Write([]byte(s))
}

func (w *Writer) markTruncatedLocked() {
	if w.truncated {
		return
	}
	w.truncated = true
	w.buf = append(w.buf, TruncationMarker...)
}

// String returns the retained output, including the truncation marker if the cap was hit.
func (w *Writer) String() string {
	w.mu.Lock()
	defer w.mu.Unlock()
	return string(w.buf)
}

// Bytes returns a copy of the retained output.
func (w *Writer) Bytes() []byte {
	w.mu.Lock()
	defer w.mu.Unlock()
	return append([]byte(nil), w.buf...)
}

// Truncated reports whether output was dropped because the cap was reached.
func (w *Writer) Truncated() bool {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.truncated
}

// Len returns the number of retained bytes (marker included).
func (w *Writer) Len() int {
	w.mu.Lock()
	defer w.mu.Unlock()
	return len(w.buf)
}

// trimPartialRune drops a trailing byte sequence that is only the prefix of a multi-byte
// UTF-8 rune, so the cut point never splits a character in half (which would otherwise turn
// the last Japanese character before the marker into mojibake).
func trimPartialRune(b []byte) []byte {
	if len(b) == 0 {
		return b
	}
	if r, size := utf8.DecodeLastRune(b); r != utf8.RuneError || size > 1 {
		return b
	}
	// The final byte did not decode: walk back to the start of that sequence and drop it.
	for i := len(b) - 1; i >= 0 && i > len(b)-utf8.UTFMax; i-- {
		if utf8.RuneStart(b[i]) {
			return b[:i]
		}
	}
	return b
}
