package textsig

import (
	"strings"
	"testing"
)

// The same vectors are in frontend/js/disk_sync_test.js: the page and the Go side must give one fingerprint for one text, or every
// save would be refused as "the file changed".
var vectors = []struct {
	text string
	want string
}{
	{"", "0-bdcb81aee8d83"},
	{"a", "1-1c2ba782c97901"},
	{"hello\nworld", "b-6bfbd9b9e5295"},
	{"hello\r\nworld", "b-6bfbd9b9e5295"},
	{"hello\rworld", "b-6bfbd9b9e5295"},
	{"日本語のメモ\n二行目", "a-16fd479b32b673"},
	{"emoji 😀 x", "a-a2882ef1032fe"},
	{"mix \U0001F600\r\n日本", "9-3b4fa21a35574"},
	{"# 2026-10-02\n\n- a\n- b\n", "16-11b4cc9cb86841"},
	{strings.Repeat("x", 5000), "1388-c7e5049271672"},
}

func TestSumMatchesThePage(t *testing.T) {
	for _, v := range vectors {
		if got := Sum(v.text); got != v.want {
			t.Errorf("Sum(%q) = %s, want %s", abbreviate(v.text), got, v.want)
		}
	}
}

func TestSumNoticesChange(t *testing.T) {
	a := Sum("one line\nsecond")
	if a == Sum("one line\nsecond.") || a == Sum("one line\nSecond") || a == Sum("one line\n second") {
		t.Fatal("a one-character change kept the fingerprint")
	}
	if Sum("a\nb") != Sum("a\r\nb") {
		t.Error("line endings must not count")
	}
}

func TestToCRLF(t *testing.T) {
	cases := map[string]string{
		"":               "",
		"no break":       "no break",
		"a\nb\n":         "a\r\nb\r\n",
		"a\r\nb\r\n":     "a\r\nb\r\n", // already CRLF: not doubled
		"a\rb\nc\r\nd":   "a\r\nb\r\nc\r\nd",
		"trailing\r\n\n": "trailing\r\n\r\n",
	}
	for in, want := range cases {
		if got := ToCRLF(in); got != want {
			t.Errorf("ToCRLF(%q) = %q, want %q", in, got, want)
		}
	}
}

func abbreviate(s string) string {
	if len(s) > 30 {
		return s[:30] + "..."
	}
	return s
}
