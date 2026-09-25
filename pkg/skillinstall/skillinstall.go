// Package skillinstall puts the agent skill (a folder of Markdown files, SKILL.md at its root)
// into an agent's skills folder, the way `md-memo agent install-skill` does.
//
// A copy is written into a temporary sibling folder and renamed into place, so an agent that is
// reading the skills folder never sees a half-written skill. Every installed folder carries a
// small marker file (MarkerFile) with the md-memo version, a hash of the content and the hash of
// each file, which is how a later run tells "an older copy nobody touched" (replaced) from "a
// folder somebody edited, or that md-memo never wrote" (left alone unless Force says otherwise).
//
// The package knows nothing about which agent the folder belongs to: the caller picks Base.
package skillinstall

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"time"
)

const (
	// SkillName is the folder the skill is installed as, below the agent's skills folder.
	SkillName = "md-memo"
	// MarkerFile is written inside the installed folder.
	MarkerFile = ".md-memo-skill-version"
)

// Action says what an Install or Link call did.
type Action string

const (
	Installed Action = "installed" // nothing was there
	Updated   Action = "updated"   // an older, untouched copy was replaced
	Replaced  Action = "replaced"  // Force replaced something else: edited files, a foreign folder, a link
	UpToDate  Action = "up-to-date"
	Linked    Action = "linked" // a link to a folder on disk was created (or was already there)
)

// Options is what the caller decides.
type Options struct {
	// Base is the agent's skills folder; the skill lands in Base/md-memo. It is created when missing.
	Base string
	// Version is the md-memo version written into the marker.
	Version string
	// Force replaces a folder that has local edits, has no marker, is newer, or is a link.
	Force bool
}

// Result describes what is on disk after the call.
type Result struct {
	Action          Action   `json:"action"`
	Path            string   `json:"path"`
	Version         string   `json:"version"`
	Hash            string   `json:"hash"`
	Files           int      `json:"files"`
	Bytes           int64    `json:"bytes"`
	Names           []string `json:"names,omitempty"` // the files of the skill, marker not counted
	PreviousVersion string   `json:"previous_version,omitempty"`
	Discarded       []string `json:"discarded,omitempty"` // with Force: the local changes that were lost
	LinkTarget      string   `json:"link_target,omitempty"`
}

// ConflictError means the target exists and was left alone. Files names what differs, one per
// line as "modified: x", "missing: x" or "extra: x".
type ConflictError struct {
	Path   string
	Reason string
	Files  []string
}

func (e *ConflictError) Error() string {
	var b strings.Builder
	fmt.Fprintf(&b, "%s already exists and was left alone: %s", e.Path, e.Reason)
	const shown = 20
	for i, f := range e.Files {
		if i == shown {
			fmt.Fprintf(&b, "\n  ... and %d more", len(e.Files)-shown)
			break
		}
		b.WriteString("\n  " + f)
	}
	b.WriteString("\nRun it again with --force to replace it")
	if len(e.Files) > 0 {
		b.WriteString(" (the changes listed above are lost)")
	}
	return b.String()
}

// Marker is the content of MarkerFile.
type Marker struct {
	Version string            `json:"version"`
	Hash    string            `json:"hash"`
	Files   map[string]string `json:"files"`
	Note    string            `json:"note"`
}

const markerNote = "Written by md-memo agent install-skill. Delete this file and md-memo will treat the folder as yours: it will not overwrite it without --force."

type file struct {
	path string
	data []byte
}

// fileHash hashes one file's text with CRLF read as LF, so the same skill has the same hash
// whether it was checked out with Windows or Unix line endings, and an editor that converts them
// does not count as an edit.
func fileHash(data []byte) string {
	sum := sha256.Sum256(bytes.ReplaceAll(data, []byte("\r\n"), []byte("\n")))
	return "sha256:" + hex.EncodeToString(sum[:])
}

// treeHash combines the per-file hashes into one, independent of the order files were read in.
func treeHash(files map[string]string) string {
	paths := make([]string, 0, len(files))
	for p := range files {
		paths = append(paths, p)
	}
	sort.Strings(paths)
	h := sha256.New()
	for _, p := range paths {
		h.Write([]byte(p))
		h.Write([]byte{0})
		h.Write([]byte(files[p]))
		h.Write([]byte{'\n'})
	}
	return "sha256:" + hex.EncodeToString(h.Sum(nil))
}

