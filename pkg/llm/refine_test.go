package llm

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestMarkdownLineKind(t *testing.T) {
	cases := []struct{ line, want string }{
		{"", ""},
		{"ただの文章", ""},
		{"- [ ] ", "task"},
		{"- [ ] 買い物", "task"},
		{"  - [x] 済み", "task"},
		{"* [X] 済み", "task"},
		{"- ", "bullet"},
		{"- 項目", "bullet"},
		{"\t* 項目", "bullet"},
		{"+ 項目", "bullet"},
		{"1. 一つ目", "ordered"},
		{"12) 十二番目", "ordered"},
		{"| a | b |", "table"},
		{"---", ""},
		{"**強調**", ""},
		{"-項目", ""},
		{"1.5 倍", ""},
		{"-", ""},
		{"[ ] 記号なし", ""},
	}
	for _, c := range cases {
		if got := markdownLineKind(c.line); got != c.want {
			t.Errorf("markdownLineKind(%q) = %q, want %q", c.line, got, c.want)
		}
	}
}

func TestBuildRefinePrompt(t *testing.T) {
	t.Run("tidy names the caret line's syntax and never the transcript", func(t *testing.T) {
		got := buildRefinePrompt(RefineContext{Line: "- [ ] "}, nil)
		if !strings.Contains(got, "フィラー") || !strings.Contains(got, "言い直し") {
			t.Errorf("the tidy rules are missing: %s", got)
		}
		if !strings.Contains(got, "タスクリスト") || !strings.Contains(got, "含めない") {
			t.Errorf("a task line must tell the model its marker is already there: %s", got)
		}
		if strings.Contains(got, "書き換える") {
			t.Errorf("the edit rules leaked into a plain dictation: %s", got)
		}
	})

	t.Run("each line kind gets its own rule", func(t *testing.T) {
		seen := map[string]string{}
		for _, line := range []string{"", "- 項目", "1. 項目", "| a |", "- [ ] x"} {
			rule := refineLineRule(markdownLineKind(line))
			for other, otherLine := range seen {
				if rule == other {
					t.Errorf("%q and %q share a rule", line, otherLine)
				}
			}
			seen[rule] = line
		}
	})

	t.Run("selection switches to the edit rules and stays out of the system prompt", func(t *testing.T) {
		got := buildRefinePrompt(RefineContext{Line: "秘密の行", Selection: "秘密の選択"}, nil)
		if !strings.Contains(got, "書き換える") {
			t.Errorf("edit rules missing: %s", got)
		}
		if strings.Contains(got, "秘密の選択") || strings.Contains(got, "秘密の行") {
			t.Errorf("the user's text belongs in the user turn: %s", got)
		}
		if strings.Contains(got, "フィラー") {
			t.Errorf("the tidy rules leaked into speak-to-edit: %s", got)
		}
	})

	t.Run("vocabulary is listed, deduplicated and capped", func(t *testing.T) {
		got := buildRefinePrompt(RefineContext{}, []string{"OCuLink", " OCuLink ", "", "FreeOSMemory"})
		if !strings.Contains(got, "OCuLink、FreeOSMemory") {
			t.Errorf("vocabulary missing or not cleaned: %s", got)
		}
		if strings.Count(got, "OCuLink") != 1 {
			t.Errorf("duplicate term kept: %s", got)
		}
		many := make([]string, maxRefineVocabulary+50)
		for i := range many {
			many[i] = "語" + strings.Repeat("x", i)
		}
		prompt := buildRefinePrompt(RefineContext{}, many)
		section := prompt[strings.Index(prompt, refineVocabularyHeader):]
		if n := strings.Count(section, "、"); n != maxRefineVocabulary-1 {
			t.Errorf("vocabulary separators = %d, want %d (cap)", n, maxRefineVocabulary-1)
		}
	})

	t.Run("no vocabulary, no vocabulary section", func(t *testing.T) {
		if strings.Contains(buildRefinePrompt(RefineContext{}, nil), refineVocabularyHeader) {
			t.Error("empty vocabulary must not add a section")
		}
	})

	t.Run("an over-long caret line is cut", func(t *testing.T) {
		got := buildRefinePrompt(RefineContext{Line: strings.Repeat("Ω", 5000)}, nil)
		if n := strings.Count(got, "Ω"); n != maxRefineLineRunes {
			t.Errorf("quoted line has %d runes, want %d", n, maxRefineLineRunes)
		}
	})
}

