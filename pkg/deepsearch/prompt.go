package deepsearch

import (
	"fmt"
	"strings"
	"unicode"
)

// DetectLang is "ja" when the text has Japanese in it (kana or kanji), else "en": the language the answer and the headings of the note
// are written in.
func DetectLang(text string) string {
	for _, r := range text {
		if unicode.Is(unicode.Hiragana, r) || unicode.Is(unicode.Katakana, r) || unicode.Is(unicode.Han, r) {
			return "ja"
		}
	}
	return "en"
}

// EstimateTokens is a rough size of a text in tokens: a Japanese character is about two thirds of a token (bge-m3 and the common
// models count 1.5 to 1.9 characters per token), a Latin one a quarter. It is for showing a size before sending and for the context
// window asked of a local model, not for billing.
func EstimateTokens(text string) int {
	cjk, other := 0, 0
	for _, r := range text {
		switch {
		case r < 0x250:
			other++
		default:
			cjk++
		}
	}
	return int(float64(cjk)/1.5) + other/4 + 1
}

// Heading words of the evidence section, in the two languages; Resolve and Compose know them.
const (
	evidenceJA = "根拠"
	evidenceEN = "Evidence"
)

// BuildPrompt is what the model is sent: the rules, the numbered sources, the question. The rules ask for the shape Resolve reads:
// every statement of fact ends with the numbers of its sources in square brackets, no URL, no file name, and a few quotations copied
// word for word, one per line after "> ".
func BuildPrompt(query string, sources []Source, lang string) string {
	answerIn, evidence := "English", evidenceEN
	if lang == "ja" {
		answerIn, evidence = "Japanese", evidenceJA
	}
	var sb strings.Builder
	sb.WriteString("You answer a question using ONLY the user's own notes, given below as numbered sources.\n\nRules:\n")
	fmt.Fprintf(&sb, "1. Write the answer in %s. Be concise and concrete.\n", answerIn)
	sb.WriteString("2. End every sentence that states a fact with the number of the source it comes from, in square brackets: [1] or [2][5]. " +
		"Use only the numbers of the sources below. Never write a URL, a file name or a path. " +
		"Cite each sentence with the sources of THAT sentence only, not all of them at the end; the shape (the numbers are only an illustration): " +
		"\"The delivery was agreed for the end of next month [2]. The drawings are due on the 10th [1][3].\"\n")
	fmt.Fprintf(&sb, "3. After the answer add a section titled \"## %s\" with at most 5 quotations. Each quotation is one line that starts with \"> \", "+
		"is copied word for word from a single source (at most 160 characters, nothing changed or translated) and ends with that source's number in brackets, like: > copied text [2]\n", evidence)
	sb.WriteString("4. The notes have dates in their headings, and the sources are numbered oldest first. When sources disagree, or one replaces another, say which is newer. " +
		"When the question asks what happened, or for a history, answer in date order and name the dates.\n")
	sb.WriteString("5. Sources that do not help are ignored; do not mention them.\n")
	sb.WriteString("6. If the sources do not answer the question, say so in one sentence and say what they do contain. " +
		"Do not guess, and do not use anything from outside the sources.\n\nSources:\n")
	for _, s := range sources {
		// no square brackets in the label ("2026-08-26 [10:12:40] ..."): a small model copies them as if they were citations
		fmt.Fprintf(&sb, "\n[%d] %s\n%s\n", s.N, SafeLabel(s.Label), strings.TrimSpace(forModel(s.Text)))
	}
	fmt.Fprintf(&sb, "\nQuestion: %s\n", strings.TrimSpace(query))
	return sb.String()
}

func oneLine(s string) string { return strings.Join(strings.Fields(s), " ") }
