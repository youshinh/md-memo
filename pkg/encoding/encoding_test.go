package encoding

import (
	"strings"
	"testing"
	"unicode/utf8"
)

func TestEncodingRoundTrip(t *testing.T) {
	testCases := []struct {
		name     string
		input    string
		encoding string
	}{
		{
			name:     "UTF-8 ASCII and Japanese",
			input:    "# こんにちは世界 (Hello World)\n\nこれはテストです。",
			encoding: "UTF-8",
		},
		{
			name:     "Shift_JIS Japanese",
			input:    "Shift_JISの日本語テキスト\nメモ帳テスト\n12345",
			encoding: "Shift_JIS",
		},
	}

	for _, tc := range testCases {
		t.Run(tc.name, func(t *testing.T) {
			encoded, err := Encode(tc.input, tc.encoding)
			if err != nil {
				t.Fatalf("Encode failed: %v", err)
			}

			decoded, detectedEnc, err := DetectAndDecode(encoded)
			if err != nil {
				t.Fatalf("DetectAndDecode failed: %v", err)
			}

			if detectedEnc != tc.encoding {
				t.Errorf("expected encoding %s, got %s", tc.encoding, detectedEnc)
			}

			if decoded != tc.input {
				t.Errorf("expected content %q, got %q", tc.input, decoded)
			}
		})
	}
}

func TestShiftJISEmojiFallback(t *testing.T) {
	inputWithEmoji := "日本語と絵文字 🤖 ✨ のShift_JIS保存テスト"
	encoded, err := Encode(inputWithEmoji, "Shift_JIS")
	if err != nil {
		t.Fatalf("Encode with emoji failed: %v", err)
	}

	decoded, err := DecodeWith(encoded, "Shift_JIS")
	if err != nil {
		t.Fatalf("Decode failed: %v", err)
	}

	if !strings.Contains(decoded, "日本語と絵文字") {
		t.Errorf("expected Japanese text preserved, got %q", decoded)
	}
}

func TestTrimPartialRune(t *testing.T) {
	// A UTF-8 note cut at a byte limit inside a character: without trimming it is read as Shift_JIS (mojibake).
	text := "# 1. 損益報告書\n" + strings.Repeat("売上と費用の内訳を確認する。", 200)
	for cut := 1; cut < len(text) && cut < 60; cut++ {
		head := []byte(text)[:cut]
		got, enc, err := DetectAndDecode(TrimPartialRune(head))
		if err != nil || enc != "UTF-8" || !strings.HasPrefix(text, got) {
			t.Fatalf("cut at %d bytes: got %q (%s, %v), want a UTF-8 prefix of the text", cut, got, enc, err)
		}
	}
	// The same cut without the trim is what produced the garbled titles: it is not valid UTF-8, so it was read as Shift_JIS.
	bad := []byte(text)[:len("# 1. 損益報告書\n")+1]
	if utf8.Valid(bad) {
		t.Fatalf("test setup: the cut was expected to split a character")
	}
	if got, enc, _ := DetectAndDecode(bad); enc != "Shift_JIS" || strings.HasPrefix(text, got) {
		t.Fatalf("test setup: without the trim the cut should be misread as Shift_JIS, got %q (%s)", got, enc)
	}

	// Shift_JIS is left alone, and decodes as Shift_JIS.
	sjis, err := Encode("# 損益報告書\n売上と費用の内訳を確認する。", "Shift_JIS")
	if err != nil {
		t.Fatal(err)
	}
	if got := TrimPartialRune(sjis); len(got) != len(sjis) {
		t.Errorf("Shift_JIS data was trimmed from %d to %d bytes", len(sjis), len(got))
	}
	if got, enc, _ := DetectAndDecode(TrimPartialRune(sjis)); enc != "Shift_JIS" || !strings.HasPrefix(got, "# 損益報告書") {
		t.Errorf("Shift_JIS decoded as %q (%s)", got, enc)
	}

	// Plain ASCII, empty and already-valid input are returned as they are.
	for _, in := range [][]byte{nil, []byte(""), []byte("abc"), []byte("日本語")} {
		if got := TrimPartialRune(in); string(got) != string(in) {
			t.Errorf("%q changed to %q", in, got)
		}
	}
}
