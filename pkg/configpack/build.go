package configpack

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"os"
	"time"
)

type AgentsInput struct {
	Scope    string
	OrigName string
	Data     []byte
}

// Config and Agents are stored as given (stripping is the caller's job); Skills are re-read here.
type Input struct {
	AppVersion      string
	CreatedAt       time.Time
	IncludesSecrets bool
	ConfigSections  []string
	Config          []byte
	Agents          []AgentsInput
	Skills          []Skill
}

type Result struct {
	Manifest Manifest
	Files    int   // file entries written, not counting the manifest
	Bytes    int64 // their total uncompressed size
}

type capWriter struct {
	w    io.Writer
	left int64
}

func (c *capWriter) Write(p []byte) (int, error) {
	if int64(len(p)) > c.left {
		return 0, ErrTooLarge
	}
	n, err := c.w.Write(p)
	c.left -= int64(n)
	return n, err
}

type builder struct {
	zw         *zip.Writer
	maxEntries int
	entries    int
	files      int
	bytes      int64
}

// add streams src and never trusts a size measured earlier.
func (b *builder) add(name string, mod time.Time, mode fs.FileMode, src io.Reader, limit int64) (int64, error) {
	if b.entries >= b.maxEntries {
		return 0, ErrTooManyEntries
	}
	if err := ValidateEntryName(name); err != nil {
		return 0, err
	}
	hdr := &zip.FileHeader{Name: name, Method: zip.Deflate, Modified: mod}
	hdr.SetMode(mode)
	fw, err := b.zw.CreateHeader(hdr)
	if err != nil {
		return 0, err
	}
	n, err := io.Copy(fw, io.LimitReader(src, limit+1))
	if err != nil {
		return n, err
	}
	if n > limit {
		return n, fmt.Errorf("%w: %s", ErrTooLarge, name)
	}
	b.entries++
	b.files++
	b.bytes += n
	if b.bytes > MaxTotalBytes {
		return n, ErrTooLarge
	}
	return n, nil
}

// Build fails past MaxPackBytes instead of producing a file Open would refuse.
func Build(w io.Writer, in Input) (Result, error) {
	// One slot stays free for the manifest.
	b := &builder{zw: zip.NewWriter(&capWriter{w: w, left: MaxPackBytes}), maxEntries: MaxEntries - 1}
	m := Manifest{
		Format:          Format,
		Version:         Version,
		CreatedAt:       in.CreatedAt.Format(time.RFC3339),
		AppVersion:      in.AppVersion,
		IncludesSecrets: in.IncludesSecrets,
		ConfigSections:  CleanSections(in.ConfigSections),
		Items:           []Item{},
	}
	mod := in.CreatedAt

	if in.Config != nil {
		if len(in.Config) > MaxConfigBytes {
			return Result{}, fmt.Errorf("%w: config", ErrTooLarge)
		}
		if !isJSONObject(in.Config) {
			return Result{}, fmt.Errorf("%w: config is not a JSON object", ErrBadEntry)
		}
		n, err := b.add(ConfigPath, mod, 0o644, bytes.NewReader(in.Config), MaxConfigBytes)
		if err != nil {
			return Result{}, err
		}
		m.Items = append(m.Items, Item{ID: IDConfig, Kind: KindConfig, Path: ConfigPath, Bytes: n})
	}

	for _, a := range in.Agents {
		if a.Scope != ScopeApp && a.Scope != ScopeProject {
			return Result{}, fmt.Errorf("%w: agents scope %q", ErrBadEntry, clip(a.Scope))
		}
		if len(a.Data) > MaxAgentsBytes {
			return Result{}, fmt.Errorf("%w: agents file", ErrTooLarge)
		}
		path := AgentsPath(a.Scope)
		n, err := b.add(path, mod, 0o644, bytes.NewReader(a.Data), MaxAgentsBytes)
		if err != nil {
			return Result{}, err
		}
		m.Items = append(m.Items, Item{ID: "agents:" + a.Scope, Kind: KindAgents, Scope: a.Scope, Path: path, OrigName: agentsOrigName(a.OrigName), Bytes: n})
	}

	for _, sk := range in.Skills {
		item, err := b.addSkill(sk)
		if err != nil {
			return Result{}, err
		}
		m.Items = append(m.Items, item)
	}

	mf, err := json.MarshalIndent(m, "", "  ")
	if err != nil {
		return Result{}, err
	}
	if len(mf) > MaxManifestBytes {
		return Result{}, fmt.Errorf("%w: manifest", ErrTooLarge)
	}
	files, total := b.files, b.bytes
	b.maxEntries = MaxEntries
	if _, err := b.add(ManifestName, mod, 0o644, bytes.NewReader(mf), MaxManifestBytes); err != nil {
		return Result{}, err
	}
	if err := b.zw.Close(); err != nil {
		return Result{}, err
	}
	return Result{Manifest: m, Files: files, Bytes: total}, nil
}

func (b *builder) addSkill(sk Skill) (Item, error) {
	if err := ValidateSkillIdent(sk.Root, sk.Name, sk.Entry); err != nil {
		return Item{}, err
	}
	var files []skillFile
	if sk.Entry == EntryFile {
		fi, err := os.Lstat(sk.Path)
		if err != nil || !fi.Mode().IsRegular() {
			return Item{}, fmt.Errorf("%w: %s", ErrBadEntry, sk.ID)
		}
		files = []skillFile{{abs: sk.Path, size: fi.Size(), mode: fi.Mode(), mod: fi.ModTime()}}
	} else {
		var err error
		if files, err = walkSkill(sk.Path); err != nil {
			return Item{}, fmt.Errorf("%s: %w", sk.ID, err)
		}
	}

	prefix := "skills/" + sk.Root + "/" + sk.Name
	var total int64
	for _, f := range files {
		name := prefix
		if f.rel != "" {
			name += "/" + f.rel
		}
		n, err := b.addFile(name, f)
		if err != nil {
			return Item{}, err
		}
		total += n
	}
	return Item{ID: SkillID(sk.Root, sk.Name), Kind: KindSkill, Root: sk.Root, Name: sk.Name, Entry: sk.Entry, Files: len(files), Bytes: total}, nil
}

func (b *builder) addFile(name string, f skillFile) (int64, error) {
	// A link swapped in after discovery must not be followed.
	if fi, err := os.Lstat(f.abs); err != nil || !fi.Mode().IsRegular() {
		return 0, fmt.Errorf("%w: %s", ErrBadEntry, name)
	}
	src, err := os.Open(f.abs)
	if err != nil {
		return 0, err
	}
	defer src.Close()
	mode := fs.FileMode(0o644)
	if f.mode&0o111 != 0 {
		mode = 0o755
	}
	return b.add(name, f.mod, mode, src, MaxEntryBytes)
}

func isJSONObject(data []byte) bool {
	t := bytes.TrimSpace(bytes.TrimPrefix(data, utf8BOM))
	return len(t) > 0 && t[0] == '{' && json.Valid(t)
}
