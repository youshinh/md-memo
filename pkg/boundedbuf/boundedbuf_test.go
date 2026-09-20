package boundedbuf

import (
	"bytes"
	"io"
	"strings"
	"sync"
	"testing"
	"unicode/utf8"
)

func TestWriter_UnderCapKeepsEverything(t *testing.T) {
	w := New(100)
	payload := "hello world\n"
	n, err := w.WriteString(payload)
	if err != nil || n != len(payload) {
		t.Fatalf("Write = (%d, %v), want (%d, nil)", n, err, len(payload))
	}
	if w.Truncated() {
		t.Error("Truncated() = true under the cap")
	}
	if got := w.String(); got != payload {
		t.Errorf("String() = %q, want %q", got, payload)
	}
}

func TestWriter_CapRespectedAndMarkerAppendedOnce(t *testing.T) {
	const capBytes = 32
	w := New(capBytes)

	// Feed far more than the cap, in several chunks, after the cap is already exceeded.
	total := 0
	for i := 0; i < 50; i++ {
		chunk := strings.Repeat("x", 100)
		n, err := w.Write([]byte(chunk))
		if err != nil {
			t.Fatalf("Write returned error after cap: %v", err)
		}
		if n != len(chunk) {
			t.Fatalf("Write returned short count %d for %d bytes", n, len(chunk))
		}
		total += len(chunk)
	}

	if !w.Truncated() {
		t.Fatal("Truncated() = false after exceeding the cap")
	}

	got := w.String()
	if c := strings.Count(got, TruncationMarker); c != 1 {
		t.Errorf("truncation marker appears %d times, want exactly 1:\n%q", c, got)
	}
	if !strings.HasSuffix(got, TruncationMarker) {
		t.Errorf("output does not end with the marker: %q", got)
	}
	payload := strings.TrimSuffix(got, TruncationMarker)
	if len(payload) > capBytes {
		t.Errorf("retained %d payload bytes, cap is %d", len(payload), capBytes)
	}
	if len(got) >= total {
		t.Errorf("retained %d bytes for %d bytes of input: nothing was bounded", len(got), total)
	}
}

func TestWriter_NeverSplitsRune(t *testing.T) {
	// Each 'あ' is 3 bytes; a cap of 10 falls in the middle of the 4th rune.
	w := New(10)
	input := strings.Repeat("あ", 20)
	if _, err := w.Write([]byte(input)); err != nil {
		t.Fatalf("Write error: %v", err)
	}

	payload := strings.TrimSuffix(w.String(), TruncationMarker)
	if !utf8.ValidString(payload) {
		t.Fatalf("retained payload is not valid UTF-8: %q", payload)
	}
	if payload != strings.Repeat("あ", 3) {
		t.Errorf("payload = %q, want 3 full runes", payload)
	}
}

func TestWriter_ExactCapDoesNotTruncate(t *testing.T) {
	w := New(5)
	if _, err := w.WriteString("abcde"); err != nil {
		t.Fatalf("Write error: %v", err)
	}
	if w.Truncated() {
		t.Errorf("Truncated() = true for input exactly at the cap: %q", w.String())
	}
	if got := w.String(); got != "abcde" {
		t.Errorf("String() = %q, want %q", got, "abcde")
	}
}

func TestWriter_ZeroCapStillDrains(t *testing.T) {
	w := New(0)
	src := bytes.NewReader(bytes.Repeat([]byte("y"), 1<<16))
	n, err := io.Copy(w, src)
	if err != nil {
		t.Fatalf("io.Copy error: %v", err)
	}
	if n != 1<<16 {
		t.Errorf("io.Copy copied %d bytes, want %d (producer must never stall)", n, 1<<16)
	}
	if got := w.String(); got != TruncationMarker {
		t.Errorf("String() = %q, want just the marker", got)
	}
}

func TestWriter_ConcurrentWritersAreSafe(t *testing.T) {
	w := New(1024)
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for j := 0; j < 200; j++ {
				_, _ = w.WriteString("abcdefghij")
			}
		}()
	}
	wg.Wait()

	payload := strings.TrimSuffix(w.String(), TruncationMarker)
	if len(payload) > 1024 {
		t.Errorf("retained %d bytes, cap is 1024", len(payload))
	}
}

func TestWriter_BytesIsACopy(t *testing.T) {
	w := New(64)
	_, _ = w.WriteString("abc")
	b := w.Bytes()
	b[0] = 'z'
	if w.String() != "abc" {
		t.Errorf("Bytes() aliased internal storage: %q", w.String())
	}
}
