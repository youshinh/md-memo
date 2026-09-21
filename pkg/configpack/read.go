package configpack

import (
	"archive/zip"
	"bytes"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"os"
	pathpkg "path"
	"runtime"
	"sort"
	"strings"
)

// Pack is a validated package; the read methods re-check size limits on the bytes they decompress.
type Pack struct {
	Manifest Manifest
	// Ignored: entries the manifest does not list (never read).
	Ignored int
	// Skipped: listed skill files that are never restored (.env files, .git folders).
	Skipped int

	f      *os.File
	byName map[string]*zip.File
	skills map[string][]skillEntry
	budget int64
}

type skillEntry struct {
	rel string // destination-relative: "<name>/<sub>" or "<name>"
	zf  *zip.File
}

func IsZipFile(path string) (bool, error) {
	f, err := os.Open(path)
	if err != nil {
		return false, err
	}
	defer f.Close()
	var sig [2]byte
	n, err := io.ReadFull(f, sig[:])
	if err != nil && err != io.ErrUnexpectedEOF && err != io.EOF {
		return false, err
	}
	return n == 2 && sig[0] == 'P' && sig[1] == 'K', nil
}

func (p *Pack) Close() error { return p.f.Close() }

// Open validates sizes, entry names, the manifest and the declared sizes of everything it lists
// before anything is read. Unlisted entries are ignored, but their names must still be safe.
func Open(path string) (*Pack, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	p, err := openFile(f)
	if err != nil {
		f.Close()
		return nil, err
	}
	return p, nil
}

func openFile(f *os.File) (*Pack, error) {
	fi, err := f.Stat()
	if err != nil {
		return nil, err
	}
	if !fi.Mode().IsRegular() {
		return nil, ErrNotZip
	}
	size := fi.Size()
	if size > MaxPackBytes {
		return nil, ErrTooLarge
	}
	if err := precheckZip(f, size); err != nil {
		return nil, err
	}
	zr, err := zip.NewReader(f, size)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrNotZip, err)
	}
	// The 16-bit count in the end record wraps, so it cannot be relied on alone.
	if len(zr.File) > MaxEntries {
		return nil, ErrTooManyEntries
	}

	p := &Pack{f: f, byName: make(map[string]*zip.File, len(zr.File)), skills: map[string][]skillEntry{}, budget: MaxTotalBytes}
	seen := make(map[string]bool, len(zr.File))
	for _, zf := range zr.File {
		if err := ValidateEntryName(zf.Name); err != nil {
			return nil, err
		}
		key := strings.ToLower(strings.TrimSuffix(zf.Name, "/"))
		if seen[key] {
			return nil, fmt.Errorf("%w: %q", ErrDuplicate, clip(zf.Name))
		}
		seen[key] = true
		p.byName[zf.Name] = zf
	}

	mz := p.byName[ManifestName]
	if mz == nil {
		return nil, fmt.Errorf("%w: %s missing", ErrBadManifest, ManifestName)
	}
	raw, err := p.readEntry(mz, MaxManifestBytes)
	if err != nil {
		return nil, err
	}
	if err := json.Unmarshal(raw, &p.Manifest); err != nil {
		return nil, fmt.Errorf("%w: %v", ErrBadManifest, err)
	}
	if err := validateManifest(&p.Manifest); err != nil {
		return nil, err
	}
	if err := p.bind(zr.File, mz); err != nil {
		return nil, err
	}
	return p, nil
}

