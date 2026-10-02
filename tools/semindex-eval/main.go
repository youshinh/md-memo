// Command semindex-eval measures the semantic search (pkg/semindex) on synthetic scraps whose answers are known: how often the right
// note is first (hit@1), among the first five (hit@5), how many of the right notes are in the first ten (recall@10), and the mean
// reciprocal rank (MRR), for several chunk sizes, with and without the date-and-heading header, and for several weights of the
// lexical score. See README.md; the numbers it prints are the ones in docs/design/semantic-search-2026-10.md section 2.
//
//	node gen.mjs ./data/scraps 300          # writes the scraps and ./data/truth.json
//	go run ./tools/semindex-eval -scraps tools/semindex-eval/data/scraps
//
// It talks to the model named by -base and -model (Ollama by default, on this machine). Synthetic notes only; nothing of yours is read.
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"md-memo/pkg/embed"
	"md-memo/pkg/semindex"
)

type truth struct {
	Lang string `json:"lang"` // "ja", "en" or "mixed": which corpus gen.mjs made
	// EntryLang is the language each entry that holds a right answer was written in (only entries with an answer are listed).
	EntryLang map[string]string `json:"entryLang"`
	Queries   []struct {
		Q    string   `json:"q"`
		Type string   `json:"type"`
		Lang string   `json:"lang"` // "ja", "en" or "mix" (a Japanese sentence with English terms in it); empty in old data = "ja"
		Rel  []string `json:"rel"`
	} `json:"queries"`
}

// groupOf names the table a query's result goes in.
func groupOf(typ, lang string) string {
	if typ == "identifier" {
		return "identifier"
	}
	if lang == "" {
		lang = "ja"
	}
	return "semantic " + lang
}

// crossGroup is the table of the cross-language test: a Japanese question that must find the English notes of the same facts, and the
// other way round. The right notes written in the question's own language are taken out of the ranking and out of the answers, so
// that only an answer in the other language can score.
func crossGroup(lang string) string {
	switch lang {
	case "ja":
		return "cross ja>en"
	case "en":
		return "cross en>ja"
	}
	return ""
}

func crossRanking(rank, rel []string, qLang string, entryLang map[string]string) (r, relOther []string) {
	isRel := map[string]bool{}
	for _, id := range rel {
		isRel[id] = true
		if entryLang[id] != qLang {
			relOther = append(relOther, id)
		}
	}
	for _, id := range rank {
		if isRel[id] && entryLang[id] == qLang {
			continue
		}
		r = append(r, id)
	}
	return r, relOther
}

// groupOrder is the order the tables are printed in.
var groupOrder = []string{"semantic ja", "semantic en", "semantic mix", "identifier", "cross ja>en", "cross en>ja"}

// queryCache remembers the vector of each query text, so that trying several weights costs one model call per query.
type queryCache struct {
	embed.Embedder
	mu sync.Mutex
	m  map[string][]float32
}

func (c *queryCache) Embed(ctx context.Context, kind embed.Kind, in []embed.Input) ([][]float32, error) {
	if kind == embed.Query && len(in) == 1 && in[0].Image == nil {
		c.mu.Lock()
		v, ok := c.m[in[0].Text]
		c.mu.Unlock()
		if ok {
			return [][]float32{v}, nil
		}
		out, err := c.Embedder.Embed(ctx, kind, in)
		if err == nil && len(out) == 1 {
			c.mu.Lock()
			c.m[in[0].Text] = out[0]
			c.mu.Unlock()
		}
		return out, err
	}
	return c.Embedder.Embed(ctx, kind, in)
}

type metric struct{ h1, h5, r10, mrr float64 }

func score(rank []string, rel []string) metric {
	relSet := map[string]bool{}
	for _, r := range rel {
		relSet[r] = true
	}
	var m metric
	pos := -1
	top10 := 0
	for i, id := range rank {
		if relSet[id] {
			if pos < 0 {
				pos = i
			}
			if i < 10 {
				top10++
			}
		}
	}
	if pos == 0 {
		m.h1 = 1
	}
	if pos >= 0 && pos < 5 {
		m.h5 = 1
	}
	if pos >= 0 {
		m.mrr = 1 / float64(pos+1)
	}
	if len(relSet) > 0 {
		m.r10 = float64(top10) / float64(len(relSet))
	}
	return m
}

