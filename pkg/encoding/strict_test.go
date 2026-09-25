package encoding

import (
	"bytes"
	"errors"
	"strings"
	"testing"
)

func TestParseName(t *testing.T) {
	cases := []struct {
		in      string
		want    string
		wantErr bool
	}{
		{"", "", false},
		{"   ", "", false},
		{"utf-8", NameUTF8, false},
		{"UTF-8", NameUTF8, false},
		{"utf8", NameUTF8, false},
		{" Utf-8 ", NameUTF8, false},
		{"sjis", NameShiftJIS, false},
		{"SJIS", NameShiftJIS, false},
		{"shift_jis", NameShiftJIS, false},
		{"Shift_JIS", NameShiftJIS, false},
		{"shift-jis", NameShiftJIS, false},
		{"SHIFT-JIS", NameShiftJIS, false},
		{"cp932", NameShiftJIS, false},
		{"CP932", NameShiftJIS, false},
		{"latin1", "", true},
		{"utf-16", "", true},
		{"euc-jp", "", true},
		{"shiftjis", "", true},
	}
	for _, c := range cases {
		got, err := ParseName(c.in)
		if (err != nil) != c.wantErr {
			t.Errorf("ParseName(%q) error = %v, wantErr %v", c.in, err, c.wantErr)
			continue
		}
		if got != c.want {
			t.Errorf("ParseName(%q) = %q, want %q", c.in, got, c.want)
		}
		if err != nil && !strings.Contains(err.Error(), "use utf-8 or sjis") {
			t.Errorf("ParseName(%q) error %q should say what to use", c.in, err)
		}
	}
}

func TestEncodeStrictUTF8AndEmptyName(t *testing.T) {
	text := "# 見出し 🤖\nline\r\nend"
	for _, name := range []string{"", "utf-8", "UTF-8", "utf8"} {
		got, err := EncodeStrict(text, name)
		if err != nil {
			t.Fatalf("%q: %v", name, err)
		}
		if !bytes.Equal(got, []byte(text)) {
			t.Errorf("%q: UTF-8 bytes must be the text unchanged (no BOM, no line-ending change), got %x", name, got)
		}
	}
}

func TestEncodeStrictUnknownNameIsAnError(t *testing.T) {
	if _, err := EncodeStrict("x", "latin1"); err == nil {
		t.Fatal("an unknown encoding name must be an error, not a silent UTF-8")
	}
}

func TestEncodeStrictShiftJISRoundTripAndAliases(t *testing.T) {
	text := "Shift_JISの日本語テキスト\nメモ帳テスト\n12345 \\ ~"
	want, err := Encode(text, "Shift_JIS")
	if err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"sjis", "shift_jis", "shift-jis", "cp932", "SJIS", "Shift_JIS"} {
		got, err := EncodeStrict(text, name)
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		if !bytes.Equal(got, want) {
			t.Errorf("%s: EncodeStrict differs from Encode for representable text", name)
		}
	}
	back, err := DecodeWith(want, "Shift_JIS")
	if err != nil || back != text {
		t.Errorf("round trip = %q, %v", back, err)
	}
	if bytes.Contains(want, []byte{0xEF, 0xBB, 0xBF}) {
		t.Error("no BOM may be written")
	}
}

func TestEncodeStrictShiftJISUnrepresentable(t *testing.T) {
	// U+1F916 (robot) is at line 2, column 4; U+2728 at line 3, column 1. Neither has a Shift_JIS form.
	text := "日本語\nabc\U0001F916 z\n✨end"
	out, err := EncodeStrict(text, "sjis")
	if err == nil {
		t.Fatalf("expected an error, got bytes %x", out)
	}
	if out != nil {
		t.Errorf("no bytes may be returned with the error, got %x", out)
	}
	var ue *UnrepresentableError
	if !errors.As(err, &ue) {
		t.Fatalf("error type = %T, want *UnrepresentableError", err)
	}
	if ue.Total != 2 || len(ue.Chars) != 2 {
		t.Fatalf("Total=%d Chars=%d, want 2 and 2", ue.Total, len(ue.Chars))
	}
	first, second := ue.Chars[0], ue.Chars[1]
	if first.Rune != 0x1F916 || first.Line != 2 || first.Column != 4 || first.Offset != 7 {
		t.Errorf("first = %+v", first)
	}
	if second.Rune != 0x2728 || second.Line != 3 || second.Column != 1 {
		t.Errorf("second = %+v", second)
	}
	msg := err.Error()
	for _, want := range []string{"Shift_JIS", "U+1F916 at line 2, column 4", "U+2728 at line 3, column 1"} {
		if !strings.Contains(msg, want) {
			t.Errorf("message %q lacks %q", msg, want)
		}
	}
	if strings.Contains(msg, "\U0001F916") || strings.Contains(msg, "日本語") {
		t.Errorf("the message must not quote note content: %q", msg)
	}
}

func TestEncodeStrictShiftJISListsOnlyTheFirstFew(t *testing.T) {
	text := strings.Repeat("\U0001F600", 12)
	_, err := EncodeStrict(text, "sjis")
	var ue *UnrepresentableError
	if !errors.As(err, &ue) {
		t.Fatalf("error = %v", err)
	}
	if ue.Total != 12 || len(ue.Chars) != MaxReported {
		t.Errorf("Total=%d listed=%d, want 12 and %d", ue.Total, len(ue.Chars), MaxReported)
	}
	if !strings.Contains(err.Error(), "first 5 of 12") {
		t.Errorf("message should say how many were left out: %q", err)
	}
}

// The table behind "Shift_JIS" is Windows-31J (CP932), which is why "cp932" is a spelling of it: the
// NEC/IBM extensions are there, and characters that only JIS X 0208 has are not.
func TestEncodeStrictUsesTheWindows31JTable(t *testing.T) {
	for _, s := range []string{"①", "㈱", "～", "－", "∥", "ｱ"} { // circled 1, (kabu), fullwidth tilde, fullwidth minus, parallel, half-width katakana
		if _, err := EncodeStrict(s, "cp932"); err != nil {
			t.Errorf("%U should be representable: %v", []rune(s)[0], err)
		}
	}
	for _, s := range []string{"〜", "−", "¥", "é"} { // wave dash, minus sign, yen sign, e acute
		_, err := EncodeStrict(s, "cp932")
		var ue *UnrepresentableError
		if !errors.As(err, &ue) {
			t.Errorf("%U should be refused, got %v", []rune(s)[0], err)
		}
	}
}

func TestEncodeStrictDoesNotReplaceWithQuestionMarks(t *testing.T) {
	// The permissive Encode writes '?'; the strict one must refuse instead.
	text := "a\U0001F916b"
	loose, err := Encode(text, "Shift_JIS")
	if err != nil || string(loose) != "a?b" {
		t.Fatalf("Encode behaviour changed: %q, %v", loose, err)
	}
	if _, err := EncodeStrict(text, "Shift_JIS"); err == nil {
		t.Fatal("EncodeStrict must not write '?' for an unrepresentable character")
	}
}
