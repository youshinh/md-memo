package encoding

import (
	"strings"
	"testing"
)

func TestDecodePipedAs(t *testing.T) {
	// "ping 128.1.15.33 に ping を送信しています" and "ミリ秒" as a Japanese Windows console writes them (Shift_JIS)
	sjisPing := []byte{0x70, 0x69, 0x6E, 0x67, 0x20, 0x82, 0xC9, 0x20, 0x83, 0x7E, 0x83, 0x8A, 0x95, 0x62}
	utf16le := []byte{0xFF, 0xFE, 0x61, 0x00, 0xE9, 0x00, 0x0D, 0x00, 0x0A, 0x00}

	cases := []struct {
		name string
		data []byte
		cp   int
		want string
	}{
		{"empty", nil, 932, ""},
		{"plain ASCII", []byte("hello\r\nworld"), 932, "hello\r\nworld"},
		{"UTF-8 stays", []byte("日本語 ok"), 932, "日本語 ok"},
		{"UTF-8 with BOM", append([]byte{0xEF, 0xBB, 0xBF}, "日本語"...), 437, "日本語"},
		{"Shift_JIS from a Japanese console", sjisPing, 932, "ping に ミリ秒"},
		{"Shift_JIS when the page is unknown", sjisPing, 0, "ping に ミリ秒"},
		{"UTF-16LE with BOM (a file shown by type)", utf16le, 932, "aé\r\n"},
		{"CP437 e-acute", []byte{0x63, 0x61, 0x66, 0x82}, 437, "café"},
		{"CP850 e-acute", []byte{0x63, 0x61, 0x66, 0x82}, 850, "café"},
		{"Windows-1252 e-acute", []byte{0x63, 0x61, 0x66, 0xE9}, 1252, "café"},
		{"65001 console, Shift_JIS from a file shown by type", sjisPing, 65001, "ping に ミリ秒"},
		{"65001 with bytes that are nothing is left as received", []byte{0x61, 0xFF, 0x62}, 65001, "a\xffb"},
	}
	for _, c := range cases {
		if got := DecodePipedAs(c.data, c.cp); got != c.want {
			t.Errorf("%s: got %q, want %q", c.name, got, c.want)
		}
	}
}

func TestDecodePipedLeavesWhatItCannotReadAlone(t *testing.T) {
	// not valid in Shift_JIS either (a lone lead byte at the end): never invent text, keep the bytes
	data := []byte{0x61, 0x62, 0x81}
	if got := DecodePipedAs(data, 932); got != string(data) {
		t.Errorf("got %q, want the bytes as they came", got)
	}
}

func TestDecodePipedUsesTheSystemPageButStillTakesUTF8(t *testing.T) {
	// whatever page this machine reports, UTF-8 text is never reinterpreted
	in := "日本語のテキスト\n" + strings.Repeat("あ", 100)
	if got := DecodePiped([]byte(in)); got != in {
		t.Errorf("UTF-8 changed by DecodePiped")
	}
}
