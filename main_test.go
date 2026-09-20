package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestIsAllowedImageHost(t *testing.T) {
	tests := []struct {
		name   string
		host   string
		port   int
		expect bool
	}{
		{"exact loopback match", "127.0.0.1:41739", 41739, true},
		{"exact localhost match", "localhost:41739", 41739, true},
		{"wrong port", "127.0.0.1:9999", 41739, false},
		{"attacker rebind host", "evil.example.com:41739", 41739, false},
		{"attacker rebind host resolving to loopback", "rebind.attacker.test:41739", 41739, false},
		{"missing port", "127.0.0.1", 41739, false},
		{"empty host", "", 41739, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := isAllowedImageHost(tt.host, tt.port)
			if got != tt.expect {
				t.Errorf("isAllowedImageHost(%q, %d) = %v, want %v", tt.host, tt.port, got, tt.expect)
			}
		})
	}
}

func TestResolveImageFileRequest(t *testing.T) {
	dir := t.TempDir()

	// 1. Allowed image: a real PNG (minimal valid PNG signature + IHDR-ish bytes is enough for
	// http.DetectContentType to sniff "image/png").
	pngPath := filepath.Join(dir, "diagram.png")
	pngBytes := []byte{0x89, 'P', 'N', 'G', 0x0D, 0x0A, 0x1A, 0x0A}
	pngBytes = append(pngBytes, make([]byte, 24)...) // pad past sniff window requirements
	if err := os.WriteFile(pngPath, pngBytes, 0644); err != nil {
		t.Fatalf("failed to write test png: %v", err)
	}

	// 2. Text file renamed to .png (must be rejected by content sniffing).
	fakePngPath := filepath.Join(dir, "notreally.png")
	if err := os.WriteFile(fakePngPath, []byte("just some plain text content, not an image"), 0644); err != nil {
		t.Fatalf("failed to write fake png: %v", err)
	}

	// 3. Non-image extension.
	txtPath := filepath.Join(dir, "notes.txt")
	if err := os.WriteFile(txtPath, []byte("hello"), 0644); err != nil {
		t.Fatalf("failed to write txt file: %v", err)
	}

	// 4. Directory with an image-like name.
	dirPath := filepath.Join(dir, "folder.png")
	if err := os.Mkdir(dirPath, 0755); err != nil {
		t.Fatalf("failed to create directory: %v", err)
	}

	// 5. Missing file.
	missingPath := filepath.Join(dir, "does-not-exist.png")

	// 6. SVG: text/XML content, allowed via extension-only gate (not raster-sniffable).
	svgPath := filepath.Join(dir, "icon.svg")
	if err := os.WriteFile(svgPath, []byte(`<svg xmlns="http://www.w3.org/2000/svg"></svg>`), 0644); err != nil {
		t.Fatalf("failed to write svg file: %v", err)
	}

	tests := []struct {
		name       string
		path       string
		expectOK   bool
		expectPath string
	}{
		{"allowed image", pngPath, true, pngPath},
		{"text file renamed to .png is rejected", fakePngPath, false, ""},
		{"non-image extension is rejected", txtPath, false, ""},
		{"directory is rejected", dirPath, false, ""},
		{"missing file is rejected", missingPath, false, ""},
		{"empty path is rejected", "", false, ""},
		{"svg is allowed without content sniffing", svgPath, true, svgPath},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, ok := resolveImageFileRequest(tt.path)
			if ok != tt.expectOK {
				t.Fatalf("resolveImageFileRequest(%q) ok = %v, want %v (path=%q)", tt.path, ok, tt.expectOK, got)
			}
			if ok && got != tt.expectPath {
				t.Errorf("resolveImageFileRequest(%q) path = %q, want %q", tt.path, got, tt.expectPath)
			}
		})
	}
}
