package embed

import (
	"errors"
	"net/http"
	"strings"
	"testing"
)

func TestIsLocal(t *testing.T) {
	cases := []struct {
		url  string
		want bool
	}{
		// this machine
		{"http://localhost:11434", true},
		{"http://localhost", true},
		{"localhost:11434", true},
		{"HTTP://LOCALHOST:11434/v1", true},
		{"http://localhost.:11434", true},
		{"http://ollama.localhost:11434", true},
		{"http://127.0.0.1:11434", true},
		{"127.0.0.1", true},
		{"http://127.0.0.1", true},
		{"http://127.1.2.3:8080/v1", true},
		{"http://127.255.255.254", true},
		{"http://[::1]:11434", true},
		{"http://[::1]", true},
		{"[::1]:1234", true},
		{"::1", true},
		{"http://[::ffff:127.0.0.1]:80", true},
		{"http://user:pw@localhost:11434", true},
		{"https://127.0.0.1:8443/path?x=1#y", true},

		// it looks local, but the host is somewhere else
		{"http://127.0.0.1.evil.example", false},
		{"http://127.0.0.1.evil.example:11434/v1", false},
		{"http://localhost.evil.example", false},
		{"http://localhost.evil.example:11434", false},
		{"http://evil-localhost", false},
		{"http://notlocalhost:1234", false},
		{"http://10.0.0.1@evil.example", false},
		{"http://127.0.0.1@evil.example", false},
		{"http://localhost@evil.example/", false},
		{"http://localhost:11434@evil.example", false},
		{"http://evil.example#@127.0.0.1", false},
		{"http://evil.example/?h=127.0.0.1", false},
		{"http://evil.example/localhost", false},
		{"http://127.0.0.1:80@evil.example:80", false},
		{"http://1270.0.0.1", false},
		{"http://128.0.0.1", false},
		{"http://126.255.255.255", false},
		{"http://0.0.0.0", false}, // not loopback: it means "any address" and has no single owner
		{"http://[::2]", false},
		{"http://[::]", false},

		// on the local network, which is not this machine: what is sent there leaves this computer
		{"http://192.168.1.10:11434", false},
		{"http://10.0.0.5:1234/v1", false},
		{"http://172.16.0.1", false},
		{"http://nas.local:11434", false},
		{"http://nas:11434", false},

		// the cloud
		{"https://api.openai.com/v1", false},
		{"https://generativelanguage.googleapis.com", false},
		{"https://8.8.8.8", false},

		// no address
		{"", false},
		{"   ", false},
		{"http://", false},
		{"not a url at all", false},
		{"http://[::1", false},
		{"http://127.0.0.1:notaport", false},
		{"http://2130706433", false}, // a decimal IPv4 form: not read as an address, so not trusted
	}
	for _, c := range cases {
		if got := IsLocal(c.url); got != c.want {
			t.Errorf("IsLocal(%q) = %v, want %v", c.url, got, c.want)
		}
	}
}

