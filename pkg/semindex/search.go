package semindex

import (
	"context"
	"errors"
	"fmt"
	"math"
	"path"
	"runtime"
	"sort"
	"strings"
	"sync"
	"unicode"

	"md-memo/pkg/embed"
	"md-memo/pkg/lazyre"
)

// ErrEmpty means there is nothing in the index to search.
var ErrEmpty = errors.New("the semantic index is empty; build it first (md-memo scrap index)")

// ErrModelMismatch means the index was made with another model than the one configured now (the vectors would not be comparable).
var ErrModelMismatch = errors.New("the semantic index was made with another model; rebuild it (md-memo scrap index --rebuild)")

// SearchOptions of Search.
type SearchOptions struct {
	Limit int // hits to return (default 10); one hit per entry (note) of a scrap
	// Since and Until bound the date of the file (YYYY-MM-DD, inclusive; either may be empty). A chunk of a file that has no date in its
	// name does not pass a bound.
	Since, Until string
	// Kinds restricts the chunk kinds (KindNote, KindLog); empty = notes and logs, the logs ranked a little lower.
	Kinds []string
	// Path is a path.Match pattern for the file's path inside the scrap folder, or for its name.
	Path string
	// Weight of the lexical score next to the cosine (the design's best: 0.05). 0 = the default; use a negative number for none.
	Weight float64
	// LogPenalty is taken off the score of a piped log (default 0.05; negative = none).
	LogPenalty float64
	// ContextChars bounds the Context of a hit (default 1200).
	ContextChars int
	// LexNorm says what the lexical score is divided by: "idf" (the default: the score a chunk would get by holding every token of
	// the query once, so a chunk that shares only common words with the query gets next to nothing) or "max" (the best score among
	// the candidates, so the best chunk always gets the whole weight). "max" was the first design; on notes written in two languages
	// it lifted every chunk that shared common words of the query's language and pushed a right note in the other language down
	// (hit@1 0.79 to 0.57 for English questions, 0.77 to 0.45 for English questions finding Japanese notes), see
	// docs/design/semantic-search-2026-10.md section 15. tools/semindex-eval compares the two.
	LexNorm string
	// Keep, when set, is asked about every chunk that passed the filters above before it is scored; a chunk it rejects is not a
	// candidate. rel is the file's path in the index (with "/" separators) and line the chunk's first line. It is how the tag filter of
	// the command line and the window reaches the index; nil lets everything through. It is called one chunk after the other on the
	// goroutine that called Search, so it may keep a cache without a lock.
	Keep func(rel string, line int) bool
}

// Hit is one note that matched.
type Hit struct {
	Rel     string  `json:"rel"`
	Entry   int     `json:"entry"`
	Line    int     `json:"line"` // of the best chunk
	EndLine int     `json:"end_line"`
	Date    string  `json:"date,omitempty"`
	Heading string  `json:"heading,omitempty"`
	Kind    string  `json:"kind"`
	Score   float64 `json:"score"`
	Cosine  float64 `json:"cosine"`
	Lexical float64 `json:"lexical"`
	Text    string  `json:"text"`    // the best chunk
	Context string  `json:"context"` // the chunks of the same entry, in order
}

// SearchInfo says how much was searched.
type SearchInfo struct {
	Chunks     int // live chunks in the index
	Candidates int // chunks left after the filters
}

func (o SearchOptions) weight() float64 {
	switch {
	case o.Weight < 0:
		return 0
	case o.Weight == 0:
		return 0.05
	}
	return o.Weight
}

func (o SearchOptions) logPenalty() float64 {
	switch {
	case o.LogPenalty < 0:
		return 0
	case o.LogPenalty == 0:
		return 0.05
	}
	return o.LogPenalty
}

func (o SearchOptions) kindOK(kind string) bool {
	if len(o.Kinds) == 0 {
		return kind == KindNote || kind == KindLog
	}
	for _, k := range o.Kinds {
		if k == kind {
			return true
		}
	}
	return false
}

func (o SearchOptions) passes(m meta) bool {
	if !o.kindOK(m.Kind) {
		return false
	}
	if o.Since != "" && (m.Date == "" || m.Date < o.Since) {
		return false
	}
	if o.Until != "" && (m.Date == "" || m.Date > o.Until) {
		return false
	}
	if o.Path != "" {
		okFull, _ := path.Match(o.Path, m.Rel)
		okBase, _ := path.Match(o.Path, path.Base(m.Rel))
		if !okFull && !okBase {
			return false
		}
	}
	if o.Keep != nil && !o.Keep(m.Rel, m.Line) {
		return false
	}
	return true
}

