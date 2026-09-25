// Package notesave decides whether a note may be written to a path an outside caller named
// (`md-memo buffer save --as`, JSON-RPC buffer.save) and writes it, all-or-nothing.
//
// The caller is not the user at a file dialog, it can be a script or an AI agent, so nothing is
// taken for granted: the path must be absolute and plain (no network or device path, no alternate
// data stream, no reserved name), name a .md / .markdown / .txt file, sit in a folder that already
// exists, and never replace an existing file unless it was asked to. No dialog is ever opened and
// no folder is ever created.
package notesave

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"syscall"
)

// AllowedExtensions are the file name extensions a note may be saved under (compared without regard
// to case).
var AllowedExtensions = []string{".md", ".markdown", ".txt"}

// Rule names, in RefusedError.Rule. They are stable: tests and callers may look at them.
const (
	RuleEmpty         = "empty"
	RuleNotAbsolute   = "not-absolute"
	RuleNetworkPath   = "network-path"
	RuleStream        = "stream"
	RuleInvalidChar   = "invalid-char"
	RuleTrailing      = "trailing-dot-or-space"
	RuleDeviceName    = "device-name"
	RuleExtension     = "extension"
	RuleDirectory     = "directory"
	RuleParentMissing = "parent-missing"
	RuleExists        = "exists"
	RuleBrokenLink    = "broken-link"
)

// RefusedError is a refusal by one of the rules above. Its message is English and names the rule
// that failed; it never contains note text.
type RefusedError struct {
	Rule string
	Msg  string
}

func (e *RefusedError) Error() string { return e.Msg }

func refuse(rule, format string, args ...interface{}) error {
	return &RefusedError{Rule: rule, Msg: fmt.Sprintf(format, args...)}
}

func isSep(c byte) bool { return c == '/' || c == '\\' }

// reservedNames are the Windows device names: a file with such a name (whatever its extension) cannot
// be created there, and one made in another way cannot be reached again. They are refused on every
// system so a note saved on a Mac still opens on a Windows PC that shares the folder.
var reservedNames = func() map[string]bool {
	m := map[string]bool{"CON": true, "PRN": true, "AUX": true, "NUL": true}
	for i := '1'; i <= '9'; i++ {
		m["COM"+string(i)] = true
		m["LPT"+string(i)] = true
	}
	return m
}()

// isDeviceName reports whether one path component is a reserved device name, with or without an
// extension ("NUL", "nul.md", "Com1.txt"), also with spaces before the dot ("con .md").
func isDeviceName(component string) bool {
	stem := component
	if i := strings.IndexByte(stem, '.'); i >= 0 {
		stem = stem[:i]
	}
	stem = strings.TrimRight(stem, " ")
	return reservedNames[strings.ToUpper(stem)]
}

// CleanPath applies the rules that need no access to the disk and returns the cleaned absolute
// path. Everything it refuses is refused on every system (a Windows path is judged the same on a
// Mac), except that "absolute" means what the running system means by it.
//
// Refused: an empty path; a control character or one of < > " | ? * anywhere; a path that begins with
// two separators (UNC and network paths in either slash style, the \\?\ and \\.\ prefixes); a path
// that is not absolute; a colon anywhere after the drive letter (an NTFS alternate data stream such
// as note.md:secret); a name that ends with a dot or a space; a Windows device name (CON, PRN, AUX,
// NUL, COM1-9, LPT1-9, with or without an extension) as any part of the path.
func CleanPath(path string) (string, error) {
	if path == "" {
		return "", refuse(RuleEmpty, "the path is empty")
	}
	for i := 0; i < len(path); i++ {
		c := path[i]
		if c < 0x20 || c == 0x7f {
			return "", refuse(RuleInvalidChar, "the path contains a control character")
		}
	}
	if len(path) >= 2 && isSep(path[0]) && isSep(path[1]) {
		return "", refuse(RuleNetworkPath, "network and device paths are not accepted (%s begins with two slashes); use a path on a local drive", quote(path))
	}
	if !filepath.IsAbs(path) {
		return "", refuse(RuleNotAbsolute, "the path must be absolute (a full path from the drive or root): %s", quote(path))
	}
	vol := filepath.VolumeName(path)
	rest := path[len(vol):]
	if strings.Contains(rest, ":") {
		return "", refuse(RuleStream, "a colon is not allowed in the path after the drive letter (Windows alternate data stream): %s", quote(path))
	}
	clean := filepath.Clean(path)
	if !filepath.IsAbs(clean) {
		return "", refuse(RuleNotAbsolute, "the path must be absolute (a full path from the drive or root): %s", quote(path))
	}
	rest = clean[len(filepath.VolumeName(clean)):]
	for _, comp := range strings.FieldsFunc(rest, func(r rune) bool { return r == '/' || r == '\\' }) {
		if strings.ContainsAny(comp, `<>"|?*`) {
			return "", refuse(RuleInvalidChar, "the name %s contains a character that is not allowed in file names (< > \" | ? *)", quote(comp))
		}
		if last := comp[len(comp)-1]; last == '.' || last == ' ' {
			return "", refuse(RuleTrailing, "the name %s ends with a dot or a space, which Windows silently removes", quote(comp))
		}
		if isDeviceName(comp) {
			return "", refuse(RuleDeviceName, "the name %s is a reserved Windows device name (CON, PRN, AUX, NUL, COM1-9, LPT1-9)", quote(comp))
		}
	}
	return clean, nil
}

