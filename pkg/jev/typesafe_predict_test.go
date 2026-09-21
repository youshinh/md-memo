package jev

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"reflect"
	"strings"
	"testing"
	"time"
)

// Nothing in this file touches the network: every client gets a stub transport, and the tests that
// expect "no request at all" install failingRoundTripper (jev_privacy_test.go).

const (
	testORKey        = "sk-or-v1-test-key"
	testTSKey        = "ts-test-key"
	tsSystemOneURL   = "https://api.typesafe.ai/v1/systemone"
	orSystemOneURL   = "https://openrouter.ai/api/v1/systemone"
	orChatURL        = "https://openrouter.ai/api/v1/chat/completions"
	gitNoteExcerpt   = "コミット前に git diff で変更内容を確認したい"
	planNoteExcerpt  = "今日の予定を整理したい"
	testRankedPick   = "go test -v ./..."
	testRankedSecond = "{{ 直近の変更内容からコミットメッセージ案を作成 }}"
)

func jsonReply(status int, body string) *http.Response {
	return &http.Response{
		StatusCode: status,
		Header:     http.Header{"Content-Type": []string{"application/json"}},
		Body:       io.NopCloser(strings.NewReader(body)),
	}
}

// systemOneSpy records every request the client makes and answers each one with reply.
type systemOneSpy struct {
	urls     []string
	auths    []string
	requests []SystemOneRequest
	reply    func(SystemOneRequest) (*http.Response, error)
}

func (s *systemOneSpy) RoundTrip(r *http.Request) (*http.Response, error) {
	var req SystemOneRequest
	if r.Body != nil {
		_ = json.NewDecoder(r.Body).Decode(&req)
	}
	s.urls = append(s.urls, r.URL.String())
	s.auths = append(s.auths, r.Header.Get("Authorization"))
	s.requests = append(s.requests, req)
	return s.reply(req)
}

func newSpyClient(t *testing.T, cfg ClientConfig, reply func(SystemOneRequest) (*http.Response, error)) (*Client, *systemOneSpy) {
	t.Helper()
	clearJevEnv(t)
	cfg.Timeout = 2 * time.Second
	client := NewClient(cfg)
	spy := &systemOneSpy{reply: reply}
	client.httpClient.Transport = spy
	return client, spy
}

// rankingReply answers the ranking question the way the real API does: the option whose criteria
// mention pick gets top, the rest share what is left, and confidence is reported as given. The
// reply also carries the fields OpenRouter adds (id, provider, usage.cost).
func rankingReply(t *testing.T, pick string, top, confidence float64) func(SystemOneRequest) (*http.Response, error) {
	t.Helper()
	return func(req SystemOneRequest) (*http.Response, error) {
		q, ok := req.Questions[systemOneRankKey]
		if !ok {
			t.Errorf("request has no %q question: %+v", systemOneRankKey, req.Questions)
			return jsonReply(422, `{"error":{"message":"bad"}}`), nil
		}
		criteria, _ := q.Criteria.(map[string]interface{})
		probs := make(map[string]float64, len(criteria))
		chosen := ""
		for option, text := range criteria {
			if s, _ := text.(string); strings.Contains(s, pick) {
				chosen = option
			}
		}
		if chosen == "" {
			t.Errorf("no option mentions %q: %+v", pick, criteria)
		}
		rest := (1 - top) / float64(len(criteria)-1)
		for option := range criteria {
			probs[option] = rest
		}
		probs[chosen] = top

		body, _ := json.Marshal(map[string]interface{}{
			"id":       "gen-dec-test",
			"model":    "jev-1.13.0",
			"provider": "TypeSafe",
			"answers": map[string]interface{}{
				systemOneRankKey: map[string]interface{}{
					"type":          "choice",
					"choice":        chosen,
					"confidence":    confidence,
					"probabilities": probs,
				},
			},
			"usage": map[string]interface{}{"input_tokens": 476, "output_tokens": 70, "cost": 0.00002},
		})
		return jsonReply(200, string(body)), nil
	}
}

func commandsOf(cs []Candidate) []string {
	out := make([]string, len(cs))
	for i, c := range cs {
		out[i] = c.Command
	}
	return out
}

func guiKeySlots(cfg ClientConfig, key string) ClientConfig {
	// The settings screen has one key field; initJevEngineLocked copies it into all three slots.
	cfg.APIKey, cfg.OpenRouterKey, cfg.TypeSafeKey = key, key, key
	return cfg
}

