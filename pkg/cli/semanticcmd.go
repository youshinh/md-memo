package cli

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/signal"
	"path"
	"path/filepath"
	"strings"
	"time"

	"md-memo/pkg/embed"
	"md-memo/pkg/scrap"
	"md-memo/pkg/search"
	"md-memo/pkg/semindex"
)

// `md-memo scrap index` and `scrap search --semantic`: the semantic index of the scrap folder (docs/design/semantic-search-2026-10.md).
// Off unless config.json says semantic.enabled. The index is kept outside the scrap folder (semindex.IndexDir); these commands never
// write inside it. Nothing is sent to a host that is not this machine unless semantic.privacy.cloudConsent names the host.

const (
	// cloudIndexConfirmTexts: an index run that would send more chunk texts than this to a host that is not this machine asks for --yes.
	cloudIndexConfirmTexts = 1000
	// semanticUpdateBudget is how long `scrap search --update` may spend on updating the index before it searches.
	semanticUpdateBudget = 3 * time.Second
)

// ---- scrap index -----------------------------------------------------------------------------------------------------------------

type scrapIndexResult struct {
	ScrapDir      string  `json:"scrap_dir"`
	IndexDir      string  `json:"index_dir"`
	Model         string  `json:"model"`
	Local         bool    `json:"local"`
	Rebuilt       bool    `json:"rebuilt,omitempty"`
	DryRun        bool    `json:"dry_run,omitempty"`
	Files         int     `json:"files"`
	FilesChanged  int     `json:"files_changed"`
	FilesRemoved  int     `json:"files_removed"`
	FilesSettling int     `json:"files_settling,omitempty"`
	Chunks        int     `json:"chunks"`
	ChunksNew     int     `json:"chunks_new"`
	ChunksReused  int     `json:"chunks_reused"`
	Embedded      int     `json:"embedded"`
	Compacted     bool    `json:"compacted,omitempty"`
	Seconds       float64 `json:"seconds"`
}

type scrapIndexStatus struct {
	Enabled       bool   `json:"enabled"`
	Model         string `json:"model,omitempty"`
	ModelError    string `json:"model_error,omitempty"`
	Destination   string `json:"destination,omitempty"`
	Local         bool   `json:"local"`
	ScrapDir      string `json:"scrap_dir"`
	IndexDir      string `json:"index_dir"`
	Exists        bool   `json:"exists"`
	Corrupt       bool   `json:"corrupt,omitempty"`
	IndexModel    string `json:"index_model,omitempty"`
	Dim           int    `json:"dim,omitempty"`
	Chunks        int    `json:"chunks"`
	DeadChunks    int    `json:"dead_chunks,omitempty"`
	Files         int    `json:"files"`
	Updated       string `json:"updated,omitempty"`
	SizeBytes     int64  `json:"size_bytes"`
	FolderMissing bool   `json:"folder_missing,omitempty"`
	FilesInFolder int    `json:"files_in_folder"`
	NewFiles      int    `json:"new_files"`
	ChangedFiles  int    `json:"changed_files"`
	RemovedFiles  int    `json:"removed_files"`
	RebuildNeeded bool   `json:"rebuild_needed,omitempty"`
}

