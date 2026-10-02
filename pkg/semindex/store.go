package semindex

import (
	"bufio"
	"bytes"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"os"
	"path/filepath"
	"sort"
	"time"

	"md-memo/pkg/atomicfile"
)

// The index lives in one folder (outside the scrap folder, see IndexDir):
//
//	manifest.json   what is valid: the embedder, the chunking, the counts, the files seen; rewritten whole, atomically
//	chunks.jsonl    one line per chunk (its text and place, and the row of its vector); only ever appended to
//	vectors.bin     "MDSV", version, dim, 0, then one row of dim float32 (little endian) per distinct chunk text; only appended to
//	index.lock      present while a process updates the index
//
// The manifest is the commit point: rows and bytes beyond what it says are the leftovers of an interrupted run and are ignored (and
// overwritten by the next append). Two chunks with the same text (the same embedded text) share one vector row, so an unchanged chunk
// of a changed file, or a copy of a note, costs no new embedding. A chunk that is replaced is marked dead; the files are rewritten
// ("compacted") when many are dead.

const (
	storeVersion  = 1
	manifestFile  = "manifest.json"
	chunksFile    = "chunks.jsonl"
	vectorsFile   = "vectors.bin"
	lockFile      = "index.lock"
	vectorsHeader = 16
)

// ErrCorrupt means the files of the index do not match its manifest (an interrupted compaction, a damaged disk). The index holds only
// derived data: rebuild it.
var ErrCorrupt = errors.New("the semantic index is damaged; rebuild it (md-memo scrap index --rebuild)")

// FileRec is what the index knows of one scrap file: its size and time when it was last read, and the chunk rows made from it.
type FileRec struct {
	Size  int64 `json:"size"`
	ModNs int64 `json:"mod_ns"`
	Metas []int `json:"metas"`
}

// Manifest is the commit record of an index.
type Manifest struct {
	Version        int                `json:"version"`
	Embedder       string             `json:"embedder"` // embed.Embedder.ID() of the model the vectors come from
	Dim            int                `json:"dim"`
	ChunkerVersion int                `json:"chunker_version"`
	MaxChars       int                `json:"max_chars"`
	Header         bool               `json:"header"`
	IncludeAI      bool               `json:"include_ai"`
	Metas          int                `json:"metas"`       // valid lines of chunks.jsonl
	MetasBytes     int64              `json:"metas_bytes"` // and their length
	Vecs           int                `json:"vecs"`        // valid rows of vectors.bin
	Dead           []int              `json:"dead,omitempty"`
	Files          map[string]FileRec `json:"files"`
	Updated        time.Time          `json:"updated"`
}

// meta is one line of chunks.jsonl.
type meta struct {
	Chunk
	V int `json:"v"` // row of the chunk's vector
}

// Store is an opened index.
type Store struct {
	dir   string
	m     Manifest
	metas []meta
	dead  map[int]bool
	hv    map[string]int // chunk hash -> vector row, from every line of chunks.jsonl (dead ones too: their vectors are still there)
}

func newManifest() Manifest {
	return Manifest{Version: storeVersion, Files: map[string]FileRec{}}
}

// OpenStore opens the index in dir; a folder with no manifest is an empty index. It reads the chunk lines (the text of every chunk).
func OpenStore(dir string) (*Store, error) {
	s := &Store{dir: dir, m: newManifest(), dead: map[int]bool{}, hv: map[string]int{}}
	raw, err := os.ReadFile(filepath.Join(dir, manifestFile))
	if errors.Is(err, os.ErrNotExist) {
		return s, nil
	}
	if err != nil {
		return nil, err
	}
	if err := json.Unmarshal(raw, &s.m); err != nil {
		return nil, fmt.Errorf("%w (%v)", ErrCorrupt, err)
	}
	if s.m.Version != storeVersion {
		return nil, fmt.Errorf("%w (format version %d)", ErrCorrupt, s.m.Version)
	}
	if s.m.Files == nil {
		s.m.Files = map[string]FileRec{}
	}
	for _, d := range s.m.Dead {
		s.dead[d] = true
	}
	if err := s.loadMetas(); err != nil {
		return nil, err
	}
	return s, nil
}

