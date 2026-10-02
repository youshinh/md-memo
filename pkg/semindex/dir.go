package semindex

import (
	"bufio"
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path"
	"path/filepath"
	"runtime"
	"strings"

	"md-memo/pkg/appdir"
)

// IndexDir is the folder of the index of a scrap folder: <settings folder>/index/<id>. It is never inside the scrap folder (Git sync
// would push the vectors) and it is only computed here, not created. The id comes from the Git remote of the scrap folder when it is a
// repository (so moving or renaming the folder, or opening the same repository on another path, keeps the index), and from the
// folder's absolute path otherwise.
func IndexDir(scrapDir string) string {
	return filepath.Join(appdir.AppConfigDir(), "index", indexID(scrapDir))
}

func indexID(scrapDir string) string {
	if remote := normalizeRemote(remoteURL(scrapDir)); remote != "" {
		return slug(path.Base(remote)) + "-" + shortHash("remote:"+remote)
	}
	abs, err := filepath.Abs(scrapDir)
	if err != nil {
		abs = filepath.Clean(scrapDir)
	}
	if real, err := filepath.EvalSymlinks(abs); err == nil {
		abs = real
	}
	key := filepath.ToSlash(abs)
	if runtime.GOOS == "windows" || runtime.GOOS == "darwin" { // case-insensitive file systems
		key = strings.ToLower(key)
	}
	return slug(filepath.Base(abs)) + "-" + shortHash("path:"+key)
}

func shortHash(s string) string {
	sum := sha256.Sum256([]byte(s))
	return hex.EncodeToString(sum[:])[:12]
}

// slug is a short readable part of an id: lower-case letters, digits and "._-"; anything else becomes "_".
func slug(s string) string {
	var b strings.Builder
	for _, r := range strings.ToLower(s) {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9', r == '.', r == '_', r == '-':
			b.WriteRune(r)
		default:
			b.WriteByte('_')
		}
		if b.Len() >= 24 {
			break
		}
	}
	out := strings.Trim(b.String(), "._-")
	if strings.Trim(out, "_") == "" {
		return "scraps"
	}
	return out
}

// remoteURL reads the URL of the "origin" remote (or, failing that, the first remote) from <scrapDir>/.git/config. It runs no git
// process. A missing file, a ".git" that is a file (a worktree or submodule) or no remote gives "".
func remoteURL(scrapDir string) string {
	f, err := os.Open(filepath.Join(scrapDir, ".git", "config"))
	if err != nil {
		return ""
	}
	defer f.Close()
	var origin, first string
	section := ""
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if strings.HasPrefix(line, "[") {
			section = strings.ToLower(strings.Join(strings.Fields(line), " "))
			continue
		}
		if !strings.HasPrefix(section, "[remote ") {
			continue
		}
		key, val, ok := strings.Cut(line, "=")
		if !ok || strings.ToLower(strings.TrimSpace(key)) != "url" {
			continue
		}
		val = strings.Trim(strings.TrimSpace(val), `"`)
		if val == "" {
			continue
		}
		if first == "" {
			first = val
		}
		if section == `[remote "origin"]` && origin == "" {
			origin = val
		}
	}
	if origin != "" {
		return origin
	}
	return first
}

// normalizeRemote makes the ways of writing one repository's address equal: the scheme, the user name and password, a port and a
// trailing ".git" or "/" are dropped and the rest is lower-cased, so git@github.com:me/notes.git, https://github.com/me/notes and
// ssh://git@github.com:22/me/notes/ are all "github.com/me/notes".
func normalizeRemote(raw string) string {
	s := strings.ToLower(strings.TrimSpace(raw))
	if s == "" {
		return ""
	}
	scheme := false
	if i := strings.Index(s, "://"); i >= 0 {
		s, scheme = s[i+3:], true
	}
	if at := strings.Index(s, "@"); at >= 0 && (strings.Index(s, "/") < 0 || at < strings.Index(s, "/")) {
		s = s[at+1:] // user:password@
	}
	host, rest := s, ""
	if i := strings.IndexAny(s, "/:"); i >= 0 {
		host, rest = s[:i], s[i:]
	}
	if scheme && strings.HasPrefix(rest, ":") { // a port: https://host:8443/me/notes
		if j := strings.Index(rest, "/"); j >= 0 {
			rest = rest[j:]
		} else {
			rest = ""
		}
	}
	rest = strings.TrimPrefix(rest, ":") // scp style: host:me/notes
	rest = strings.Trim(rest, "/")
	rest = strings.TrimSuffix(rest, ".git")
	rest = strings.Trim(rest, "/")
	if rest == "" {
		return host
	}
	return host + "/" + rest
}