func (r *HeadlessRunner) runScrapIndex(args []string) (int, error) {
	fs := newQuietFlagSet("scrap index")
	status := fs.Bool("status", false, "Show the index and how far it lags behind the scrap files")
	rebuild := fs.Bool("rebuild", false, "Make the index again from scratch (after the model or the chunking changed)")
	dry := fs.Bool("dry-run", false, "Count what would be done; write nothing, call no model")
	force := fs.Bool("force", false, "Read every file again (chunks that did not change still cost no embedding)")
	yes := fs.Bool("yes", false, "Go ahead with a large run that sends your notes to a host that is not this machine")
	settle := fs.Int("settle", 0, "Leave files changed less than this many minutes ago for later")
	forceJSON := fs.Bool("json", false, "Force JSON output")
	forceText := fs.Bool("text", false, "Force plain text output")
	rest, err := parseInterspersed(fs, args)
	if err != nil {
		return r.flagErr("scrap", err)
	}
	if len(rest) > 0 {
		return 1, fmt.Errorf("scrap index takes no arguments, got %q", rest[0])
	}
	if *settle < 0 {
		return 1, fmt.Errorf("invalid --settle %d (use 0 or more)", *settle)
	}
	if *status && (*rebuild || *dry || *force || *yes) {
		return 1, errors.New("--status only looks; it cannot be combined with --rebuild, --dry-run, --force or --yes")
	}
	asJSON := ResolveFormatCustom(*forceJSON, *forceText, IsTerminal(os.Stdout)) == FormatJSON

	cfg := LoadConfig()
	scrapDir := cfg.ScrapDirResolved()
	idxDir := semindex.IndexDir(scrapDir)
	sc := semindex.ParseConfig(cfg.Values)
	if *status {
		return r.printIndexStatus(sc, scrapDir, idxDir, asJSON)
	}

	emb, err := sc.NewEmbedder()
	if err != nil {
		return 1, err
	}
	dest, local := sc.Destination()
	opts := sc.Options()
	opts.Force = *force
	opts.SettleMinutes = *settle

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()

	// planDir is where a dry run (and the size check) counts: a rebuild starts from nothing, so it counts against a folder that does not exist.
	planDir := idxDir
	if *rebuild {
		planDir = idxDir + ".plan"
	}
	if !local && !*yes && !*dry {
		po := opts
		po.DryRun = true
		if plan, perr := semindex.Update(ctx, scrapDir, planDir, emb, po); perr == nil && plan.ChunksNew > cloudIndexConfirmTexts {
			return 1, fmt.Errorf("this would send %d chunk texts of your notes to %s; run it again with --yes to go ahead (--dry-run shows the numbers)", plan.ChunksNew, dest)
		}
	}

	if !asJSON && !*dry && IsTerminal(os.Stderr) {
		opts.Progress = func(p semindex.Progress) {
			fmt.Fprintf(r.stderr, "\rindexing: %d/%d files, %d/%d texts embedded", p.FilesDone, p.FilesTotal, p.TextsEmbedded, p.TextsTotal)
		}
	}
	var st semindex.Stats
	switch {
	case *dry:
		opts.DryRun = true
		st, err = semindex.Update(ctx, scrapDir, planDir, emb, opts)
	case *rebuild:
		st, err = semindex.Rebuild(ctx, scrapDir, idxDir, emb, opts)
	default:
		st, err = semindex.Update(ctx, scrapDir, idxDir, emb, opts)
	}
	if opts.Progress != nil {
		fmt.Fprintln(r.stderr)
	}
	if err != nil {
		switch {
		case errors.Is(err, semindex.ErrRebuildNeeded), errors.Is(err, semindex.ErrLocked), errors.Is(err, semindex.ErrCorrupt):
			return 1, err
		case errors.Is(err, context.Canceled):
			return 1, errors.New("interrupted; what was done is kept, run the command again to continue")
		}
		return 1, fmt.Errorf("%w (what was done is kept; run the command again to continue)", err)
	}

	res := scrapIndexResult{
		ScrapDir: scrapDir, IndexDir: idxDir, Model: emb.ID(), Local: local, Rebuilt: *rebuild && !*dry, DryRun: *dry,
		Files: st.Files, FilesChanged: st.FilesChanged, FilesRemoved: st.FilesRemoved, FilesSettling: st.FilesSettling,
		Chunks: st.Chunks, ChunksNew: st.ChunksNew, ChunksReused: st.ChunksReused, Embedded: st.Embedded, Compacted: st.Compacted,
		Seconds: roundTenth(st.Duration.Seconds()),
	}
	if asJSON {
		PrintFormatted(r.stdout, FormatJSON, "", res)
		return 0, nil
	}
	verb := "Indexed"
	switch {
	case *dry:
		verb = "Would index"
	case *rebuild:
		verb = "Rebuilt"
	}
	fmt.Fprintf(r.stdout, "%s %d files (%d read, %d removed): %d chunks in the index, %d new texts %s, %d reused. %.1f s\n",
		verb, res.Files, res.FilesChanged, res.FilesRemoved, res.Chunks, res.ChunksNew, map[bool]string{true: "to embed", false: "embedded"}[*dry], res.ChunksReused, res.Seconds)
	if res.FilesSettling > 0 {
		fmt.Fprintf(r.stdout, "%d files were changed too recently and were left for later.\n", res.FilesSettling)
	}
	return 0, nil
}

func roundTenth(x float64) float64 { return float64(int(x*10+0.5)) / 10 }

