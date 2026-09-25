package encoding

import (
	"bytes"
	"fmt"
	"io"
	"strings"
	"unicode/utf8"

	"golang.org/x/text/encoding/japanese"
	"golang.org/x/text/transform"
)

// DetectAndDecode detects if the data is UTF-8 or Shift_JIS and decodes it to string.
func DetectAndDecode(data []byte) (string, string, error) {
	if len(data) == 0 {
		return "", "UTF-8", nil
	}

	// Check BOM
	if len(data) >= 3 && data[0] == 0xEF && data[1] == 0xBB && data[2] == 0xBF {
		return string(data[3:]), "UTF-8", nil
	}

	// If valid UTF-8, prefer UTF-8
	if utf8.Valid(data) {
		return string(data), "UTF-8", nil
	}

	// Try Shift_JIS (CP932)
	decoded, err := DecodeWith(data, "Shift_JIS")
	if err == nil {
		return decoded, "Shift_JIS", nil
	}

	// Fallback to raw string
	return string(data), "UTF-8", nil
}

// DecodeWith decodes byte slice to string using the specified encoding ("UTF-8" or "Shift_JIS").
func DecodeWith(data []byte, enc string) (string, error) {
	if strings.EqualFold(enc, "Shift_JIS") || strings.EqualFold(enc, "SJIS") || strings.EqualFold(enc, "CP932") {
		reader := transform.NewReader(bytes.NewReader(data), japanese.ShiftJIS.NewDecoder())
		buf, err := io.ReadAll(reader)
		if err != nil {
			return "", err
		}
		return string(buf), nil
	}

	return string(data), nil
}

// Encode encodes a UTF-8 string to a byte slice with specified encoding ("UTF-8" or "Shift_JIS").
// For Shift_JIS, unconvertible characters (e.g. emojis) are safely replaced with '?' instead of failing.
func Encode(str string, enc string) ([]byte, error) {
	if strings.EqualFold(enc, "Shift_JIS") || strings.EqualFold(enc, "SJIS") || strings.EqualFold(enc, "CP932") {
		writer := &bytes.Buffer{}
		tWriter := transform.NewWriter(writer, japanese.ShiftJIS.NewEncoder())
		_, err := tWriter.Write([]byte(str))
		if err == nil {
			if closeErr := tWriter.Close(); closeErr == nil {
				return writer.Bytes(), nil
			}
		}

		// Fallback: encode rune by rune, replacing unmappable characters with '?'
		fallbackBuf := &bytes.Buffer{}
		encoder := japanese.ShiftJIS.NewEncoder()
		for _, r := range str {
			rBytes := []byte(string(r))
			encodedRune, _, err := transform.Bytes(encoder, rBytes)
			if err != nil || len(encodedRune) == 0 {
				fallbackBuf.WriteByte('?')
			} else {
				fallbackBuf.Write(encodedRune)
			}
		}
		return fallbackBuf.Bytes(), nil
	}

	return []byte(str), nil
}

// Canonical encoding names, the spelling the tabs of the editor and FileResult.Encoding use.
const (
	NameUTF8     = "UTF-8"
	NameShiftJIS = "Shift_JIS"
)

// ParseName maps the spelling a caller typed to a canonical name: NameUTF8 for "utf-8" or "utf8",
// NameShiftJIS for "sjis", "shift_jis", "shift-jis" or "cp932" (case does not matter, surrounding
// white space is ignored). An empty name returns ("", nil): the caller did not name one. Anything
// else is an error, unlike Encode, which quietly turns an unknown name into UTF-8.
func ParseName(name string) (string, error) {
	switch strings.ToLower(strings.TrimSpace(name)) {
	case "":
		return "", nil
	case "utf-8", "utf8":
		return NameUTF8, nil
	case "sjis", "shift_jis", "shift-jis", "cp932":
		return NameShiftJIS, nil
	}
	return "", fmt.Errorf("unknown encoding %q (use utf-8 or sjis)", name)
}

// Unrepresentable is one character an encoding cannot hold.
type Unrepresentable struct {
	Rune   rune
	Offset int // 0-based index counted in characters (runes)
	Line   int // 1-based
	Column int // 1-based, in characters
}

// UnrepresentableError is what EncodeStrict returns when the text has characters the encoding has
// no form for. It names the first few (with where they are) and how many there are in all; it
// never carries the characters themselves, only their code points, so it is safe to show.
type UnrepresentableError struct {
	Encoding string
	Chars    []Unrepresentable // the first MaxReported ones
	Total    int
}

// MaxReported is how many unrepresentable characters an UnrepresentableError lists.
const MaxReported = 5

func (e *UnrepresentableError) Error() string {
	parts := make([]string, 0, len(e.Chars))
	for _, c := range e.Chars {
		parts = append(parts, fmt.Sprintf("U+%04X at line %d, column %d", c.Rune, c.Line, c.Column))
	}
	more := ""
	if e.Total > len(e.Chars) {
		more = fmt.Sprintf(" (first %d of %d)", len(e.Chars), e.Total)
	}
	return fmt.Sprintf("unrepresentable character in %s: %s%s", e.Encoding, strings.Join(parts, "; "), more)
}

// EncodeStrict encodes str with the named encoding (see ParseName) and never changes a character:
// an unknown name is an error, and text that the encoding cannot hold is an *UnrepresentableError
// listing the first characters (code point, line, column) instead of being written with '?'. The
// GUI's own save keeps using Encode. An empty name means UTF-8. No byte order mark is written.
func EncodeStrict(str, enc string) ([]byte, error) {
	canonical, err := ParseName(enc)
	if err != nil {
		return nil, err
	}
	if canonical != NameShiftJIS {
		return []byte(str), nil
	}
	encoder := japanese.ShiftJIS.NewEncoder()
	if out, _, err := transform.Bytes(encoder, []byte(str)); err == nil {
		return out, nil
	}

	// Something cannot be encoded: find every such character, in order.
	res := &UnrepresentableError{Encoding: NameShiftJIS}
	line, col, offset := 1, 1, 0
	for _, r := range str {
		if r >= utf8.RuneSelf {
			if _, _, err := transform.Bytes(encoder, []byte(string(r))); err != nil {
				res.Total++
				if len(res.Chars) < MaxReported {
					res.Chars = append(res.Chars, Unrepresentable{Rune: r, Offset: offset, Line: line, Column: col})
				}
			}
		}
		offset++
		if r == '\n' {
			line++
			col = 1
		} else {
			col++
		}
	}
	if res.Total == 0 {
		// The whole-text pass failed but no single character does: report it rather than write
		// something unverified.
		return nil, fmt.Errorf("cannot encode the text as %s", NameShiftJIS)
	}
	return nil, res
}