// parallel runs fn over [0,n) in slices on all cores.
func parallel(n int, fn func(from, to int)) {
	workers := runtime.NumCPU()
	if workers > n {
		workers = n
	}
	if workers < 2 {
		fn(0, n)
		return
	}
	var wg sync.WaitGroup
	step := (n + workers - 1) / workers
	for from := 0; from < n; from += step {
		to := from + step
		if to > n {
			to = n
		}
		wg.Add(1)
		go func(from, to int) {
			defer wg.Done()
			fn(from, to)
		}(from, to)
	}
	wg.Wait()
}

var asciiWord = lazyre.New(`[a-z0-9._-]+`)

// queryTokens are what the lexical score looks for: every pair of neighbouring characters of the query (white space taken out, so a
// pair may span two words) and every Latin word of two or more characters. Character pairs make Japanese work without a tokenizer.
func queryTokens(q string) []string {
	low := strings.ToLower(q)
	seen := map[string]bool{}
	var out []string
	add := func(t string) {
		if !seen[t] {
			seen[t] = true
			out = append(out, t)
		}
	}
	for _, w := range asciiWord.FindAllString(low, -1) {
		if len(w) > 1 && len(out) < maxLexicalWords {
			add(w)
		}
	}
	rs := []rune(strings.Map(func(r rune) rune {
		if unicode.IsSpace(r) {
			return -1
		}
		return r
	}, low))
	var pairs []string
	seenPair := map[string]bool{}
	for i := 0; i+1 < len(rs); i++ {
		if p := string(rs[i : i+2]); !seen[p] && !seenPair[p] {
			seenPair[p] = true
			pairs = append(pairs, p)
		}
	}
	// The lexical score costs (tokens x chunks): a pasted page must not make a search take seconds. Beyond the cap the pairs are taken
	// at even steps through the whole text, so the end of a long query counts as much as its start.
	room := maxLexicalTokens - len(out)
	if len(pairs) > room {
		for i := 0; i < room; i++ {
			add(pairs[i*len(pairs)/room])
		}
		return out
	}
	for _, p := range pairs {
		add(p)
	}
	return out
}

const (
	// maxLexicalTokens bounds the tokens of the lexical score; a query of up to about 120 characters is not affected.
	maxLexicalTokens = 128
	// maxLexicalWords bounds how many of them are Latin words (identifiers such as an IP address come first and are never crowded out).
	maxLexicalWords = 32
)

func squash(s string) string {
	return strings.Map(func(r rune) rune {
		if unicode.IsSpace(r) {
			return -1
		}
		return r
	}, strings.ToLower(s))
}

