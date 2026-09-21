package configpack

import (
	"fmt"
	"strings"
	"unicode/utf8"
)

const (
	maxNameBytes      = 512
	maxComponentBytes = 255
)

// ValidateEntryName rejects names that could climb out of the target or name a Windows device
// or stream. Every zip entry goes through it, listed or not.
func ValidateEntryName(name string) error {
	bad := func() error { return fmt.Errorf("%w: %q", ErrUnsafePath, clip(name)) }
	if name == "" || len(name) > maxNameBytes || !utf8.ValidString(name) {
		return bad()
	}
	for _, r := range name {
		if r < 0x20 || r == 0x7f || r == '\\' || r == ':' || strings.ContainsRune(`<>"|?*`, r) {
			return bad()
		}
	}
	if name[0] == '/' {
		return bad()
	}
	for _, c := range strings.Split(strings.TrimSuffix(name, "/"), "/") {
		if c == "" || c == "." || c == ".." || len(c) > maxComponentBytes {
			return bad()
		}
		// Windows drops trailing dots and spaces, so "... " would resolve to ".."
		if last := c[len(c)-1]; last == '.' || last == ' ' {
			return bad()
		}
		if isReservedDeviceName(c) {
			return bad()
		}
	}
	return nil
}

func isReservedDeviceName(c string) bool {
	base := c
	if i := strings.IndexByte(base, '.'); i >= 0 {
		base = base[:i]
	}
	u := strings.ToUpper(strings.TrimRight(base, " "))
	switch u {
	case "CON", "PRN", "AUX", "NUL", "CONIN$", "CONOUT$":
		return true
	}
	if strings.HasPrefix(u, "COM") || strings.HasPrefix(u, "LPT") {
		rest := u[3:]
		r, size := utf8.DecodeRuneInString(rest)
		return size > 0 && size == len(rest) && (r >= '0' && r <= '9' || r == '¹' || r == '²' || r == '³')
	}
	return false
}

// isEnvFileName matches .env and .env.<suffix>, except the conventional committed templates.
func isEnvFileName(base string) bool {
	l := strings.ToLower(base)
	if l == ".env" {
		return true
	}
	if strings.HasPrefix(l, ".env.") {
		for _, tmpl := range []string{".example", ".sample", ".template", ".dist"} {
			if strings.HasSuffix(l, tmpl) {
				return false
			}
		}
		return true
	}
	return false
}

func isJunkFileName(base string) bool {
	switch strings.ToLower(base) {
	case ".ds_store", "thumbs.db", "desktop.ini":
		return true
	}
	return false
}

func skipTreeDir(name string) bool {
	switch strings.ToLower(name) {
	case ".git", "node_modules", "__pycache__":
		return true
	}
	return false
}

func hasSkippedComponent(rel string) bool {
	parts := strings.Split(rel, "/")
	for _, p := range parts[:len(parts)-1] {
		if skipTreeDir(p) {
			return true
		}
	}
	base := parts[len(parts)-1]
	return isEnvFileName(base) || isJunkFileName(base)
}