func (s *Store) loadMetas() error {
	if s.m.Metas == 0 {
		return nil
	}
	f, err := os.Open(filepath.Join(s.dir, chunksFile))
	if err != nil {
		return fmt.Errorf("%w (%v)", ErrCorrupt, err)
	}
	defer f.Close()
	r := bufio.NewReaderSize(io.LimitReader(f, s.m.MetasBytes), 1<<20)
	s.metas = make([]meta, 0, s.m.Metas)
	for {
		line, err := r.ReadBytes('\n')
		if len(bytes.TrimSpace(line)) > 0 {
			var mt meta
			if jerr := json.Unmarshal(line, &mt); jerr != nil {
				return fmt.Errorf("%w (%v)", ErrCorrupt, jerr)
			}
			s.metas = append(s.metas, mt)
			s.hv[mt.Hash] = mt.V
		}
		if err != nil {
			break
		}
	}
	if len(s.metas) != s.m.Metas {
		return fmt.Errorf("%w (%d chunk lines, the manifest says %d)", ErrCorrupt, len(s.metas), s.m.Metas)
	}
	if fi, err := os.Stat(filepath.Join(s.dir, vectorsFile)); err != nil || fi.Size() < int64(vectorsHeader+s.m.Vecs*s.m.Dim*4) {
		return fmt.Errorf("%w (the vector file is shorter than the manifest says)", ErrCorrupt)
	}
	return nil
}

// Manifest returns a copy of the commit record.
func (s *Store) Manifest() Manifest { return s.m }

// Empty reports whether the index holds no chunk at all.
func (s *Store) Empty() bool { return s.m.Metas == 0 }

// liveCount is the number of chunks that are not dead.
func (s *Store) liveCount() int { return s.m.Metas - len(s.dead) }

// VectorRow is the row of the vector of a chunk text with this hash, if there is one.
func (s *Store) VectorRow(hash string) (int, bool) {
	v, ok := s.hv[hash]
	return v, ok
}

// AppendVectors adds vectors and returns the row of the first one. Every vector has the index's dimension (the first call fixes it).
func (s *Store) AppendVectors(vs [][]float32) (int, error) {
	if len(vs) == 0 {
		return s.m.Vecs, nil
	}
	dim := len(vs[0])
	if dim == 0 {
		return 0, errors.New("an empty vector came back from the embedder")
	}
	if s.m.Dim == 0 {
		s.m.Dim = dim
	}
	if dim != s.m.Dim {
		return 0, fmt.Errorf("the embedder returned %d numbers per vector; the index holds %d (rebuild it if the model changed)", dim, s.m.Dim)
	}
	if err := os.MkdirAll(s.dir, 0o755); err != nil {
		return 0, err
	}
	path := filepath.Join(s.dir, vectorsFile)
	f, err := os.OpenFile(path, os.O_RDWR|os.O_CREATE, 0o644)
	if err != nil {
		return 0, err
	}
	defer f.Close()
	if fi, err := f.Stat(); err == nil && fi.Size() < vectorsHeader {
		var h [vectorsHeader]byte
		copy(h[:4], "MDSV")
		binary.LittleEndian.PutUint32(h[4:], storeVersion)
		binary.LittleEndian.PutUint32(h[8:], uint32(s.m.Dim))
		if _, err := f.WriteAt(h[:], 0); err != nil {
			return 0, err
		}
	}
	first := s.m.Vecs
	end := int64(vectorsHeader + first*s.m.Dim*4)
	if err := f.Truncate(end); err != nil { // drop what an interrupted run left past the committed rows
		return 0, err
	}
	buf := make([]byte, 0, len(vs)*s.m.Dim*4)
	for _, v := range vs {
		if len(v) != s.m.Dim {
			return 0, errors.New("vectors of different lengths in one batch")
		}
		for _, x := range v {
			buf = binary.LittleEndian.AppendUint32(buf, math.Float32bits(x))
		}
	}
	if _, err := f.WriteAt(buf, end); err != nil {
		return 0, err
	}
	s.m.Vecs += len(vs)
	return first, nil
}

