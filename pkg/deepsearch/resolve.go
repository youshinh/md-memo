package deepsearch

import (
	"strconv"
	"strings"
	"unicode"

	"md-memo/pkg/lazyre"
)

// Resolved is the model's answer with its citation numbers checked and its quotations checked.
type Resolved struct {
	Markdown      string
	Cited         map[int]bool // the source numbers the answer cites
	Verified      int          // quotations found in the source they cite
	Unverified    int          // quotations that are not (marked in the text)
	InvalidRefs   int          // citations of a number that is not a source
	StrippedLinks int          // links and addresses the model wrote itself, taken out
}

// citation is [1], [1, 2] or [1、2]: one to three digits each.
var (
	citationRE = lazyre.New(`\[\s*\d{1,3}(?:\s*[,、，]\s*\d{1,3})*\s*\]`)
	trailingRE = lazyre.New(`(?:\s*\[\s*\d{1,3}(?:\s*[,、，]\s*\d{1,3})*\s*\])+\s*$`)
	mdLinkRE   = lazyre.New(`\[([^\]]*)\]\(([^)\s]*)[^)]*\)`)
	bareURLRE  = lazyre.New(`(?i)\b(?:https?|file)://[^\s)<>\]]+`)
	numberRE   = lazyre.New(`\d{1,3}`)
	elideRE    = lazyre.New(`…|\.{3}|\[\.\.\.\]`)
	// a time in square brackets, as a note's heading has it ("## [10:12:40] ..."): what a small model sometimes writes where the number
	// of its source belongs
	timeTailRE    = lazyre.New(`\s*\[\d{1,2}:\d{2}(?::\d{2})?\]\s*$`)
	bracketTimeRE = lazyre.New(`\[(\d{1,2}:\d{2}(?::\d{2})?)\]`)
)

// forModel is a source's text as the model is sent it, and as a quotation of it is checked: a time in square brackets becomes one in
// parentheses, so that it cannot be taken for the number of a source.
func forModel(text string) string { return bracketTimeRE.ReplaceAllString(text, "($1)") }

