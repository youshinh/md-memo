package encoding

import (
	"strings"
	"testing"
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