func (r *HeadlessRunner) printIndexStatus(sc semindex.Config, scrapDir, idxDir string, asJSON bool) (int, error) {
	out := scrapIndexStatus{Enabled: sc.Enabled, ScrapDir: scrapDir, IndexDir: idxDir}
	out.Destination, out.Local = sc.Destination()
	var emb embed.Embedder
	if e, err := embed.New(sc.Model); err != nil { // nothing is sent: New only builds
		out.ModelError = err.Error()
	} else {
		emb = e
		out.Model = e.ID()
	}
	info, serr := semindex.Status(scrapDir, idxDir)
	switch {
	case serr != nil && !info.Corrupt:
		return 1, serr
	case info.Corrupt:
		out.Corrupt = true
	}
	out.Exists, out.IndexModel, out.Dim, out.Chunks, out.DeadChunks, out.Files = info.Exists, info.Embedder, info.Dim, info.Chunks, info.Dead, info.Files
	out.SizeBytes, out.FilesInFolder, out.FolderMissing = info.SizeBytes, info.FilesInFolder, info.FolderMissing
	out.NewFiles, out.ChangedFiles, out.RemovedFiles = info.NewFiles, info.ChangedFiles, info.RemovedFiles
	if !info.Updated.IsZero() {
		out.Updated = info.Updated.Local().Format(time.RFC3339)
	}
	if emb != nil && info.Exists {
		out.RebuildNeeded, _ = semindex.NeedsRebuild(idxDir, emb, sc.Options())
	}
	if asJSON {
		PrintFormatted(r.stdout, FormatJSON, "", out)
		return 0, nil
	}

	on := "off (set \"semantic\": {\"enabled\": true} in config.json)"
	if out.Enabled {
		on = "on"
	}
	fmt.Fprintf(r.stdout, "semantic search: %s\n", on)
	switch {
	case out.Model != "":
		where := "this machine"
		if !out.Local {
			where = out.Destination
			if !sc.ConsentGiven() {
				where += ", NOT allowed yet (semantic.privacy.cloudConsent)"
			}
		}
		fmt.Fprintf(r.stdout, "model:           %s (%s)\n", out.Model, where)
	default:
		fmt.Fprintf(r.stdout, "model:           not usable: %s\n", out.ModelError)
	}
	if out.FolderMissing {
		fmt.Fprintf(r.stdout, "scrap folder:    %s (does not exist or cannot be read)\n", out.ScrapDir)
	} else {
		fmt.Fprintf(r.stdout, "scrap folder:    %s (%d files)\n", out.ScrapDir, out.FilesInFolder)
	}
	switch {
	case out.Corrupt:
		fmt.Fprintf(r.stdout, "index:           %s is damaged; run: md-memo scrap index --rebuild\n", out.IndexDir)
	case !out.Exists:
		fmt.Fprintf(r.stdout, "index:           not built yet (%s); run: md-memo scrap index\n", out.IndexDir)
	default:
		fmt.Fprintf(r.stdout, "index:           %s\n", out.IndexDir)
		fmt.Fprintf(r.stdout, "                 %d chunks from %d files, %.1f MB, made with %s, updated %s\n", out.Chunks, out.Files, float64(out.SizeBytes)/1e6, out.IndexModel, out.Updated)
		if out.RebuildNeeded {
			fmt.Fprintln(r.stdout, "                 made with another model or chunking than the settings name; run: md-memo scrap index --rebuild")
		}
	}
	if p := out.NewFiles + out.ChangedFiles + out.RemovedFiles; p > 0 {
		fmt.Fprintf(r.stdout, "not up to date: %d new, %d changed, %d removed files\n", out.NewFiles, out.ChangedFiles, out.RemovedFiles)
	}
	return 0, nil
}

// ---- scrap search --semantic -----------------------------------------------------------------------------------------------------

type semanticQuery struct {
	query    string
	limit    int
	days     dayRange
	kinds    []string
	pathGlob string
	update   bool
	cutoff   float64 // leave out notes scoring below this share of the best; 0 = none
}

// validateKinds checks --kind (or the kind parameter): note, log, ai, in any case; empty entries are left out.
func validateKinds(list []string) ([]string, error) {
	var out []string
	for _, k := range list {
		k = strings.ToLower(strings.TrimSpace(k))
		if k == "" {
			continue
		}
		switch k {
		case semindex.KindNote, semindex.KindLog, semindex.KindAI:
			out = append(out, k)
		default:
			return nil, fmt.Errorf("invalid --kind %q (use note, log or ai, separated by commas)", k)
		}
	}
	return out, nil
}

