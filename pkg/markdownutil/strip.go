package markdownutil

import (
	"regexp"
	"strings"
)

var (
	reFencedCode    = regexp.MustCompile("(?s)```[a-zA-Z0-9_-]*\n(.*?)\n```")
	reInlineCode    = regexp.MustCompile("`([^`]+)`")
	reImages        = regexp.MustCompile(`!\[([^\]]*)\]\([^)]+\)`)
	reLinks         = regexp.MustCompile(`\[([^\]]+)\]\([^)]+\)`)
	reHeaders       = regexp.MustCompile(`(?m)^#{1,6}\s+`)
	reBlockquote    = regexp.MustCompile(`(?m)^>\s*`)
	reListTasks     = regexp.MustCompile(`(?m)^[\s*\-+]*\[[ xX]\]\s+`)
	reListBulleted  = regexp.MustCompile(`(?m)^[\s]*[-*+]\s+`)
	reListNumbered  = regexp.MustCompile(`(?m)^[\s]*\d+\.\s+`)
	reBoldAsterisk  = regexp.MustCompile(`\*\*([^*]+)\*\*`)
	reBoldUnder     = regexp.MustCompile(`__([^_]+)__`)
	reItalicAster   = regexp.MustCompile(`\*([^*]+)\*`)
	reItalicUnder   = regexp.MustCompile(`_([^_]+)_`)
	reStrikethrough = regexp.MustCompile(`~~(.*?)~~`)
	reMathBlock     = regexp.MustCompile(`(?s)\$\$(.*?)\$\$`)
	reMathInline    = regexp.MustCompile(`\$([^$\n]+)\$`)
	reHR            = regexp.MustCompile(`(?m)^[-*_]{3,}\s*$`)
)

// StripMarkdown converts markdown text to clean plain text without formatting symbols.
func StripMarkdown(md string) string {
	text := md

	// 1. Math block & inline
	text = reMathBlock.ReplaceAllString(text, "$1")
	text = reMathInline.ReplaceAllString(text, "$1")

	// 2. Fenced Code Blocks (preserve content, remove ```)
	text = reFencedCode.ReplaceAllString(text, "$1")

	// 3. Inline code
	text = reInlineCode.ReplaceAllString(text, "$1")

	// 4. Images ![alt](url) -> alt
	text = reImages.ReplaceAllString(text, "$1")

	// 5. Links [text](url) -> text
	text = reLinks.ReplaceAllString(text, "$1")

	// 6. Headers # -> remove #
	text = reHeaders.ReplaceAllString(text, "")

	// 7. Blockquotes > -> remove >
	text = reBlockquote.ReplaceAllString(text, "")

	// 8. Task lists and list markers
	text = reListTasks.ReplaceAllString(text, "")
	text = reListBulleted.ReplaceAllString(text, "")
	text = reListNumbered.ReplaceAllString(text, "")

	// 9. Bold & Italic & Strikethrough
	text = reBoldAsterisk.ReplaceAllString(text, "$1")
	text = reBoldUnder.ReplaceAllString(text, "$1")
	text = reItalicAster.ReplaceAllString(text, "$1")
	text = reItalicUnder.ReplaceAllString(text, "$1")
	text = reStrikethrough.ReplaceAllString(text, "$1")

	// 10. Horizontal Rules
	text = reHR.ReplaceAllString(text, "")

	return strings.TrimSpace(text) + "\n"
}
