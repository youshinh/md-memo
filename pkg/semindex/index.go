package semindex

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"md-memo/pkg/embed"
)

// ErrRebuildNeeded means the index was made with another model or another way of cutting the text than the one asked for now: its
// vectors cannot be mixed with new ones. Update refuses; Rebuild makes a new index (the old one stays in use until it is done).
var ErrRebuildNeeded = errors.New("the semantic index was made with another model or chunking; rebuild it (md-memo scrap index --rebuild)")

// Options of Update and Rebuild.
type Options struct {
	Chunk ChunkOptions
	// SettleMinutes: a file changed less than this long ago is left for later (it is still being written to). 0 = no wait.
	SettleMinutes int
	// Force reads and cuts every file even when its size and time are those the index saw; chunks that did not change still cost no
	// embedding (they are found by their hash).
	Force bool
	// BatchSize is the number of texts per embedding request (default 32, never more than the embedder takes).
	BatchSize int
	// CommitEvery is how many new vectors are made valid at a time, so that an interrupted first build keeps what it did (default 500).
	CommitEvery int
	// DryRun counts what would be done and writes nothing and calls no model.
	DryRun   bool
	Progress func(Progress)
	Now      func() time.Time
	// afterBatch runs after every embedding request (Rebuild uses it to keep its own lock fresh while Update works in another folder).
	afterBatch func()
}

// DefaultOptions are the settings the design chose: chunks of about 150 characters with the date and heading in front, no AI results.
func DefaultOptions() Options {
	return Options{Chunk: ChunkOptions{MaxChars: DefaultMaxChars, Header: true}}
}

// Progress is reported while Update works.
type Progress struct {
	FilesTotal    int // files to read this time
	FilesDone     int
	TextsTotal    int // chunk texts that need a vector
	TextsEmbedded int
}

// Stats says what an Update did (or, with DryRun, would do).
type Stats struct {
	Files         int // scrap files found
	FilesChanged  int // read again, and cut anew
	FilesRemoved  int
	FilesSettling int // left for later because they were changed just now
	Chunks        int // chunks in the index afterwards
	ChunksNew     int // chunk texts that needed a vector
	ChunksReused  int // chunks whose vector was already there
	Embedded      int // texts sent to the model
	Compacted     bool
	Duration      time.Duration
}

// fileInfo is a scrap file as listed.
type fileInfo struct {
	rel   string
	abs   string
	size  int64
	modNs int64
	mod   time.Time
}

// ---- which files are indexed ----------------------------------------------------------------------------------------------------

// ignoreRules are the lines of the .md-memo-ignore file in the scrap folder (it is synced by Git, so two PCs agree): "name" or
// "*.glob" matches a file or folder of that name anywhere, "dir/" a folder and what is in it, "a/b.md" a path. "#" starts a comment.
type ignoreRules struct{ patterns []string }

func loadIgnore(root string) ignoreRules {
	raw, err := os.ReadFile(filepath.Join(root, ".md-memo-ignore"))
	if err != nil {
		return ignoreRules{}
	}
	var r ignoreRules
	for _, line := range strings.Split(strings.ReplaceAll(string(raw), "\r\n", "\n"), "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		r.patterns = append(r.patterns, filepath.ToSlash(line))
	}
	return r
}

// matches reports whether rel (a "/" path inside the scrap folder) is left out.
func (r ignoreRules) matches(rel string) bool {
	parts := strings.Split(rel, "/")
	for _, p := range r.patterns {
		if strings.HasSuffix(p, "/") { // a folder
			dir := strings.TrimSuffix(strings.TrimPrefix(p, "/"), "/")
			if rel == dir || strings.HasPrefix(rel, dir+"/") {
				return true
			}
			for i := range parts[:len(parts)-1] {
				if ok, _ := path.Match(dir, parts[i]); ok && !strings.Contains(dir, "/") {
					return true
				}
			}
			continue
		}
		if strings.Contains(p, "/") {
			if ok, _ := path.Match(strings.TrimPrefix(p, "/"), rel); ok {
				return true
			}
			continue
		}
		for _, part := range parts { // a bare name or glob matches any component
			if ok, _ := path.Match(p, part); ok {
				return true
			}
		}
	}
	return false
}