func TestBuildRefineInput(t *testing.T) {
	if got := buildRefineInput("えーと明日", RefineContext{}); got != "<transcript>\nえーと明日\n</transcript>" {
		t.Errorf("tidy input = %q", got)
	}
	got := buildRefineInput("丁寧に", RefineContext{Selection: "おはよう"})
	if got != "<selection>\nおはよう\n</selection>\n<transcript>\n丁寧に\n</transcript>" {
		t.Errorf("edit input = %q", got)
	}
}

func TestCleanRefineOutput(t *testing.T) {
	cases := []struct {
		name, out, raw, sel, want string
	}{
		{"plain", "  明日の会議  \n", "raw", "", "明日の会議"},
		{"echoed transcript tags", "<transcript>\n明日の会議\n</transcript>", "raw", "", "明日の会議"},
		{"echoed selection tags", "<selection>おはようございます</selection>", "raw", "おはよう", "おはようございます"},
		{"whole-answer fence", "```\n明日の会議\n```", "raw", "", "明日の会議"},
		{"fence with a language", "```markdown\n- 一つ目\n- 二つ目\n```", "raw", "", "- 一つ目\n- 二つ目"},
		{"a fence the input already had is kept", "```go\nx := 1\n```", "```go\nx := 1\n```", "", "```go\nx := 1\n```"},
		{"a selection with a fence keeps it", "```\nq\n```", "raw", "```\nq\n```", "```\nq\n```"},
		{"an inline backtick is not a fence", "`code` を使う", "raw", "", "`code` を使う"},
		{"empty stays empty", "  \n", "raw", "", ""},
	}
	for _, c := range cases {
		if got := cleanRefineOutput(c.out, c.raw, RefineContext{Selection: c.sel}); got != c.want {
			t.Errorf("%s: got %q, want %q", c.name, got, c.want)
		}
	}
}

const okGenerate = `{"candidates":[{"content":{"parts":[{"text":"  明日の会議は"},{"text":"4時からです。\n"}]}}]}`

// refineServer answers POST /v1beta/models/<model>:generateContent with reply (status 200 unless
// set) and hands every decoded request to check. Anything else is a 404.
func refineServer(t *testing.T, status int, reply string, check func(r *http.Request, body map[string]interface{})) *httptest.Server {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasPrefix(r.URL.Path, "/v1beta/models/") || !strings.HasSuffix(r.URL.Path, ":generateContent") {
			t.Errorf("unexpected path %q", r.URL.Path)
			http.NotFound(w, r)
			return
		}
		raw, _ := io.ReadAll(r.Body)
		var body map[string]interface{}
		if err := json.Unmarshal(raw, &body); err != nil {
			t.Errorf("request body is not JSON: %v (%s)", err, raw)
		}
		if check != nil {
			check(r, body)
		}
		w.Header().Set("Content-Type", "application/json")
		if status != 0 {
			w.WriteHeader(status)
		}
		_, _ = io.WriteString(w, reply)
	}))
	t.Cleanup(server.Close)
	return server
}