// readTree reads every regular file of src (paths with forward slashes, marker excluded).
func readTree(src fs.FS) ([]file, error) {
	var files []file
	err := fs.WalkDir(src, ".", func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() || p == MarkerFile {
			return nil
		}
		data, err := fs.ReadFile(src, p)
		if err != nil {
			return err
		}
		files = append(files, file{p, data})
		return nil
	})
	if err != nil {
		return nil, err
	}
	if len(files) == 0 {
		return nil, errors.New("the skill folder is empty")
	}
	sort.Slice(files, func(i, j int) bool { return files[i].path < files[j].path })
	return files, nil
}

// Hash returns the content hash of the skill in src (the value written into the marker).
func Hash(src fs.FS) (string, error) {
	files, err := readTree(src)
	if err != nil {
		return "", err
	}
	return treeHash(hashesOf(files)), nil
}

func hashesOf(files []file) map[string]string {
	m := make(map[string]string, len(files))
	for _, f := range files {
		m[f.path] = fileHash(f.data)
	}
	return m
}

// existing is what Install found at the target.
type existing struct {
	link   bool              // a symbolic link or another reparse point: not a folder of ours
	notDir bool              // a plain file
	marker *Marker           // nil: no readable marker
	files  map[string]string // hash of every file on disk, marker excluded
}

func inspect(target string, fi os.FileInfo) existing {
	var ex existing
	switch {
	case fi.Mode()&(os.ModeSymlink|os.ModeIrregular) != 0:
		ex.link = true
		return ex
	case !fi.IsDir():
		ex.notDir = true
		return ex
	}
	ex.files = map[string]string{}
	_ = filepath.WalkDir(target, func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return nil
		}
		rel, err := filepath.Rel(target, p)
		if err != nil {
			return nil
		}
		rel = filepath.ToSlash(rel)
		if rel == MarkerFile {
			return nil
		}
		if data, err := os.ReadFile(p); err == nil {
			ex.files[rel] = fileHash(data)
		} else {
			ex.files[rel] = "unreadable"
		}
		return nil
	})
	if data, err := os.ReadFile(filepath.Join(target, MarkerFile)); err == nil {
		var m Marker
		if json.Unmarshal(data, &m) == nil && m.Hash != "" && m.Files != nil {
			ex.marker = &m
		}
	}
	return ex
}

// diff lists how `have` differs from `want`, as "modified: x", "missing: x", "extra: x".
func diff(want, have map[string]string) []string {
	var out []string
	for p, h := range want {
		switch got, ok := have[p]; {
		case !ok:
			out = append(out, "missing: "+p)
		case got != h:
			out = append(out, "modified: "+p)
		}
	}
	for p := range have {
		if _, ok := want[p]; !ok {
			out = append(out, "extra: "+p)
		}
	}
	sort.Strings(out)
	return out
}

