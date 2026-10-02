package semindex

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
	"time"
)

func note(date, hm, body string) string {
	return fmt.Sprintf("# %s %s\n\n%s\n\n", date, hm, body)
}

func logBlock(hms, title, out string) string {
	return fmt.Sprintf("---\n## [%s] %s\n```text\n%s\n```\n\n", hms, title, out)
}

// seed writes three days of notes and returns their names.
func seed(t *testing.T, scrap string) {
	t.Helper()
	writeFile(t, scrap, "2026-09-01.md",
		note("2026-09-01", "09:00", "竹は成長が早く、三年ほどで伐採できる。建材として使えば環境への負荷が小さい。")+
			note("2026-09-01", "15:30", "Rust の借用チェッカーに怒られた。ライフタイムの書き方を調べる。"))
	writeFile(t, scrap, "2026-09-02.md",
		note("2026-09-02", "10:00", "夕食はカレーにした。スパイスから煮込むと香りが全然違う。")+
			logBlock("10:05:00", "ping", "128.1.33.254 からの応答: 時間 =5ms"))
	writeFile(t, scrap, "sub/2026-09-03.md",
		note("2026-09-03", "08:00", "会議の議事録。次回までに見積もりを出す。担当は佐藤さん。"))
}

func newOpts() Options {
	o := DefaultOptions()
	o.CommitEvery = 1
	return o
}