func TestPredict_SystemOne_RanksTheBuiltInPool(t *testing.T) {
	routes := []struct {
		name     string
		cfg      ClientConfig
		wantURL  string
		wantAuth string
	}{
		{"TypeSafe direct", ClientConfig{Endpoint: "https://api.typesafe.ai", TypeSafeKey: testTSKey}, tsSystemOneURL, "Bearer " + testTSKey},
		{"TypeSafe, key in every GUI slot, /v1 base", guiKeySlots(ClientConfig{Endpoint: "https://api.typesafe.ai/v1"}, testTSKey), tsSystemOneURL, "Bearer " + testTSKey},
		{"TypeSafe, full systemone address", ClientConfig{Endpoint: tsSystemOneURL, TypeSafeKey: testTSKey}, tsSystemOneURL, "Bearer " + testTSKey},
		{"OpenRouter, default Base URL (GUI)", guiKeySlots(ClientConfig{Endpoint: "https://openrouter.ai/api/v1"}, testORKey), orSystemOneURL, "Bearer " + testORKey},
		{"OpenRouter key, blank Base URL (GUI defaults it to TypeSafe)", guiKeySlots(ClientConfig{}, testORKey), orSystemOneURL, "Bearer " + testORKey},
		{"OpenRouter key next to a TypeSafe Base URL", guiKeySlots(ClientConfig{Endpoint: "https://api.typesafe.ai"}, testORKey), orSystemOneURL, "Bearer " + testORKey},
	}

	for _, tc := range routes {
		t.Run(tc.name, func(t *testing.T) {
			client, spy := newSpyClient(t, tc.cfg, nil)
			spy.reply = rankingReply(t, testRankedPick, 0.7, 0.67)

			resp, err := client.Predict(context.Background(), JevPredictRequest{BufferContext: gitNoteExcerpt})
			if err != nil {
				t.Fatalf("Predict returned an error: %v", err)
			}

			if len(spy.urls) != 1 || spy.urls[0] != tc.wantURL {
				t.Fatalf("requests = %v, want exactly one to %s", spy.urls, tc.wantURL)
			}
			if spy.auths[0] != tc.wantAuth {
				t.Errorf("Authorization = %q, want %q", spy.auths[0], tc.wantAuth)
			}

			req := spy.requests[0]
			if req.Model != "jev-latest" {
				t.Errorf("model = %q, want jev-latest", req.Model)
			}
			state, _ := req.State.(map[string]interface{})
			if state["note_excerpt"] != gitNoteExcerpt {
				t.Errorf("state = %#v, want the note excerpt under note_excerpt", req.State)
			}
			if len(req.Questions) != 1 {
				t.Fatalf("want one question, got %d", len(req.Questions))
			}
			q := req.Questions[systemOneRankKey]
			if q.Type != QuestionChoice || q.Instructions == "" {
				t.Errorf("question = %+v, want a Choice with instructions", q)
			}
			if got := len(choiceCriteriaOptions(q.Criteria)); got != 11 {
				t.Errorf("options = %d, want the 11 built-in candidates", got)
			}

			// Jev picked a candidate the keyword rules would not have shown for a git note; the
			// options it cannot tell apart keep the rules' own order.
			got := resp.Candidates
			if len(got) != 11 {
				t.Fatalf("ranked %d candidates, want 11", len(got))
			}
			if got[0].Command != testRankedPick || got[0].Confidence != 0.7 {
				t.Errorf("top = %+v, want %q at 0.7", got[0], testRankedPick)
			}
			if got[1].Command != testRankedSecond {
				t.Errorf("second = %q, want the rules' first pick %q", got[1].Command, testRankedSecond)
			}
			seen := map[string]bool{}
			for _, c := range got {
				if seen[c.Command] {
					t.Errorf("duplicate command in ranking: %q", c.Command)
				}
				seen[c.Command] = true
			}
		})
	}
}