// AppendMetas adds chunk lines (each pointing at its vector row) and returns the row numbers they got.
func (s *Store) AppendMetas(ms []meta) ([]int, error) {
	if len(ms) == 0 {
		return nil, nil
	}
	if err := os.MkdirAll(s.dir, 0o755); err != nil {
		return nil, err
	}
	f, err := os.OpenFile(filepath.Join(s.dir, chunksFile), os.O_RDWR|os.O_CREATE, 0o644)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	if err := f.Truncate(s.m.MetasBytes); err != nil {
		return nil, err
	}
	var buf bytes.Buffer
	rows := make([]int, len(ms))
	for i, mt := range ms {
		line, err := json.Marshal(mt)
		if err != nil {
			return nil, err
		}
		buf.Write(line)
		buf.WriteByte('\n')
		rows[i] = s.m.Metas + i
	}
	if _, err := f.WriteAt(buf.Bytes(), s.m.MetasBytes); err != nil {
		return nil, err
	}
	s.m.Metas += len(ms)
	s.m.MetasBytes += int64(buf.Len())
	s.metas = append(s.metas, ms...)
	for _, mt := range ms {
		s.hv[mt.Hash] = mt.V
	}
	return rows, nil
}

// Kill marks chunk rows as dead: they are skipped by searches and dropped by the next compaction.
func (s *Store) Kill(rows []int) {
	for _, r := range rows {
		if r >= 0 && r < s.m.Metas {
			s.dead[r] = true
		}
	}
}

// Commit makes everything appended so far (and the dead marks) valid, by writing the manifest.
func (s *Store) Commit() error {
	s.m.Dead = s.m.Dead[:0]
	for d := range s.dead {
		s.m.Dead = append(s.m.Dead, d)
	}
	sort.Ints(s.m.Dead)
	s.m.Updated = time.Now().UTC()
	raw, err := json.Marshal(s.m)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(s.dir, 0o755); err != nil {
		return err
	}
	return atomicfile.Write(filepath.Join(s.dir, manifestFile), raw, ".manifest-*.tmp")
}

// LoadVectors reads every valid vector row into one slice (row r is [r*dim : (r+1)*dim]).
func (s *Store) LoadVectors() ([]float32, error) {
	if s.m.Vecs == 0 || s.m.Dim == 0 {
		return nil, nil
	}
	f, err := os.Open(filepath.Join(s.dir, vectorsFile))
	if err != nil {
		return nil, fmt.Errorf("%w (%v)", ErrCorrupt, err)
	}
	defer f.Close()
	n := s.m.Vecs * s.m.Dim
	raw := make([]byte, n*4)
	if _, err := f.ReadAt(raw, vectorsHeader); err != nil {
		return nil, fmt.Errorf("%w (%v)", ErrCorrupt, err)
	}
	out := make([]float32, n)
	for i := range out {
		out[i] = math.Float32frombits(binary.LittleEndian.Uint32(raw[i*4:]))
	}
	return out, nil
}

// deadShare says whether the files are worth rewriting: more than a fifth of the chunks are dead (and not just a handful).
func (s *Store) deadShare() bool {
	return len(s.dead) > 200 && len(s.dead)*5 > s.m.Metas
}