func TestUpdateBuildsAndSearchFindsTheNote(t *testing.T) {
	scrap, idx := dirs(t)
	seed(t, scrap)
	emb := newFake()
	st, err := Update(context.Background(), scrap, idx, emb, newOpts())
	if err != nil {
		t.Fatal(err)
	}
	if st.Files != 3 || st.FilesChanged != 3 || st.Chunks == 0 || st.Embedded != st.ChunksNew || st.Embedded != emb.inputs {
		t.Fatalf("stats = %+v (the model saw %d texts)", st, emb.inputs)
	}
	hits, info, err := Search(context.Background(), idx, emb, "竹の伐採と建材", SearchOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if len(hits) == 0 || hits[0].Rel != "2026-09-01.md" || !strings.Contains(hits[0].Text, "竹") {
		t.Fatalf("hits = %+v", hits)
	}
	if info.Chunks != st.Chunks || info.Candidates != st.Chunks {
		t.Errorf("info = %+v, chunks = %d", info, st.Chunks)
	}
	if hits[0].Line != 3 || hits[0].Date != "2026-09-01" || hits[0].Heading != "2026-09-01 09:00" || hits[0].Kind != KindNote {
		t.Errorf("hit metadata: %+v", hits[0])
	}
	// the query is embedded as a query; the documents as documents, with the date and heading in front
	found := false
	for _, x := range emb.texts {
		if strings.HasPrefix(x, "2026-09-01 > 2026-09-01 09:00\n竹は") {
			found = true
		}
	}
	if !found {
		t.Errorf("document texts do not carry their header: %q", emb.texts)
	}
	// the index is outside the scrap folder
	if rel, _ := filepath.Rel(scrap, idx); !strings.HasPrefix(rel, "..") {
		t.Fatalf("test setup: the index %s is inside %s", idx, scrap)
	}
	// subfolder paths are kept with "/"
	hits, _, _ = Search(context.Background(), idx, emb, "議事録 見積もり 佐藤", SearchOptions{})
	if len(hits) == 0 || hits[0].Rel != "sub/2026-09-03.md" {
		t.Errorf("subfolder hit: %+v", hits)
	}
}

func TestUpdateIsIncrementalAndCostsNothingWhenNothingChanged(t *testing.T) {
	scrap, idx := dirs(t)
	seed(t, scrap)
	emb := newFake()
	first, err := Update(context.Background(), scrap, idx, emb, newOpts())
	if err != nil {
		t.Fatal(err)
	}
	calls := emb.calls
	again, err := Update(context.Background(), scrap, idx, emb, newOpts())
	if err != nil {
		t.Fatal(err)
	}
	if again.FilesChanged != 0 || again.Embedded != 0 || emb.calls != calls || again.Chunks != first.Chunks {
		t.Fatalf("an Update with nothing new must not call the model: %+v, calls %d -> %d", again, calls, emb.calls)
	}

	// one new entry appended to a day: only its text is embedded, the rest of the day is found by hash
	p := filepath.Join(scrap, "2026-09-01.md")
	old, _ := os.ReadFile(p)
	if err := os.WriteFile(p, append(old, []byte(note("2026-09-01", "18:00", "新しく書いた夜のメモ。"))...), 0o644); err != nil {
		t.Fatal(err)
	}
	upd, err := Update(context.Background(), scrap, idx, emb, newOpts())
	if err != nil {
		t.Fatal(err)
	}
	if upd.FilesChanged != 1 || upd.Embedded != 1 || upd.ChunksReused < 2 || upd.Chunks != first.Chunks+1 {
		t.Fatalf("appending one entry: %+v (before: %+v)", upd, first)
	}
	hits, _, err := Search(context.Background(), idx, emb, "新しく書いた夜のメモ", SearchOptions{})
	if err != nil || len(hits) == 0 || hits[0].Heading != "2026-09-01 18:00" {
		t.Fatalf("the new entry is searchable: %+v, %v", hits, err)
	}
	// no entry appears twice: the chunks of the old version of the file are dead
	seen := map[string]bool{}
	hits, _, _ = Search(context.Background(), idx, emb, "メモ", SearchOptions{Limit: 50})
	for _, h := range hits {
		k := fmt.Sprintf("%s#%d", h.Rel, h.Entry)
		if seen[k] {
			t.Errorf("entry %s listed twice", k)
		}
		seen[k] = true
	}
}

func TestSameTextAndForceCostNothing(t *testing.T) {
	scrap, idx := dirs(t)
	seed(t, scrap)
	emb := newFake()
	if _, err := Update(context.Background(), scrap, idx, emb, newOpts()); err != nil {
		t.Fatal(err)
	}
	// a copy of a day (same text, other file) shares the vectors
	data, _ := os.ReadFile(filepath.Join(scrap, "2026-09-01.md"))
	writeFile(t, scrap, "copy/2026-09-01.md", string(data))
	calls := emb.calls
	st, err := Update(context.Background(), scrap, idx, emb, newOpts())
	if err != nil || st.Embedded != 0 || emb.calls != calls || st.ChunksReused == 0 {
		t.Fatalf("a copied file costs no embedding: %+v %v", st, err)
	}
	// touching a file without changing its text: re-read (the time moved), nothing embedded, nothing stored twice
	p := filepath.Join(scrap, "2026-09-02.md")
	future := time.Now().Add(time.Hour)
	if err := os.Chtimes(p, future, future); err != nil {
		t.Fatal(err)
	}
	before, _ := OpenStore(idx)
	st, err = Update(context.Background(), scrap, idx, emb, newOpts())
	if err != nil || st.FilesChanged != 1 || st.Embedded != 0 {
		t.Fatalf("touched: %+v %v", st, err)
	}
	after, _ := OpenStore(idx)
	if after.Manifest().Metas != before.Manifest().Metas {
		t.Errorf("a touched file with the same chunks stored its chunks again: %d -> %d", before.Manifest().Metas, after.Manifest().Metas)
	}
	// Force reads everything but still embeds nothing
	o := newOpts()
	o.Force = true
	st, err = Update(context.Background(), scrap, idx, emb, o)
	if err != nil || st.FilesChanged != st.Files || st.Embedded != 0 {
		t.Fatalf("force: %+v %v", st, err)
	}
}

func TestRemovedFilesLeaveTheIndex(t *testing.T) {
	scrap, idx := dirs(t)
	seed(t, scrap)
	emb := newFake()
	first, _ := Update(context.Background(), scrap, idx, emb, newOpts())
	if err := os.Remove(filepath.Join(scrap, "sub", "2026-09-03.md")); err != nil {
		t.Fatal(err)
	}
	st, err := Update(context.Background(), scrap, idx, emb, newOpts())
	if err != nil || st.FilesRemoved != 1 || st.Chunks >= first.Chunks || st.Embedded != 0 {
		t.Fatalf("%+v %v", st, err)
	}
	hits, _, _ := Search(context.Background(), idx, emb, "議事録 見積もり 佐藤", SearchOptions{})
	for _, h := range hits {
		if strings.HasPrefix(h.Rel, "sub/") {
			t.Errorf("a removed file is still found: %+v", h)
		}
	}
}

func TestSettleMinutesLeavesFreshFilesForLater(t *testing.T) {
	scrap, idx := dirs(t)
	seed(t, scrap)
	emb := newFake()
	o := newOpts()
	o.SettleMinutes = 10
	// all three files were just written
	st, err := Update(context.Background(), scrap, idx, emb, o)
	if err != nil || st.FilesSettling != 3 || st.Embedded != 0 || st.Chunks != 0 {
		t.Fatalf("%+v %v", st, err)
	}
	if info, _ := Status(scrap, idx); info.NewFiles != 3 {
		t.Errorf("settling files are still pending: %+v", info)
	}
	o.Now = func() time.Time { return time.Now().Add(11 * time.Minute) }
	st, err = Update(context.Background(), scrap, idx, emb, o)
	if err != nil || st.FilesSettling != 0 || st.FilesChanged != 3 || st.Chunks == 0 {
		t.Fatalf("%+v %v", st, err)
	}
}

func TestDryRunWritesNothingAndCallsNoModel(t *testing.T) {
	scrap, idx := dirs(t)
	seed(t, scrap)
	emb := newFake()
	o := newOpts()
	o.DryRun = true
	st, err := Update(context.Background(), scrap, idx, emb, o)
	if err != nil || st.FilesChanged != 3 || st.ChunksNew == 0 || st.Embedded != 0 || emb.calls != 0 {
		t.Fatalf("%+v %v", st, err)
	}
	if _, serr := os.Stat(idx); !os.IsNotExist(serr) {
		t.Errorf("a dry run created %s", idx)
	}
}

func distinctTexts(f *fakeEmb) (all, distinct int) {
	m := map[string]bool{}
	for _, x := range f.texts {
		m[x] = true
	}
	return len(f.texts), len(m)
}

func TestInterruptedRunKeepsWhatItDidAndResumes(t *testing.T) {
	scrap, idx := dirs(t)
	for i := 0; i < 12; i++ {
		d := fmt.Sprintf("2026-08-%02d", i+1)
		writeFile(t, scrap, d+".md", note(d, "09:00", fmt.Sprintf("第%d日のメモ。固有の単語 alpha%d を書いた。", i, i*7))+note(d, "13:00", fmt.Sprintf("午後は別の話 beta%d。", i*11)))
	}
	emb := newFake()
	o := newOpts()
	o.BatchSize = 4
	emb.failAt = 3 // the third request fails
	st, err := Update(context.Background(), scrap, idx, emb, o)
	if err == nil || !strings.Contains(err.Error(), "down") {
		t.Fatalf("the failure must be reported: %v", err)
	}
	if st.Embedded == 0 || st.Embedded >= 24 {
		t.Fatalf("part of the work was done: %+v", st)
	}
	info, serr := Status(scrap, idx)
	if serr != nil || info.Chunks == 0 || info.Chunks >= 24 || info.Pending() == 0 {
		t.Fatalf("what was done is kept, the rest is pending: %+v %v", info, serr)
	}
	// the index in that state can be searched
	if _, _, err := Search(context.Background(), idx, emb, "午後は別の話", SearchOptions{}); err != nil {
		t.Fatalf("search of a half-built index: %v", err)
	}
	emb.texts = emb.texts[:len(emb.texts)-1] // the query is not a document
	// the next run finishes it, and nothing is embedded twice
	st2, err := Update(context.Background(), scrap, idx, emb, o)
	if err != nil {
		t.Fatal(err)
	}
	all, distinct := distinctTexts(emb)
	if all != distinct {
		t.Errorf("%d texts were sent, %d distinct: some were embedded twice", all, distinct)
	}
	info, _ = Status(scrap, idx)
	if st.Embedded+st2.Embedded != all || info.Pending() != 0 || st2.Chunks != 24 {
		t.Errorf("resumed: first %+v, second %+v, status %+v", st, st2, info)
	}
}

func TestCancelledContextStopsAndLeavesAUsableIndex(t *testing.T) {
	scrap, idx := dirs(t)
	seed(t, scrap)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	emb := newFake()
	_, err := Update(ctx, scrap, idx, emb, newOpts())
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("err = %v", err)
	}
	if _, serr := Status(scrap, idx); serr != nil {
		t.Errorf("status after a cancelled run: %v", serr)
	}
	if _, err := Update(context.Background(), scrap, idx, emb, newOpts()); err != nil {
		t.Fatalf("the next run: %v", err)
	}
}

