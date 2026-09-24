package markdownutil

import (
	"regexp"
	"strings"
	"sync"
)

// stripRegexes holds every pattern StripMarkdown needs. Compiling 16 patterns costs about 43 KiB and
// 450 allocs, which is wasted on every app start for code paths that may never call StripMarkdown, so
// they are compiled lazily on first use instead of at package init.
type stripRegexes struct {
	fencedCode    *regexp.Regexp
	inlineCode    *regexp.Regexp
	images        *regexp.Regexp
	links         *regexp.Regexp
	headers       *regexp.Regexp
	blockquote    *regexp.Regexp
	listTasks     *regexp.Regexp
	listBulleted  *regexp.Regexp
	listNumbered  *regexp.Regexp
	boldAsterisk  *regexp.Regexp
	boldUnder     *regexp.Regexp
	italicAster   *regexp.Regexp
	italicUnder   *regexp.Regexp
	strikethrough *regexp.Regexp
	mathBlock     *regexp.Regexp
	mathInline    *regexp.Regexp
	hr            *regexp.Regexp
}

var getStripRegexes = sync.OnceValue(func() *stripRegexes {
	return &stripRegexes{
		fencedCode:    regexp.MustCompile("(?s)```[a-zA-Z0-9_-]*\n(.*?)\n```"),
		inlineCode:    regexp.MustCompile("`([^`]+)`"),
		images:        regexp.MustCompile(`!\[([^\]]*)\]\([^)]+\)`),
		links:         regexp.MustCompile(`\[([^\]]+)\]\([^)]+\)`),
		headers:       regexp.MustCompile(`(?m)^#{1,6}\s+`),
		blockquote:    regexp.MustCompile(`(?m)^>\s*`),
		listTasks:     regexp.MustCompile(`(?m)^[\s*\-+]*\[[ xX]\]\s+`),
		listBulleted:  regexp.MustCompile(`(?m)^[\s]*[-*+]\s+`),
		listNumbered:  regexp.MustCompile(`(?m)^[\s]*\d+\.\s+`),
		boldAsterisk:  regexp.MustCompile(`\*\*([^*]+)\*\*`),
		boldUnder:     regexp.MustCompile(`__([^_]+)__`),
		italicAster:   regexp.MustCompile(`\*([^*]+)\*`),
		italicUnder:   regexp.MustCompile(`_([^_]+)_`),
		strikethrough: regexp.MustCompile(`~~(.*?)~~`),
		mathBlock:     regexp.MustCompile(`(?s)\$\$(.*?)\$\$`),
		mathInline:    regexp.MustCompile(`\$([^$\n]+)\$`),
		hr:            regexp.MustCompile(`(?m)^[-*_]{3,}\s*$`),
	}
})

// StripMarkdown converts markdown text to clean plain text without formatting symbols.
func StripMarkdown(md string) string {
	re := getStripRegexes()
	text := md

	// 1. Math block & inline
	text = re.mathBlock.ReplaceAllString(text, "$1")
	text = re.mathInline.ReplaceAllString(text, "$1")

	// 2. Fenced Code Blocks (preserve content, remove ```)
	text = re.fencedCode.ReplaceAllString(text, "$1")

	// 3. Inline code
	text = re.inlineCode.ReplaceAllString(text, "$1")

	// 4. Images ![alt](url) -> alt
	text = re.images.ReplaceAllString(text, "$1")

	// 5. Links [text](url) -> text
	text = re.links.ReplaceAllString(text, "$1")

	// 6. Headers # -> remove #
	text = re.headers.ReplaceAllString(text, "")

	// 7. Blockquotes > -> remove >
	text = re.blockquote.ReplaceAllString(text, "")

	// 8. Task lists and list markers
	text = re.listTasks.ReplaceAllString(text, "")
	text = re.listBulleted.ReplaceAllString(text, "")
	text = re.listNumbered.ReplaceAllString(text, "")

	// 9. Bold & Italic & Strikethrough
	text = re.boldAsterisk.ReplaceAllString(text, "$1")
	text = re.boldUnder.ReplaceAllString(text, "$1")
	text = re.italicAster.ReplaceAllString(text, "$1")
	text = re.italicUnder.ReplaceAllString(text, "$1")
	text = re.strikethrough.ReplaceAllString(text, "$1")

	// 10. Horizontal Rules
	text = re.hr.ReplaceAllString(text, "")

	return strings.TrimSpace(text) + "\n"
}
