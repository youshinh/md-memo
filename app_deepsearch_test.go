package main

import (
	"context"
	"encoding/json"
	"fmt"
	"hash/fnv"
	"math"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
	"unicode"

	"md-memo/pkg/appdir"
	"md-memo/pkg/cli"
	"md-memo/pkg/deepsearch"
	"md-memo/pkg/semindex"
)

// A loopback server that is every model these tests talk to: it embeds with hashed character pairs (/v1/embeddings), answers a chat
// (/v1/chat/completions) with a script, and remembers what it was sent. Nothing leaves the machine.
type deepFakeServer struct {
	*httptest.Server
	mu          sync.Mutex
	prompts     []string      // the user message of every chat request
	chats       int32         // chat requests received
	answer      string        // what a chat answers
	chatGate    chan struct{} // when not nil, a chat waits for it to be closed
	embedGate   chan struct{} // when not nil, the first embedding request waits for it to be closed
	embedWaits  int32         // embedding requests that reached the gate
	embedPasses int32
}

func pairVec(text string, dim int) []float32 {
	rs := []rune(strings.Map(func(r rune) rune {
		if unicode.IsSpace(r) {
			return -1
		}
		return unicode.ToLower(r)
	}, text))
	v := make([]float32, dim)
	for i := 0; i+1 < len(rs); i++ {
		h := fnv.New32a()
		_, _ = h.Write([]byte(string(rs[i : i+2])))
		v[h.Sum32()%uint32(dim)]++
	}
	var n float64
	for _, x := range v {
		n += float64(x * x)
	}
	if n == 0 {
		v[0] = 1
		return v
	}
	for i := range v {
		v[i] /= float32(math.Sqrt(n))
	}
	return v
}

func newDeepFakeServer(t *testing.T) *deepFakeServer {
	t.Helper()
	f := &deepFakeServer{answer: "No answer."}
	f.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v1/embeddings":
			var req struct {
				Input []string `json:"input"`
			}
			if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
				http.Error(w, err.Error(), http.StatusBadRequest)
				return
			}
			f.mu.Lock()
			gate := f.embedGate
			f.mu.Unlock()
			if gate != nil && atomic.AddInt32(&f.embedWaits, 1) == 1 {
				select {
				case <-gate:
				case <-r.Context().Done():
				}
			}
			data := make([]map[string]interface{}, len(req.Input))
			for i, s := range req.Input {
				data[i] = map[string]interface{}{"index": i, "embedding": pairVec(s, 64)}
			}
			_ = json.NewEncoder(w).Encode(map[string]interface{}{"data": data})
		case "/v1/chat/completions":
			var req struct {
				Messages []struct {
					Role    string `json:"role"`
					Content string `json:"content"`
				} `json:"messages"`
			}
			if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
				http.Error(w, err.Error(), http.StatusBadRequest)
				return
			}
			f.mu.Lock()
			for _, m := range req.Messages {
				if m.Role == "user" {
					f.prompts = append(f.prompts, m.Content)
				}
			}
			gate, answer := f.chatGate, f.answer
			f.mu.Unlock()
			atomic.AddInt32(&f.chats, 1)
			if gate != nil {
				select {
				case <-gate:
				case <-r.Context().Done():
					return
				}
			}
			_ = json.NewEncoder(w).Encode(map[string]interface{}{
				"choices": []map[string]interface{}{{"message": map[string]string{"role": "assistant", "content": answer}}},
			})
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(f.Close)
	return f
}

func (f *deepFakeServer) lastPrompt() string {
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.prompts) == 0 {
		return ""
	}
	return f.prompts[len(f.prompts)-1]
}

func (f *deepFakeServer) setAnswer(s string) {
	f.mu.Lock()
	f.answer = s
	f.mu.Unlock()
}

func (f *deepFakeServer) chatCount() int { return int(atomic.LoadInt32(&f.chats)) }

// waitUntil polls until cond holds.
func waitUntil(t *testing.T, what string, d time.Duration, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(d)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", what)
}

