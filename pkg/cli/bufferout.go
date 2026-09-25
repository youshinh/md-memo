package cli

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"

	"md-memo/pkg/atomicfile"
)

// `md-memo buffer get --out <file>` writes the note to a file from THIS process instead of printing
// it. Why: text that travels through a shell pipe (`md-memo buffer get | Set-Content x.md`,
// `> x.md`, a Python subprocess) is decoded and re-encoded with the console's code page on the way
// (Windows PowerShell 5.1 writes UTF-16 or the ANSI page), which garbles Japanese and other
// non-ASCII text. A file written here is UTF-8 exactly as the app sent it. No new RPC is involved:
// the note still comes from buffer.get / buffer.get_selection.

var utf8BOM = []byte{0xEF, 0xBB, 0xBF}

// bufferOutResult is what `buffer get --out` prints in place of the content.
type bufferOutResult struct {
	Path  string `json:"path"`
	Bytes int    `json:"bytes"`
	// Hash is the note's hash as buffer get reports it (usable with buffer set --expected-hash);
	// with --selection it is the hash of the selected text, computed the same way.
	Hash string `json:"hash"`
	// Generation is the note's revision counter (usable with --expected-gen); absent with --selection.
	Generation *uint64 `json:"generation,omitempty"`
}

// contentHash is computeHash of app_rpc.go (package main, so not importable here): the first
// 8 bytes of the SHA-256, in hex. Keep the two in step.
func contentHash(s string) string {
	sum := sha256.Sum256([]byte(s))
	return hex.EncodeToString(sum[:8])
}

// resolveOutPath makes the --out value absolute against the working directory of this process
// (not the app's) and refuses what cannot be a note file: a directory, or a file in a folder that
// does not exist (no folder is ever created for you).
func resolveOutPath(out string) (string, error) {
	if out == "" {
		return "", errors.New("--out needs a file path")
	}
	abs, err := filepath.Abs(out)
	if err != nil {
		return "", fmt.Errorf("cannot resolve --out %q: %w", out, err)
	}
	if fi, err := os.Stat(abs); err == nil && fi.IsDir() {
		return "", fmt.Errorf("--out %s is a folder, not a file", abs)
	}
	dir := filepath.Dir(abs)
	if fi, err := os.Stat(dir); err != nil || !fi.IsDir() {
		return "", fmt.Errorf("the folder %s does not exist (create it first; --out never creates folders)", dir)
	}
	return abs, nil
}

// writeFileAtomic writes data to a temporary file in the same folder and renames it over path, so a
// reader (or a crash) sees either the old file or the whole new one, never half of it. An existing
// file keeps its permission bits; a new one gets 0644 (the temp file itself is created 0600).
func writeFileAtomic(path string, data []byte) error {
	return atomicfile.Write(path, data, ".md-memo-out-*.tmp")
}

// writeBufferOut is the second half of `buffer get --out`: content has been fetched from the app,
// path is what resolveOutPath returned.
func (c *ClientRunner) writeBufferOut(path, content, hash string, generation *uint64, bom bool, format OutputFormat) (int, error) {
	data := []byte(content)
	if bom {
		data = append(append(make([]byte, 0, len(utf8BOM)+len(data)), utf8BOM...), data...)
	}
	if err := writeFileAtomic(path, data); err != nil {
		return 1, fmt.Errorf("cannot write %s: %w", path, err)
	}
	if hash == "" {
		hash = contentHash(content)
	}
	res := bufferOutResult{Path: path, Bytes: len(data), Hash: hash, Generation: generation}
	if format == FormatJSON {
		PrintFormatted(c.stdout, FormatJSON, "", res)
	} else {
		fmt.Fprintf(c.stdout, "Wrote %d bytes to %s (hash %s)\n", res.Bytes, res.Path, res.Hash)
	}
	return 0, nil
}
