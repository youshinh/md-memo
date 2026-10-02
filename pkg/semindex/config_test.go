package semindex

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"md-memo/pkg/appdir"
	"md-memo/pkg/embed"
)

func decode(t *testing.T, s string) map[string]interface{} {
	t.Helper()
	dec := json.NewDecoder(strings.NewReader(s))
	dec.UseNumber() // as the command line's shared Config does
	var v map[string]interface{}
	if err := dec.Decode(&v); err != nil {
		t.Fatal(err)
	}
	return v
}

func TestParseConfigDefaultsAreOff(t *testing.T) {
	t.Setenv(EnvAPIKey, "")
	c := ParseConfig(nil)
	if c.Enabled || c.IncludeAI || c.SettleMinutes != 10 || c.Model.Model != "" {
		t.Fatalf("%+v", c)
	}
	if _, err := c.NewEmbedder(); !errors.Is(err, ErrNotEnabled) {
		t.Errorf("a disabled feature builds nothing: %v", err)
	}
	c = ParseConfig(decode(t, `{"semantic": {"model": {"model": "bge-m3"}}}`))
	if _, err := c.NewEmbedder(); !errors.Is(err, ErrNotEnabled) {
		t.Errorf("a model without enabled is still off: %v", err)
	}
}

func TestParseConfigReadsTheSection(t *testing.T) {
	t.Setenv(EnvAPIKey, "")
	c := ParseConfig(decode(t, `{"semantic": {
		"enabled": true,
		"model": {"baseUrl": " http://localhost:11434 ", "model": "bge-m3", "dimensions": 512},
		"schedule": {"settleMinutes": 3},
		"privacy": {"excludeKinds": []}
	}}`))
	if !c.Enabled || c.Model.BaseURL != "http://localhost:11434" || c.Model.Model != "bge-m3" || c.Model.Dimensions != 512 || c.SettleMinutes != 3 || !c.IncludeAI {
		t.Fatalf("%+v", c)
	}
	if o := c.Options(); !o.Chunk.IncludeAI || o.Chunk.MaxChars != DefaultMaxChars || !o.Chunk.Header {
		t.Errorf("options: %+v", o)
	}
	c = ParseConfig(decode(t, `{"semantic": {"enabled": true, "privacy": {"excludeKinds": ["ai", "log"]}}}`))
	if c.IncludeAI {
		t.Error(`excludeKinds naming "ai" leaves the AI results out`)
	}
	if c = ParseConfig(decode(t, `{"semantic": {"schedule": {"settleMinutes": 0}}}`)); c.SettleMinutes != 0 {
		t.Errorf("0 minutes is a valid setting: %d", c.SettleMinutes)
	}
}

func TestLocalModelsNeedNoConsent(t *testing.T) {
	t.Setenv(EnvAPIKey, "")
	for _, base := range []string{"", "http://localhost:11434", "http://127.0.0.1:1234/v1", "localhost:11434", "http://[::1]:11434"} {
		c := ParseConfig(map[string]interface{}{"semantic": map[string]interface{}{"enabled": true, "model": map[string]interface{}{"baseUrl": base, "model": "bge-m3"}}})
		if _, local := c.Destination(); !local || !c.ConsentGiven() {
			t.Errorf("%q must be local", base)
		}
		if _, err := c.NewEmbedder(); err != nil {
			t.Errorf("%q: %v", base, err)
		}
	}
}

