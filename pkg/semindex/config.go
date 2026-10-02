package semindex

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"strconv"
	"strings"

	"md-memo/pkg/embed"
)

// config.json's "semantic" section (see docs/design/semantic-search-2026-10.md section 4), as far as the command line and the update
// job read it. Everything is off unless the file says "enabled": true.
//
//	"semantic": {
//	  "enabled": false,
//	  "model": { "baseUrl": "http://localhost:11434", "model": "bge-m3", "apiKey": "", "dimensions": 0 },
//	  "schedule": { "settleMinutes": 10 },
//	  "privacy": { "cloudConsent": { "generativelanguage.googleapis.com": "2026-10-02" }, "excludeKinds": ["ai"] }
//	}

// ErrNotEnabled means the section is missing or "enabled" is not true.
var ErrNotEnabled = errors.New(`semantic search is off; set "semantic": {"enabled": true} in config.json (see md-memo config get semantic)`)

// ErrNeedsConsent is matched (errors.Is) by the error ConsentError: the model is not on this machine and its host has not been allowed.
var ErrNeedsConsent = errors.New("the embedding model's host has not been allowed")

// ConsentError says which host needs the person's consent before a single byte of a note is sent to it.
type ConsentError struct{ Host string }

func (e *ConsentError) Error() string {
	return fmt.Sprintf("the embedding model is at %s, which is not on this machine, and sending your notes there has not been allowed; "+
		`allow it in config.json: "semantic": {"privacy": {"cloudConsent": {%q: "yes"}}} (the settings screen asks for this in a later version)`, e.Host, e.Host)
}

func (e *ConsentError) Is(target error) bool { return target == ErrNeedsConsent }

// EnvAPIKey is the environment variable that supplies the API key of the embedding model when config.json holds none, so that a key
// need not be stored in a file (a build machine, a scheduled task).
const EnvAPIKey = "MD_MEMO_EMBED_API_KEY"

// Config is the "semantic" section, read.
type Config struct {
	Enabled bool
	Model   embed.Config // the key is already filled in (own, inherited from the same host, or from the environment)
	// SettleMinutes is how long a file must be unchanged before the background update reads it (default 10). The command line's
	// own `scrap index` does not wait unless asked.
	SettleMinutes int
	// IncludeAI keeps the AI result blocks in the index (excludeKinds does not name "ai"); the default leaves them out.
	IncludeAI bool
	consent   map[string]bool
}

// ParseConfig reads the section from the top level of config.json (the map the command line's shared Config holds, with json.Number
// for numbers, or any generically decoded JSON object). A missing section gives the disabled default. The API key is taken from the
// section; if it has none, from the "text", "vision" or "autocomplete" section whose base URL is on the same host (a key never goes to
// another host); and if there is still none, from the environment (EnvAPIKey).
func ParseConfig(values map[string]interface{}) Config {
	c := Config{SettleMinutes: 10}
	sec := obj(values["semantic"])
	c.Enabled = boolOf(sec["enabled"])
	m := obj(sec["model"])
	c.Model = embed.Config{
		BaseURL:    str(m["baseUrl"]),
		Model:      str(m["model"]),
		APIKey:     str(m["apiKey"]),
		Dimensions: intOf(m["dimensions"]),
	}
	if sched := obj(sec["schedule"]); sched["settleMinutes"] != nil {
		if n := intOf(sched["settleMinutes"]); n >= 0 {
			c.SettleMinutes = n
		}
	}
	priv := obj(sec["privacy"])
	if list, ok := priv["excludeKinds"].([]interface{}); ok { // a list that does not name "ai" (an empty one too) keeps AI results
		c.IncludeAI = true
		for _, k := range list {
			if strings.EqualFold(str(k), KindAI) {
				c.IncludeAI = false
			}
		}
	} // no list: the default, AI results are left out
	c.consent = map[string]bool{}
	for host, v := range obj(priv["cloudConsent"]) {
		if truthy(v) && !strings.Contains(host, "@") { // a key with credentials in it is never matched
			c.consent[strings.ToLower(host)] = true
		}
	}
	if c.Model.APIKey == "" {
		c.Model.APIKey = inheritedKey(values, c.Model)
	}
	if c.Model.APIKey == "" {
		c.Model.APIKey = strings.TrimSpace(os.Getenv(EnvAPIKey))
	}
	return c
}