func TestDetectProviderAndNewPickTheSameProvider(t *testing.T) {
	cases := []struct {
		name string
		cfg  Config
		want string
		id   string
	}{
		{"ollama default (no base)", Config{Model: "bge-m3"}, ProviderOllama, "ollama|bge-m3|0"},
		{"ollama port", Config{BaseURL: "http://localhost:11434", Model: "bge-m3"}, ProviderOllama, "ollama|bge-m3|0"},
		{"ollama on another machine", Config{BaseURL: "http://192.168.1.10:11434", Model: "bge-m3"}, ProviderOllama, "ollama|bge-m3|0"},
		{"ollama by name", Config{BaseURL: "https://ollama.example.com", Model: "bge-m3", APIKey: "k"}, ProviderOllama, "ollama|bge-m3|0"},
		{"ollama with a cut", Config{BaseURL: "localhost:11434", Model: "nomic-embed-text", Dimensions: 256}, ProviderOllama, "ollama|nomic-embed-text|256"},
		{"ollama's own /v1 is the OpenAI shape", Config{BaseURL: "http://localhost:11434/v1", Model: "bge-m3"}, ProviderOpenAI, "openai|bge-m3|0"},
		{"openai", Config{BaseURL: "https://api.openai.com/v1", Model: "text-embedding-3-small", APIKey: "sk-x"}, ProviderOpenAI, "openai|text-embedding-3-small|0"},
		{"openai without /v1", Config{BaseURL: "https://api.openai.com", Model: "text-embedding-3-large", APIKey: "sk-x", Dimensions: 1024}, ProviderOpenAI, "openai|text-embedding-3-large|1024"},
		{"lm studio", Config{BaseURL: "http://localhost:1234/v1", Model: "nomic-embed-text-v1.5"}, ProviderOpenAI, "openai|nomic-embed-text-v1.5|0"},
		{"gemini by host", Config{BaseURL: "https://generativelanguage.googleapis.com", Model: "gemini-embedding-2", APIKey: "AIza-x"}, ProviderGemini, "gemini|gemini-embedding-2|0"},
		{"gemini by host with a version", Config{BaseURL: "https://generativelanguage.googleapis.com/v1beta", Model: "x", APIKey: "AIza-x"}, ProviderGemini, "gemini|x|0"},
		{"gemini by model", Config{Model: "gemini-embedding-001", APIKey: "AIza-x", Dimensions: 768}, ProviderGemini, "gemini|gemini-embedding-001|768"},
		{"gemini by model, models/ form", Config{BaseURL: "https://example.com", Model: "models/gemini-embedding-2", APIKey: "k"}, ProviderGemini, "gemini|gemini-embedding-2|0"},
		{"scheme-less openai host", Config{BaseURL: "api.openai.com", Model: "text-embedding-3-small", APIKey: "sk-x"}, ProviderOpenAI, "openai|text-embedding-3-small|0"},
	}
	for _, c := range cases {
		e, err := New(c.cfg)
		if err != nil {
			t.Errorf("%s: %v", c.name, err)
			continue
		}
		if got := DetectProvider(c.cfg.BaseURL, c.cfg.Model); got != c.want {
			t.Errorf("%s: DetectProvider = %q, want %q", c.name, got, c.want)
		}
		if e.ID() != c.id {
			t.Errorf("%s: ID = %q, want %q", c.name, e.ID(), c.id)
		}
		var kind string
		switch e.(type) {
		case *ollamaEmbedder:
			kind = ProviderOllama
		case *openaiEmbedder:
			kind = ProviderOpenAI
		case *geminiEmbedder:
			kind = ProviderGemini
		}
		if kind != c.want {
			t.Errorf("%s: New built a %T, want provider %s", c.name, e, c.want)
		}
	}
}

func TestNewEndpoints(t *testing.T) {
	e, _ := New(Config{BaseURL: "localhost:1234", Model: "m"})
	if got := e.(*openaiEmbedder).endpoint; got != "http://localhost:1234/v1/embeddings" {
		t.Errorf("a local address typed without a scheme is read as http: %s", got)
	}
	e, _ = New(Config{BaseURL: "api.openai.com", Model: "m", APIKey: "sk-x"})
	if got := e.(*openaiEmbedder).endpoint; got != "https://api.openai.com/v1/embeddings" {
		t.Errorf("a public address typed without a scheme must be read as https (the key travels there): %s", got)
	}
	e, _ = New(Config{Model: "bge-m3"})
	if got := e.(*ollamaEmbedder).endpoint; got != "http://127.0.0.1:11434/api/embed" {
		t.Errorf("default Ollama endpoint = %s", got)
	}
	e, _ = New(Config{BaseURL: "localhost:11434/", Model: "bge-m3"})
	if got := e.(*ollamaEmbedder).endpoint; got != "http://localhost:11434/api/embed" {
		t.Errorf("Ollama endpoint = %s", got)
	}
}