func (p *Pack) bind(all []*zip.File, manifest *zip.File) error {
	listed := map[*zip.File]bool{manifest: true}
	var declared int64
	take := func(zf *zip.File, limit int64) error {
		if err := checkListedEntry(zf, limit); err != nil {
			return err
		}
		listed[zf] = true
		declared += int64(zf.UncompressedSize64)
		if declared > MaxTotalBytes {
			return ErrTooLarge
		}
		return nil
	}

	groups := map[string]*skillGroup{}
	for _, zf := range all {
		root, name, sub, hasSub, ok := splitSkillEntry(zf.Name)
		if !ok {
			continue
		}
		id := SkillID(root, name)
		g := groups[id]
		if g == nil {
			g = &skillGroup{}
			groups[id] = g
		}
		switch {
		case !hasSub:
			g.file = zf
		case sub != "" && !strings.HasSuffix(zf.Name, "/"):
			g.dirFiles = append(g.dirFiles, skillEntry{rel: name + "/" + sub, zf: zf})
		}
	}

	for i := range p.Manifest.Items {
		it := &p.Manifest.Items[i]
		switch it.Kind {
		case KindConfig, KindAgents:
			zf := p.byName[it.Path]
			limit := int64(MaxConfigBytes)
			if it.Kind == KindAgents {
				limit = MaxAgentsBytes
			}
			if zf == nil {
				return fmt.Errorf("%w: %s is listed but missing", ErrBadEntry, it.ID)
			}
			if err := take(zf, limit); err != nil {
				return err
			}
		case KindSkill:
			var list []skillEntry
			if g := groups[it.ID]; g != nil {
				if it.Entry == EntryFile {
					if g.file != nil {
						list = []skillEntry{{rel: it.Name, zf: g.file}}
					}
				} else {
					for _, e := range g.dirFiles {
						if hasSkippedComponent(strings.TrimPrefix(e.rel, it.Name+"/")) {
							p.Skipped++
							listed[e.zf] = true // reported as skipped, not also as ignored
							continue
						}
						list = append(list, e)
					}
				}
			}
			if len(list) == 0 {
				return fmt.Errorf("%w: %s has no files", ErrBadEntry, it.ID)
			}
			sort.Slice(list, func(a, b int) bool { return list[a].rel < list[b].rel })
			for _, e := range list {
				if err := take(e.zf, MaxEntryBytes); err != nil {
					return err
				}
			}
			p.skills[it.ID] = list
		}
	}
	for _, zf := range all {
		if !listed[zf] && !strings.HasSuffix(zf.Name, "/") {
			p.Ignored++
		}
	}
	return nil
}

type skillGroup struct {
	file     *zip.File
	dirFiles []skillEntry
}

// splitSkillEntry parses "skills/<root>/<name>[/<sub>]".
func splitSkillEntry(name string) (root, skill, sub string, hasSub, ok bool) {
	rest, found := strings.CutPrefix(name, "skills/")
	if !found {
		return "", "", "", false, false
	}
	for _, r := range SkillRoots {
		tail, found := strings.CutPrefix(rest, r+"/")
		if !found {
			continue
		}
		first, after, has := strings.Cut(tail, "/")
		if first == "" {
			return "", "", "", false, false
		}
		return r, first, after, has, true
	}
	return "", "", "", false, false
}

// checkListedEntry refuses encrypted or exotic entries, non-regular files (links, devices) and oversize ones.
func checkListedEntry(zf *zip.File, limit int64) error {
	if zf.Flags&0x1 != 0 {
		return fmt.Errorf("%w: encrypted entry %q", ErrBadEntry, clip(zf.Name))
	}
	if zf.Method != zip.Store && zf.Method != zip.Deflate {
		return fmt.Errorf("%w: unsupported compression in %q", ErrBadEntry, clip(zf.Name))
	}
	if zf.Mode()&^fs.ModePerm != 0 {
		return fmt.Errorf("%w: %q is not a regular file", ErrBadEntry, clip(zf.Name))
	}
	if zf.UncompressedSize64 > uint64(limit) {
		return fmt.Errorf("%w: %q", ErrTooLarge, clip(zf.Name))
	}
	return nil
}

func (p *Pack) spend(n int64) error {
	p.budget -= n
	if p.budget < 0 {
		return ErrTooLarge
	}
	return nil
}

// readEntry's limit applies to the bytes actually decompressed, whatever the header claims.
func (p *Pack) readEntry(zf *zip.File, limit int64) ([]byte, error) {
	if err := checkListedEntry(zf, limit); err != nil {
		return nil, err
	}
	rc, err := zf.Open()
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrBadEntry, err)
	}
	defer rc.Close()
	b, err := io.ReadAll(io.LimitReader(rc, limit+1))
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrBadEntry, err)
	}
	if int64(len(b)) > limit {
		return nil, ErrTooLarge
	}
	if err := p.spend(int64(len(b))); err != nil {
		return nil, err
	}
	return b, nil
}

// ReadConfig returns nil when the pack has no settings.
func (p *Pack) ReadConfig() ([]byte, error) {
	if p.Manifest.Item(IDConfig) == nil {
		return nil, nil
	}
	data, err := p.readEntry(p.byName[ConfigPath], MaxConfigBytes)
	if err != nil {
		return nil, err
	}
	if !isJSONObject(data) {
		return nil, fmt.Errorf("%w: config is not a JSON object", ErrBadEntry)
	}
	return bytes.TrimPrefix(data, utf8BOM), nil
}