// Excluded says whether a file (rel: its path inside the scrap folder, with "/") is outside what the semantic index covers, and so
// outside what a deep search may send to a model: a folder starting with "." (.git and the like), the assets folder, the "(sync
// conflict ...)" copies that Git sync makes, and what .md-memo-ignore names. The ignore file is read once, when Excluded is called.
func Excluded(scrapDir string) func(rel string) bool {
	ign := loadIgnore(filepath.Clean(scrapDir))
	return func(rel string) bool {
		rel = strings.TrimPrefix(filepath.ToSlash(rel), "/")
		parts := strings.Split(rel, "/")
		for _, p := range parts[:len(parts)-1] {
			low := strings.ToLower(p)
			if strings.HasPrefix(low, ".") || low == "assets" {
				return true
			}
		}
		if strings.Contains(parts[len(parts)-1], " (sync conflict ") {
			return true
		}
		return ign.matches(rel)
	}
}

// listFiles lists the scrap files the index covers: the .md files of the scrap folder, except folders starting with "." (.git and the
// like) and the assets folder, the "(sync conflict …)" copies Git sync makes (they would only repeat a note), and what
// .md-memo-ignore names.
func listFiles(scrapDir string) ([]fileInfo, error) {
	root := filepath.Clean(scrapDir)
	if fi, err := os.Stat(root); err != nil || !fi.IsDir() {
		return nil, fmt.Errorf("the scrap folder %s cannot be read", root)
	}
	ign := loadIgnore(root)
	var out []fileInfo
	_ = filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		rel, rerr := filepath.Rel(root, p)
		if rerr != nil || rel == "." {
			return nil
		}
		rel = filepath.ToSlash(rel)
		if d.IsDir() {
			name := strings.ToLower(d.Name())
			if strings.HasPrefix(name, ".") || name == "assets" || ign.matches(rel+"/") || ign.matches(rel) {
				return filepath.SkipDir
			}
			return nil
		}
		if !strings.HasSuffix(strings.ToLower(d.Name()), ".md") || strings.Contains(d.Name(), " (sync conflict ") || ign.matches(rel) {
			return nil
		}
		info, ierr := d.Info()
		if ierr != nil {
			return nil
		}
		out = append(out, fileInfo{rel: rel, abs: p, size: info.Size(), modNs: info.ModTime().UnixNano(), mod: info.ModTime()})
		return nil
	})
	sort.Slice(out, func(i, j int) bool { return out[i].rel < out[j].rel })
	return out, nil
}

// ---- Update ---------------------------------------------------------------------------------------------------------------------

func (s *Store) configure(embedderID string, c ChunkOptions) {
	s.m.Embedder = embedderID
	s.m.ChunkerVersion = ChunkerVersion
	s.m.MaxChars = c.maxChars()
	s.m.Header = c.Header
	s.m.IncludeAI = c.IncludeAI
}

func (s *Store) compatible(embedderID string, c ChunkOptions) bool {
	return s.m.Embedder == embedderID && s.m.ChunkerVersion == ChunkerVersion && s.m.MaxChars == c.maxChars() &&
		s.m.Header == c.Header && s.m.IncludeAI == c.IncludeAI
}

// sameChunks reports whether the chunks a file has now are exactly those the index holds for it (the text and the place).
func (s *Store) sameChunks(rows []int, now []Chunk) bool {
	if len(rows) != len(now) {
		return false
	}
	for i, r := range rows {
		if r < 0 || r >= len(s.metas) || s.dead[r] {
			return false
		}
		if s.metas[r].Chunk != now[i] {
			return false
		}
	}
	return true
}

