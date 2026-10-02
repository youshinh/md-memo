package encoding

import (
	"strings"
	"unicode/utf8"

	"golang.org/x/text/encoding"
	"golang.org/x/text/encoding/charmap"
	"golang.org/x/text/encoding/japanese"
	"golang.org/x/text/encoding/unicode"
)

// DecodePiped turns the bytes of a text piped into MD-Memo (`ping host | md-memo`, `type notes.txt | md-memo-cli buffer set`)
// into a string. Console programs do not write UTF-8: on a Japanese Windows `ping`, `ipconfig`, `dir` and the like write
// Shift_JIS (code page 932), which landed in the note as "◆◆ ping ◆" garbage when the bytes were taken as UTF-8.
//
// Valid UTF-8 (with or without a BOM) is taken as it is, UTF-16 with a BOM (a file shown with `type`) is decoded, and
// anything else is read in the code page of the console the text came from (Windows; elsewhere Shift_JIS is tried). Text
// that does not decode cleanly is left exactly as it was received, never made up.
func DecodePiped(data []byte) string {
	return DecodePipedAs(data, pipedCodePage())
}

// DecodePipedAs is DecodePiped with the code page named (0 = unknown). It exists so that the rules can be tested on any system.
func DecodePipedAs(data []byte, codePage int) string {
	if len(data) == 0 {
		return ""
	}
	// A UTF-8 BOM is dropped, and what follows is judged on its own: Windows PowerShell 5.1 puts one in front of whatever it pipes to a
	// program (once or twice) even when the bytes after it are Shift_JIS, so a BOM does not mean that the rest is UTF-8.
	for len(data) >= 3 && data[0] == 0xEF && data[1] == 0xBB && data[2] == 0xBF {
		data = data[3:]
	}
	if len(data) == 0 {
		return ""
	}
	if len(data) >= 2 && ((data[0] == 0xFF && data[1] == 0xFE) || (data[0] == 0xFE && data[1] == 0xFF)) {
		if out, err := unicode.UTF16(unicode.LittleEndian, unicode.UseBOM).NewDecoder().Bytes(data); err == nil {
			return string(out)
		}
	}
	if utf8.Valid(data) {
		return string(data)
	}

	var enc encoding.Encoding
	switch codePage {
	case 437:
		enc = charmap.CodePage437
	case 850:
		enc = charmap.CodePage850
	case 1252:
		enc = charmap.Windows1252
	default:
		// 932, and the guess for any other page, 65001 included: a console set to UTF-8 still shows a program or a file (`type`)
		// that writes Shift_JIS, and this app's text is mostly Japanese. Taken only when it decodes cleanly (below).
		enc = japanese.ShiftJIS
	}
	if out, err := enc.NewDecoder().Bytes(data); err == nil && !strings.ContainsRune(string(out), utf8.RuneError) {
		return string(out)
	}
	return string(data)
}
