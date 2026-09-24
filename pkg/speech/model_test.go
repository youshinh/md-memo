package speech

import (
	"encoding/binary"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestValidateModelFile(t *testing.T) {
	dir := t.TempDir()
	header := func(magic uint32, vocab int32, extra int) []byte {
		b := make([]byte, 8+extra)
		binary.LittleEndian.PutUint32(b, magic)
		binary.LittleEndian.PutUint32(b[4:], uint32(vocab))
		return b
	}
	write := func(name string, b []byte) string {
		p := filepath.Join(dir, name)
		if err := os.WriteFile(p, b, 0o644); err != nil {
			t.Fatal(err)
		}
		return p
	}

	t.Run("multilingual", func(t *testing.T) {
		info, err := ValidateModelFile(write("kotoba.bin", header(ggmlMagic, 51866, 100)))
		if err != nil || info.VocabSize != 51866 || !info.Multilingual || info.Size != 108 {
			t.Fatalf("got %+v, %v", info, err)
		}
	})
	t.Run("multilingual 51865", func(t *testing.T) {
		info, err := ValidateModelFile(write("multi.bin", header(ggmlMagic, 51865, 0)))
		if err != nil || !info.Multilingual {
			t.Fatalf("got %+v, %v", info, err)
		}
	})
	t.Run("english only", func(t *testing.T) {
		info, err := ValidateModelFile(write("en.bin", header(ggmlMagic, 51864, 0)))
		if err != nil || info.VocabSize != 51864 || info.Multilingual {
			t.Fatalf("got %+v, %v", info, err)
		}
	})

	notGGML := map[string][]byte{
		"gguf":        append([]byte("GGUF"), make([]byte, 20)...),
		"safetensors": append([]byte{0x10, 0, 0, 0, 0, 0, 0, 0}, []byte(`{"a":1}`)...),
		"zip":         append([]byte("PK\x03\x04"), make([]byte, 20)...),
		"text":        []byte("this is not a model at all"),
	}
	for name, b := range notGGML {
		t.Run(name, func(t *testing.T) {
			_, err := ValidateModelFile(write(name+".bin", b))
			if err == nil || !strings.Contains(err.Error(), "ggml") {
				t.Fatalf("got %v, want an error that mentions ggml", err)
			}
		})
	}
	if _, err := ValidateModelFile(write("gguf2.bin", notGGML["gguf"])); err == nil || !strings.Contains(err.Error(), "GGUF") {
		t.Errorf("a GGUF file should be named as such, got %v", err)
	}
	if _, err := ValidateModelFile(write("st2.bin", notGGML["safetensors"])); err == nil || !strings.Contains(err.Error(), "safetensors") {
		t.Errorf("a safetensors file should be named as such, got %v", err)
	}

	t.Run("bad vocab", func(t *testing.T) {
		for _, v := range []int32{0, -5, 1 << 30} {
			if _, err := ValidateModelFile(write("vocab.bin", header(ggmlMagic, v, 0))); err == nil {
				t.Errorf("vocab %d accepted", v)
			}
		}
	})
	t.Run("too short", func(t *testing.T) {
		for _, n := range []int{0, 3, 7} {
			if _, err := ValidateModelFile(write("short.bin", make([]byte, n))); err == nil || !strings.Contains(err.Error(), "小さすぎ") {
				t.Errorf("%d bytes: got %v", n, err)
			}
		}
	})
	t.Run("missing", func(t *testing.T) {
		_, err := ValidateModelFile(filepath.Join(dir, "nope.bin"))
		if err == nil || !strings.Contains(err.Error(), "見つかりません") {
			t.Fatalf("got %v", err)
		}
	})
	t.Run("directory", func(t *testing.T) {
		if _, err := ValidateModelFile(dir); err == nil {
			t.Fatal("a directory was accepted")
		}
	})
}