type fileWork struct {
	fi     fileInfo
	chunks []Chunk
}

// Update brings the index in indexDir up to date with the scrap files in scrapDir: files that were not changed since the last run are
// skipped on their size and time, a changed file is cut into chunks and only the chunk texts that no vector exists for are sent to the
// embedder. It returns ErrRebuildNeeded when the index was made with another model or chunking. When ctx is cancelled (or the model
// fails) what was done is kept, the error is returned, and the next Update goes on from there.
func Update(ctx context.Context, scrapDir, indexDir string, emb embed.Embedder, opts Options) (Stats, error) {
	started := time.Now()
	var st Stats
	now := opts.Now
	if now == nil {
		now = time.Now
	}
	if !opts.DryRun {
		unlock, err := Lock(indexDir)
		if err != nil {
			return st, err
		}
		defer unlock()
	}
	store, err := OpenStore(indexDir)
	if err != nil {
		return st, err
	}
	if store.Empty() && store.m.Embedder == "" {
		store.configure(emb.ID(), opts.Chunk)
	} else if !store.compatible(emb.ID(), opts.Chunk) {
		return st, ErrRebuildNeeded
	}

	files, err := listFiles(scrapDir)
	if err != nil {
		return st, err
	}
	st.Files = len(files)
	present := make(map[string]bool, len(files))
	for _, f := range files {
		present[f.rel] = true
	}

	// which files are read again
	settle := time.Duration(opts.SettleMinutes) * time.Minute
	var todo []fileWork
	for _, f := range files {
		rec, known := store.m.Files[f.rel]
		if known && !opts.Force && rec.Size == f.size && rec.ModNs == f.modNs {
			continue
		}
		if settle > 0 && now().Sub(f.mod) < settle {
			st.FilesSettling++
			continue
		}
		data, rerr := os.ReadFile(f.abs)
		if rerr != nil {
			continue
		}
		todo = append(todo, fileWork{fi: f, chunks: ChunkFile(f.rel, data, opts.Chunk)})
	}

	// which chunk texts need a vector (each distinct text once, in the order they come)
	seen := map[string]bool{}
	var needed int
	for _, w := range todo {
		for _, c := range w.chunks {
			if _, ok := store.VectorRow(c.Hash); ok || seen[c.Hash] {
				st.ChunksReused++
				continue
			}
			seen[c.Hash] = true
			st.ChunksNew++
			needed++
		}
	}
	for rel := range store.m.Files {
		if !present[rel] {
			st.FilesRemoved++
		}
	}
	st.FilesChanged = len(todo)
	if opts.DryRun {
		st.Chunks = store.liveCount()
		st.Duration = time.Since(started)
		return st, nil
	}

	report := func(done, embedded int) {
		if opts.Progress != nil {
			opts.Progress(Progress{FilesTotal: len(todo), FilesDone: done, TextsTotal: needed, TextsEmbedded: embedded})
		}
	}
	batch := opts.BatchSize
	if batch <= 0 {
		batch = 32
	}
	if mb := emb.Caps().MaxBatch; mb > 0 && batch > mb {
		batch = mb
	}
	commitEvery := opts.CommitEvery
	if commitEvery <= 0 {
		commitEvery = 500
	}

	// Files that are gone: their chunks are dead.
	for rel, rec := range store.m.Files {
		if !present[rel] {
			store.Kill(rec.Metas)
			delete(store.m.Files, rel)
		}
	}

	var runErr error
	sinceCommit, done := 0, 0
	embedded := 0
	for gi := 0; gi < len(todo) && runErr == nil; {
		// a group of files whose missing texts fill about two requests
		var group []fileWork
		var order []string
		missing := map[string]string{}
		for gi < len(todo) && (len(group) == 0 || len(order) < batch*2) {
			w := todo[gi]
			gi++
			group = append(group, w)
			for _, c := range w.chunks {
				if _, ok := store.VectorRow(c.Hash); ok {
					continue
				}
				if _, dup := missing[c.Hash]; dup {
					continue
				}
				missing[c.Hash] = EmbedText(c.Text, c.Date, c.Heading, opts.Chunk.Header)
				order = append(order, c.Hash)
			}
		}
		vecsAtStart := store.m.Vecs
		for i := 0; i < len(order); i += batch {
			if err := ctx.Err(); err != nil {
				runErr = err
				break
			}
			end := i + batch
			if end > len(order) {
				end = len(order)
			}
			hs := order[i:end]
			in := make([]embed.Input, len(hs))
			for k, h := range hs {
				in[k] = embed.Input{Text: missing[h]}
			}
			vs, err := emb.Embed(ctx, embed.Document, in)
			if err == nil && len(vs) != len(hs) {
				err = fmt.Errorf("the embedder returned %d vectors for %d texts", len(vs), len(hs))
			}
			var first int
			if err == nil {
				first, err = store.AppendVectors(vs)
			}
			if err != nil {
				runErr = err
				break
			}
			for k, h := range hs {
				store.hv[h] = first + k
			}
			embedded += len(hs)
			st.Embedded += len(hs)
			sinceCommit += len(hs)
			touchLock(indexDir)
			if opts.afterBatch != nil {
				opts.afterBatch()
			}
			report(done, embedded)
		}
		if runErr != nil {
			store.m.Vecs = vecsAtStart // vectors of a group that was not finished belong to no chunk: drop them
			for h := range missing {
				if r, ok := store.hv[h]; ok && r >= vecsAtStart {
					delete(store.hv, h)
				}
			}
			break
		}
		for _, w := range group {
			if err := store.finalizeFile(w); err != nil {
				runErr = err
				break
			}
			done++
		}
		report(done, embedded)
		if runErr == nil && sinceCommit >= commitEvery {
			if err := store.Commit(); err != nil {
				runErr = err
			}
			sinceCommit = 0
		}
	}

	if runErr == nil && store.deadShare() {
		if err := store.Compact(); err != nil {
			runErr = err
		} else {
			st.Compacted = true
		}
	}
	if !st.Compacted {
		if err := store.Commit(); err != nil && runErr == nil {
			runErr = err
		}
	}
	st.Chunks = store.liveCount()
	st.Duration = time.Since(started)
	return st, runErr
}