func TestCloudNeedsConsentBeforeAnythingIsBuilt(t *testing.T) {
	t.Setenv(EnvAPIKey, "")
	cases := []struct{ base, model, key string }{
		{"https://api.openai.com/v1", "text-embedding-3-small", "api.openai.com"},
		{"", "gemini-embedding-001", "generativelanguage.googleapis.com"},
		{"https://generativelanguage.googleapis.com", "gemini-embedding-001", "generativelanguage.googleapis.com"},
		{"http://nas.example.com:8080/v1", "bge-m3", "http://nas.example.com:8080"}, // plain http is its own answer
		{"http://192.168.1.20:11434", "bge-m3", "http://192.168.1.20:11434"},        // a LAN machine is not this machine
		{"http://localhost.evil.example", "bge-m3", "http://localhost.evil.example"},
	}
	for _, tc := range cases {
		c := ParseConfig(map[string]interface{}{"semantic": map[string]interface{}{"enabled": true, "model": map[string]interface{}{"baseUrl": tc.base, "model": tc.model, "apiKey": "k"}}})
		key, local := c.Destination()
		if local || key != tc.key {
			t.Errorf("%q: destination = %q local=%v, want %q", tc.base, key, local, tc.key)
		}
		if c.ConsentGiven() {
			t.Errorf("%q: nothing was allowed", tc.base)
		}
		emb, err := c.NewEmbedder()
		var ce *ConsentError
		if emb != nil || !errors.Is(err, ErrNeedsConsent) || !errors.As(err, &ce) || ce.Host != tc.key {
			t.Errorf("%q: got %v, %v", tc.base, emb, err)
		}
		if err != nil && (strings.Contains(err.Error(), "k\"") || !strings.Contains(err.Error(), tc.key)) {
			t.Errorf("the message names the host and never the key: %v", err)
		}
	}
}

func TestConsentIsPerHostAndPerScheme(t *testing.T) {
	t.Setenv(EnvAPIKey, "")
	mk := func(base, consent string) Config {
		return ParseConfig(decode(t, `{"semantic": {"enabled": true,
			"model": {"baseUrl": "`+base+`", "model": "text-embedding-3-small", "apiKey": "sk-x"},
			"privacy": {"cloudConsent": `+consent+`}}}`))
	}
	ok := mk("https://api.openai.com/v1", `{"api.openai.com": "2026-10-02"}`)
	if !ok.ConsentGiven() {
		t.Error("allowed host")
	}
	if _, err := ok.NewEmbedder(); err != nil {
		t.Errorf("allowed: %v", err)
	}
	if mk("https://api.openai.com/v1", `{"api.example.com": "2026-10-02"}`).ConsentGiven() {
		t.Error("another host's answer is not this host's")
	}
	if mk("http://api.openai.com/v1", `{"api.openai.com": "2026-10-02"}`).ConsentGiven() {
		t.Error("allowing https must not allow plain http (the key would travel in clear)")
	}
	if !mk("http://api.openai.com/v1", `{"http://api.openai.com": "2026-10-02"}`).ConsentGiven() {
		t.Error("an http answer allows http")
	}
	for _, v := range []string{`false`, `""`, `null`} {
		if mk("https://api.openai.com/v1", `{"api.openai.com": `+v+`}`).ConsentGiven() {
			t.Errorf("a %s answer is no consent", v)
		}
	}
	if !mk("https://API.OpenAI.com/v1", `{"API.openai.com": true}`).ConsentGiven() {
		t.Error("host names are case-insensitive")
	}
	if mk("https://api.openai.com/v1", `{"user:pw@api.openai.com": "x"}`).ConsentGiven() {
		t.Error("an old key with credentials is never matched")
	}
	if mk("https://api.openai.com/v1", `["api.openai.com"]`).ConsentGiven() {
		t.Error("a list is not a consent map")
	}
}

func TestNotConfiguredIsReportedBeforeConsent(t *testing.T) {
	t.Setenv(EnvAPIKey, "")
	c := ParseConfig(decode(t, `{"semantic": {"enabled": true, "model": {"baseUrl": "https://api.openai.com/v1"}}}`))
	if _, err := c.NewEmbedder(); !errors.Is(err, embed.ErrNotConfigured) {
		t.Errorf("no model name: %v", err)
	}
	c = ParseConfig(decode(t, `{"semantic": {"enabled": true, "model": {"baseUrl": "https://api.openai.com/v1", "model": "m"},
		"privacy": {"cloudConsent": {"api.openai.com": "x"}}}}`))
	if _, err := c.NewEmbedder(); !errors.Is(err, embed.ErrNotConfigured) {
		t.Errorf("no key: %v", err)
	}
}