func TestPredict_SystemOne_FallsBackToTheBuiltInRules(t *testing.T) {
	uniform := func(req SystemOneRequest) (*http.Response, error) {
		return rankingReply(t, testRankedPick, 1.0/11, 0)(req)
	}
	replies := map[string]func(SystemOneRequest) (*http.Response, error){
		"401 unauthorized": func(SystemOneRequest) (*http.Response, error) {
			return jsonReply(401, `{"error":{"message":"bad key"}}`), nil
		},
		"402 no credits": func(SystemOneRequest) (*http.Response, error) {
			return jsonReply(402, `{"error":{"message":"credits"}}`), nil
		},
		"422 invalid":    func(SystemOneRequest) (*http.Response, error) { return jsonReply(422, `{"detail":"x"}`), nil },
		"429 rate limit": func(SystemOneRequest) (*http.Response, error) { return jsonReply(429, `{}`), nil },
		"529 overloaded": func(SystemOneRequest) (*http.Response, error) { return jsonReply(529, `{}`), nil },
		"not JSON":       func(SystemOneRequest) (*http.Response, error) { return jsonReply(200, `<html>`), nil },
		"answer missing": func(SystemOneRequest) (*http.Response, error) { return jsonReply(200, `{"answers":{}}`), nil },
		"wrong answer type": func(SystemOneRequest) (*http.Response, error) {
			return jsonReply(200, `{"answers":{"next_action":{"type":"noul","noul":0.9}}}`), nil
		},
		"no probabilities": func(SystemOneRequest) (*http.Response, error) {
			return jsonReply(200, `{"answers":{"next_action":{"type":"choice","choice":"x","confidence":0.9}}}`), nil
		},
		"even split, no opinion": uniform,
		"network error":          func(SystemOneRequest) (*http.Response, error) { return nil, errors.New("connection refused") },
	}
	configs := map[string]ClientConfig{
		"TypeSafe":   {Endpoint: "https://api.typesafe.ai", TypeSafeKey: testTSKey},
		"OpenRouter": guiKeySlots(ClientConfig{Endpoint: "https://openrouter.ai/api/v1"}, testORKey),
	}

	for cfgName, cfg := range configs {
		for name, reply := range replies {
			t.Run(cfgName+"/"+name, func(t *testing.T) {
				client, spy := newSpyClient(t, cfg, reply)
				req := JevPredictRequest{BufferContext: planNoteExcerpt}

				resp, err := client.Predict(context.Background(), req)
				if err != nil {
					t.Fatalf("Predict returned an error: %v", err)
				}
				want := client.predictLocal(req).Candidates
				if !reflect.DeepEqual(commandsOf(resp.Candidates), commandsOf(want)) {
					t.Errorf("candidates = %v, want the built-in rules' %v", commandsOf(resp.Candidates), commandsOf(want))
				}
				// The key is not tried on any other engine after System One failed.
				if len(spy.urls) != 1 {
					t.Errorf("requests = %v, want exactly one System One call", spy.urls)
				}
			})
		}
	}
}

func TestPredict_SystemOne_NothingToSendMeansNoRequest(t *testing.T) {
	cases := []struct {
		name    string
		cfg     ClientConfig
		excerpt string
	}{
		{"TypeSafe URL without a key", ClientConfig{Endpoint: "https://api.typesafe.ai"}, planNoteExcerpt},
		{"OpenRouter URL without a key", ClientConfig{Endpoint: "https://openrouter.ai/api/v1"}, planNoteExcerpt},
		{"TypeSafe key, empty note", ClientConfig{Endpoint: "https://api.typesafe.ai", TypeSafeKey: testTSKey}, "  \n\t"},
		{"OpenRouter key, empty note", guiKeySlots(ClientConfig{Endpoint: "https://openrouter.ai/api/v1"}, testORKey), ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			clearJevEnv(t)
			tc.cfg.Timeout = 2 * time.Second
			client := NewClient(tc.cfg)
			client.httpClient.Transport = failingRoundTripper{t: t}

			resp, err := client.Predict(context.Background(), JevPredictRequest{BufferContext: tc.excerpt})
			if err != nil {
				t.Fatalf("Predict returned an error: %v", err)
			}
			if len(resp.Candidates) != 3 {
				t.Errorf("want the 3 built-in candidates, got %d", len(resp.Candidates))
			}
		})
	}
}