// finalizeFile records the chunks of one file whose vectors are all there, and kills the chunks it had before.
func (s *Store) finalizeFile(w fileWork) error {
	rec := s.m.Files[w.fi.rel]
	if s.sameChunks(rec.Metas, w.chunks) {
		rec.Size, rec.ModNs = w.fi.size, w.fi.modNs // touched or rewritten with the same text: nothing to store
		s.m.Files[w.fi.rel] = rec
		return nil
	}
	ms := make([]meta, len(w.chunks))
	for i, c := range w.chunks {
		v, ok := s.VectorRow(c.Hash)
		if !ok {
			return fmt.Errorf("internal error: no vector for a chunk of %s", w.fi.rel)
		}
		ms[i] = meta{Chunk: c, V: v}
	}
	rows, err := s.AppendMetas(ms)
	if err != nil {
		return err
	}
	s.Kill(rec.Metas)
	s.m.Files[w.fi.rel] = FileRec{Size: w.fi.size, ModNs: w.fi.modNs, Metas: rows}
	return nil
}

// Rebuild makes a new index in a folder beside indexDir and puts it in place when it is complete; the old one is used until then. Use
// it when the model or the chunking changed.
func Rebuild(ctx context.Context, scrapDir, indexDir string, emb embed.Embedder, opts Options) (Stats, error) {
	unlock, err := Lock(indexDir)
	if err != nil {
		return Stats{}, err
	}
	defer unlock()
	tmp := indexDir + ".rebuild"
	_ = os.RemoveAll(tmp)
	opts.afterBatch = func() { touchLock(indexDir) }
	st, err := Update(ctx, scrapDir, tmp, emb, opts)
	if err != nil {
		return st, err
	}
	old := indexDir + ".old"
	_ = os.RemoveAll(old)
	if _, serr := os.Stat(indexDir); serr == nil {
		if err := os.Rename(indexDir, old); err != nil {
			return st, err
		}
	}
	if err := os.Rename(tmp, indexDir); err != nil {
		return st, err
	}
	_ = os.RemoveAll(old)
	return st, nil
}