func TestNewRefusesAnUnusableSetup(t *testing.T) {
	cases := []struct {
		name string
		cfg  Config
		want string
	}{
		{"no model", Config{BaseURL: "http://localhost:11434"}, "no model name"},
		{"blank model", Config{BaseURL: "http://localhost:11434", Model: "   "}, "no model name"},
		{"negative dimensions", Config{Model: "m", Dimensions: -1}, "dimensions"},
		{"gemini without a key", Config{BaseURL: "https://generativelanguage.googleapis.com", Model: "gemini-embedding-2"}, "API key"},
		{"gemini by model without a key", Config{Model: "gemini-embedding-001"}, "API key"},
		{"gemini with a blank key", Config{Model: "gemini-embedding-001", APIKey: "  "}, "API key"},
		{"openai without a key", Config{BaseURL: "https://api.openai.com/v1", Model: "text-embedding-3-small"}, "API key"},
		{"cloud host without a key", Config{BaseURL: "https://embeddings.example.com", Model: "m"}, "API key"},
		{"scheme-less cloud host without a key", Config{BaseURL: "api.example.com/v1", Model: "m"}, "API key"},
		{"look-alike local host without a key", Config{BaseURL: "http://localhost.evil.example/v1", Model: "m"}, "API key"},
		{"look-alike userinfo without a key", Config{BaseURL: "http://127.0.0.1@evil.example/v1", Model: "m"}, "API key"},
		{"wrong scheme", Config{BaseURL: "ftp://localhost:11434", Model: "m"}, "http"},
		{"no host", Config{BaseURL: "http://", Model: "m"}, "not an address"},
	}
	for _, c := range cases {
		e, err := New(c.cfg)
		if err == nil {
			t.Errorf("%s: New returned %T, want an error", c.name, e)
			continue
		}
		if !errors.Is(err, ErrNotConfigured) || !strings.Contains(err.Error(), c.want) {
			t.Errorf("%s: error = %v, want ErrNotConfigured naming %q", c.name, err, c.want)
		}
	}
}

func TestNewNeedsNoKeyWhereNoneIsNeeded(t *testing.T) {
	for name, cfg := range map[string]Config{
		"ollama":                      {BaseURL: "http://localhost:11434", Model: "bge-m3"},
		"remote ollama":               {BaseURL: "https://ollama.example.com", Model: "bge-m3"},
		"lm studio":                   {BaseURL: "http://localhost:1234/v1", Model: "m"},
		"vllm on this machine":        {BaseURL: "http://127.0.0.1:8000", Model: "m"},
		"vllm on the local network":   {BaseURL: "http://192.168.1.20:8000/v1", Model: "m"},
		"vllm by host name":           {BaseURL: "http://gpu-box:8000/v1", Model: "m"},
		"vllm on a .local name":       {BaseURL: "http://gpu.local:8000/v1", Model: "m"},
		"gemini behind a local proxy": {BaseURL: "http://localhost:9000", Model: "gemini-embedding-2"},
	} {
		if _, err := New(cfg); err != nil {
			t.Errorf("%s: %v", name, err)
		}
	}
}

func TestNewTrimsItsFieldsAndSendsNothing(t *testing.T) {
	srv, rec := serve(t, func(_ int, _ captured, w http.ResponseWriter) { w.WriteHeader(500) })
	e, err := New(Config{BaseURL: "  " + srv.URL + "  ", Model: "  m  ", APIKey: "  k  "})
	if err != nil {
		t.Fatal(err)
	}
	if e.ID() != "openai|m|0" {
		t.Fatalf("ID = %q, want the model name trimmed", e.ID())
	}
	_ = e.Dim()
	_ = e.Caps()
	_ = e.ID()
	if rec.count() != 0 {
		t.Fatalf("constructing an Embedder sent %d requests", rec.count())
	}
}
