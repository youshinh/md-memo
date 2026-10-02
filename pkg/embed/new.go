package embed

import (
	"errors"
	"fmt"
	"net"
	"net/url"
	"strings"
)

// ErrNotConfigured is matched (errors.Is) by every "the embedding model's setup is unusable" error from New: no model name, a cloud
// provider without its API key, a base URL that is no address. The caller can tell it from a transient failure of Embed.
var ErrNotConfigured = errors.New("embedding model is not configured")

// Provider names, as DetectProvider returns them and as they appear in Embedder IDs.
const (
	ProviderOllama = "ollama"
	ProviderOpenAI = "openai" // any OpenAI-compatible server: OpenAI, LM Studio, vLLM, OpenRouter...
	ProviderGemini = "gemini"
)

const defaultOllamaBase = "http://127.0.0.1:11434"

// New builds the Embedder the configuration names. Nothing is sent anywhere, and nothing is looked up: the provider follows from the
// base URL and the model name alone, so the choice can be shown in the settings before a single request is made.
//
//   - host generativelanguage.googleapis.com, or a model named gemini...: Gemini
//   - port 11434, or "ollama" in the host, with no /v1 in the path (or no base URL at all): Ollama's native /api/embed
//   - anything else: an OpenAI-compatible /v1/embeddings
//
// A model name is required. An API key is required of Gemini and of an OpenAI-compatible server that is not on this machine or on
// a private network (a local server needs none); Ollama never needs one.
func New(cfg Config) (Embedder, error) {
	cfg.BaseURL = strings.TrimSpace(cfg.BaseURL)
	cfg.Model = strings.TrimSpace(cfg.Model)
	cfg.APIKey = strings.TrimSpace(cfg.APIKey)

	if cfg.Model == "" {
		return nil, fmt.Errorf("%w: no model name is set (config.semantic.model.model, for example bge-m3 or text-embedding-3-small)", ErrNotConfigured)
	}
	if cfg.Dimensions < 0 {
		return nil, fmt.Errorf("%w: dimensions is %d; use 0 for the model's own", ErrNotConfigured, cfg.Dimensions)
	}

	base, host, err := normalizeBase(cfg.BaseURL)
	if err != nil {
		return nil, fmt.Errorf("%w: base URL: %v", ErrNotConfigured, err)
	}
	provider := DetectProvider(base, cfg.Model)

	if cfg.APIKey == "" && keyRequired(provider, host) {
		return nil, fmt.Errorf("%w: the API key for %s is not set (config.semantic.model.apiKey); a model on this machine or on the local network needs none", ErrNotConfigured, hostLabel(provider, host))
	}

	switch provider {
	case ProviderGemini:
		return newGemini(cfg, base), nil
	case ProviderOllama:
		if base == "" {
			base = defaultOllamaBase
		}
		return newOllama(cfg, base), nil
	default:
		return newOpenAI(cfg, base), nil
	}
}

// DetectProvider says which provider New picks for a base URL and a model name: ProviderGemini, ProviderOllama or ProviderOpenAI.
// The settings screen uses it to label the destination before anything is sent.
func DetectProvider(baseURL, model string) string {
	host := ""
	path := ""
	port := ""
	if u := parseHostURL(baseURL); u != nil {
		host = strings.ToLower(u.Hostname())
		path = strings.ToLower(u.Path)
		port = u.Port()
	}
	m := strings.ToLower(strings.TrimPrefix(strings.TrimSpace(model), "models/"))

	if host == "generativelanguage.googleapis.com" || strings.HasPrefix(m, "gemini") {
		return ProviderGemini
	}
	if strings.TrimSpace(baseURL) == "" {
		return ProviderOllama // the settings' default: the Ollama on this machine
	}
	if !strings.Contains(path, "/v1") && (port == "11434" || strings.Contains(host, "ollama")) {
		return ProviderOllama
	}
	return ProviderOpenAI
}

// IsLocal reports whether baseURL points at this machine: a loopback address only (localhost, *.localhost, 127.0.0.0/8, ::1). The
// host is parsed and compared whole, never matched by prefix, so "127.0.0.1.evil.example", "localhost.evil.example" and
// "10.0.0.1@evil.example" (whose host is evil.example) are not local. A machine on the local network (192.168.x.x) is not local
// either: what is sent to it leaves this computer. An empty or unparsable address is not local.
func IsLocal(baseURL string) bool {
	if ip := net.ParseIP(strings.TrimSpace(baseURL)); ip != nil { // a bare IPv6 address, which no URL parser reads without brackets
		return ip.IsLoopback()
	}
	u := parseHostURL(baseURL)
	if u == nil {
		return false
	}
	return isLoopbackHost(u.Hostname())
}

func isLoopbackHost(host string) bool {
	host = strings.ToLower(strings.TrimSuffix(host, "."))
	if host == "localhost" || strings.HasSuffix(host, ".localhost") {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

// isPrivateHost reports a machine on a private network: an RFC 1918 / unique-local / link-local address, or a name that only a
// local network resolves (a single label like "nas", ".local", ".lan", ".home.arpa", ".internal"). Loopback counts too.
func isPrivateHost(host string) bool {
	host = strings.ToLower(strings.TrimSuffix(host, "."))
	if host == "" {
		return false
	}
	if isLoopbackHost(host) {
		return true
	}
	if ip := net.ParseIP(host); ip != nil {
		return ip.IsPrivate() || ip.IsLinkLocalUnicast()
	}
	if !strings.Contains(host, ".") {
		return true
	}
	for _, suffix := range []string{".local", ".lan", ".home.arpa", ".internal"} {
		if strings.HasSuffix(host, suffix) {
			return true
		}
	}
	return false
}

// keyRequired: Gemini always, an OpenAI-compatible server when it is not local; Ollama never (it has no key of its own).
func keyRequired(provider, host string) bool {
	if provider == ProviderOllama {
		return false
	}
	if provider == ProviderGemini && host == "" {
		host = "generativelanguage.googleapis.com"
	}
	return !isPrivateHost(host)
}

func hostLabel(provider, host string) string {
	if host == "" && provider == ProviderGemini {
		return "Gemini"
	}
	return host
}

// parseHostURL parses a base URL for its host; a URL typed without a scheme ("localhost:11434") is read as http. It returns nil when
// there is nothing usable.
func parseHostURL(raw string) *url.URL {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil
	}
	if !strings.Contains(raw, "://") {
		raw = "http://" + raw
	}
	u, err := url.Parse(raw)
	if err != nil || u.Hostname() == "" {
		return nil
	}
	return u
}

// normalizeBase checks a base URL and gives it a scheme when it was typed without one: http for a machine on this or a private
// network, https for everything else (a key must not travel in clear to a public host because a scheme was left out). It returns
// the URL and its lower-cased host; an empty base is returned as it is.
func normalizeBase(raw string) (base, host string, err error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return "", "", nil
	}
	if !strings.Contains(raw, "://") {
		probe := parseHostURL(raw)
		if probe == nil {
			return "", "", fmt.Errorf("%q is not an address", redact(raw))
		}
		if isPrivateHost(probe.Hostname()) {
			raw = "http://" + raw
		} else {
			raw = "https://" + raw
		}
	}
	u, perr := url.Parse(raw)
	if perr != nil || u.Hostname() == "" {
		return "", "", fmt.Errorf("%q is not an address", redact(raw))
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return "", "", fmt.Errorf("the address must start with http:// or https://, not %s://", u.Scheme)
	}
	return strings.TrimRight(raw, "/"), strings.ToLower(u.Hostname()), nil
}