// ---- Status ---------------------------------------------------------------------------------------------------------------------

// StatusInfo describes an index and how far it lags behind the scrap files.
type StatusInfo struct {
	Exists    bool
	Corrupt   bool
	Embedder  string
	Dim       int
	Chunks    int // live chunks
	Dead      int
	Files     int // files the index knows
	Updated   time.Time
	SizeBytes int64
	// the scrap folder against the index (by size and time)
	FolderMissing bool // the scrap folder does not exist or cannot be read; the counts below are then 0
	FilesInFolder int
	NewFiles      int
	ChangedFiles  int
	RemovedFiles  int
}

// NeedsRebuild reports whether the index in indexDir was made with another model or chunking than emb and opts, so that Update would
// refuse (ErrRebuildNeeded). A missing or empty index needs none.
func NeedsRebuild(indexDir string, emb embed.Embedder, opts Options) (bool, error) {
	store, err := OpenStore(indexDir)
	if err != nil {
		return false, err
	}
	if store.Empty() && store.m.Embedder == "" {
		return false, nil
	}
	return !store.compatible(emb.ID(), opts.Chunk), nil
}

// Pending is the number of files whose chunks are not (or not yet) in the index.
func (s StatusInfo) Pending() int { return s.NewFiles + s.ChangedFiles + s.RemovedFiles }

// Status looks at the index and the scrap folder; it reads no file's text and calls no model.
func Status(scrapDir, indexDir string) (StatusInfo, error) {
	var info StatusInfo
	store, err := OpenStore(indexDir)
	if err != nil {
		info.Corrupt = errors.Is(err, ErrCorrupt)
		return info, err
	}
	m := store.Manifest()
	info.Exists = m.Embedder != ""
	info.Embedder, info.Dim, info.Chunks, info.Dead, info.Files, info.Updated = m.Embedder, m.Dim, store.liveCount(), len(store.dead), len(m.Files), m.Updated
	for _, name := range []string{manifestFile, chunksFile, vectorsFile} {
		if fi, err := os.Stat(filepath.Join(indexDir, name)); err == nil {
			info.SizeBytes += fi.Size()
		}
	}
	files, err := listFiles(scrapDir)
	if err != nil { // no scrap folder (yet), or one that cannot be read: say so, and do not count every indexed file as removed
		info.FolderMissing = true
		return info, nil
	}
	info.FilesInFolder = len(files)
	present := map[string]bool{}
	for _, f := range files {
		present[f.rel] = true
		rec, known := m.Files[f.rel]
		switch {
		case !known:
			info.NewFiles++
		case rec.Size != f.size || rec.ModNs != f.modNs:
			info.ChangedFiles++
		}
	}
	for rel := range m.Files {
		if !present[rel] {
			info.RemovedFiles++
		}
	}
	return info, nil
}

// PendingFiles lists the files (relative paths) whose chunks are not yet in the index: new or changed since the last Update. The
// search falls back to the lexical search for them.
func PendingFiles(scrapDir, indexDir string) (map[string]bool, error) {
	store, err := OpenStore(indexDir)
	if err != nil {
		return nil, err
	}
	files, err := listFiles(scrapDir)
	if err != nil {
		return nil, err
	}
	out := map[string]bool{}
	for _, f := range files {
		rec, known := store.m.Files[f.rel]
		if !known || rec.Size != f.size || rec.ModNs != f.modNs {
			out[f.rel] = true
		}
	}
	return out, nil
}
