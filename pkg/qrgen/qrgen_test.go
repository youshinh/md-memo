package qrgen

import (
	"bytes"
	"strings"
	"testing"
)

var pngSignature = []byte("\x89PNG\r\n\x1a\n")

func TestPNGRendersAPairingURL(t *testing.T) {
	// The longest URL Mobile Drop produces: a tunnel host plus the 32-hex token.
	url := "https://some-long-tunnel-name-with-words.trycloudflare.com/?token=0123456789abcdef0123456789abcdef"
	png, err := PNG(url)
	if err != nil {
		t.Fatalf("PNG() error: %v", err)
	}
	if !bytes.HasPrefix(png, pngSignature) {
		t.Fatalf("output is not a PNG: % x", png[:8])
	}
}

func TestDataURIWrapsThePNG(t *testing.T) {
	uri, err := DataURI("http://192.168.1.5:8765/?token=abc")
	if err != nil {
		t.Fatalf("DataURI() error: %v", err)
	}
	if !strings.HasPrefix(uri, "data:image/png;base64,") {
		t.Errorf("unexpected prefix: %.30s", uri)
	}
}

func TestPNGRejectsEmptyContent(t *testing.T) {
	if _, err := PNG(""); err == nil {
		t.Error("an empty string cannot be encoded as a QR code")
	}
}