func TestRebuildNeededWhenModelOrChunkingChanges(t *testing.T) {
	scrap, idx := dirs(t)
	seed(t, scrap)
	a := newFake()
	if _, err := Update(context.Background(), scrap, idx, a, newOpts()); err != nil {
		t.Fatal(err)
	}
	b := newFake()
	b.id = "fake|other|96"
	if _, err := Update(context.Background(), scrap, idx, b, newOpts()); !errors.Is(err, ErrRebuildNeeded) {
		t.Fatalf("another model: %v", err)
	}
	if _, _, err := Search(context.Background(), idx, b, "竹", SearchOptions{}); !errors.Is(err, ErrModelMismatch) {
		t.Fatalf("search with another model: %v", err)
	}
	o := newOpts()
	o.Chunk.MaxChars = 300
	if _, err := Update(context.Background(), scrap, idx, a, o); !errors.Is(err, ErrRebuildNeeded) {
		t.Fatalf("another chunk size: %v", err)
	}
	o = newOpts()
	o.Chunk.IncludeAI = true
	if _, err := Update(context.Background(), scrap, idx, a, o); !errors.Is(err, ErrRebuildNeeded) {
		t.Fatalf("AI blocks switched on: %v", err)
	}
	// the old index is untouched and works until the rebuild is done
	if _, _, err := Search(context.Background(), idx, a, "竹", SearchOptions{}); err != nil {
		t.Fatalf("the old index: %v", err)
	}
	st, err := Rebuild(context.Background(), scrap, idx, b, newOpts())
	if err != nil || st.Chunks == 0 || st.Embedded != st.ChunksNew {
		t.Fatalf("rebuild: %+v %v", st, err)
	}
	if hits, _, err := Search(context.Background(), idx, b, "竹の伐採", SearchOptions{}); err != nil || len(hits) == 0 {
		t.Fatalf("after the rebuild: %v %v", hits, err)
	}
	if _, _, err := Search(context.Background(), idx, a, "竹", SearchOptions{}); !errors.Is(err, ErrModelMismatch) {
		t.Fatalf("the old model must not search the new index: %v", err)
	}
	for _, leftover := range []string{idx + ".rebuild", idx + ".old"} {
		if _, err := os.Stat(leftover); !os.IsNotExist(err) {
			t.Errorf("%s was left behind", leftover)
		}
	}
	if _, err := os.Stat(filepath.Join(idx, lockFile)); !os.IsNotExist(err) {
		t.Errorf("the lock file survived the rebuild")
	}
	// a failed rebuild leaves the old index in place
	c := newFake()
	c.id = "fake|third|96"
	c.failAt = 1
	if _, err := Rebuild(context.Background(), scrap, idx, c, newOpts()); err == nil {
		t.Fatal("the failure must be reported")
	}
	if _, _, err := Search(context.Background(), idx, b, "竹の伐採", SearchOptions{}); err != nil {
		t.Fatalf("a failed rebuild broke the index: %v", err)
	}
}