// Install copies the skill in src to Base/md-memo, as described in the package comment.
func Install(src fs.FS, opt Options) (*Result, error) {
	if opt.Base == "" {
		return nil, errors.New("no target folder")
	}
	files, err := readTree(src)
	if err != nil {
		return nil, err
	}
	want := hashesOf(files)
	overall := treeHash(want)
	var total int64
	for _, f := range files {
		total += int64(len(f.data))
	}
	marker := Marker{Version: opt.Version, Hash: overall, Files: want, Note: markerNote}
	target := filepath.Join(opt.Base, SkillName)
	res := &Result{Path: target, Version: opt.Version, Hash: overall, Files: len(files), Bytes: total}
	for _, f := range files {
		res.Names = append(res.Names, f.path)
	}

	fi, err := os.Lstat(target)
	if errors.Is(err, fs.ErrNotExist) {
		if err := os.MkdirAll(opt.Base, 0o755); err != nil {
			return nil, err
		}
		if err := swapIn(opt.Base, target, false, func(dir string) error { return writeTree(dir, files, marker) }); err != nil {
			return nil, err
		}
		res.Action = Installed
		return res, nil
	}
	if err != nil {
		return nil, err
	}

	ex := inspect(target, fi)
	switch {
	case ex.link:
		if !opt.Force {
			return nil, &ConflictError{Path: target, Reason: "it is a link, not a folder md-memo wrote"}
		}
		res.Discarded = []string{"a link"}
	case ex.notDir:
		if !opt.Force {
			return nil, &ConflictError{Path: target, Reason: "it is a file, not a folder"}
		}
		res.Discarded = []string{"a file"}
	default:
		changes := diff(want, ex.files)
		if len(changes) == 0 {
			// The new content is what is already there. Keep the marker current so a later update
			// can tell an untouched copy from an edited one, but touch nothing else.
			res.Action = UpToDate
			if ex.marker == nil || ex.marker.Hash != overall {
				if err := writeMarker(target, marker); err != nil {
					return nil, err
				}
			}
			return res, nil
		}
		if ex.marker == nil {
			if !opt.Force {
				return nil, &ConflictError{
					Path:   target,
					Reason: "it has no " + MarkerFile + " (md-memo did not write it, or the marker was deleted) and differs from the skill in this build",
					Files:  changes,
				}
			}
			res.Discarded = changes
			break
		}
		res.PreviousVersion = ex.marker.Version
		if local := diff(ex.marker.Files, ex.files); len(local) > 0 {
			if !opt.Force {
				return nil, &ConflictError{Path: target, Reason: "it has been edited since md-memo installed it", Files: local}
			}
			res.Discarded = local
			break
		}
		if newer(ex.marker.Version, opt.Version) {
			if !opt.Force {
				return nil, &ConflictError{Path: target, Reason: "it comes from a newer md-memo (" + ex.marker.Version + ", this one is " + opt.Version + ")"}
			}
			break // a downgrade the user asked for: reported as "replaced"
		}
		res.Action = Updated
	}
	if res.Action == "" {
		res.Action = Replaced
	}
	if err := swapIn(opt.Base, target, true, func(dir string) error { return writeTree(dir, files, marker) }); err != nil {
		return nil, err
	}
	return res, nil
}

// linksAllowed is false on Windows, where a symbolic link needs administrator rights or Developer
// Mode and the standard library cannot create a directory junction (the alternative that needs
// neither). It is a variable so that the tests can exercise the rest of Link there.
var linksAllowed = runtime.GOOS != "windows"

// LinksSupported reports whether Link can work on this system.
func LinksSupported() bool { return linksAllowed }

// ErrLinkUnsupported is returned by Link where a link cannot be made without extra rights.
var ErrLinkUnsupported = errors.New("--link is not supported on Windows: a symbolic link needs administrator rights or Developer Mode, and a directory junction cannot be created without extra tools. Run it without --link to install a copy")

// Link makes Base/md-memo a symbolic link to source (a folder with SKILL.md), so the agent always
// reads the checkout's current text. No marker is written: the folder is not a copy.
func Link(source string, opt Options) (*Result, error) {
	if !linksAllowed {
		return nil, ErrLinkUnsupported
	}
	if opt.Base == "" {
		return nil, errors.New("no target folder")
	}
	source, err := filepath.Abs(source)
	if err != nil {
		return nil, err
	}
	if !looksLikeSkill(source) {
		return nil, fmt.Errorf("%s is not the md-memo skill folder (no SKILL.md with name: md-memo)", source)
	}
	target := filepath.Join(opt.Base, SkillName)
	res := &Result{Action: Linked, Path: target, Version: opt.Version, LinkTarget: source}

	fi, err := os.Lstat(target)
	switch {
	case errors.Is(err, fs.ErrNotExist):
		if err := os.MkdirAll(opt.Base, 0o755); err != nil {
			return nil, err
		}
		if err := swapIn(opt.Base, target, false, func(p string) error { return os.Symlink(source, p) }); err != nil {
			return nil, err
		}
		return res, nil
	case err != nil:
		return nil, err
	}

	if fi.Mode()&os.ModeSymlink != 0 {
		if cur, err := os.Readlink(target); err == nil {
			if !filepath.IsAbs(cur) {
				cur = filepath.Join(filepath.Dir(target), cur)
			}
			if filepath.Clean(cur) == filepath.Clean(source) {
				return res, nil // already linked there
			}
		}
	}
	if !opt.Force {
		return nil, &ConflictError{Path: target, Reason: "it is already there (a link elsewhere, or an installed copy)"}
	}
	res.Action = Linked
	res.Discarded = []string{"the existing " + SkillName + " folder or link"}
	if err := swapIn(opt.Base, target, true, func(p string) error { return os.Symlink(source, p) }); err != nil {
		return nil, err
	}
	return res, nil
}