// A TypeSafe key must not reach OpenRouter (or a /predict route TypeSafe does not have), and an
// OpenRouter key must not reach TypeSafe.
func TestPredict_KeysStayWithTheirOwnService(t *testing.T) {
	t.Run("TypeSafe key and the GUI's key slots", func(t *testing.T) {
		client, spy := newSpyClient(t, guiKeySlots(ClientConfig{Endpoint: "https://api.typesafe.ai"}, testTSKey), func(SystemOneRequest) (*http.Response, error) {
			return jsonReply(500, `{}`), nil
		})
		if _, err := client.Predict(context.Background(), JevPredictRequest{BufferContext: planNoteExcerpt}); err != nil {
			t.Fatal(err)
		}
		if !reflect.DeepEqual(spy.urls, []string{tsSystemOneURL}) {
			t.Errorf("requests = %v, want only %s", spy.urls, tsSystemOneURL)
		}
	})

	t.Run("TypeSafe key next to OpenRouter's default Base URL goes nowhere", func(t *testing.T) {
		clearJevEnv(t)
		client := NewClient(guiKeySlots(ClientConfig{Endpoint: "https://openrouter.ai/api/v1", Timeout: time.Second}, testTSKey))
		client.httpClient.Transport = failingRoundTripper{t: t}
		resp, err := client.Predict(context.Background(), JevPredictRequest{BufferContext: planNoteExcerpt})
		if err != nil {
			t.Fatal(err)
		}
		if len(resp.Candidates) != 3 {
			t.Errorf("want the 3 built-in candidates, got %d", len(resp.Candidates))
		}
	})

	t.Run("OpenRouter key next to a TypeSafe Base URL", func(t *testing.T) {
		client, spy := newSpyClient(t, guiKeySlots(ClientConfig{Endpoint: "https://api.typesafe.ai"}, testORKey), func(SystemOneRequest) (*http.Response, error) {
			return jsonReply(500, `{}`), nil
		})
		if _, err := client.Predict(context.Background(), JevPredictRequest{BufferContext: planNoteExcerpt}); err != nil {
			t.Fatal(err)
		}
		if !reflect.DeepEqual(spy.urls, []string{orSystemOneURL}) {
			t.Errorf("requests = %v, want only %s", spy.urls, orSystemOneURL)
		}
	})
}

// An ordinary chat model on OpenRouter keeps using chat completions; only Jev models are System One.
func TestPredict_ChatModelOnOpenRouterKeepsChatCompletions(t *testing.T) {
	clearJevEnv(t)
	cfg := guiKeySlots(ClientConfig{Endpoint: "https://openrouter.ai/api/v1", Model: "google/gemini-3.8-flash", Timeout: 2 * time.Second}, testORKey)
	client := NewClient(cfg)
	attempted := make(chan string, 1)
	client.httpClient.Transport = recordingRoundTripper{urls: attempted}

	if _, err := client.Predict(context.Background(), JevPredictRequest{BufferContext: planNoteExcerpt}); err != nil {
		t.Fatal(err)
	}
	select {
	case u := <-attempted:
		if u != orChatURL {
			t.Errorf("first request = %s, want %s", u, orChatURL)
		}
	default:
		t.Fatal("expected a chat-completions request")
	}
}

func TestSystemOne_RoutesOnlyToSystemOneHosts(t *testing.T) {
	question := SystemOneRequest{
		State:     "check this",
		Questions: map[string]SystemOneQuestion{"q": {Type: QuestionNoul, Instructions: "Is it fine?"}},
	}
	remoteNoul := func(SystemOneRequest) (*http.Response, error) {
		return jsonReply(200, `{"model":"jev-1.13.0","answers":{"q":{"type":"noul","noul":0.9}},"usage":{"input_tokens":1,"output_tokens":1}}`), nil
	}

	t.Run("OpenRouter key and a Jev model reach OpenRouter's System One API", func(t *testing.T) {
		client, spy := newSpyClient(t, guiKeySlots(ClientConfig{Endpoint: "https://openrouter.ai/api/v1"}, testORKey), remoteNoul)
		resp, err := client.SystemOne(context.Background(), question)
		if err != nil {
			t.Fatal(err)
		}
		if resp.Answers["q"].Noul != 0.9 {
			t.Errorf("noul = %v, want the remote 0.9", resp.Answers["q"].Noul)
		}
		if !reflect.DeepEqual(spy.urls, []string{orSystemOneURL}) {
			t.Errorf("requests = %v, want only %s", spy.urls, orSystemOneURL)
		}
	})

	t.Run("a TypeSafe-style key is not sent to OpenRouter", func(t *testing.T) {
		clearJevEnv(t)
		client := NewClient(guiKeySlots(ClientConfig{Endpoint: "https://openrouter.ai/api/v1", Timeout: time.Second}, testTSKey))
		client.httpClient.Transport = failingRoundTripper{t: t}
		if _, err := client.SystemOne(context.Background(), question); err != nil {
			t.Fatal(err)
		}
	})

	t.Run("a chat model on OpenRouter is not a System One call", func(t *testing.T) {
		clearJevEnv(t)
		client := NewClient(guiKeySlots(ClientConfig{Endpoint: "https://openrouter.ai/api/v1", Model: "google/gemini-3.8-flash", Timeout: time.Second}, testORKey))
		client.httpClient.Transport = failingRoundTripper{t: t}
		if _, err := client.SystemOne(context.Background(), question); err != nil {
			t.Fatal(err)
		}
	})

	t.Run("an OpenRouter key is not sent to a custom server", func(t *testing.T) {
		clearJevEnv(t)
		client := NewClient(guiKeySlots(ClientConfig{Endpoint: "http://127.0.0.1:9", Timeout: time.Second}, testORKey))
		client.httpClient.Transport = failingRoundTripper{t: t}
		if _, err := client.SystemOne(context.Background(), question); err != nil {
			t.Fatal(err)
		}
	})
}

