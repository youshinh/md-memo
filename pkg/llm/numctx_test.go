package llm

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// A long prompt must not be cut by Ollama's small default context window: the request names num_ctx when the config does, and says
// nothing about it otherwise (the default of the person's Ollama stays).
func TestQueryOllamaSendsNumCtxOnlyWhenAsked(t *testing.T) {
	var got map[string]interface{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got = nil
		_ = json.NewDecoder(r.Body).Decode(&got)
		_, _ = w.Write([]byte(`{"response":"ok","done":true}`))
	}))
	defer srv.Close()

	if out, err := queryOllama(srv.URL, "m", "p", Config{NumCtx: 16384}); err != nil || out != "ok" {
		t.Fatalf("%q %v", out, err)
	}
	opts, _ := got["options"].(map[string]interface{})
	if opts["num_ctx"] != float64(16384) || got["prompt"] != "p" || got["stream"] != false {
		t.Errorf("request = %v", got)
	}
	if _, err := queryOllama(srv.URL, "m", "p", Config{}); err != nil {
		t.Fatal(err)
	}
	if _, has := got["options"]; has {
		t.Errorf("no NumCtx, no options: %v", got)
	}
}

// How long a text request waits is the config's: two minutes unless TimeoutSec says otherwise (a deep search asks for longer than the
// default, because a slow machine reads a long prompt for minutes).
func TestTimeoutSecSetsHowLongATextRequestWaits(t *testing.T) {
	if (Config{}).httpClient() != client || (Config{TimeoutSec: -5}).httpClient() != client {
		t.Errorf("no timeout asked for: the shared client")
	}
	if got := (Config{TimeoutSec: 600}).httpClient().Timeout; got != 600*time.Second {
		t.Errorf("timeout = %v", got)
	}
	// a server that answers after 1.5 s: waits 1 s -> error; the default (and a longer wait) get the answer
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		time.Sleep(1500 * time.Millisecond)
		_, _ = w.Write([]byte(`{"response":"late","done":true}`))
	}))
	defer srv.Close()
	if _, err := queryOllama(srv.URL, "m", "p", Config{TimeoutSec: 1}); err == nil {
		t.Errorf("a wait of one second must not last for 1.5")
	}
	if out, err := queryOllama(srv.URL, "m", "p", Config{TimeoutSec: 30}); err != nil || out != "late" {
		t.Errorf("a longer wait gets the answer: %q %v", out, err)
	}
}