// FindSource looks for a real skills/md-memo folder on disk, starting at each of dirs and going up
// (so a checkout, an unpacked release zip and the folder around MD-Memo.app are all found). It
// returns "" when there is none.
func FindSource(dirs ...string) string {
	const levels = 6
	for _, start := range dirs {
		if start == "" {
			continue
		}
		dir, err := filepath.Abs(start)
		if err != nil {
			continue
		}
		for i := 0; i < levels; i++ {
			cand := filepath.Join(dir, "skills", SkillName)
			if looksLikeSkill(cand) {
				return cand
			}
			parent := filepath.Dir(dir)
			if parent == dir {
				break
			}
			dir = parent
		}
	}
	return ""
}

// looksLikeSkill reports whether dir holds this skill: a SKILL.md whose front matter names it.
func looksLikeSkill(dir string) bool {
	f, err := os.Open(filepath.Join(dir, "SKILL.md"))
	if err != nil {
		return false
	}
	defer f.Close()
	buf := make([]byte, 512)
	n, _ := f.Read(buf)
	head := strings.ReplaceAll(string(buf[:n]), "\r\n", "\n")
	return strings.HasPrefix(head, "---\n") && strings.Contains(head, "\nname: "+SkillName+"\n")
}

// swapIn builds the new content at a temporary sibling of target and renames it into place. When
// target exists it is renamed aside first and removed after the new one is in place; if the second
// rename fails, the old one is put back.
func swapIn(base, target string, replace bool, build func(path string) error) error {
	tmp := filepath.Join(base, fmt.Sprintf(".%s-new-%d-%d", SkillName, os.Getpid(), time.Now().UnixNano()))
	if err := build(tmp); err != nil {
		removeAny(tmp)
		return err
	}
	if !replace {
		if err := os.Rename(tmp, target); err != nil {
			removeAny(tmp)
			return err
		}
		return nil
	}
	old := tmp + ".old"
	if err := os.Rename(target, old); err != nil {
		removeAny(tmp)
		return fmt.Errorf("cannot move the existing %s out of the way (is it open in another program?): %w", target, err)
	}
	if err := os.Rename(tmp, target); err != nil {
		_ = os.Rename(old, target)
		removeAny(tmp)
		return err
	}
	removeAny(old)
	return nil
}

// removeAny deletes a folder, file or link; a link is removed without touching what it points to.
func removeAny(p string) {
	if fi, err := os.Lstat(p); err == nil && fi.Mode()&os.ModeSymlink != 0 {
		_ = os.Remove(p)
		return
	}
	_ = os.RemoveAll(p)
}

// writeTree creates dir with every file and the marker.
func writeTree(dir string, files []file, m Marker) error {
	if err := os.Mkdir(dir, 0o755); err != nil {
		return err
	}
	for _, f := range files {
		p := filepath.Join(dir, filepath.FromSlash(f.path))
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			return err
		}
		if err := os.WriteFile(p, f.data, 0o644); err != nil {
			return err
		}
	}
	return writeMarker(dir, m)
}

// writeMarker writes MarkerFile in dir; an existing one is replaced in one step.
func writeMarker(dir string, m Marker) error {
	data, err := json.MarshalIndent(m, "", "  ")
	if err != nil {
		return err
	}
	data = append(data, '\n')
	final := filepath.Join(dir, MarkerFile)
	tmp := final + ".tmp"
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		return err
	}
	if err := os.Rename(tmp, final); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	return nil
}

// newer reports whether version a is strictly newer than b, for versions like "1.8.0". A version
// that is not dotted numbers ("dev", "") is never newer and never older.
func newer(a, b string) bool {
	pa, oka := parseVersion(a)
	pb, okb := parseVersion(b)
	if !oka || !okb {
		return false
	}
	for i := 0; i < len(pa) || i < len(pb); i++ {
		var x, y int
		if i < len(pa) {
			x = pa[i]
		}
		if i < len(pb) {
			y = pb[i]
		}
		if x != y {
			return x > y
		}
	}
	return false
}

func parseVersion(v string) ([]int, bool) {
	if v == "" {
		return nil, false
	}
	var out []int
	for _, part := range strings.Split(v, ".") {
		n, err := strconv.Atoi(part)
		if err != nil || n < 0 {
			return nil, false
		}
		out = append(out, n)
	}
	return out, true
}