func leadLine(s string, max int) string {
	s = strings.TrimSpace(s)
	if i := strings.IndexByte(s, '\n'); i >= 0 {
		s = s[:i] + " ..."
	}
	if rs := []rune(s); len(rs) > max {
		s = string(rs[:max]) + "..."
	}
	return s
}

// hitsFromResults turns file results of the word search into hits, stopping at limit (truncated says there were more).
func hitsFromResults(found []search.SearchResult, limit int) (hits []scrapHit, truncated bool) {
	for _, file := range found {
		day, _ := scrap.DateOfFile(file.FileName)
		for _, m := range file.Matches {
			if len(hits) == limit {
				return hits, true
			}
			hits = append(hits, scrapHit{
				File: file.FilePath, Date: day, Line: m.LineNumber, Text: m.LineText,
				Heading: m.Heading, HeadingLine: m.HeadingLine, Score: m.Score, Partial: m.Partial,
			})
		}
	}
	return hits, false
}

// keepWords is the file filter of the word search: the day range, the --path pattern and, when only is given, only those files.
func keepWords(scrapDir string, q semanticQuery, only map[string]bool) func(string) bool {
	return func(p string) bool {
		rel, err := filepath.Rel(scrapDir, p)
		if err != nil {
			return false
		}
		rel = filepath.ToSlash(rel)
		if only != nil && !only[rel] {
			return false
		}
		if q.days.set() {
			day, ok := scrap.DateOfFile(filepath.Base(p))
			if !ok || !q.days.contains(day) {
				return false
			}
		}
		if q.pathGlob != "" {
			okFull, _ := path.Match(q.pathGlob, rel)
			okBase, _ := path.Match(q.pathGlob, path.Base(rel))
			if !okFull && !okBase {
				return false
			}
		}
		return true
	}
}

// scrapSearchSemantic is `scrap search --semantic` and the semantic scrap.search (ScrapSearch in shared.go calls it).
func scrapSearchSemantic(ctx context.Context, q semanticQuery) (scrapSearchResult, error) {
	cfg := LoadConfig()
	scrapDir := cfg.ScrapDirResolved()
	idxDir := semindex.IndexDir(scrapDir)
	sc := semindex.ParseConfig(cfg.Values)
	emb, err := sc.NewEmbedder() // not enabled, not allowed, not set up: the person has to act, so this is an error
	if err != nil {
		return scrapSearchResult{}, err
	}
	res := scrapSearchResult{Query: q.query, Semantic: true, Matches: []scrapHit{}}

	if q.update {
		uctx, cancel := context.WithTimeout(ctx, semanticUpdateBudget)
		_, uerr := semindex.Update(uctx, scrapDir, idxDir, emb, sc.Options())
		cancel()
		if uerr != nil {
			res.Notes = append(res.Notes, "the index update was cut short ("+oneLine(uerr)+"); the files not indexed yet were searched by words")
		}
	}

	sopts := semindex.SearchOptions{Limit: q.limit + 1, Since: q.days.from, Until: q.days.to, Kinds: q.kinds, Path: q.pathGlob}
	hits, _, serr := semindex.Search(ctx, idxDir, emb, q.query, sopts)
	if serr != nil {
		// The index or the model cannot answer now: search by words instead and say why, rather than answering nothing.
		res.Semantic = false
		res.Ranked = true
		res.Notes = append(res.Notes, "searched by words, not by meaning: "+semanticFailure(serr))
		found, err := search.SearchScrapsRanked(ctx, scrapDir, q.query, q.limit+1, search.Options{Headings: true, Less: scrapFileOrder, Keep: keepWords(scrapDir, q, nil)})
		if err != nil {
			return scrapSearchResult{}, err
		}
		res.Matches, res.Truncated = hitsFromResults(found, q.limit)
		for i := range res.Matches {
			res.Matches[i].Source = "words"
		}
	} else {
		sem := make([]scrapHit, 0, len(hits))
		for _, h := range hits {
			sem = append(sem, scrapHit{
				File: filepath.Join(scrapDir, filepath.FromSlash(h.Rel)), Date: h.Date, Line: h.Line, EndLine: h.EndLine,
				Text: h.Text, Heading: h.Heading, Score: h.Score, Cosine: h.Cosine, Kind: h.Kind, Context: h.Context, Source: "semantic",
			})
		}
		// The notes far below the best one are noise: a fixed score cannot say so (the scores of a model sit in a narrow band that the
		// right and the wrong notes share), a share of the best score can.
		if q.cutoff > 0 && len(sem) > 0 && sem[0].Score > 0 {
			floor := q.cutoff * sem[0].Score
			kept := make([]scrapHit, 0, len(sem))
			for _, h := range sem {
				if h.Score >= floor {
					kept = append(kept, h)
				}
			}
			if dropped := len(sem) - len(kept); dropped > 0 {
				res.LeftOut = dropped
				res.Notes = append(res.Notes, fmt.Sprintf("%d lower-scoring notes were left out (below %.0f%% of the best score; --cutoff 0 shows them)", dropped, q.cutoff*100))
			}
			sem = kept
		}
		// Files that are new or changed since the index was updated are not in it. Their notes are searched by words, so that a note
		// written a minute ago can be found: the ones that hold every word of the text come first (an exact find in what you just
		// wrote is what you are most likely after), the ones that hold only some of the words come after the semantic hits.
		var full, partial []scrapHit
		if pend, perr := semindex.PendingFiles(scrapDir, idxDir); perr == nil && len(pend) > 0 {
			res.Pending = len(pend)
			if len(q.kinds) > 0 {
				res.Notes = append(res.Notes, fmt.Sprintf("%d files are not indexed yet (md-memo scrap index) and were not searched, because --kind needs the index", len(pend)))
			} else if found, ferr := search.SearchScrapsRanked(ctx, scrapDir, q.query, q.limit+1, search.Options{Headings: true, Less: scrapFileOrder, Keep: keepWords(scrapDir, q, pend)}); ferr == nil {
				words, _ := hitsFromResults(found, q.limit+1)
				for _, w := range words {
					w.Source = "words"
					if w.Partial {
						partial = append(partial, w)
					} else {
						full = append(full, w)
					}
				}
				res.Notes = append(res.Notes, fmt.Sprintf("%d files are not indexed yet (md-memo scrap index, or --update); they were searched by words, and the notes that hold every word come first", len(pend)))
			}
		}
		res.Matches, res.Truncated = firstOf(q.limit, full, sem, partial)
	}
	res.Count = len(res.Matches)
	return res, nil
}