func TestAPIKeySources(t *testing.T) {
	t.Setenv(EnvAPIKey, "")
	cfg := func(extra string) Config {
		return ParseConfig(decode(t, `{`+extra+`"semantic": {"enabled": true, "model": {"baseUrl": "https://api.openai.com/v1", "model": "text-embedding-3-small"}}}`))
	}
	if k := cfg("").Model.APIKey; k != "" {
		t.Errorf("no source: %q", k)
	}
	// the text model's key, from the same host
	if k := cfg(`"text": {"baseUrl": "https://api.openai.com/v1", "model": "gpt-x", "apiKey": "sk-text"},`).Model.APIKey; k != "sk-text" {
		t.Errorf("same host: %q", k)
	}
	// but never another host's
	if k := cfg(`"text": {"baseUrl": "https://api.example.com/v1", "model": "gpt-x", "apiKey": "sk-other"},`).Model.APIKey; k != "" {
		t.Errorf("another host's key was used: %q", k)
	}
	// vision and autocomplete are looked at too; a section without a key is skipped
	if k := cfg(`"text": {"baseUrl": "https://api.openai.com/v1"}, "vision": {"baseUrl": "https://api.openai.com", "apiKey": "sk-vision"},`).Model.APIKey; k != "sk-vision" {
		t.Errorf("vision: %q", k)
	}
	// the section's own key wins
	own := ParseConfig(decode(t, `{"text": {"baseUrl": "https://api.openai.com/v1", "apiKey": "sk-text"},
		"semantic": {"enabled": true, "model": {"baseUrl": "https://api.openai.com/v1", "model": "m", "apiKey": "sk-own"}}}`))
	if own.Model.APIKey != "sk-own" {
		t.Errorf("own key: %q", own.Model.APIKey)
	}
	// an Ollama on this machine has no key to inherit: its host is the loopback, which a cloud section never names
	if k := ParseConfig(decode(t, `{"text": {"baseUrl": "https://api.openai.com/v1", "apiKey": "sk-text"}, "semantic": {"enabled": true, "model": {"model": "bge-m3"}}}`)).Model.APIKey; k != "" {
		t.Errorf("a local model must not get a cloud key: %q", k)
	}
	// the environment is the last resort
	t.Setenv(EnvAPIKey, " sk-env ")
	if k := cfg("").Model.APIKey; k != "sk-env" {
		t.Errorf("env: %q", k)
	}
	if k := cfg(`"text": {"baseUrl": "https://api.openai.com/v1", "apiKey": "sk-text"},`).Model.APIKey; k != "sk-text" {
		t.Errorf("a configured key beats the environment: %q", k)
	}
}

func TestIntOfAcceptsEveryJSONNumberShape(t *testing.T) {
	for in, want := range map[string]int{`512`: 512, `512.0`: 512, `"256"`: 256, `"x"`: 0, `null`: 0} {
		c := ParseConfig(decode(t, `{"semantic": {"model": {"dimensions": `+in+`}}}`))
		if c.Model.Dimensions != want {
			t.Errorf("%s -> %d, want %d", in, c.Model.Dimensions, want)
		}
	}
	if got := intOf(float64(3)); got != 3 {
		t.Errorf("float64: %d", got)
	}
}

// ---- IndexDir ---------------------------------------------------------------------------------------------------------------------

func TestNormalizeRemote(t *testing.T) {
	same := []string{
		"git@github.com:Me/Notes.git",
		"https://github.com/me/notes",
		"https://github.com/me/notes.git",
		"https://user:tok3n@github.com/me/notes.git/",
		"ssh://git@github.com:22/me/notes",
		"HTTPS://GitHub.com/ME/NOTES.GIT",
		"  git@github.com:me/notes.git \n",
	}
	for _, s := range same {
		if got := normalizeRemote(s); got != "github.com/me/notes" {
			t.Errorf("normalizeRemote(%q) = %q", s, got)
		}
	}
	if normalizeRemote("") != "" || normalizeRemote("https://github.com/me/other") == "github.com/me/notes" {
		t.Error("empty stays empty; another repository differs")
	}
	if got := normalizeRemote("https://example.com:8443/a/b.git"); got != "example.com/a/b" {
		t.Errorf("a port is dropped: %q", got)
	}
}

