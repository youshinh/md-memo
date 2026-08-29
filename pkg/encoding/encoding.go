package encoding

import (
	"bytes"
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