func TestRefineVoiceText_RequestShapeAndResult(t *testing.T) {
	var calls int32
	server := refineServer(t, 0, okGenerate, func(r *http.Request, body map[string]interface{}) {
		atomic.AddInt32(&calls, 1)
		if r.URL.Path != "/v1beta/models/gemini-flash-lite-latest:generateContent" {
			t.Errorf("path = %q, want the default refine model", r.URL.Path)
		}
		if got := r.Header.Get("x-goog-api-key"); got != "k-123" {
			t.Errorf("x-goog-api-key = %q", got)
		}
		if r.URL.Query().Get("key") != "" {
			t.Errorf("the key must travel in the header, not the URL: %s", r.URL.String())
		}
		si, _ := body["system_instruction"].(map[string]interface{})
		parts, _ := si["parts"].([]interface{})
		if len(parts) != 1 || !strings.Contains(parts[0].(map[string]interface{})["text"].(string), "フィラー") {
			t.Errorf("system_instruction = %v", si)
		}
		contents, _ := body["contents"].([]interface{})
		if len(contents) != 1 {
			t.Fatalf("contents = %v", body["contents"])
		}
		user := contents[0].(map[string]interface{})
		if user["role"] != "user" {
			t.Errorf("role = %v", user["role"])
		}
		text := user["parts"].([]interface{})[0].(map[string]interface{})["text"].(string)
		if text != "<transcript>\nえーと明日の会議は4時から\n</transcript>" {
			t.Errorf("user turn = %q", text)
		}
		gc, _ := body["generation_config"].(map[string]interface{})
		if gc["temperature"] != 0.1 {
			t.Errorf("temperature = %v, want 0.1", gc["temperature"])
		}
	})

	cfg := VoiceConfig{BaseURL: server.URL, APIKey: "k-123", CustomVocabulary: []string{"OCuLink"}}
	got, err := RefineVoiceText(context.Background(), "  えーと明日の会議は4時から  ", cfg, RefineContext{Line: "- "})
	if err != nil {
		t.Fatalf("RefineVoiceText failed: %v", err)
	}
	if got != "明日の会議は4時からです。" {
		t.Errorf("got %q, want the joined, trimmed text", got)
	}
	if atomic.LoadInt32(&calls) != 1 {
		t.Errorf("expected exactly one request, got %d", calls)
	}
}

func TestRefineVoiceText_SpeakToEditSendsTheSelection(t *testing.T) {
	server := refineServer(t, 0, okGenerate, func(r *http.Request, body map[string]interface{}) {
		si, _ := body["system_instruction"].(map[string]interface{})
		sys := si["parts"].([]interface{})[0].(map[string]interface{})["text"].(string)
		if !strings.Contains(sys, "書き換える") {
			t.Errorf("edit rules missing: %s", sys)
		}
		contents, _ := body["contents"].([]interface{})
		text := contents[0].(map[string]interface{})["parts"].([]interface{})[0].(map[string]interface{})["text"].(string)
		if !strings.Contains(text, "<selection>\nおはよう\n</selection>") || !strings.Contains(text, "<transcript>\nもっと丁寧に\n</transcript>") {
			t.Errorf("user turn = %q", text)
		}
	})
	cfg := VoiceConfig{BaseURL: server.URL, APIKey: "k"}
	if _, err := RefineVoiceText(context.Background(), "もっと丁寧に", cfg, RefineContext{Selection: "おはよう"}); err != nil {
		t.Fatalf("RefineVoiceText failed: %v", err)
	}
}

func TestRefineVoiceText_ModelOverride(t *testing.T) {
	server := refineServer(t, 0, okGenerate, func(r *http.Request, body map[string]interface{}) {
		if r.URL.Path != "/v1beta/models/gemini-custom-model:generateContent" {
			t.Errorf("path = %q, want the configured model without the models/ prefix", r.URL.Path)
		}
	})
	cfg := VoiceConfig{BaseURL: server.URL, APIKey: "k", Refine: RefineSettings{Model: "models/gemini-custom-model"}}
	if _, err := RefineVoiceText(context.Background(), "x", cfg, RefineContext{}); err != nil {
		t.Fatalf("RefineVoiceText failed: %v", err)
	}
}