// CheckExtension refuses a path whose extension is not one of AllowedExtensions.
func CheckExtension(clean string) error {
	ext := strings.ToLower(filepath.Ext(clean))
	for _, ok := range AllowedExtensions {
		if ext == ok {
			return nil
		}
	}
	if ext == "" {
		return refuse(RuleExtension, "the file name has no extension; only %s files can be written", strings.Join(AllowedExtensions, ", "))
	}
	return refuse(RuleExtension, "the extension %q is not allowed; only %s files can be written", ext, strings.Join(AllowedExtensions, ", "))
}

// ValidatePath is CleanPath followed by CheckExtension: every rule that needs no disk access.
func ValidatePath(path string) (string, error) {
	clean, err := CleanPath(path)
	if err != nil {
		return "", err
	}
	if err := CheckExtension(clean); err != nil {
		return "", err
	}
	return clean, nil
}

// Target is a validated place to write.
type Target struct {
	// Path is the cleaned path as named.
	Path string
	// Real is where the bytes go: Path, or what a symbolic link at Path points to (the link itself
	// is left in place).
	Real string
	// Exists: a file is there now (so the write replaces it).
	Exists bool
	// Own: the file is the note's own bound file, so replacing it needs no permission.
	Own bool
}

// CheckTarget looks at the disk for a path that ValidatePath accepted. ownPath is the file the note
// is already bound to ("" if none); overwrite says the caller may replace another existing file.
//
// Refused: a directory (even with overwrite); a folder that does not exist or is not a folder
// (nothing is ever created); an existing file that is neither ownPath nor allowed by overwrite. A
// symbolic link is followed to the file it names, and a link to nowhere is refused. Any other
// failure to look (permissions) comes back as a plain error.
func CheckTarget(clean, ownPath string, overwrite bool) (*Target, error) {
	t := &Target{Path: clean, Real: clean}
	fi, err := os.Lstat(clean)
	switch {
	case err == nil:
		t.Exists = true
		if fi.Mode()&os.ModeSymlink != 0 {
			real, err := filepath.EvalSymlinks(clean)
			if err != nil {
				return nil, refuse(RuleBrokenLink, "%s is a link to a file that does not exist", quote(clean))
			}
			t.Real = real
			st, err := os.Stat(real)
			if err != nil {
				return nil, refuse(RuleBrokenLink, "%s is a link to a file that cannot be read", quote(clean))
			}
			fi = st
		}
		if fi.IsDir() {
			return nil, refuse(RuleDirectory, "%s is a folder, not a file", quote(clean))
		}
	case errors.Is(err, fs.ErrNotExist):
		dir := filepath.Dir(clean)
		if st, derr := os.Stat(dir); derr != nil || !st.IsDir() {
			return nil, refuse(RuleParentMissing, "the folder %s does not exist (create it first; saving never creates folders)", quote(dir))
		}
	case errors.Is(err, syscall.ENOTDIR):
		// A folder on the way is really a file: macOS and Linux answer ENOTDIR here where Windows says "not found".
		return nil, refuse(RuleParentMissing, "%s is not a folder (a file is in the way; saving never creates folders)", quote(filepath.Dir(clean)))
	default:
		return nil, fmt.Errorf("cannot look at %s: %w", quote(clean), err)
	}

	if t.Exists {
		t.Own = samePath(clean, ownPath)
		if !t.Own && !overwrite {
			return nil, refuse(RuleExists, "refused overwrite: %s already exists (pass overwrite to replace it)", quote(clean))
		}
	}
	return t, nil
}

// samePath reports whether a and b name the same existing file: equal after cleaning, or the same
// file on disk (which covers case-insensitive volumes, 8.3 short names and links).
func samePath(a, b string) bool {
	if a == "" || b == "" {
		return false
	}
	if filepath.Clean(a) == filepath.Clean(b) {
		return true
	}
	fa, errA := os.Stat(a)
	fb, errB := os.Stat(b)
	return errA == nil && errB == nil && os.SameFile(fa, fb)
}

func quote(s string) string { return `"` + s + `"` }