func TestIsSystemOneModel(t *testing.T) {
	for model, want := range map[string]bool{
		"jev-latest":            true,
		"jev-1.13":              true,
		"typesafe/jev-1.13":     true,
		"~typesafe/jev-latest":  true,
		"  JEV-latest ":         true,
		"":                      false,
		"google/gemini-3.8":     false,
		"openai/gpt-5":          false,
		"typesafe/other-model":  false,
		"meta/jevons-paradox-1": false,
	} {
		if got := isSystemOneModel(model); got != want {
			t.Errorf("isSystemOneModel(%q) = %v, want %v", model, got, want)
		}
	}
}

func TestSystemOneEndpointHelpers(t *testing.T) {
	typeSafe := map[string]bool{
		"https://api.typesafe.ai":                 true,
		"https://api.typesafe.ai/":                true,
		"https://api.typesafe.ai/v1":              true,
		"api.typesafe.ai":                         true,
		"HTTPS://API.TYPESAFE.AI/v1/systemone":    true,
		"https://typesafe.ai":                     true,
		"http://127.0.0.1:8080/v1/systemone":      true,
		"https://openrouter.ai/api/v1":            false,
		"https://example.com":                     false,
		"https://nottypesafe.ai":                  false,
		"https://typesafe.ai.example.com/predict": false,
		"":    false,
		"   ": false,
	}
	for endpoint, want := range typeSafe {
		if got := isTypeSafeEndpoint(endpoint); got != want {
			t.Errorf("isTypeSafeEndpoint(%q) = %v, want %v", endpoint, got, want)
		}
	}

	for endpoint, want := range map[string]string{
		"https://api.typesafe.ai":              tsSystemOneURL,
		"https://api.typesafe.ai/":             tsSystemOneURL,
		"https://api.typesafe.ai/v1":           tsSystemOneURL,
		"https://api.typesafe.ai/v1/":          tsSystemOneURL,
		"https://api.typesafe.ai/v1/systemone": tsSystemOneURL,
		"https://api.typesafe.ai/v1/systemOne": tsSystemOneURL,
		"api.typesafe.ai":                      tsSystemOneURL,
		"http://localhost:8080/api":            "http://localhost:8080/api/v1/systemone",
	} {
		if got := systemOneURL(endpoint); got != want {
			t.Errorf("systemOneURL(%q) = %q, want %q", endpoint, got, want)
		}
	}
}

// The pool Jev ranks is exactly what the built-in rules can produce: nothing from the network is
// ever shown or run, and every plain shell command in it passes the command guard.
func TestLocalCandidatePool(t *testing.T) {
	client := NewClient(ClientConfig{})
	verifier := NewASTCommandVerifier()

	req := JevPredictRequest{BufferContext: gitNoteExcerpt}
	pool := client.localCandidatePool(req)
	if len(pool) != 11 {
		t.Fatalf("pool has %d candidates, want 11: %v", len(pool), commandsOf(pool))
	}

	primary := client.predictLocal(req).Candidates
	if !reflect.DeepEqual(commandsOf(pool[:len(primary)]), commandsOf(primary)) {
		t.Errorf("pool starts with %v, want the rules' own picks %v", commandsOf(pool[:len(primary)]), commandsOf(primary))
	}

	seen := map[string]bool{}
	for _, c := range pool {
		if seen[c.Command] {
			t.Errorf("duplicate command %q", c.Command)
		}
		seen[c.Command] = true

		if strings.HasPrefix(c.Command, "{{") || strings.HasPrefix(c.Command, "[?") {
			continue
		}
		if c.ActionType != "sh" {
			t.Errorf("plain command %q must be typed sh, got %q", c.Command, c.ActionType)
		}
		result, err := verifier.Verify(c.Command)
		if err != nil || !result.IsSafe {
			t.Errorf("command %q must pass the guard: %+v, %v", c.Command, result, err)
		}
	}

	// Every candidate any keyword rule can pick is in the pool.
	for _, ctx := range []string{"agent の調査", "git diff", "今日の予定", "unit test", "banana"} {
		for _, c := range client.predictLocal(JevPredictRequest{BufferContext: ctx}).Candidates {
			if !seen[c.Command] {
				t.Errorf("candidate %q for context %q is missing from the pool", c.Command, ctx)
			}
		}
	}
}