func mean(ms []metric) metric {
	var s metric
	for _, m := range ms {
		s.h1 += m.h1
		s.h5 += m.h5
		s.r10 += m.r10
		s.mrr += m.mrr
	}
	n := float64(len(ms))
	if n == 0 {
		return s
	}
	return metric{s.h1 / n, s.h5 / n, s.r10 / n, s.mrr / n}
}

func (m metric) String() string {
	return fmt.Sprintf("%.2f / %.2f / %.2f / %.2f", m.h1, m.h5, m.r10, m.mrr)
}

func ints(s string) ([]int, error) {
	var out []int
	for _, f := range strings.Split(s, ",") {
		n, err := strconv.Atoi(strings.TrimSpace(f))
		if err != nil {
			return nil, err
		}
		out = append(out, n)
	}
	return out, nil
}

func floats(s string) ([]float64, error) {
	var out []float64
	for _, f := range strings.Split(s, ",") {
		x, err := strconv.ParseFloat(strings.TrimSpace(f), 64)
		if err != nil {
			return nil, err
		}
		out = append(out, x)
	}
	return out, nil
}

func main() {
	scraps := flag.String("scraps", "", "folder of the synthetic daily scraps (made by gen.mjs)")
	truthPath := flag.String("truth", "", "truth.json (default: next to the scraps folder)")
	base := flag.String("base", "http://localhost:11434", "model server")
	model := flag.String("model", "bge-m3", "embedding model")
	dims := flag.Int("dims", 0, "dimensions (0 = the model's own)")
	chunks := flag.String("chunks", "150,300,600", "chunk sizes in characters, comma separated")
	headers := flag.String("headers", "on,off", "with the date and heading in front of each chunk: on, off or both")
	weights := flag.String("weights", "-1,0.05,0.1,0.2", "weights of the lexical score; -1 = none (the vector alone)")
	logPenalty := flag.Float64("logpenalty", 0, "points taken off a piped log (0 = the default 0.05, -1 = none)")
	lexNorm := flag.String("lexnorm", "idf", "what the lexical score is divided by: idf (a chunk holding every token of the query; the default) or max (the best candidate)")
	work := flag.String("work", "", "folder for the indexes (default: a temporary one, removed at the end)")
	verbose := flag.Bool("v", false, "list the queries whose right note is not in the first five (first variant only)")
	flag.Parse()
	if *scraps == "" {
		fmt.Fprintln(os.Stderr, "-scraps is required")
		os.Exit(2)
	}
	if *truthPath == "" {
		*truthPath = filepath.Join(filepath.Dir(filepath.Clean(*scraps)), "truth.json")
	}
	raw, err := os.ReadFile(*truthPath)
	if err != nil {
		fatal(err)
	}
	var tr truth
	if err := json.Unmarshal(raw, &tr); err != nil {
		fatal(err)
	}
	sizes, err := ints(*chunks)
	if err != nil {
		fatal(err)
	}
	ws, err := floats(*weights)
	if err != nil {
		fatal(err)
	}
	var hdrs []bool
	for _, h := range strings.Split(*headers, ",") {
		switch strings.TrimSpace(h) {
		case "on":
			hdrs = append(hdrs, true)
		case "off":
			hdrs = append(hdrs, false)
		case "both":
			hdrs = append(hdrs, true, false)
		default:
			fatal(fmt.Errorf("-headers: %q", h))
		}
	}

	e, err := embed.New(embed.Config{BaseURL: *base, Model: *model, APIKey: os.Getenv(semindex.EnvAPIKey), Dimensions: *dims})
	if err != nil {
		fatal(err)
	}
	if !embed.IsLocal(*base) {
		fmt.Fprintf(os.Stderr, "note: the synthetic notes are sent to %s\n", *base)
	}
	emb := &queryCache{Embedder: e, m: map[string][]float32{}}

	workDir := *work
	if workDir == "" {
		workDir, err = os.MkdirTemp("", "semindex-eval-")
		if err != nil {
			fatal(err)
		}
		defer os.RemoveAll(workDir)
	}
	ctx := context.Background()

	type cell struct {
		by map[string][]metric // per table (groupOf, crossGroup)
	}
	type row struct {
		size   int
		header bool
		chunks int
		cells  map[float64]*cell
	}
	var rows []row
	var embedded int
	var embedTime time.Duration
	var searchTime time.Duration
	var searches int

	for _, size := range sizes {
		for _, header := range hdrs {
			idx := filepath.Join(workDir, fmt.Sprintf("c%d-h%v", size, header))
			opts := semindex.DefaultOptions()
			opts.Chunk.MaxChars = size
			opts.Chunk.Header = header
			t0 := time.Now()
			st, err := semindex.Update(ctx, *scraps, idx, emb, opts)
			if err != nil {
				fatal(err)
			}
			embedded += st.Embedded
			embedTime += time.Since(t0)
			fmt.Fprintf(os.Stderr, "chunk %d header %v: %d files, %d chunks, %d embedded in %.1f s\n", size, header, st.Files, st.Chunks, st.Embedded, time.Since(t0).Seconds())

			r := row{size: size, header: header, chunks: st.Chunks, cells: map[float64]*cell{}}
			for _, w := range ws {
				c := &cell{by: map[string][]metric{}}
				for _, q := range tr.Queries {
					t1 := time.Now()
					hits, _, err := semindex.Search(ctx, idx, emb, q.Q, semindex.SearchOptions{Limit: 100000, Weight: w, LogPenalty: *logPenalty, LexNorm: *lexNorm})
					if err != nil {
						fatal(err)
					}
					searchTime += time.Since(t1)
					searches++
					rank := make([]string, len(hits))
					for i, h := range hits {
						rank[i] = fmt.Sprintf("%s#%d", h.Rel, h.Entry)
					}
					m := score(rank, q.Rel)
					g := groupOf(q.Type, q.Lang)
					c.by[g] = append(c.by[g], m)
					if cg := crossGroup(q.Lang); cg != "" && q.Type == "semantic" && tr.Lang == "mixed" {
						// only a question whose facts were written (also) in the other language can be asked of it
						if r, relOther := crossRanking(rank, q.Rel, q.Lang, tr.EntryLang); len(relOther) > 0 {
							c.by[cg] = append(c.by[cg], score(r, relOther))
						}
					}
					if *verbose && size == sizes[0] && header == hdrs[0] && w == ws[len(ws)-1] && m.h5 == 0 {
						top := ""
						if len(hits) > 0 {
							top = strings.ReplaceAll(strings.TrimSpace(hits[0].Text), "\n", " ")
							if rs := []rune(top); len(rs) > 40 {
								top = string(rs[:40])
							}
						}
						fmt.Fprintf(os.Stderr, "  miss: %q (%d right notes), first hit: %s\n", q.Q, len(q.Rel), top)
					}
				}
				r.cells[w] = c
			}
			rows = append(rows, r)
		}
	}

	sort.SliceStable(rows, func(i, j int) bool { return rows[i].size < rows[j].size })
	for _, typ := range groupOrder {
		n := 0
		if len(rows) > 0 {
			n = len(rows[0].cells[ws[0]].by[typ])
		}
		if n == 0 {
			continue
		}
		fmt.Printf("\n=== %s queries (%d) ===  [hit@1 / hit@5 / recall@10 / MRR]\n", typ, n)
		fmt.Printf("%-7s%-5s%-8s", "chunk", "hdr", "chunks")
		for _, w := range ws {
			if w < 0 {
				fmt.Printf("%-26s", "vector alone")
			} else {
				fmt.Printf("%-26s", fmt.Sprintf("vector + %.2f * lexical", w))
			}
		}
		fmt.Println()
		for _, r := range rows {
			h := "off"
			if r.header {
				h = "on"
			}
			fmt.Printf("%-7d%-5s%-8d", r.size, h, r.chunks)
			for _, w := range ws {
				fmt.Printf("%-26s", mean(r.cells[w].by[typ]).String())
			}
			fmt.Println()
		}
	}
	if embedded > 0 {
		fmt.Printf("\nindexing: %d texts embedded in %.1f s = %.0f texts/s (the model's speed on this machine, not the program's)\n", embedded, embedTime.Seconds(), float64(embedded)/embedTime.Seconds())
	}
	if searches > 0 {
		fmt.Printf("search: %d searches, %.1f ms each on average (the query vector is cached, so this is the index's own time)\n", searches, float64(searchTime.Milliseconds())/float64(searches))
	}
}

func fatal(err error) {
	fmt.Fprintln(os.Stderr, "Error:", err)
	os.Exit(1)
}