func writeGitConfig(t *testing.T, dir, body string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Join(dir, ".git"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, ".git", "config"), []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestIndexIDFollowsTheRemoteNotThePath(t *testing.T) {
	root := t.TempDir()
	a, b, c := filepath.Join(root, "notes-a"), filepath.Join(root, "other", "名前が違う"), filepath.Join(root, "third")
	for _, d := range []string{a, b, c} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	cfg := "[core]\n\trepositoryformatversion = 0\n[remote \"upstream\"]\n\turl = https://example.com/x/y.git\n[remote \"origin\"]\n\turl = git@github.com:me/notes.git\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n[branch \"main\"]\n\tremote = origin\n"
	writeGitConfig(t, a, cfg)
	writeGitConfig(t, b, strings.ReplaceAll(cfg, "git@github.com:me/notes.git", "https://github.com/me/notes"))
	writeGitConfig(t, c, strings.ReplaceAll(cfg, "me/notes", "me/another"))
	ia, ib, ic := indexID(a), indexID(b), indexID(c)
	if ia != ib {
		t.Errorf("one repository on two paths must share an index: %s vs %s", ia, ib)
	}
	if ia == ic {
		t.Errorf("two repositories must not: %s", ia)
	}
	if !strings.HasPrefix(ia, "notes-") || len(ia) != len("notes-")+12 {
		t.Errorf("id = %q", ia)
	}
	// origin wins over the first remote; with no origin the first remote is used
	if got := remoteURL(a); got != "git@github.com:me/notes.git" {
		t.Errorf("remote = %q", got)
	}
	d := filepath.Join(root, "d")
	writeGitConfig(t, d, "[remote \"backup\"]\n\turl = https://example.com/x/y.git\n")
	if got := remoteURL(d); got != "https://example.com/x/y.git" {
		t.Errorf("first remote = %q", got)
	}
}

func TestIndexIDWithoutARemoteUsesThePath(t *testing.T) {
	root := t.TempDir()
	a, b := filepath.Join(root, "scraps"), filepath.Join(root, "他の場所")
	for _, d := range []string{a, b} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	if indexID(a) == indexID(b) {
		t.Error("two folders, two ids")
	}
	if indexID(a) != indexID(a+string(filepath.Separator)) || indexID(a) != indexID(filepath.Join(a, "..", "scraps")) {
		t.Error("the same folder written two ways is one id")
	}
	if id := indexID(b); !strings.HasPrefix(id, "scraps-") { // a name with no usable letters falls back to "scraps"
		t.Errorf("id of a Japanese folder name = %q", id)
	}
	// a .git with no remote, or a .git that is a file, is no remote
	writeGitConfig(t, a, "[core]\n\tbare = false\n")
	if remoteURL(a) != "" {
		t.Error("no remote")
	}
	if err := os.WriteFile(filepath.Join(b, ".git"), []byte("gitdir: ../x\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if remoteURL(b) != "" {
		t.Error("a .git file")
	}
}

func TestIndexDirIsInTheSettingsFolderNotTheScrapFolder(t *testing.T) {
	cfgRoot := t.TempDir()
	appdir.SetConfigDirOverride(cfgRoot)
	t.Cleanup(func() { appdir.SetConfigDirOverride("") })
	scrap := filepath.Join(t.TempDir(), "scraps")
	dir := IndexDir(scrap)
	if !strings.HasPrefix(dir, filepath.Join(cfgRoot, "md-memo", "index")+string(filepath.Separator)) {
		t.Errorf("IndexDir = %s", dir)
	}
	if rel, err := filepath.Rel(scrap, dir); err == nil && !strings.HasPrefix(rel, "..") {
		t.Errorf("the index is inside the scrap folder: %s", dir)
	}
	if _, err := os.Stat(dir); !os.IsNotExist(err) {
		t.Error("IndexDir must only compute the path")
	}
}

func TestSlug(t *testing.T) {
	cases := map[string]string{"Notes": "notes", "メモ": "scraps", "my notes!": "my_notes", "..": "scraps", "": "scraps", strings.Repeat("a", 40): strings.Repeat("a", 24)}
	for in, want := range cases {
		if got := slug(in); got != want {
			t.Errorf("slug(%q) = %q, want %q", in, got, want)
		}
	}
}