func TestRefineVoiceText_EmptyInputSendsNothing(t *testing.T) {
	var calls int32
	server := refineServer(t, 0, okGenerate, func(r *http.Request, body map[string]interface{}) { atomic.AddInt32(&calls, 1) })
	got, err := RefineVoiceText(context.Background(), " \n", VoiceConfig{BaseURL: server.URL, APIKey: "k"}, RefineContext{})
	if err != nil || got != "" || atomic.LoadInt32(&calls) != 0 {
		t.Errorf("got (%q, %v) after %d calls, want (\"\", nil) after 0", got, err, calls)
	}
}

func TestRefineVoiceText_NotConfigured(t *testing.T) {
	// A non-Gemini setup and a missing key are "not configured", the kind of error callers can tell
	// from a transient failure.
	_, err := RefineVoiceText(context.Background(), "x", VoiceConfig{BaseURL: "http://localhost:11434", APIKey: "", Refine: RefineSettings{Model: "qwen2.5"}}, RefineContext{})
	if !errors.Is(err, ErrNotConfigured) {
		t.Errorf("a non-Gemini model: err = %v, want ErrNotConfigured", err)
	}
	_, err = RefineVoiceText(context.Background(), "x", VoiceConfig{BaseURL: "https://generativelanguage.googleapis.com"}, RefineContext{})
	if !errors.Is(err, ErrNotConfigured) {
		t.Errorf("no key: err = %v, want ErrNotConfigured", err)
	}
}

func TestRefineVoiceText_Failures(t *testing.T) {
	cases := []struct {
		name    string
		status  int
		reply   string
		wantErr string
	}{
		{"http error", http.StatusInternalServerError, `{"error":{"message":"boom"}}`, "500"},
		{"no candidates", 0, `{"candidates":[]}`, "空のレスポンス"},
		{"blank answer", 0, `{"candidates":[{"content":{"parts":[{"text":"  \n"}]}}]}`, "空でした"},
		{"blocked answer without content", 0, `{"candidates":[{"finishReason":"SAFETY"}]}`, "空でした"},
		{"not json", 0, `<html>`, ""},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			server := refineServer(t, c.status, c.reply, nil)
			_, err := RefineVoiceText(context.Background(), "x", VoiceConfig{BaseURL: server.URL, APIKey: "k"}, RefineContext{})
			if err == nil {
				t.Fatal("expected an error")
			}
			if c.wantErr != "" && !strings.Contains(err.Error(), c.wantErr) {
				t.Errorf("err = %v, want it to mention %q", err, c.wantErr)
			}
		})
	}
}

func TestRefineVoiceText_ErrorNeverQuotesTheKey(t *testing.T) {
	server := refineServer(t, 0, okGenerate, nil)
	url := server.URL
	server.Close()
	_, err := RefineVoiceText(context.Background(), "x", VoiceConfig{BaseURL: url, APIKey: "SECRET-KEY"}, RefineContext{})
	if err == nil {
		t.Fatal("expected a connection error")
	}
	if strings.Contains(err.Error(), "SECRET-KEY") {
		t.Errorf("the key leaked into the error text: %v", err)
	}
}

func TestRefineVoiceText_TimeoutReturnsAnError(t *testing.T) {
	release := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		select {
		case <-release:
		case <-r.Context().Done():
		}
	}))
	t.Cleanup(func() { close(release); server.Close() })

	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	start := time.Now()
	_, err := RefineVoiceText(ctx, "x", VoiceConfig{BaseURL: server.URL, APIKey: "k", Refine: RefineSettings{Model: "gemini-flash-lite-latest"}}, RefineContext{})
	if err == nil || !strings.Contains(err.Error(), "秒") {
		t.Errorf("err = %v, want a timeout message", err)
	}
	if time.Since(start) > 3*time.Second {
		t.Errorf("the call outlived its deadline: %v", time.Since(start))
	}
}