const deepFakeSecret = "sk-abcdefghijklmnopqrstuvwxyz0123456789ABCD"

// deepSandbox writes config.json (scrap folder, text model, optional semantic model and consents), seeds a few notes and returns an App
// that has them. textBase is the text model's base URL; semBase "" leaves the semantic search off.
func deepSandbox(t *testing.T, textBase, semBase string, consent map[string]interface{}) (*App, string, *asyncMockWebView) {
	t.Helper()
	t.Setenv(semindex.EnvAPIKey, "")
	dir := t.TempDir()
	write := func(name, body string) {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write("2026-09-01.md", "# 2026-09-01 09:00\n\n竹は成長が早く、三年ほどで伐採できる。建材として使えば環境への負荷が小さい。\n連絡用のキーは "+deepFakeSecret+" だった。\n\n# 2026-09-01 15:30\n\nRust の借用チェッカーに怒られた。ライフタイムの書き方を調べる。\n")
	write("2026-09-02.md", "# 2026-09-02 10:00\n\n夕食はカレーにした。スパイスから煮込むと香りが全然違う。\n\n# 2026-09-02 11:00\n\n竹の伐採の件。業者に連絡した。\n")
	write("2026-09-03.md", "# 2026-09-03 08:00\n\n会議の議事録。次回までに見積もりを出す。担当は佐藤さん。\n")

	cfg := map[string]interface{}{"scraps": map[string]string{"scrapDir": dir}}
	if textBase != "" {
		cfg["text"] = map[string]interface{}{"baseUrl": textBase, "model": "test-model"}
	}
	if semBase != "" {
		cfg["semantic"] = map[string]interface{}{"enabled": true, "model": map[string]interface{}{"baseUrl": semBase, "model": "bge-m3"}}
	}
	if consent != nil {
		cfg["general"] = map[string]interface{}{"cloudConsent": consent}
	}
	writeDeepConfig(t, cfg)
	mock := &asyncMockWebView{}
	return &App{w: mock, scrapDir: dir}, dir, mock
}

func writeDeepConfig(t *testing.T, cfg map[string]interface{}) {
	t.Helper()
	b, _ := json.Marshal(cfg)
	path := appdir.ConfigFilePath()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, b, 0o600); err != nil {
		t.Fatal(err)
	}
}

func buildDeepIndex(t *testing.T) {
	t.Helper()
	var out, errOut strings.Builder
	code, err := cli.NewHeadlessRunner(&out, &errOut).Run([]string{"scrap", "index", "--json"})
	if err != nil || code != 0 {
		t.Fatalf("scrap index: code %d err %v stderr %q", code, err, errOut.String())
	}
}

// sourceWith is the number of the planned source whose text holds s.
func sourceWith(t *testing.T, planID, s string) int {
	t.Helper()
	p := deepPlans.get(planID, time.Now())
	if p == nil {
		t.Fatalf("plan %q is not kept", planID)
	}
	for _, src := range p.sources {
		if strings.Contains(src.Text, s) {
			return src.N
		}
	}
	t.Fatalf("no source holds %q: %+v", s, p.sources)
	return 0
}

