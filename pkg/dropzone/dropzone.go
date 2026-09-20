// Package dropzone implements the "Mobile Drop" QR-sync feature: an ephemeral,
// token-gated HTTP server that lets a phone on the same LAN push a photo,
// piece of text, or small file into the currently running md-memo instance.
//
// The package is intentionally dependency-free (standard library only) so it
// can be unit tested without network access to the Go module proxy. QR code
// rendering is injected from the caller via the QREncoder function type
// (see server.go), keeping the one unavoidable third-party dependency
// (github.com/skip2/go-qrcode) out of this package entirely.
package dropzone

import (
	"fmt"
	"regexp"
	"strings"
	"sync"
	"time"
	"unicode"
)

// Kind identifies what sort of payload a mobile client sent.
type Kind string

const (
	// KindImage is a photo or picture file (image/* MIME type). It is routed
	// to the vision/OCR pipeline by the caller.
	KindImage Kind = "image"
	// KindURL is plain text that is, in its entirety, a single URL.
	KindURL Kind = "url"
	// KindText is free-form text typed into the mobile web UI.
	KindText Kind = "text"
	// KindFile is an uploaded file that is neither an image nor typed text
	// (.md/.txt/.html/.js/.json/... etc). See ClassifyFileExtension for how
	// its content ends up formatted.
	KindFile Kind = "file"
)

// Payload is the normalized result of a single Mobile Drop submission,
// independent of whether it arrived as multipart file upload or a plain
// text/URL post.
type Payload struct {
	Kind     Kind
	Filename string // original filename, empty for KindText/KindURL
	MimeType string // sniffed/declared MIME type, empty for KindText/KindURL
	Text     string // raw text for KindText/KindURL
	Data     []byte // raw bytes for KindImage/KindFile
}

// bareURLRegex matches a string that, once trimmed, is nothing but a single
// http(s) URL with no surrounding words or whitespace.
//
// Compiled on first use, not at start-up (see pageTemplate in html.go).
var bareURLRegex = sync.OnceValue(func() *regexp.Regexp { return regexp.MustCompile(`^https?://\S+$`) })

// IsBareURL reports whether s (after trimming leading/trailing whitespace)
// consists of exactly one http(s) URL and nothing else.
func IsBareURL(s string) bool {
	trimmed := strings.TrimSpace(s)
	if trimmed == "" || strings.ContainsAny(trimmed, " \t\n\r") {
		return false
	}
	return bareURLRegex().MatchString(trimmed)
}

// textFenceExtensions maps a file extension (including the leading dot, all
// lowercase) to the markdown fenced-code-block language tag it should be
// wrapped in. Extensions not present here are treated as plain, unfenced
// text when they are otherwise recognized as text-like (see
// plainTextExtensions), or fall back to a generic "text" fence otherwise.
var textFenceExtensions = map[string]string{
	".js":   "javascript",
	".mjs":  "javascript",
	".cjs":  "javascript",
	".ts":   "typescript",
	".tsx":  "tsx",
	".jsx":  "jsx",
	".json": "json",
	".html": "html",
	".htm":  "html",
	".css":  "css",
	".py":   "python",
	".go":   "go",
	".java": "java",
	".c":    "c",
	".h":    "c",
	".cpp":  "cpp",
	".rb":   "ruby",
	".php":  "php",
	".sh":   "bash",
	".yaml": "yaml",
	".yml":  "yaml",
	".xml":  "xml",
	".sql":  "sql",
	".rs":   "rust",
}

// plainTextExtensions are extensions whose content should be appended as
// plain markdown/text (no fence), because it typically already reads well
// as prose.
var plainTextExtensions = map[string]bool{
	".md":       true,
	".markdown": true,
	".txt":      true,
}

// FileClass describes how an uploaded file's content should be rendered
// once appended to the buffer.
type FileClass struct {
	// Plain is true when the content should be appended as-is (Markdown/
	// text files). When false, the content should be wrapped in a fenced
	// code block using Lang.
	Plain bool
	// Lang is the fenced-code-block language tag to use when Plain is
	// false. Empty means a generic, language-less fence.
	Lang string
}