// Search finds the notes closest in meaning to query: the query is embedded (as a Query) with emb, which must be the model the index
// was made with; every chunk's score is its cosine similarity plus a small share of a character-overlap (BM25) score; the best chunk of
// each entry stands for the entry. See docs/design/semantic-search-2026-10.md section 2 for the numbers behind the weight.
func Search(ctx context.Context, indexDir string, emb embed.Embedder, query string, opts SearchOptions) ([]Hit, SearchInfo, error) {
	var info SearchInfo
	if strings.TrimSpace(query) == "" {
		return nil, info, errors.New("search text required")
	}
	store, err := OpenStore(indexDir)
	if err != nil {
		return nil, info, err
	}
	if store.Empty() {
		return nil, info, ErrEmpty
	}
	if store.m.Embedder != emb.ID() {
		return nil, info, ErrModelMismatch
	}
	info.Chunks = store.liveCount()
	vecs, err := store.LoadVectors()
	if err != nil {
		return nil, info, err
	}
	qvs, err := emb.Embed(ctx, embed.Query, []embed.Input{{Text: query}})
	if err != nil {
		return nil, info, err
	}
	if len(qvs) != 1 || len(qvs[0]) != store.m.Dim {
		return nil, info, fmt.Errorf("the model gave a vector of %d numbers for the query; the index holds %d", func() int {
			if len(qvs) == 1 {
				return len(qvs[0])
			}
			return 0
		}(), store.m.Dim)
	}
	q := qvs[0]
	dim := store.m.Dim

	// the candidates
	var cand []int
	for i, m := range store.metas {
		if !store.dead[i] && opts.passes(m) {
			cand = append(cand, i)
		}
	}
	info.Candidates = len(cand)
	if len(cand) == 0 {
		return nil, info, nil
	}

	// cosine (the vectors are normalized, so a dot product)
	cos := make([]float64, len(cand))
	parallel(len(cand), func(from, to int) {
		for ci := from; ci < to; ci++ {
			v := vecs[store.metas[cand[ci]].V*dim : (store.metas[cand[ci]].V+1)*dim]
			var s float32
			for k := range v {
				s += v[k] * q[k]
			}
			cos[ci] = float64(s)
		}
	})
	if err := ctx.Err(); err != nil {
		return nil, info, err
	}

	// lexical: BM25 over the query's tokens, computed on the candidates
	toks := queryTokens(query)
	lex := make([]float64, len(cand))
	if w := opts.weight(); w > 0 && len(toks) > 0 {
		tf := make([][]int32, len(cand))
		lens := make([]int, len(cand))
		parallel(len(cand), func(from, to int) {
			for ci := from; ci < to; ci++ {
				m := store.metas[cand[ci]]
				low := strings.ToLower(m.Text)
				sq := squash(m.Text)
				lens[ci] = len([]rune(sq))
				row := make([]int32, len(toks))
				for ti, t := range toks {
					if len(t) > 1 && asciiWord.MatchString(t) && len([]rune(t)) == len(t) {
						row[ti] = int32(strings.Count(low, t))
					} else {
						row[ti] = int32(strings.Count(sq, t))
					}
				}
				tf[ci] = row
			}
		})
		df := make([]int, len(toks))
		total := 0
		for ci := range cand {
			total += lens[ci]
			for ti, c := range tf[ci] {
				if c > 0 {
					df[ti]++
				}
			}
		}
		avg := float64(total) / float64(len(cand))
		n := float64(len(cand))
		maxLex := 0.0
		idfSum := 0.0
		for ti := range toks {
			idfSum += math.Log(1 + (n-float64(df[ti])+0.5)/(float64(df[ti])+0.5))
		}
		for ci := range cand {
			s := 0.0
			for ti, c := range tf[ci] {
				if c == 0 {
					continue
				}
				idf := math.Log(1 + (n-float64(df[ti])+0.5)/(float64(df[ti])+0.5))
				f := float64(c)
				s += idf * f * 2.2 / (f + 1.2*(0.25+0.75*float64(lens[ci])/avg))
			}
			lex[ci] = s
			if s > maxLex {
				maxLex = s
			}
		}
		denom := idfSum
		if opts.LexNorm == "max" {
			denom = maxLex
		}
		if denom > 0 {
			for ci := range lex {
				lex[ci] /= denom
			}
		}
	}

	// the best chunk of each entry
	type key struct {
		rel   string
		entry int
	}
	best := map[key]int{} // -> index into cand
	scoreOf := func(ci int) float64 {
		s := cos[ci] + opts.weight()*lex[ci]
		if store.metas[cand[ci]].Kind == KindLog {
			s -= opts.logPenalty()
		}
		return s
	}
	for ci := range cand {
		m := store.metas[cand[ci]]
		k := key{m.Rel, m.Entry}
		if b, ok := best[k]; !ok || scoreOf(ci) > scoreOf(b) {
			best[k] = ci
		}
	}
	order := make([]int, 0, len(best))
	for _, ci := range best {
		order = append(order, ci)
	}
	sort.Slice(order, func(a, b int) bool {
		sa, sb := scoreOf(order[a]), scoreOf(order[b])
		if sa != sb {
			return sa > sb
		}
		ma, mb := store.metas[cand[order[a]]], store.metas[cand[order[b]]]
		if ma.Rel != mb.Rel {
			return ma.Rel > mb.Rel // newer day first on a tie
		}
		return ma.Line < mb.Line
	})
	limit := opts.Limit
	if limit <= 0 {
		limit = 10
	}
	if len(order) > limit {
		order = order[:limit]
	}

	// the entries of the hits, to give each hit its surroundings
	want := map[key]bool{}
	for _, ci := range order {
		m := store.metas[cand[ci]]
		want[key{m.Rel, m.Entry}] = true
	}
	ctxMax := opts.ContextChars
	if ctxMax <= 0 {
		ctxMax = 1200
	}
	parts := map[key][]meta{}
	for i, m := range store.metas {
		if store.dead[i] {
			continue
		}
		if k := (key{m.Rel, m.Entry}); want[k] {
			parts[k] = append(parts[k], m)
		}
	}
	hits := make([]Hit, 0, len(order))
	for _, ci := range order {
		m := store.metas[cand[ci]]
		ps := parts[key{m.Rel, m.Entry}]
		sort.Slice(ps, func(a, b int) bool { return ps[a].Line < ps[b].Line })
		var sb strings.Builder
		for _, p := range ps {
			if sb.Len() > 0 {
				sb.WriteString("\n")
			}
			sb.WriteString(p.Text)
		}
		context := sb.String()
		if rs := []rune(context); len(rs) > ctxMax {
			context = string(rs[:ctxMax])
		}
		hits = append(hits, Hit{
			Rel: m.Rel, Entry: m.Entry, Line: m.Line, EndLine: m.EndLine, Date: m.Date, Heading: m.Heading, Kind: m.Kind,
			Score: round4(scoreOf(ci)), Cosine: round4(cos[ci]), Lexical: round4(lex[ci]), Text: m.Text, Context: context,
		})
	}
	return hits, info, nil
}

func round4(x float64) float64 { return math.Round(x*10000) / 10000 }