// Resolve makes the model's answer ready to be a note. The model was told to cite sources by number and never to write an address,
// and cannot be trusted either way, so: a link or an address it wrote that is not in the sources is taken out (keeping its text); every
// quotation (a line after "> ") is looked for in the text of the sources it cites, and one that is not there is marked "(unverified)"
// ("(未検証)"); and every [n] is kept only when it names a source that was sent (a number that is no source is dropped and counted); the
// list of sources, with a link to each file, is Compose's. Sentences with no citation are left as they are: they cannot be checked, only seen.
func Resolve(answer string, sources []Source, lang string) Resolved {
	res := Resolved{Cited: map[int]bool{}}
	text := strings.ReplaceAll(strings.TrimSpace(answer), "\r\n", "\n")
	text = unfence(text)

	// 1. addresses the model wrote: kept only when a source holds the very same address
	known := func(url string) bool {
		for _, s := range sources {
			if strings.Contains(s.Text, url) {
				return true
			}
		}
		return false
	}
	text = mdLinkRE.ReplaceAllStringFunc(text, func(m string) string {
		sub := mdLinkRE.FindStringSubmatch(m)
		if sub[2] != "" && known(sub[2]) {
			return m
		}
		res.StrippedLinks++
		return sub[1]
	})
	text = bareURLRE.ReplaceAllStringFunc(text, func(m string) string {
		if known(m) {
			return m
		}
		res.StrippedLinks++
		return ""
	})

	// 2. quotations: each "> ..." line against the sources it cites
	unverified := "(unverified)"
	if lang == "ja" {
		unverified = "(未検証)"
	}
	lines := strings.Split(text, "\n")
	for i, l := range lines {
		t := strings.TrimSpace(l)
		if !strings.HasPrefix(t, ">") {
			continue
		}
		quote := strings.TrimSpace(strings.TrimPrefix(t, ">"))
		cites := []int{}
		if loc := trailingRE.FindStringIndex(quote); loc != nil {
			for _, d := range numberRE.FindAllString(quote[loc[0]:], -1) {
				n, _ := strconv.Atoi(d)
				cites = append(cites, n)
			}
			quote = strings.TrimSpace(quote[:loc[0]])
		} else if loc := timeTailRE.FindStringIndex(quote); loc != nil {
			quote = strings.TrimSpace(quote[:loc[0]]) // a time where the number of the source belongs: no citation at all
		}
		stripped := quote
		inferred := 0
		quote = strings.Trim(quote, "「」『』\"“”'‘’ ")
		frags := fragments(quote)
		if len(frags) == 0 {
			continue // too short to say anything about
		}
		if len(cites) == 0 {
			// No citation: the quotation is still right when a source holds it word for word, and then that source is the citation.
			for n := 1; n <= len(sources) && inferred == 0; n++ {
				held := norm(forModel(sources[n-1].Text))
				all := true
				for _, f := range frags {
					all = all && strings.Contains(held, f)
				}
				if all {
					inferred = n
				}
			}
			if inferred > 0 {
				cites = []int{inferred}
			}
		}
		ok := len(cites) > 0
		for _, f := range frags {
			found := false
			for _, n := range cites {
				if n >= 1 && n <= len(sources) && strings.Contains(norm(forModel(sources[n-1].Text)), f) {
					found = true
					break
				}
			}
			ok = ok && found
		}
		if ok {
			res.Verified++
			if inferred > 0 { // the line gets the citation it lacked (and loses a time that stood in its place)
				lines[i] = "> " + stripped + " [" + strconv.Itoa(inferred) + "]"
			}
		} else {
			res.Unverified++
			lines[i] = strings.TrimRight(l, " ") + " " + unverified
		}
	}
	text = strings.Join(lines, "\n")

	// 3. every [n] stays a bare marker (a number that is no source goes). The links are in the list of sources, which Compose writes under
	// the answer, where the number names the line: written after every claim, an address is a path of 100 characters, and the note, which
	// is read as plain text in the editor, would be mostly addresses (the preview does not draw a file: link either)
	var sb strings.Builder
	last := 0
	for _, loc := range citationRE.FindAllStringIndex(text, -1) {
		if loc[1] < len(text) && text[loc[1]] == '(' { // [1](address): a link label, not a citation (step 1 left only known ones)
			continue
		}
		sb.WriteString(text[last:loc[0]])
		last = loc[1]
		for _, d := range numberRE.FindAllString(text[loc[0]:loc[1]], -1) {
			n, _ := strconv.Atoi(d)
			if n < 1 || n > len(sources) {
				res.InvalidRefs++
				continue
			}
			res.Cited[n] = true
			sb.WriteString("[" + strconv.Itoa(n) + "]")
		}
	}
	sb.WriteString(text[last:])
	res.Markdown = sb.String()
	return res
}

// unfence takes the code fence off an answer that is wholly inside one (models like to wrap Markdown in ```markdown).
func unfence(s string) string {
	if !strings.HasPrefix(s, "```") || !strings.HasSuffix(s, "```") || strings.Count(s, "```") != 2 {
		return s
	}
	inner := strings.TrimPrefix(s, "```")
	if nl := strings.Index(inner, "\n"); nl >= 0 && !strings.ContainsAny(inner[:nl], " \t") {
		inner = inner[nl+1:] // the language word
	}
	return strings.TrimSpace(strings.TrimSuffix(inner, "```"))
}

// fragments are the pieces of a quotation that must be found in a source: the quotation split where it elides ("..."), each piece
// of at least four characters, normalised (norm). A quotation with no such piece is too short to check.
func fragments(q string) []string {
	var out []string
	for _, p := range elideRE.Split(q, -1) {
		if n := norm(p); len([]rune(n)) >= 4 {
			out = append(out, n)
		}
	}
	return out
}

// norm makes two texts comparable: lower case, no white space, no Markdown emphasis or code marks (a model copies the words, not the
// stars around them).
func norm(s string) string {
	var sb strings.Builder
	for _, r := range strings.ToLower(s) {
		if unicode.IsSpace(r) || r == '*' || r == '`' {
			continue
		}
		sb.WriteRune(r)
	}
	return sb.String()
}