// ReadAgents also returns the extension the file had when exported.
func (p *Pack) ReadAgents(id string) (data []byte, ext string, err error) {
	it := p.Manifest.Item(id)
	if it == nil || it.Kind != KindAgents {
		return nil, "", fmt.Errorf("%w: %s is not in the package", ErrBadEntry, clip(id))
	}
	data, err = p.readEntry(p.byName[it.Path], MaxAgentsBytes)
	return data, AgentsExt(it.OrigName), err
}

func (p *Pack) SkillStats(id string) (files int, bytes int64, ok bool) {
	list, ok := p.skills[id]
	for _, e := range list {
		bytes += int64(e.zf.UncompressedSize64)
	}
	return len(list), bytes, ok
}

// ExtractSkill writes dest/<name> into an empty folder the caller owns. Writes go through
// os.Root, so even a name that slipped past validation cannot leave dest.
func (p *Pack) ExtractSkill(id, dest string) (files int, bytes int64, err error) {
	it := p.Manifest.Item(id)
	list, ok := p.skills[id]
	if it == nil || it.Kind != KindSkill || !ok {
		return 0, 0, fmt.Errorf("%w: %s is not in the package", ErrBadEntry, clip(id))
	}
	root, err := os.OpenRoot(dest)
	if err != nil {
		return 0, 0, err
	}
	defer root.Close()
	for _, e := range list {
		n, err := p.extractOne(root, e)
		if err != nil {
			return files, bytes, err
		}
		files++
		bytes += n
	}
	return files, bytes, nil
}

func (p *Pack) extractOne(root *os.Root, e skillEntry) (int64, error) {
	if err := checkListedEntry(e.zf, MaxEntryBytes); err != nil {
		return 0, err
	}
	if dir := pathpkg.Dir(e.rel); dir != "." {
		if err := root.MkdirAll(dir, 0o755); err != nil {
			return 0, err
		}
	}
	perm := fs.FileMode(0o644)
	if runtime.GOOS != "windows" && e.zf.Mode()&0o111 != 0 {
		perm = 0o755
	}
	rc, err := e.zf.Open()
	if err != nil {
		return 0, fmt.Errorf("%w: %v", ErrBadEntry, err)
	}
	defer rc.Close()
	out, err := root.OpenFile(e.rel, os.O_WRONLY|os.O_CREATE|os.O_EXCL, perm)
	if err != nil {
		return 0, err
	}
	limit := int64(MaxEntryBytes)
	if p.budget < limit {
		limit = p.budget
	}
	n, err := io.Copy(out, io.LimitReader(rc, limit+1))
	if cerr := out.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		return n, fmt.Errorf("%w: %v", ErrBadEntry, err)
	}
	if n > limit {
		return n, ErrTooLarge
	}
	return n, p.spend(n)
}

// precheckZip refuses a hostile directory before archive/zip parses it: the reader keeps every
// record in memory (a 50 MB file can hold about a million) and trusts a 16-bit count that wraps.
func precheckZip(f *os.File, size int64) error {
	const eocdLen = 22
	if size < eocdLen {
		return ErrNotZip
	}
	window := int64(eocdLen + 0xFFFF)
	if window > size {
		window = size
	}
	buf := make([]byte, window)
	if _, err := f.ReadAt(buf, size-window); err != nil && err != io.EOF {
		return err
	}
	// Same rule as archive/zip: the last signature counts, and a truncated comment is fatal.
	at := -1
	for j := len(buf) - eocdLen; j >= 0; j-- {
		if buf[j] == 'P' && buf[j+1] == 'K' && buf[j+2] == 5 && buf[j+3] == 6 {
			if int(binary.LittleEndian.Uint16(buf[j+20:]))+eocdLen+j > len(buf) {
				return ErrNotZip
			}
			at = j
			break
		}
	}
	if at < 0 {
		return ErrNotZip
	}
	eocdPos := size - window + int64(at)
	records := int(binary.LittleEndian.Uint16(buf[at+10:]))
	dirSize := int64(binary.LittleEndian.Uint32(buf[at+12:]))
	dirOff := int64(binary.LittleEndian.Uint32(buf[at+16:]))
	if records == 0xFFFF || dirSize == 0xFFFF || dirSize == 0xFFFFFFFF || dirOff == 0xFFFFFFFF {
		return fmt.Errorf("%w: zip64", ErrNotZip)
	}
	if records > MaxEntries {
		return ErrTooManyEntries
	}
	// archive/zip starts at dirOff or eocdPos-dirSize depending on its own heuristics; bound both.
	if span := eocdPos - dirOff; span < 0 {
		return ErrNotZip
	} else if span > maxCentralDirBytes || dirSize > maxCentralDirBytes {
		return ErrTooManyEntries
	}
	return nil
}
