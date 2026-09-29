package main

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// B23 of the UX review: a note can name an image as //host/share/x.png (or the backslash form). The preview and
// the hover tooltip turned that into /api/image?path=..., and Windows resolves such a path over SMB, so merely
// looking at the note made the machine connect to that host. The endpoint must refuse them without touching the
// file system; nothing below reaches a network (the checks are on the text).

func TestIsRemoteSharePath(t *testing.T) {
	bs := "\\"
	tests := []struct {
		path string
		want bool
	}{
		{"//evil.example/share/pic.png", true},
		{bs + bs + "evil.example" + bs + "share" + bs + "pic.png", true},
		{"/" + bs + "evil.example/share/pic.png", true},
		{bs + "/evil.example/share/pic.png", true},
		{bs + bs + "?" + bs + "C:" + bs + "pic.png", true},
		{bs + bs + "." + bs + "pipe" + bs + "x.png", true},
		{"///three/slashes.png", true},
		{"//", true},
		{"C:" + bs + "pics" + bs + "a.png", false},
		{"C:/pics/a.png", false},
		{"/tmp/a.png", false},
		{"/tmp//a.png", false},
		{"a/b.png", false},
		{"a" + bs + "b.png", false},
		{bs + "a.png", false},
		{"/", false},
		{"", false},
	}
	for _, tt := range tests {
		if got := isRemoteSharePath(tt.path); got != tt.want {
			t.Errorf("isRemoteSharePath(%q) = %v, want %v", tt.path, got, tt.want)
		}
	}
}

func TestResolveImageFileRequestRejectsRemoteShares(t *testing.T) {
	dir := t.TempDir()
	png := filepath.Join(dir, "diagram.png")
	pngBytes := append([]byte{0x89, 'P', 'N', 'G', 0x0D, 0x0A, 0x1A, 0x0A}, make([]byte, 24)...)
	if err := os.WriteFile(png, pngBytes, 0644); err != nil {
		t.Fatalf("failed to write test png: %v", err)
	}

	if _, ok := resolveImageFileRequest(png); !ok {
		t.Fatalf("the local image %q must still be served", png)
	}

	// The same real file, spelled so that it starts with two separators. On Linux and macOS these are ordinary
	// paths that used to work; refusing them is the price of one rule that holds on every platform.
	bare := strings.TrimLeft(filepath.ToSlash(png), "/")
	variants := []string{
		"//" + bare,
		"/" + "\\" + bare,
		"\\\\" + strings.ReplaceAll(bare, "/", "\\"),
	}
	if runtime.GOOS == "windows" {
		// The administrative share of the local drive: a real UNC path to the file above. The request must be
		// turned away on its text, before any attempt to open it (that would be an SMB connection).
		if vol := filepath.VolumeName(png); len(vol) == 2 && vol[1] == ':' {
			rest := png[len(vol):]
			variants = append(variants,
				`\\localhost\`+vol[:1]+`$`+rest,
				"//localhost/"+vol[:1]+"$"+filepath.ToSlash(rest),
				`\\127.0.0.1\`+vol[:1]+`$`+rest,
			)
		}
	}
	for _, v := range variants {
		if got, ok := resolveImageFileRequest(v); ok {
			t.Errorf("resolveImageFileRequest(%q) served %q, want a refusal", v, got)
		}
	}
}
