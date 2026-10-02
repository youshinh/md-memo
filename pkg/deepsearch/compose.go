package deepsearch

import (
	"fmt"
	"strings"
	"time"
	"unicode/utf8"

	"md-memo/pkg/scrap"
)

// Meta is what the foot of the note says about how it was made.
type Meta struct {
	Query       string
	Lang        string // "ja" or "en"
	Model       string
	When        time.Time
	Semantic    bool // the sources came from the semantic search (false: from the word search)
	SourcesSent int
	TotalChars  int
	Masked      int
}

// headingChars is how much of the question the heading of the note holds.
const headingChars = 60

// SafeLabel is a link label the editor can read: its link pattern ends a label at the first "]", so no brackets (they become
// parentheses), and one line.
func SafeLabel(s string) string {
	s = strings.NewReplacer("[", "(", "]", ")").Replace(strings.Join(strings.Fields(s), " "))
	if strings.TrimSpace(s) == "" {
		return "note"
	}
	return s
}

// Title is the name of the tab a deep search opens: no character a file name cannot have, so that Save As starts from a good name.
func Title(query, lang string) string {
	q := strings.Join(strings.Fields(query), " ")
	q = strings.Map(func(r rune) rune {
		if strings.ContainsRune(`\/:*?"<>|`, r) || r < 0x20 {
			return ' '
		}
		return r
	}, q)
	q = strings.Join(strings.Fields(q), " ")
	if utf8.RuneCountInString(q) > 40 {
		q = string([]rune(q)[:40]) + "…"
	}
	if lang == "ja" {
		return "深掘り " + q
	}
	return "Deep search " + q
}

// Compose lays the note out: the mark that keeps it out of the search index, a heading with the question, the resolved answer, the
// list of the sources (with the lines of each excerpt, and a word on those the answer did not use) and a foot that says how it was
// made. The links are the sources' file addresses; a link opens the file (not a line, so the lines are written beside it).
func Compose(res Resolved, sources []Source, m Meta) string {
	ja := m.Lang == "ja"
	var sb strings.Builder
	sb.WriteString(scrap.DeepSearchMarker + "\n")
	// A question of a few sentences is not a heading: the first words are, and the whole question follows on a line of its own.
	query := oneLine(m.Query)
	short := query
	if rs := []rune(query); len(rs) > headingChars {
		short = string(rs[:headingChars]) + "…"
	}
	if ja {
		fmt.Fprintf(&sb, "# 深掘り: %s\n\n", short)
	} else {
		fmt.Fprintf(&sb, "# Deep search: %s\n\n", short)
	}
	if short != query {
		if ja {
			fmt.Fprintf(&sb, "質問: %s\n\n", query)
		} else {
			fmt.Fprintf(&sb, "Question: %s\n\n", query)
		}
	}
	sb.WriteString(strings.TrimSpace(res.Markdown) + "\n\n")

	if ja {
		sb.WriteString("## 出典\n\n")
	} else {
		sb.WriteString("## Sources\n\n")
	}
	for _, s := range sources {
		label := SafeLabel(s.Label)
		link := label
		if s.URL != "" {
			link = "[" + label + "](" + s.URL + ")"
		}
		var lines string
		switch {
		case s.StartLine <= 0:
		case ja && s.StartLine == s.EndLine:
			lines = fmt.Sprintf(" — %d 行目", s.StartLine)
		case ja:
			lines = fmt.Sprintf(" — %d〜%d 行目", s.StartLine, s.EndLine)
		case s.StartLine == s.EndLine:
			lines = fmt.Sprintf(" — line %d", s.StartLine)
		default:
			lines = fmt.Sprintf(" — lines %d-%d", s.StartLine, s.EndLine)
		}
		note := ""
		if !res.Cited[s.N] {
			if ja {
				note = "（本文では使われていません）"
			} else {
				note = " (not used in the answer)"
			}
		}
		fmt.Fprintf(&sb, "%d. %s%s%s\n", s.N, link, lines, note)
	}

	when := m.When.Format("2006-01-02 15:04")
	how := "word search"
	if m.Semantic {
		how = "semantic search"
	}
	sb.WriteString("\n---\n")
	if ja {
		if m.Semantic {
			how = "意味検索"
		} else {
			how = "単語の検索"
		}
		fmt.Fprintf(&sb, "作成: %s ・ モデル: %s ・ %s ・ 送った出典 %d 件、約 %d 文字", when, m.Model, how, m.SourcesSent, m.TotalChars)
		if m.Masked > 0 {
			fmt.Fprintf(&sb, " ・ 秘密と思われるもの %d 件を伏せ字", m.Masked)
		}
		if res.Unverified > 0 {
			fmt.Fprintf(&sb, " ・ 原文で確認できなかった引用 %d 件", res.Unverified)
		}
	} else {
		fmt.Fprintf(&sb, "Made: %s · model: %s · %s · %d sources sent, about %d characters", when, m.Model, how, m.SourcesSent, m.TotalChars)
		if m.Masked > 0 {
			fmt.Fprintf(&sb, " · %d possible secrets masked", m.Masked)
		}
		if res.Unverified > 0 {
			fmt.Fprintf(&sb, " · %d quotations not found in the notes", res.Unverified)
		}
	}
	sb.WriteString("\n")
	return sb.String()
}