// Compact rewrites the index without its dead chunks and the vectors nobody uses any more.
func (s *Store) Compact() error {
	type keep struct {
		m   meta
		old int
	}
	var live []keep
	for i, mt := range s.metas {
		if !s.dead[i] {
			live = append(live, keep{mt, i})
		}
	}
	vecs, err := s.LoadVectors()
	if err != nil {
		return err
	}
	remap := map[int]int{} // old vector row -> new
	var newVecs []float32
	oldToNewMeta := make(map[int]int, len(live))
	var newMetas []meta
	for ni, k := range live {
		nv, ok := remap[k.m.V]
		if !ok {
			nv = len(remap)
			remap[k.m.V] = nv
			newVecs = append(newVecs, vecs[k.m.V*s.m.Dim:(k.m.V+1)*s.m.Dim]...)
		}
		mt := k.m
		mt.V = nv
		newMetas = append(newMetas, mt)
		oldToNewMeta[k.old] = ni
	}
	var vb bytes.Buffer
	var h [vectorsHeader]byte
	copy(h[:4], "MDSV")
	binary.LittleEndian.PutUint32(h[4:], storeVersion)
	binary.LittleEndian.PutUint32(h[8:], uint32(s.m.Dim))
	vb.Write(h[:])
	for _, x := range newVecs {
		var b [4]byte
		binary.LittleEndian.PutUint32(b[:], math.Float32bits(x))
		vb.Write(b[:])
	}
	var cb bytes.Buffer
	for _, mt := range newMetas {
		line, err := json.Marshal(mt)
		if err != nil {
			return err
		}
		cb.Write(line)
		cb.WriteByte('\n')
	}
	// vectors, then chunks, then the manifest: a crash in between leaves files the manifest does not match, which OpenStore reports as
	// ErrCorrupt (the index is rebuilt; nothing but derived data is lost)
	if err := atomicfile.Write(filepath.Join(s.dir, vectorsFile), vb.Bytes(), ".vectors-*.tmp"); err != nil {
		return err
	}
	if err := atomicfile.Write(filepath.Join(s.dir, chunksFile), cb.Bytes(), ".chunks-*.tmp"); err != nil {
		return err
	}
	for rel, rec := range s.m.Files {
		var rows []int
		for _, r := range rec.Metas {
			if nr, ok := oldToNewMeta[r]; ok {
				rows = append(rows, nr)
			}
		}
		rec.Metas = rows
		s.m.Files[rel] = rec
	}
	s.metas = newMetas
	s.dead = map[int]bool{}
	s.hv = map[string]int{}
	for _, mt := range newMetas {
		s.hv[mt.Hash] = mt.V
	}
	s.m.Metas = len(newMetas)
	s.m.MetasBytes = int64(cb.Len())
	s.m.Vecs = len(remap)
	return s.Commit()
}

// ---- the lock -------------------------------------------------------------------------------------------------------------------

// ErrLocked means another process is updating the index.
var ErrLocked = errors.New("the semantic index is being updated by another process")

// lockStale: a lock not touched for this long belongs to a process that died. A running Update or Rebuild touches its lock after every
// batch (touchLock), so a build that takes hours is never mistaken for a dead one.
const lockStale = time.Hour

// touchLock marks the lock in dir as in use just now.
func touchLock(dir string) {
	now := time.Now()
	_ = os.Chtimes(filepath.Join(dir, lockFile), now, now)
}

// Lock takes the index's lock (the folder is created when it is missing) and returns the function that gives it back.
func Lock(dir string) (func(), error) {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, err
	}
	path := filepath.Join(dir, lockFile)
	for attempt := 0; attempt < 2; attempt++ {
		f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o644)
		if err == nil {
			fmt.Fprintf(f, "%d\n", os.Getpid())
			f.Close()
			return func() { _ = os.Remove(path) }, nil
		}
		if !errors.Is(err, os.ErrExist) {
			return nil, err
		}
		if fi, serr := os.Stat(path); serr == nil && time.Since(fi.ModTime()) > lockStale {
			_ = os.Remove(path) // left by a process that died
			continue
		}
		return nil, ErrLocked
	}
	return nil, ErrLocked
}
