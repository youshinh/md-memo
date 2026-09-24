package speech

import (
	"crypto/sha256"
	"encoding/hex"
	"path"
	"regexp"
	"runtime"
	"strings"
	"testing"

	"md-memo/pkg/components"
	"md-memo/pkg/llm"
)

var hex64 = regexp.MustCompile(`^[0-9a-f]{64}$`)

func TestCatalogIntegrity(t *testing.T) {
	rt, models := Catalog()
	all := append([]components.Part{rt}, models...)
	ids := map[string]bool{}
	safeID := regexp.MustCompile(`^[A-Za-z0-9._-]+$`)
	for _, p := range all {
		if ids[p.ID] {
			t.Errorf("duplicate id %q", p.ID)
		}
		ids[p.ID] = true
		if !safeID.MatchString(p.ID) {
			t.Errorf("%s: id is not filesystem-safe", p.ID)
		}
		if !strings.HasPrefix(p.URL, "https://") {
			t.Errorf("%s: URL %q is not https", p.ID, p.URL)
		}
		if !hex64.MatchString(p.SHA256) {
			t.Errorf("%s: SHA256 %q is not 64 lowercase hex chars", p.ID, p.SHA256)
		}
		if p.Entry == "" || p.Title == "" || p.Note == "" || p.Size <= 0 {
			t.Errorf("%s: missing entry/title/note/size: %+v", p.ID, p)
		}
	}

	if rt.Kind != "runtime" || rt.Platform != "windows/amd64" || rt.Archive != "zip" || rt.Entry != "whisper-cli.exe" {
		t.Errorf("runtime part is wrong: %+v", rt)
	}
	if strings.Join(rt.Extract, ",") != "whisper-cli.exe,whisper.dll,ggml*.dll" {
		t.Errorf("runtime extract list is %v", rt.Extract)
	}
	if len(models) != 5 {
		t.Errorf("%d models, want 5", len(models))
	}
	for _, m := range models {
		if m.Kind != "model" || m.Archive != "" || m.Platform != "" || len(m.Extract) != 0 {
			t.Errorf("%s: model part is wrong: %+v", m.ID, m)
		}
		if m.Entry != path.Base(m.URL) {
			t.Errorf("%s: entry %q is not the URL's file name", m.ID, m.Entry)
		}
	}
	if !ids[DefaultWhisperModelID()] || DefaultWhisperModelID() != "kotoba-v2.0-q5_0" {
		t.Errorf("default model id %q is not in the catalog", DefaultWhisperModelID())
	}
}

func TestCatalogPinnedData(t *testing.T) {
	rt, models := Catalog()
	if rt.ID != "whisper-runtime-b5130-win-x64" || rt.Size != 8573270 ||
		rt.SHA256 != "f9ec6c52a2e949b62ab51fa21d0d497958f9e41c3010c157c4e42932d5316f3c" ||
		rt.URL != "https://github.com/ggml-org/whisper.cpp/releases/download/b5130/whisper-bin-x64.zip" {
		t.Errorf("runtime data changed: %+v", rt)
	}
	want := map[string]struct {
		url, sha string
		size     int64
	}{
		"kotoba-v2.0-q5_0":    {"https://huggingface.co/kotoba-tech/kotoba-whisper-v2.0-ggml/resolve/main/ggml-kotoba-whisper-v2.0-q5_0.bin", "4a3b92192b5d3578ff854a5876213e2e27af0c2d357492c2d14271e82c303658", 537819875},
		"kotoba-v2.0":         {"https://huggingface.co/kotoba-tech/kotoba-whisper-v2.0-ggml/resolve/main/ggml-kotoba-whisper-v2.0.bin", "eff70a8a236e731abba774ba71e1f6d0fce53302137208c32207e694e0bf4546", 1519521155},
		"large-v3-turbo-q5_0": {"https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin", "394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2", 574041195},
		"small-q5_1":          {"https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small-q5_1.bin", "ae85e4a935d7a567bd102fe55afc16bb595bdb618e11b2fc7591bc08120411bb", 190085487},
		"base":                {"https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin", "60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe", 147951465},
	}
	for _, m := range models {
		w, ok := want[m.ID]
		if !ok || m.URL != w.url || m.SHA256 != w.sha || m.Size != w.size {
			t.Errorf("%s: catalog data changed: %+v", m.ID, m)
		}
		delete(want, m.ID)
	}
	if len(want) != 0 {
		t.Errorf("models missing from the catalog: %v", want)
	}
}