func TestDeepSearchPlanAndRunEndToEnd(t *testing.T) {
	srv := newDeepFakeServer(t)
	app, dir, _ := deepSandbox(t, srv.URL+"/v1", srv.URL, nil)
	buildDeepIndex(t)

	plan, err := app.buildDeepPlan(context.Background(), "竹の成長について", 10)
	if err != nil {
		t.Fatal(err)
	}
	if !plan.ModelConfigured || !plan.Semantic || plan.PlanID == "" || len(plan.Sources) == 0 {
		t.Fatalf("plan: %+v", plan)
	}
	if !plan.Destination.Local || !plan.Destination.ConsentGiven || plan.Destination.Model != "test-model" {
		t.Errorf("a model on this machine needs no consent: %+v", plan.Destination)
	}
	if plan.EstTokens <= 0 || plan.Stats.Used != len(plan.Sources) || plan.Stats.TotalChars <= 0 {
		t.Errorf("sizes: %+v", plan)
	}
	for _, n := range plan.Notes {
		if strings.Contains(n, "--cutoff") || strings.Contains(n, "md-memo scrap") {
			t.Errorf("a note written for the command line reached the dialog: %q", n)
		}
	}
	if plan.Stats.Masked != 1 {
		t.Errorf("the key in the note must be taken out of what would be sent: %+v", plan.Stats)
	}
	for _, s := range plan.Sources {
		if strings.Contains(s.Rel, `\`) || filepath.IsAbs(s.Rel) || s.Chars <= 0 || s.StartLine <= 0 || s.EndLine < s.StartLine {
			t.Errorf("source %+v", s)
		}
	}
	n := sourceWith(t, plan.PlanID, "竹は成長が早く")

	srv.setAnswer(fmt.Sprintf("竹は三年ほどで伐採できる[%d]。\n\n## 根拠\n> 竹は成長が早く、三年ほどで伐採できる。 [%d]\n> 竹は一年で必ず倍になる。 [%d]\n", n, n, n))
	got, err := app.runDeepSearch(plan.PlanID, "ja")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(got.Markdown, "<!-- md-memo:deepsearch -->\n") {
		t.Errorf("the note must start with the mark that keeps it out of the index:\n%s", got.Markdown)
	}
	if !strings.Contains(got.Markdown, "](file:///") || !strings.Contains(got.Markdown, "2026-09-01.md") {
		t.Errorf("the list of sources must link to the files:\n%s", got.Markdown)
	}
	if !strings.Contains(got.Markdown, fmt.Sprintf("伐採できる[%d]。", n)) || strings.Contains(got.Markdown, fmt.Sprintf("[%d](file", n)) {
		t.Errorf("citations in the text are bare numbers (the note is read as plain text):\n%s", got.Markdown)
	}
	if strings.Count(got.Markdown, "(未検証)") != 1 || got.Stats.Verified != 1 || got.Stats.Unverified != 1 || got.Stats.Cited != 1 || got.Stats.InvalidRefs != 0 {
		t.Errorf("the invented quotation must be marked, the real one not: %+v\n%s", got.Stats, got.Markdown)
	}
	if got.Title != "深掘り 竹の成長について" || got.Stats.Model != "test-model" || got.Stats.Sources != len(plan.Sources) {
		t.Errorf("title/stats: %q %+v", got.Title, got.Stats)
	}
	// what the model was sent: the numbered excerpts and the question, never the key
	prompt := srv.lastPrompt()
	if !strings.Contains(prompt, "竹は成長が早く") || !strings.Contains(prompt, fmt.Sprintf("[%d] ", n)) || !strings.Contains(prompt, "竹の成長について") {
		t.Errorf("prompt lacks the sources or the question:\n%s", prompt)
	}
	if strings.Contains(prompt, deepFakeSecret) || strings.Contains(got.Markdown, deepFakeSecret) {
		t.Errorf("a key of the notes reached the model or the note")
	}
	// the files themselves are not touched
	if b, _ := os.ReadFile(filepath.Join(dir, "2026-09-01.md")); !strings.Contains(string(b), deepFakeSecret) {
		t.Errorf("the note on disk must keep its text")
	}
	// the plan is spent
	if _, err := app.runDeepSearch(plan.PlanID, "ja"); err == nil || err.Error() != "plan_expired" {
		t.Errorf("a plan runs once: %v", err)
	}
}

func TestDeepSearchPlanFallsBackToWordsWhenTheSemanticSearchIsOff(t *testing.T) {
	srv := newDeepFakeServer(t)
	app, _, _ := deepSandbox(t, srv.URL+"/v1", "", nil)

	plan, err := app.buildDeepPlan(context.Background(), "竹 伐採", 10)
	if err != nil {
		t.Fatal(err)
	}
	if plan.Semantic || len(plan.Sources) == 0 || plan.PlanID == "" {
		t.Fatalf("the notes that hold the words are still sources: %+v", plan)
	}
	if len(plan.Notes) == 0 || !strings.Contains(plan.Notes[0], "semantic search is off") {
		t.Errorf("the plan must say why it searched by words: %v", plan.Notes)
	}
}

func TestDeepSearchPlanWithoutATextModelDoesNoSearch(t *testing.T) {
	app, _, _ := deepSandbox(t, "", "", nil)
	plan, err := app.buildDeepPlan(context.Background(), "竹", 10)
	if err != nil {
		t.Fatal(err)
	}
	if plan.ModelConfigured || plan.PlanID != "" || len(plan.Sources) != 0 {
		t.Errorf("no model: no plan: %+v", plan)
	}
	if _, err := app.buildDeepPlan(context.Background(), "   ", 10); err == nil {
		t.Errorf("an empty question is an error")
	}
	// a plan that exists while the model has been removed since still does not run
	id := deepPlans.put(&deepPlan{query: "竹", sources: []deepsearch.Source{{N: 1, Text: "竹"}}}, time.Now())
	if _, err := app.runDeepSearch(id, "ja"); err == nil || err.Error() != "model_not_configured" {
		t.Errorf("run without a model: %v", err)
	}
}

func TestDeepSearchNeverSendsToAHostThatWasNotAllowed(t *testing.T) {
	// .invalid never resolves: if anything tried to connect, the error would not be consent_required
	app, _, _ := deepSandbox(t, "https://llm.example.invalid/v1", "", nil)
	plan, err := app.buildDeepPlan(context.Background(), "竹 伐採", 10)
	if err != nil {
		t.Fatal(err)
	}
	d := plan.Destination
	if d.Local || d.ConsentGiven || d.Host != "llm.example.invalid" || d.ConsentKey != "llm.example.invalid" {
		t.Fatalf("destination: %+v", d)
	}
	if _, err := app.runDeepSearch(plan.PlanID, "ja"); err == nil || err.Error() != "consent_required" {
		t.Fatalf("a cloud host that was not allowed must not get the notes: %v", err)
	}

	// allowing https://host does not allow http://host (the notes and the key would travel in the clear)
	writeDeepConfig(t, map[string]interface{}{
		"scraps":  map[string]string{"scrapDir": app.scrapDir},
		"text":    map[string]interface{}{"baseUrl": "http://llm.example.invalid/v1", "model": "m"},
		"general": map[string]interface{}{"cloudConsent": map[string]interface{}{"llm.example.invalid": "2026-10-02"}},
	})
	app.invalidateConfigCache()
	plan, err = app.buildDeepPlan(context.Background(), "竹 伐採", 10)
	if err != nil {
		t.Fatal(err)
	}
	if plan.Destination.ConsentKey != "http://llm.example.invalid" || plan.Destination.ConsentGiven || plan.Destination.Host != "llm.example.invalid" {
		t.Errorf("plain http has its own key: %+v", plan.Destination)
	}
	if _, err := app.runDeepSearch(plan.PlanID, "ja"); err == nil || err.Error() != "consent_required" {
		t.Errorf("http was not allowed: %v", err)
	}

	// the answer the window stored is read from the file: allowed (a value that is truthy, a key with credentials never)
	for _, c := range []struct {
		consent map[string]interface{}
		want    bool
	}{
		{map[string]interface{}{"http://llm.example.invalid": "2026-10-02"}, true},
		{map[string]interface{}{"HTTP://LLM.example.invalid": true}, true},
		{map[string]interface{}{"http://llm.example.invalid": ""}, false},
		{map[string]interface{}{"http://llm.example.invalid": false}, false},
		{map[string]interface{}{"user:pw@llm.example.invalid": "x", "https://llm.example.invalid": "x"}, false},
	} {
		writeDeepConfig(t, map[string]interface{}{
			"text":    map[string]interface{}{"baseUrl": "http://llm.example.invalid/v1", "model": "m"},
			"general": map[string]interface{}{"cloudConsent": c.consent},
		})
		app.invalidateConfigCache()
		if got := app.deepTextSettings().consentGiven(); got != c.want {
			t.Errorf("consent %v: given = %v, want %v", c.consent, got, c.want)
		}
	}
}

func TestDeepSearchLocalNetworkIsNotThisMachine(t *testing.T) {
	// the ask bar lets a machine of the local network pass; a deep search sends many notes at once and asks
	writeDeepConfig(t, map[string]interface{}{"text": map[string]interface{}{"baseUrl": "http://192.168.1.20:11434", "model": "m"}})
	app := &App{}
	s := app.deepTextSettings()
	if key, local := s.destination(); local || key != "http://192.168.1.20:11434" || s.consentGiven() {
		t.Errorf("a machine of the local network: %q %v given %v", key, local, s.consentGiven())
	}
	for _, base := range []string{"http://localhost:11434", "http://127.0.0.1:1234/v1", "http://[::1]:11434"} {
		writeDeepConfig(t, map[string]interface{}{"text": map[string]interface{}{"baseUrl": base, "model": "m"}})
		app.invalidateConfigCache()
		if !app.deepTextSettings().consentGiven() {
			t.Errorf("%s is this machine", base)
		}
	}
}

func TestCancelDeepSearchDropsTheAnswer(t *testing.T) {
	srv := newDeepFakeServer(t)
	srv.chatGate = make(chan struct{})
	t.Cleanup(func() { // runs before the server's Close: a request that waits would hold it
		defer func() { _ = recover() }()
		close(srv.chatGate)
	})
	app, _, _ := deepSandbox(t, srv.URL+"/v1", "", nil)
	plan, err := app.buildDeepPlan(context.Background(), "竹 伐採", 10)
	if err != nil || plan.PlanID == "" {
		t.Fatalf("plan: %v %+v", err, plan)
	}
	if app.CancelDeepSearch(plan.PlanID) {
		t.Errorf("nothing is running yet")
	}
	errc := make(chan error, 1)
	go func() {
		_, err := app.runDeepSearch(plan.PlanID, "ja")
		errc <- err
	}()
	waitUntil(t, "the request to the model", 5*time.Second, func() bool { return srv.chatCount() == 1 })
	if _, err := app.runDeepSearch(plan.PlanID, "ja"); err == nil || !strings.Contains(err.Error(), "already running") {
		t.Errorf("a plan runs once at a time: %v", err)
	}
	if !app.CancelDeepSearch(plan.PlanID) {
		t.Fatalf("a run was going")
	}
	select {
	case err := <-errc:
		if err == nil || err.Error() != "cancelled" {
			t.Errorf("run after cancel: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the cancelled run did not return")
	}
	// the plan is still there to run again
	if deepPlans.get(plan.PlanID, time.Now()) == nil {
		t.Errorf("a cancelled run keeps its plan")
	}
	if app.CancelDeepSearch("p_unknown") {
		t.Errorf("an unknown plan")
	}
}

func TestDeepPlanStoreExpiresAndEvicts(t *testing.T) {
	s := &deepPlanStore{plans: map[string]*deepPlan{}}
	t0 := time.Date(2026, 10, 2, 12, 0, 0, 0, time.UTC)
	first := s.put(&deepPlan{query: "a"}, t0)
	if s.get(first, t0.Add(deepPlanTTL-time.Second)) == nil {
		t.Errorf("a plan lives for %v", deepPlanTTL)
	}
	if s.get(first, t0.Add(deepPlanTTL+time.Second)) != nil {
		t.Errorf("an old plan is gone")
	}
	if s.get(first, t0) != nil {
		t.Errorf("an expired plan was dropped when asked for")
	}
	ids := map[string]bool{}
	var firstOfMany string
	for i := 0; i < deepPlanMax+3; i++ {
		id := s.put(&deepPlan{query: fmt.Sprint(i)}, t0.Add(time.Duration(i)*time.Second))
		if i == 0 {
			firstOfMany = id
		}
		if ids[id] {
			t.Fatalf("id %s was given twice", id)
		}
		ids[id] = true
	}
	if len(s.plans) != deepPlanMax {
		t.Errorf("%d plans kept, want %d", len(s.plans), deepPlanMax)
	}
	if s.get(firstOfMany, t0.Add(time.Minute)) != nil {
		t.Errorf("the oldest plan goes first")
	}
	// expired ones go when a new one comes
	s.put(&deepPlan{query: "late"}, t0.Add(time.Hour))
	if len(s.plans) != 1 {
		t.Errorf("only the new plan is left: %d", len(s.plans))
	}
}

func TestDeepNumCtxAndLimit(t *testing.T) {
	for _, c := range []struct{ tokens, want int }{{0, 4096}, {1000, 4096}, {2048, 4096}, {2049, 5120}, {12000, 14336}, {100000, 32768}} {
		if got := deepNumCtx(c.tokens); got != c.want {
			t.Errorf("deepNumCtx(%d) = %d, want %d", c.tokens, got, c.want)
		}
	}
	for _, c := range []struct{ in, want int }{{-1, 10}, {0, 10}, {5, 5}, {30, 30}, {31, 30}, {500, 30}} {
		if got := deepLimit(c.in); got != c.want {
			t.Errorf("deepLimit(%d) = %d, want %d", c.in, got, c.want)
		}
	}
}

func TestSemanticPanelResultGroupsHitsByFile(t *testing.T) {
	// built through the real search so that the hit type is the one the command returns
	srv := newDeepFakeServer(t)
	_, dir, _ := deepSandbox(t, srv.URL+"/v1", srv.URL, nil)
	buildDeepIndex(t)
	got, err := cli.ScrapSearch(context.Background(), cli.ScrapSearchParams{Text: "竹の伐採", Semantic: true, Limit: 10})
	if err != nil || !got.Semantic || len(got.Matches) == 0 {
		t.Fatalf("search: %v %+v", err, got)
	}
	out := semanticPanelResult(got)
	if !out.Semantic || len(out.Results) == 0 || out.Notes == nil {
		t.Fatalf("%+v", out)
	}
	seen := map[string]bool{}
	total := 0
	for _, r := range out.Results {
		if seen[r.FilePath] || r.FileName != filepath.Base(r.FilePath) || !strings.HasPrefix(r.FilePath, dir) || len(r.Matches) == 0 {
			t.Errorf("one entry per file: %+v", r)
		}
		seen[r.FilePath] = true
		for _, m := range r.Matches {
			total++
			if m.Source != "semantic" || m.LineNumber <= 0 || m.EndLine < m.LineNumber || m.Score <= 0 || strings.Contains(m.LineText, "\n") || m.Heading == "" {
				t.Errorf("match %+v", m)
			}
		}
	}
	if total != len(got.Matches) {
		t.Errorf("%d matches in, %d out", len(got.Matches), total)
	}
	b, _ := json.Marshal(out)
	for _, key := range []string{`"filePath"`, `"fileName"`, `"matches"`, `"lineNumber"`, `"lineText"`, `"endLine"`, `"source":"semantic"`, `"score"`, `"semantic":true`, `"results"`} {
		if !strings.Contains(string(b), key) {
			t.Errorf("the JSON lacks %s: %s", key, b)
		}
	}
	// the word search the semantic search falls back to says so, and a long chunk is one short line
	words := semanticPanelResult(cli.ScrapSearchResult{Matches: nil, Notes: nil})
	if words.Results == nil || words.Notes == nil || len(words.Results) != 0 {
		t.Errorf("empty is [] and not null: %+v", words)
	}
	// counts travel as numbers: the sentences of the command line that repeat them (with its flags in them) do not reach the window
	counted := semanticPanelResult(cli.ScrapSearchResult{Semantic: true, Pending: 3, LeftOut: 2, Notes: []string{
		"2 lower-scoring notes were left out (below 85% of the best score; --cutoff 0 shows them)",
		"3 files are not indexed yet (md-memo scrap index, or --update); they were searched by words, and the notes that hold every word come first",
		"the index update was cut short (x)",
	}})
	if counted.LeftOut != 2 || counted.Pending != 3 || len(counted.Notes) != 1 || counted.Notes[0] != "the index update was cut short (x)" {
		t.Errorf("counts and notes: %+v", counted)
	}
	if b, _ := json.Marshal(counted); !strings.Contains(string(b), `"leftOut":2`) || !strings.Contains(string(b), `"pending":3`) {
		t.Errorf("JSON: %s", b)
	}
	if got := panelLineText("a\n  b\t" + strings.Repeat("あ", 300)); strings.Contains(got, "\n") || len([]rune(got)) != 241 || !strings.HasSuffix(got, "…") || !strings.HasPrefix(got, "a b あ") {
		t.Errorf("panelLineText = %q", got)
	}
}

func TestSearchScrapsSemanticAsyncAnswersAndIsSuperseded(t *testing.T) {
	srv := newDeepFakeServer(t)
	app, _, mock := deepSandbox(t, srv.URL+"/v1", srv.URL, nil)
	buildDeepIndex(t)

	app.SearchScrapsSemanticAsync("r1", "竹の成長", 10)
	e := mock.waitFor(t, `__onDeepSearchResult("r1"`, 5*time.Second)
	if !strings.Contains(e, `"results":[{"filePath"`) || !strings.Contains(e, `"source":"semantic"`) || !strings.HasSuffix(e, `, ""); }`) {
		t.Errorf("answer: %.300s", e)
	}

	// a newer search replaces one that is still waiting for the model
	srv.mu.Lock()
	srv.embedGate = make(chan struct{})
	srv.mu.Unlock()
	atomic.StoreInt32(&srv.embedWaits, 0)
	app.SearchScrapsSemanticAsync("r2", "竹の成長", 10)
	waitUntil(t, "the first search to reach the model", 5*time.Second, func() bool { return atomic.LoadInt32(&srv.embedWaits) >= 1 })
	app.SearchScrapsSemanticAsync("r3", "カレーの香り", 10)
	e2 := mock.waitFor(t, `__onDeepSearchResult("r2"`, 5*time.Second)
	if !strings.Contains(e2, `null, "superseded"`) {
		t.Errorf("a replaced search is rejected with superseded: %.200s", e2)
	}
	e3 := mock.waitFor(t, `__onDeepSearchResult("r3"`, 5*time.Second)
	if !strings.Contains(e3, `"results":[{"filePath"`) {
		t.Errorf("the newer search answers: %.200s", e3)
	}
	srv.mu.Lock()
	gate := srv.embedGate
	srv.embedGate = nil
	srv.mu.Unlock()
	close(gate)
}

func TestSearchScrapsSemanticAsyncRejectsWithASentenceWhenTheFeatureIsOff(t *testing.T) {
	_, _, mock := deepSandbox(t, "", "", nil)
	app := &App{w: mock}
	app.SearchScrapsSemanticAsync("r1", "竹", 10)
	e := mock.waitFor(t, `__onDeepSearchResult("r1"`, 5*time.Second)
	if !strings.Contains(e, `null, "semantic search is off`) {
		t.Errorf("the person has to act, so the answer is a sentence: %.300s", e)
	}
}

func TestDispatchDeepSearchResultIsHarmlessWithoutAWindow(t *testing.T) {
	app := &App{}
	app.dispatchDeepSearchResult("r", map[string]int{"a": 1}, nil) // no window: nothing to do, nothing to crash
	mock := &asyncMockWebView{}
	app = &App{w: mock}
	app.dispatchDeepSearchResult("r\"x", map[string]int{"a": 1}, fmt.Errorf("boom   \"quoted\""))
	e := mock.waitFor(t, "__onDeepSearchResult", time.Second)
	if strings.ContainsRune(e, ' ') || !strings.Contains(e, `{"a":1}`) {
		t.Errorf("eval string: %s", e)
	}
}