func TestRebuildOfAnEmptyOrMissingIndexJustBuilds(t *testing.T) {
	scrap, idx := dirs(t)
	seed(t, scrap)
	emb := newFake()
	if st, err := Rebuild(context.Background(), scrap, idx, emb, newOpts()); err != nil || st.Chunks == 0 {
		t.Fatalf("%+v %v", st, err)
	}
}

func TestLock(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "idx")
	un, err := Lock(dir)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := Lock(dir); !errors.Is(err, ErrLocked) {
		t.Fatalf("second lock: %v", err)
	}
	scrap, _ := dirs(t)
	seed(t, scrap)
	if _, err := Update(context.Background(), scrap, dir, newFake(), newOpts()); !errors.Is(err, ErrLocked) {
		t.Fatalf("update while locked: %v", err)
	}
	un()
	un2, err := Lock(dir)
	if err != nil {
		t.Fatalf("after unlock: %v", err)
	}
	un2()
	// a lock left by a process that died is taken over
	p := filepath.Join(dir, lockFile)
	if err := os.WriteFile(p, []byte("99999\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	old := time.Now().Add(-2 * time.Hour)
	if err := os.Chtimes(p, old, old); err != nil {
		t.Fatal(err)
	}
	un3, err := Lock(dir)
	if err != nil {
		t.Fatalf("stale lock: %v", err)
	}
	un3()
}

func TestStoreSurvivesTheLeftoversOfACrash(t *testing.T) {
	scrap, idx := dirs(t)
	seed(t, scrap)
	emb := newFake()
	first, err := Update(context.Background(), scrap, idx, emb, newOpts())
	if err != nil {
		t.Fatal(err)
	}
	// a crash after appending but before the manifest: junk past the committed ends of both files
	appendTo := func(name string, b []byte) {
		f, err := os.OpenFile(filepath.Join(idx, name), os.O_APPEND|os.O_WRONLY, 0o644)
		if err != nil {
			t.Fatal(err)
		}
		defer f.Close()
		if _, err := f.Write(b); err != nil {
			t.Fatal(err)
		}
	}
	appendTo(chunksFile, []byte(`{"rel":"ghost.md","text":"half a li`))
	appendTo(vectorsFile, make([]byte, 7*96*4+3))
	hits, _, err := Search(context.Background(), idx, emb, "竹の伐採", SearchOptions{})
	if err != nil || len(hits) == 0 || hits[0].Rel != "2026-09-01.md" {
		t.Fatalf("search with junk past the end: %+v %v", hits, err)
	}
	// the next write replaces the junk
	writeFile(t, scrap, "2026-09-04.md", note("2026-09-04", "07:00", "朝の散歩で見た桜が綺麗だった。"))
	st, err := Update(context.Background(), scrap, idx, emb, newOpts())
	if err != nil || st.Chunks != first.Chunks+1 {
		t.Fatalf("%+v %v", st, err)
	}
	hits, _, err = Search(context.Background(), idx, emb, "朝の散歩 桜", SearchOptions{})
	if err != nil || len(hits) == 0 || hits[0].Rel != "2026-09-04.md" {
		t.Fatalf("after the next write: %+v %v", hits, err)
	}
	for _, h := range hits {
		if h.Rel == "ghost.md" {
			t.Fatal("junk became a chunk")
		}
	}
	store, err := OpenStore(idx)
	if err != nil {
		t.Fatal(err)
	}
	if fi, _ := os.Stat(filepath.Join(idx, vectorsFile)); fi.Size() != int64(vectorsHeader+store.m.Vecs*store.m.Dim*4) {
		t.Errorf("vectors.bin is %d bytes for %d rows", fi.Size(), store.m.Vecs)
	}
}

func TestDamagedIndexIsReportedNotTrusted(t *testing.T) {
	scrap, idx := dirs(t)
	seed(t, scrap)
	emb := newFake()
	if _, err := Update(context.Background(), scrap, idx, emb, newOpts()); err != nil {
		t.Fatal(err)
	}
	vec := filepath.Join(idx, vectorsFile)
	raw, _ := os.ReadFile(vec)
	if err := os.WriteFile(vec, raw[:len(raw)/2], 0o644); err != nil {
		t.Fatal(err)
	}
	if _, _, err := Search(context.Background(), idx, emb, "竹", SearchOptions{}); !errors.Is(err, ErrCorrupt) {
		t.Errorf("a short vector file: %v", err)
	}
	if info, err := Status(scrap, idx); !errors.Is(err, ErrCorrupt) || !info.Corrupt {
		t.Errorf("status of a short vector file: %+v %v", info, err)
	}
	if _, err := Update(context.Background(), scrap, idx, emb, newOpts()); !errors.Is(err, ErrCorrupt) {
		t.Errorf("update of a damaged index: %v", err)
	}
	// Rebuild is the way out
	if _, err := Rebuild(context.Background(), scrap, idx, emb, newOpts()); err != nil {
		t.Fatalf("rebuild of a damaged index: %v", err)
	}
	if _, _, err := Search(context.Background(), idx, emb, "竹", SearchOptions{}); err != nil {
		t.Errorf("after the rebuild: %v", err)
	}
	// a manifest that is not JSON
	if err := os.WriteFile(filepath.Join(idx, manifestFile), []byte("{not json"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := OpenStore(idx); !errors.Is(err, ErrCorrupt) {
		t.Errorf("a broken manifest: %v", err)
	}
}

func TestCompactionDropsDeadChunks(t *testing.T) {
	scrap, idx := dirs(t)
	emb := newFake()
	write := func(tag string) {
		var sb strings.Builder
		for i := 0; i < 300; i++ {
			sb.WriteString(note("2026-07-01", fmt.Sprintf("%02d:%02d", i/60, i%60), fmt.Sprintf("%s の項目 %d。語 %s%d", tag, i, tag, i*13)))
		}
		writeFile(t, scrap, "2026-07-01.md", sb.String())
	}
	write("初版")
	o := newOpts()
	o.CommitEvery = 100
	first, err := Update(context.Background(), scrap, idx, emb, o)
	if err != nil || first.Chunks != 300 || first.Compacted {
		t.Fatalf("%+v %v", first, err)
	}
	write("改版")
	st, err := Update(context.Background(), scrap, idx, emb, o)
	if err != nil || !st.Compacted || st.Chunks != 300 {
		t.Fatalf("the second version replaces every chunk: %+v %v", st, err)
	}
	store, err := OpenStore(idx)
	if err != nil {
		t.Fatal(err)
	}
	m := store.Manifest()
	if m.Metas != 300 || len(m.Dead) != 0 || m.Vecs != 300 {
		t.Errorf("after compaction: metas %d, dead %d, vecs %d", m.Metas, len(m.Dead), m.Vecs)
	}
	if fi, _ := os.Stat(filepath.Join(idx, vectorsFile)); fi.Size() != int64(vectorsHeader+300*m.Dim*4) {
		t.Errorf("vectors.bin = %d bytes", fi.Size())
	}
	hits, _, err := Search(context.Background(), idx, emb, "改版 の項目 42", SearchOptions{})
	if err != nil || len(hits) == 0 || !strings.Contains(hits[0].Text, "改版") {
		t.Fatalf("search after compaction: %+v %v", hits, err)
	}
	// the file record still points at the right chunks: removing the file empties the index
	if err := os.Remove(filepath.Join(scrap, "2026-07-01.md")); err != nil {
		t.Fatal(err)
	}
	if st, err := Update(context.Background(), scrap, idx, emb, o); err != nil || st.Chunks != 0 || st.FilesRemoved != 1 {
		t.Fatalf("%+v %v", st, err)
	}
}

func TestWrongDimensionIsRefused(t *testing.T) {
	scrap, idx := dirs(t)
	seed(t, scrap)
	emb := newFake()
	if _, err := Update(context.Background(), scrap, idx, emb, newOpts()); err != nil {
		t.Fatal(err)
	}
	writeFile(t, scrap, "2026-09-09.md", note("2026-09-09", "09:00", "別の次元のモデルが来た。"))
	other := newFake() // the same id, but it now answers with other lengths
	other.dim = 64
	if _, err := Update(context.Background(), scrap, idx, other, newOpts()); err == nil || !strings.Contains(err.Error(), "numbers per vector") {
		t.Fatalf("err = %v", err)
	}
	if _, _, err := Search(context.Background(), idx, other, "竹", SearchOptions{}); err == nil {
		t.Error("a query vector of another length must not be compared")
	}
	if _, _, err := Search(context.Background(), idx, emb, "竹", SearchOptions{}); err != nil {
		t.Errorf("the index is still usable: %v", err)
	}
}

func TestListFilesRules(t *testing.T) {
	scrap, _ := dirs(t)
	for _, rel := range []string{
		"2026-09-01.md", "keep/a.md", "UPPER.MD",
		".git/x.md", ".hidden/x.md", "assets/y.md", "Assets/z.md",
		"2026-09-01 (sync conflict 2026-09-02).md", "notes.txt",
		"private/secret.md", "deep/private/inner.md", "drafts/wip.md", "tmp-1.md", "x/tmp-2.md", "exact/one.md", "exact/two.md",
	} {
		writeFile(t, scrap, rel, "# 2026-01-01 00:00\n\n本文\n")
	}
	writeFile(t, scrap, ".md-memo-ignore", "# comment\n\nprivate/\ndrafts\n*.tmp\ntmp-*.md\nexact/one.md\r\n")
	files, err := listFiles(scrap)
	if err != nil {
		t.Fatal(err)
	}
	var got []string
	for _, f := range files {
		got = append(got, f.rel)
	}
	sort.Strings(got)
	want := []string{"2026-09-01.md", "UPPER.MD", "exact/two.md", "keep/a.md"}
	sort.Strings(want)
	if strings.Join(got, "|") != strings.Join(want, "|") {
		t.Errorf("listed %v, want %v", got, want)
	}
	if _, err := listFiles(filepath.Join(scrap, "nope")); err == nil {
		t.Error("a missing scrap folder must be an error")
	}
}

func TestStatusAndPendingFiles(t *testing.T) {
	scrap, idx := dirs(t)
	seed(t, scrap)
	info, err := Status(scrap, idx)
	if err != nil || info.Exists || info.NewFiles != 3 || info.FilesInFolder != 3 || info.Pending() != 3 {
		t.Fatalf("before the first build: %+v %v", info, err)
	}
	emb := newFake()
	if _, err := Update(context.Background(), scrap, idx, emb, newOpts()); err != nil {
		t.Fatal(err)
	}
	info, _ = Status(scrap, idx)
	if !info.Exists || info.Embedder != emb.id || info.Dim != 96 || info.Pending() != 0 || info.Chunks == 0 || info.SizeBytes == 0 || info.Updated.IsZero() {
		t.Fatalf("after: %+v", info)
	}
	writeFile(t, scrap, "2026-09-01.md", "# 2026-09-01 09:00\n\n書き換えた。\n")
	writeFile(t, scrap, "2026-09-05.md", "# 2026-09-05 09:00\n\n新しい日。\n")
	if err := os.Remove(filepath.Join(scrap, "2026-09-02.md")); err != nil {
		t.Fatal(err)
	}
	info, _ = Status(scrap, idx)
	if info.NewFiles != 1 || info.ChangedFiles != 1 || info.RemovedFiles != 1 || info.Pending() != 3 {
		t.Fatalf("%+v", info)
	}
	pend, err := PendingFiles(scrap, idx)
	if err != nil || !pend["2026-09-01.md"] || !pend["2026-09-05.md"] || len(pend) != 2 {
		t.Fatalf("pending = %v %v", pend, err)
	}
}

// A build that takes longer than lockStale must not look dead: Update and Rebuild touch their lock after every batch. At the start of
// each request the fake model looks at the lock's age (it must have been touched since the request before) and then ages it by hours.
func TestLongRunsKeepTheirLockFresh(t *testing.T) {
	for _, rebuild := range []bool{false, true} {
		scrap, idx := dirs(t)
		for i := 0; i < 6; i++ {
			d := fmt.Sprintf("2026-08-%02d", i+1)
			writeFile(t, scrap, d+".md", note(d, "09:00", fmt.Sprintf("第%d日。固有の語 alpha%d。", i, i*7))+note(d, "13:00", fmt.Sprintf("午後 beta%d。", i*11)))
		}
		lockPath := filepath.Join(idx, lockFile) // Rebuild's own lock is this one; Update's lock is in the same place
		emb := newFake()
		fresh, stale := 0, 0
		emb.onCall = func(n int) {
			if n >= 2 {
				if fi, err := os.Stat(lockPath); err == nil && time.Since(fi.ModTime()) < time.Minute {
					fresh++
				} else {
					stale++
				}
			}
			age(t, lockPath, 2*time.Hour)
		}
		o := newOpts()
		o.BatchSize = 3
		var err error
		if rebuild {
			_, err = Rebuild(context.Background(), scrap, idx, emb, o)
		} else {
			_, err = Update(context.Background(), scrap, idx, emb, o)
		}
		if err != nil {
			t.Fatalf("rebuild=%v: %v", rebuild, err)
		}
		if emb.calls < 3 || fresh == 0 || stale != 0 {
			t.Errorf("rebuild=%v: %d requests, the lock was fresh %d times and stale %d times", rebuild, emb.calls, fresh, stale)
		}
	}
}

func age(t *testing.T, path string, by time.Duration) {
	t.Helper()
	old := time.Now().Add(-by)
	if err := os.Chtimes(path, old, old); err != nil {
		t.Errorf("age the lock %s: %v", path, err)
	}
}

func TestExcludedIsWhatTheIndexLeavesOut(t *testing.T) {
	scrap, _ := dirs(t)
	writeFile(t, scrap, ".md-memo-ignore", "# private\nprivate/\ndrafts\n*.tmp\nexact/one.md\n")
	ex := Excluded(scrap)
	for rel, want := range map[string]bool{
		"2026-09-01.md": false, "keep/a.md": false, "UPPER.MD": false, "exact/two.md": false,
		".git/x.md": true, ".hidden/deep/x.md": true, "assets/y.md": true, "Assets/z.md": true, "a/assets/y.md": true,
		"2026-09-01 (sync conflict 2026-09-02).md": true,
		"private/secret.md":                        true, "deep/private/inner.md": true, "drafts/wip.md": true, "x.tmp": true, "exact/one.md": true,
		"/leading/slash.md": false,
	} {
		if got := ex(rel); got != want {
			t.Errorf("Excluded(%q) = %v, want %v", rel, got, want)
		}
	}
	// a Windows path (a backslash is the separator there; on another system it is a letter of the name, and the rel of a file is
	// always written with "/")
	if filepath.Separator == '\\' && !ex(`private\win.md`) {
		t.Errorf(`Excluded("private\win.md") = false on Windows, want true`)
	}
	// the files listFiles keeps are exactly those Excluded lets through
	for _, f := range []string{"2026-09-01.md", "keep/a.md", ".git/x.md", "assets/y.md", "private/secret.md", "drafts/wip.md"} {
		writeFile(t, scrap, f, "# 2026-01-01 00:00\n\n本文\n")
	}
	files, _ := listFiles(scrap)
	for _, f := range files {
		if ex(f.rel) {
			t.Errorf("the index lists %s, which Excluded refuses", f.rel)
		}
	}
}
