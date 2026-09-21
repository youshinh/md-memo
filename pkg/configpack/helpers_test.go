package configpack

import (
	"archive/zip"
	"bytes"
	"compress/flate"
	"encoding/json"
	"errors"
	"hash/crc32"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// zent describes one zip entry to write, including deliberately malformed ones.
type zent struct {
	name  string
	data  []byte
	mode  fs.FileMode // 0 = leave the default
	flags uint16
	store bool // no compression (fast for bulk empty entries)
}

func newZipWriter(w io.Writer) *zip.Writer {
	zw := zip.NewWriter(w)
	zw.RegisterCompressor(zip.Deflate, func(out io.Writer) (io.WriteCloser, error) {
		return flate.NewWriter(out, flate.BestSpeed)
	})
	return zw
}

func writeZipFile(t *testing.T, ents []zent) string {
	t.Helper()
	var buf bytes.Buffer
	zw := newZipWriter(&buf)
	for _, e := range ents {
		hdr := &zip.FileHeader{Name: e.name, Method: zip.Deflate, Flags: e.flags}
		if e.store {
			hdr.Method = zip.Store
		}
		if e.mode != 0 {
			hdr.SetMode(e.mode)
		}
		w, err := zw.CreateHeader(hdr)
		if err != nil {
			t.Fatalf("CreateHeader(%q): %v", e.name, err)
		}
		if _, err := w.Write(e.data); err != nil {
			t.Fatal(err)
		}
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	return saveTemp(t, buf.Bytes())
}

func saveTemp(t *testing.T, data []byte) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), "test.mdmemopack")
	if err := os.WriteFile(p, data, 0o600); err != nil {
		t.Fatal(err)
	}
	return p
}

func testManifest(items ...Item) Manifest {
	return Manifest{Format: Format, Version: Version, CreatedAt: "2026-09-21T10:00:00+09:00", AppVersion: "1.5.5", ConfigSections: []string{}, Items: items}
}

func mustJSON(t *testing.T, v any) []byte {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

// packWith writes a pack holding manifest.json plus the given entries.
func packWith(t *testing.T, m Manifest, ents ...zent) string {
	t.Helper()
	all := append([]zent{{name: ManifestName, data: mustJSON(t, m)}}, ents...)
	return writeZipFile(t, all)
}

func skillItem(root, name, entry string) Item {
	return Item{ID: SkillID(root, name), Kind: KindSkill, Root: root, Name: name, Entry: entry}
}

func mustOpen(t *testing.T, path string) *Pack {
	t.Helper()
	p, err := Open(path)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	t.Cleanup(func() { p.Close() })
	return p
}

func wantErr(t *testing.T, err, target error) {
	t.Helper()
	if !errors.Is(err, target) {
		t.Fatalf("error = %v, want %v", err, target)
	}
}

// deflated returns n zero bytes as a raw deflate stream and their CRC-32.
func deflatedZeros(t *testing.T, n int) ([]byte, uint32) {
	t.Helper()
	var buf bytes.Buffer
	fw, _ := flate.NewWriter(&buf, flate.BestSpeed)
	chunk := make([]byte, 1<<20)
	crc := uint32(0)
	for left := n; left > 0; {
		c := chunk
		if left < len(c) {
			c = c[:left]
		}
		if _, err := fw.Write(c); err != nil {
			t.Fatal(err)
		}
		crc = crc32.Update(crc, crc32.IEEETable, c)
		left -= len(c)
	}
	if err := fw.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes(), crc
}

// rawEntry writes a stored-as-given entry, so the header can lie about the content.
type rawEntry struct {
	name             string
	method           uint16
	comp             []byte
	crc              uint32
	declaredSize     uint64
	declaredCompSize uint64
}

func writeRawZip(t *testing.T, m Manifest, raws ...rawEntry) string {
	t.Helper()
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	mw, _ := zw.CreateHeader(&zip.FileHeader{Name: ManifestName, Method: zip.Store})
	_, _ = mw.Write(mustJSON(t, m))
	for _, r := range raws {
		cs := r.declaredCompSize
		if cs == 0 {
			cs = uint64(len(r.comp))
		}
		w, err := zw.CreateRaw(&zip.FileHeader{Name: r.name, Method: r.method, CRC32: r.crc, CompressedSize64: cs, UncompressedSize64: r.declaredSize})
		if err != nil {
			t.Fatal(err)
		}
		if _, err := w.Write(r.comp); err != nil {
			t.Fatal(err)
		}
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	return saveTemp(t, buf.Bytes())
}

// writeTree creates files (relative slash paths) under dir.
func writeTree(t *testing.T, dir string, files map[string]string) {
	t.Helper()
	for rel, content := range files {
		p := filepath.Join(dir, filepath.FromSlash(rel))
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
}

var fixedTime = time.Date(2026, 9, 21, 10, 0, 0, 0, time.UTC)