// ClassifyFileExtension decides how the content of an uploaded (non-image)
// file should be formatted, based on its filename extension.
func ClassifyFileExtension(filename string) FileClass {
	ext := strings.ToLower(extOf(filename))
	if plainTextExtensions[ext] {
		return FileClass{Plain: true}
	}
	if lang, ok := textFenceExtensions[ext]; ok {
		return FileClass{Plain: false, Lang: lang}
	}
	return FileClass{Plain: false, Lang: ""}
}

func extOf(filename string) string {
	idx := strings.LastIndex(filename, ".")
	if idx < 0 || idx == len(filename)-1 {
		return ""
	}
	return filename[idx:]
}

// FormatSection renders a single Mobile Drop submission as a markdown
// section ready to be appended to the end of the active buffer. body is the
// already-processed content (OCR result for images, raw/wrapped text for
// everything else). at is injected rather than read from time.Now() so the
// function stays pure and testable.
func FormatSection(kind Kind, filename, body string, at time.Time) string {
	header := fmt.Sprintf("## Mobile Drop [%s]", at.Format("15:04:05"))
	if name := sanitizeFilename(filename); name != "" {
		header = fmt.Sprintf("%s — %s", header, name)
	}
	return fmt.Sprintf("\n\n%s\n\n%s\n", header, strings.TrimRight(body, "\n"))
}

// sanitizeFilename makes a client-supplied filename safe to put in a
// single-line markdown heading: control characters (line breaks included)
// become spaces and the length is capped.
func sanitizeFilename(name string) string {
	name = strings.Map(func(r rune) rune {
		if unicode.IsControl(r) {
			return ' '
		}
		return r
	}, name)
	name = strings.TrimSpace(name)
	if runes := []rune(name); len(runes) > 120 {
		name = string(runes[:120])
	}
	return name
}

// FormatTextBody prepares the body for KindText/KindURL submissions: a bare
// URL becomes a markdown link, anything else passes through unchanged.
func FormatTextBody(text string) string {
	trimmed := strings.TrimSpace(text)
	if IsBareURL(trimmed) {
		return fmt.Sprintf("[%s](%s)", trimmed, trimmed)
	}
	return trimmed
}

// FormatFileBody prepares the body for a KindFile submission per
// ClassifyFileExtension: markdown/text files pass through, everything else
// is wrapped in a fenced code block.
func FormatFileBody(filename string, content string) string {
	class := ClassifyFileExtension(filename)
	content = strings.TrimRight(content, "\n")
	if class.Plain {
		return content
	}
	fence := fenceFor(content)
	return fmt.Sprintf("%s%s\n%s\n%s", fence, class.Lang, content, fence)
}

// fenceFor returns a code-fence marker longer than any run of backticks in
// content, so a file that itself contains ``` cannot close the block early.
func fenceFor(content string) string {
	longest, run := 0, 0
	for _, r := range content {
		if r == '`' {
			run++
			if run > longest {
				longest = run
			}
		} else {
			run = 0
		}
	}
	n := longest + 1
	if n < 3 {
		n = 3
	}
	return strings.Repeat("`", n)
}

// StripMarkdownFence removes a single outer fenced code block wrapping
// text when its language tag is empty, "markdown", "md", or "text". Vision
// models are asked not to wrap their output this way, but occasionally do
// anyway; this mirrors the same cleanup already applied to OCR results
// pasted via Ctrl+V elsewhere in the app, so Mobile Drop photos behave the
// same way.
func StripMarkdownFence(text string) string {
	s := strings.TrimSpace(text)
	if !strings.HasPrefix(s, "```") {
		return s
	}
	lines := strings.Split(s, "\n")
	if len(lines) < 2 {
		return s
	}
	first := strings.TrimSpace(lines[0])
	last := strings.TrimSpace(lines[len(lines)-1])
	if !strings.HasPrefix(first, "```") || last != "```" {
		return s
	}
	switch strings.ToLower(strings.TrimPrefix(first, "```")) {
	case "", "markdown", "md", "text":
		return strings.TrimSpace(strings.Join(lines[1:len(lines)-1], "\n"))
	default:
		return s
	}
}