func TestCatalogReturnsCopies(t *testing.T) {
	rt, models := Catalog()
	rt.Extract[0] = "changed"
	models[0].ID = "changed"
	rt2, models2 := Catalog()
	if rt2.Extract[0] != "whisper-cli.exe" || models2[0].ID != "kotoba-v2.0-q5_0" {
		t.Fatal("mutating a Catalog() result leaked into the next call")
	}
}

func TestRuntimePartPlatform(t *testing.T) {
	old := hostPlatform
	t.Cleanup(func() { hostPlatform = old })
	for platform, want := range map[string]bool{
		"windows/amd64": true, "windows/arm64": false, "linux/amd64": false, "darwin/arm64": false,
	} {
		hostPlatform = func() string { return platform }
		p, ok := RuntimePart()
		if ok != want || (ok && p.ID == "") || (!ok && p.ID != "") {
			t.Errorf("%s: RuntimePart() = %q, %v", platform, p.ID, ok)
		}
	}

	hostPlatform = old
	if _, ok := RuntimePart(); ok != (runtime.GOOS == "windows" && runtime.GOARCH == "amd64") {
		t.Errorf("RuntimePart() on the real host = %v", ok)
	}
}

func TestResolveModelPart(t *testing.T) {
	_, models := Catalog()
	for _, m := range models {
		got, ok := ResolveModelPart(llm.WhisperSettings{Model: m.ID})
		if !ok || got.ID != m.ID || got.URL != m.URL {
			t.Errorf("%s: resolved to %+v, %v", m.ID, got, ok)
		}
	}
	def, ok := ResolveModelPart(llm.WhisperSettings{})
	if !ok || def.ID != DefaultWhisperModelID() {
		t.Errorf("empty model resolved to %q, %v", def.ID, ok)
	}
	if p, ok := ResolveModelPart(llm.WhisperSettings{Model: " small-q5_1 "}); !ok || p.ID != "small-q5_1" {
		t.Errorf("surrounding spaces should be ignored, got %q, %v", p.ID, ok)
	}

	for name, w := range map[string]llm.WhisperSettings{
		"custom-path":               {Model: "custom-path", ModelPath: `C:\models\x.bin`},
		"custom-url without url":    {Model: "custom-url"},
		"custom-url blank url":      {Model: "custom-url", CustomURL: "   "},
		"unknown id":                {Model: "large-v9"},
		"id differing only in case": {Model: "BASE"},
	} {
		if p, ok := ResolveModelPart(w); ok {
			t.Errorf("%s: resolved to %+v, want false", name, p)
		}
	}

	w := llm.WhisperSettings{Model: "custom-url", CustomURL: "https://example.com/m.bin", CustomSHA256: " ABC "}
	p, ok := ResolveModelPart(w)
	if !ok || p.ID != CustomURLPart(w.CustomURL, w.CustomSHA256).ID || p.URL != w.CustomURL || p.SHA256 != "abc" {
		t.Errorf("custom-url resolved to %+v, %v", p, ok)
	}
}

func TestCustomURLPart(t *testing.T) {
	url := "https://example.com/models/my-model.bin"
	sum := sha256.Sum256([]byte(url))
	p := CustomURLPart(url, "  "+strings.ToUpper(strings.Repeat("ab", 32))+"\n")
	if want := "custom-" + hex.EncodeToString(sum[:])[:12]; p.ID != want {
		t.Errorf("id %q, want %q", p.ID, want)
	}
	if p.Kind != "model" || p.Title != "Custom model" || p.Entry != "model.bin" || p.URL != url || p.Archive != "" || p.Platform != "" {
		t.Errorf("unexpected part: %+v", p)
	}
	if p.SHA256 != strings.Repeat("ab", 32) {
		t.Errorf("sha256 %q is not lower-cased and trimmed", p.SHA256)
	}
	if again := CustomURLPart(url, ""); again.ID != p.ID || again.SHA256 != "" {
		t.Errorf("id must not depend on the checksum, and an empty one stays empty: %+v", again)
	}
	if other := CustomURLPart(url+"2", ""); other.ID == p.ID {
		t.Error("different URLs must not share an id")
	}
}