// printSemanticResult prints the answer of `scrap search --semantic`: JSON, or text with one block per hit and the notes at the end.
func (r *HeadlessRunner) printSemanticResult(res scrapSearchResult, asJSON bool) (int, error) {
	if asJSON {
		PrintFormatted(r.stdout, FormatJSON, "", res)
		return 0, nil
	}
	if res.Count == 0 {
		fmt.Fprintf(r.stdout, "No matches for %q\n", res.Query)
	}
	for _, m := range res.Matches {
		fmt.Fprintf(r.stdout, "%s:%d: %s\n", m.File, m.Line, leadLine(m.Text, 160))
		if m.Heading != "" {
			fmt.Fprintf(r.stdout, "    under: %s\n", m.Heading)
		}
		how := "words"
		if m.Source == "semantic" {
			how = "meaning"
		}
		fmt.Fprintf(r.stdout, "    score: %.2f (%s)\n", m.Score, how)
	}
	if res.Truncated {
		fmt.Fprintf(r.stdout, "(stopped after %d matches; --limit raises it)\n", res.Count)
	}
	for _, n := range res.Notes {
		fmt.Fprintf(r.stdout, "note: %s\n", n)
	}
	return 0, nil
}

// firstOf joins the lists in order and keeps the first limit hits; truncated says some were left out.
func firstOf(limit int, lists ...[]scrapHit) (out []scrapHit, truncated bool) {
	out = []scrapHit{}
	for _, l := range lists {
		for _, h := range l {
			if len(out) == limit {
				return out, true
			}
			out = append(out, h)
		}
	}
	return out, false
}

// semanticFailure says in a few words why the semantic search could not answer, for the note that goes with the word-search fallback.
func semanticFailure(err error) string {
	switch {
	case errors.Is(err, semindex.ErrEmpty):
		return "the semantic index is empty (build it with: md-memo scrap index)"
	case errors.Is(err, semindex.ErrModelMismatch):
		return "the semantic index was made with another model (rebuild it with: md-memo scrap index --rebuild)"
	case errors.Is(err, semindex.ErrCorrupt):
		return "the semantic index is damaged (rebuild it with: md-memo scrap index --rebuild)"
	}
	return "the embedding model could not be used (" + oneLine(err) + ")"
}

func oneLine(err error) string {
	s := strings.Join(strings.Fields(err.Error()), " ")
	if rs := []rune(s); len(rs) > 200 {
		s = string(rs[:200]) + "..."
	}
	return s
}
