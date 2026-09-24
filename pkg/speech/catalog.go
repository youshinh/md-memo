package speech

import (
	"crypto/sha256"
	"encoding/hex"
	"runtime"
	"strings"

	"md-memo/pkg/components"
	"md-memo/pkg/llm"
)

const (
	defaultModelID  = "kotoba-v2.0-q5_0"
	modelCustomPath = "custom-path"
	modelCustomURL  = "custom-url"

	hfWhisperCpp = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/"
	hfKotoba     = "https://huggingface.co/kotoba-tech/kotoba-whisper-v2.0-ggml/resolve/main/"
)

var hostPlatform = func() string { return runtime.GOOS + "/" + runtime.GOARCH }

func runtimeCatalogPart() components.Part {
	return components.Part{
		ID:       "whisper-runtime-b5130-win-x64",
		Kind:     "runtime",
		Title:    "Whisper 実行ファイル (whisper.cpp b5130 / Windows x64 CPU)",
		Note:     "音声認識を実行する小さなプログラム(約9MB)",
		URL:      "https://github.com/ggml-org/whisper.cpp/releases/download/b5130/whisper-bin-x64.zip",
		SHA256:   "f9ec6c52a2e949b62ab51fa21d0d497958f9e41c3010c157c4e42932d5316f3c",
		Size:     8573270,
		Archive:  "zip",
		Extract:  []string{"whisper-cli.exe", "whisper.dll", "ggml*.dll"},
		Entry:    "whisper-cli.exe",
		Platform: "windows/amd64",
	}
}

func modelCatalogParts() []components.Part {
	model := func(id, title, note, base, file, sum string, size int64) components.Part {
		return components.Part{ID: id, Kind: "model", Title: title, Note: note, URL: base + file, SHA256: sum, Size: size, Entry: file}
	}
	return []components.Part{
		model(defaultModelID, "kotoba-whisper v2.0 量子化版(日本語特化・推奨)",
			"日本語に特化した高精度モデル。約513MB。フル精度版よりわずかに精度が落ちる代わりに小さく速い",
			hfKotoba, "ggml-kotoba-whisper-v2.0-q5_0.bin", "4a3b92192b5d3578ff854a5876213e2e27af0c2d357492c2d14271e82c303658", 537819875),
		model("kotoba-v2.0", "kotoba-whisper v2.0 フル精度版(日本語特化)",
			"日本語に特化した最高精度のモデル。約1.4GB。ディスクとメモリを多く使うぶん、量子化版よりわずかに正確",
			hfKotoba, "ggml-kotoba-whisper-v2.0.bin", "eff70a8a236e731abba774ba71e1f6d0fce53302137208c32207e694e0bf4546", 1519521155),
		model("large-v3-turbo-q5_0", "Whisper large-v3-turbo 量子化版(多言語)",
			"日本語以外も認識できる多言語モデル。約547MB。日本語だけなら kotoba 版のほうが得意",
			hfWhisperCpp, "ggml-large-v3-turbo-q5_0.bin", "394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2", 574041195),
		model("small-q5_1", "Whisper small 量子化版(軽量)",
			"約181MB の軽量な多言語モデル。速くて小さいが、固有名詞や早口は間違えやすい",
			hfWhisperCpp, "ggml-small-q5_1.bin", "ae85e4a935d7a567bd102fe55afc16bb595bdb618e11b2fc7591bc08120411bb", 190085487),
		model("base", "Whisper base(最軽量・低精度)",
			"約141MB の最小クラスのモデル。動作確認向けで、実用の精度は低い",
			hfWhisperCpp, "ggml-base.bin", "60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe", 147951465),
	}
}

// Catalog returns the runtime part (always the Windows one; see RuntimePart for the platform
// check) and the downloadable models. The result is a copy the caller may modify.
func Catalog() (components.Part, []components.Part) {
	return runtimeCatalogPart(), modelCatalogParts()
}

// RuntimePart returns the runtime part when it supports this OS/architecture.
func RuntimePart() (components.Part, bool) {
	rt := runtimeCatalogPart()
	if rt.Platform != "" && rt.Platform != hostPlatform() {
		return components.Part{}, false
	}
	return rt, true
}

func DefaultWhisperModelID() string { return defaultModelID }

// ResolveModelPart finds the downloadable part for w.Model. It is false for "custom-path" (no
// download), for a "custom-url" without a URL, and for unknown ids.
func ResolveModelPart(w llm.WhisperSettings) (components.Part, bool) {
	switch id := effectiveModelID(w); id {
	case modelCustomPath:
		return components.Part{}, false
	case modelCustomURL:
		if strings.TrimSpace(w.CustomURL) == "" {
			return components.Part{}, false
		}
		return CustomURLPart(w.CustomURL, w.CustomSHA256), true
	default:
		for _, p := range modelCatalogParts() {
			if p.ID == id {
				return p, true
			}
		}
	}
	return components.Part{}, false
}

// CustomURLPart describes a user-supplied model download. The id derives from the URL, so a
// different URL installs side by side instead of overwriting.
func CustomURLPart(url, sha string) components.Part {
	url = strings.TrimSpace(url)
	sum := sha256.Sum256([]byte(url))
	return components.Part{
		ID:     "custom-" + hex.EncodeToString(sum[:])[:12],
		Kind:   "model",
		Title:  "Custom model",
		Note:   "ユーザーが指定した URL のモデル",
		URL:    url,
		SHA256: strings.ToLower(strings.TrimSpace(sha)),
		Entry:  "model.bin",
	}
}

func effectiveModelID(w llm.WhisperSettings) string {
	if id := strings.TrimSpace(w.Model); id != "" {
		return id
	}
	return defaultModelID
}