// inheritedKey is the key of the text, vision or autocomplete model when it is for the same host as the embedding model.
func inheritedKey(values map[string]interface{}, m embed.Config) string {
	host, _ := destination(m)
	if host == "" {
		return ""
	}
	for _, name := range []string{"text", "vision", "autocomplete"} {
		s := obj(values[name])
		key := str(s["apiKey"])
		if key == "" {
			continue
		}
		other := embed.Config{BaseURL: str(s["baseUrl"]), Model: str(s["model"])}
		if h, _ := destination(other); h == host {
			return key
		}
	}
	return ""
}

// destination says where the embedding requests go: the host (lower-case, no credentials, the way a consent is keyed: "host" for https,
// "http://host" for plain http) and whether that is this machine. No base URL means the Ollama on this machine, or Google when the
// model is a Gemini one.
func destination(m embed.Config) (key string, local bool) {
	provider := embed.DetectProvider(m.BaseURL, m.Model)
	base := strings.TrimSpace(m.BaseURL)
	if base == "" {
		if provider == embed.ProviderGemini {
			return "generativelanguage.googleapis.com", false
		}
		return "127.0.0.1:11434", true
	}
	if !strings.Contains(base, "://") {
		base = "http://" + base
	}
	u, err := url.Parse(base)
	if err != nil || u.Hostname() == "" {
		return "", false
	}
	host := strings.ToLower(u.Host) // with the port
	if embed.IsLocal(base) {
		return host, true
	}
	if u.Scheme == "http" {
		return "http://" + host, false
	}
	return host, false
}

// Destination is the key an answer to "may notes be sent there?" is stored under, and whether the model is on this machine (then no
// answer is needed).
func (c Config) Destination() (key string, local bool) { return destination(c.Model) }

// ConsentGiven reports whether sending notes to the model is allowed: always for a model on this machine, otherwise only when the
// host is in semantic.privacy.cloudConsent.
func (c Config) ConsentGiven() bool {
	key, local := c.Destination()
	return local || c.consent[strings.ToLower(key)]
}

// NewEmbedder builds the embedder after the checks that must come first: the feature is on, and nothing leaves this machine without
// the host's consent. Nothing is sent. The errors are ErrNotEnabled, a *ConsentError (ErrNeedsConsent) and embed.ErrNotConfigured.
func (c Config) NewEmbedder() (embed.Embedder, error) {
	if !c.Enabled {
		return nil, ErrNotEnabled
	}
	if c.Model.Model == "" { // say it before the consent, which would name a host the person has not chosen yet
		return embed.New(c.Model)
	}
	if !c.ConsentGiven() {
		key, _ := c.Destination()
		return nil, &ConsentError{Host: key}
	}
	return embed.New(c.Model)
}

// Options are the update options this configuration asks for (chunking; the wait for a file to settle is left to the caller).
func (c Config) Options() Options {
	o := DefaultOptions()
	o.Chunk.IncludeAI = c.IncludeAI
	return o
}

// ---- generic JSON helpers --------------------------------------------------------------------------------------------------------

func obj(v interface{}) map[string]interface{} {
	m, _ := v.(map[string]interface{})
	return m
}

func str(v interface{}) string {
	s, _ := v.(string)
	return strings.TrimSpace(s)
}

func boolOf(v interface{}) bool {
	b, _ := v.(bool)
	return b
}

// truthy: a consent answer is a date string (or any non-empty value); false, null and "" are "not allowed".
func truthy(v interface{}) bool {
	switch x := v.(type) {
	case nil:
		return false
	case bool:
		return x
	case string:
		return strings.TrimSpace(x) != ""
	}
	return true
}

func intOf(v interface{}) int {
	switch n := v.(type) {
	case json.Number:
		if i, err := n.Int64(); err == nil {
			return int(i)
		}
		if f, err := n.Float64(); err == nil {
			return int(f)
		}
	case float64:
		return int(n)
	case int:
		return n
	case string:
		if i, err := strconv.Atoi(strings.TrimSpace(n)); err == nil {
			return i
		}
	}
	return 0
}
