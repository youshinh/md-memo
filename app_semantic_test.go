package main

import (
	"encoding/json"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// The Settings screen's semantic section: the index status and the update by hand (app_semantic.go). The section is passed in by the screen,
// as it is held while the person is still editing it.

// sectionFor is the "semantic" object of the screen: on, with the model on the fake server (or a host of the test's choosing).
func sectionFor(base string, extra map[string]interface{}) string {
	sec := map[string]interface{}{"enabled": true, "model": map[string]interface{}{"baseUrl": base, "model": "bge-m3"}}
	for k, v := range extra {
		sec[k] = v
	}
	b, _ := json.Marshal(sec)
	return string(b)
}

// resultOf is the JSON the page got for reqID (the first argument after the id), and the error text.
func resultOf(t *testing.T, mock *asyncMockWebView, reqID string) (map[string]interface{}, string) {
	t.Helper()
	e := mock.waitFor(t, `__onDeepSearchResult("`+reqID+`"`, 10*time.Second)
	rest := strings.TrimPrefix(e[strings.Index(e, `__onDeepSearchResult("`+reqID+`", `):], `__onDeepSearchResult("`+reqID+`", `)
	// "<result json>, <error json>); }"
	rest = strings.TrimSuffix(rest, "); }")
	cut := strings.LastIndex(rest, ", ")
	var out map[string]interface{}
	_ = json.Unmarshal([]byte(rest[:cut]), &out)
	var msg string
	_ = json.Unmarshal([]byte(rest[cut+2:]), &msg)
	return out, msg
}

func TestSemanticStatusSaysWhereTheModelIsAndHowFarTheIndexLags(t *testing.T) {
	srv := newDeepFakeServer(t)
	app, _, mock := deepSandbox(t, srv.URL+"/v1", srv.URL, nil)

	// not built yet: the notes are all new, a model on this machine needs no consent
	app.SemanticStatusAsync("s1", sectionFor(srv.URL, nil))
	st, msg := resultOf(t, mock, "s1")
	if msg != "" || st["enabled"] != true || st["local"] != true || st["consent_given"] != true || st["exists"] != false {
		t.Fatalf("status = %v (%q)", st, msg)
	}
	if n, _ := st["new_files"].(float64); n < 3 {
		t.Errorf("the notes of the sandbox are not in an index that does not exist: %v", st)
	}

	// built: the index is there and up to date
	buildDeepIndex(t)
	app.SemanticStatusAsync("s2", "") // as saved
	st, msg = resultOf(t, mock, "s2")
	if msg != "" || st["exists"] != true || st["new_files"] != float64(0) || st["changed_files"] != float64(0) {
		t.Errorf("a built index: %v (%q)", st, msg)
	}
	if c, _ := st["chunks"].(float64); c < 3 {
		t.Errorf("chunks = %v", st["chunks"])
	}

	// the section of the screen beats the saved one: off here, so the screen shows it as off
	app.SemanticStatusAsync("s3", `{"enabled": false, "model": {"baseUrl": "`+srv.URL+`", "model": "bge-m3"}}`)
	st, _ = resultOf(t, mock, "s3")
	if st["enabled"] != false {
		t.Errorf("the screen's own section is the one asked about: %v", st)
	}

	// a host that is not this machine: a cloud destination, and no consent until the screen's section carries it
	app.SemanticStatusAsync("s4", sectionFor("https://api.example.com/v1", nil))
	st, _ = resultOf(t, mock, "s4")
	if st["local"] != false || st["consent_given"] != false || st["destination"] != "api.example.com" {
		t.Errorf("cloud without consent: %v", st)
	}
	app.SemanticStatusAsync("s5", sectionFor("https://api.example.com/v1", map[string]interface{}{"privacy": map[string]interface{}{"cloudConsent": map[string]string{"api.example.com": "2026-10-03"}}}))
	st, _ = resultOf(t, mock, "s5")
	if st["consent_given"] != true {
		t.Errorf("cloud with the host allowed in the screen's section: %v", st)
	}

	// a section that is not JSON is a sentence, not a crash
	app.SemanticStatusAsync("s6", "{not json")
	_, msg = resultOf(t, mock, "s6")
	if !strings.Contains(msg, "could not be read") {
		t.Errorf("bad section: %q", msg)
	}
}

func TestSemanticUpdateBuildsTheIndexAndReportsProgress(t *testing.T) {
	srv := newDeepFakeServer(t)
	app, _, mock := deepSandbox(t, srv.URL+"/v1", srv.URL, nil)

	app.SemanticUpdateAsync("u1", sectionFor(srv.URL, nil), false, false)
	res, msg := resultOf(t, mock, "u1")
	if msg != "" {
		t.Fatalf("update: %q", msg)
	}
	if f, _ := res["files"].(float64); f < 3 {
		t.Errorf("files = %v", res["files"])
	}
	if e, _ := res["embedded"].(float64); e < 3 || res["local"] != true {
		t.Errorf("result = %v", res)
	}
	mock.waitFor(t, "__semanticProgress(", 2*time.Second) // the last report always goes out

	// the status now says so, and a second run has nothing new to embed
	app.SemanticStatusAsync("s1", "")
	st, _ := resultOf(t, mock, "s1")
	if st["exists"] != true || st["new_files"] != float64(0) {
		t.Errorf("after the update: %v", st)
	}
	app.SemanticUpdateAsync("u2", "", false, false)
	res, msg = resultOf(t, mock, "u2")
	if msg != "" || res["embedded"] != float64(0) {
		t.Errorf("an update with nothing new embeds nothing: %v (%q)", res, msg)
	}

	// a rebuild makes it again
	app.SemanticUpdateAsync("u3", "", true, false)
	res, msg = resultOf(t, mock, "u3")
	if msg != "" || res["rebuilt"] != true {
		t.Errorf("rebuild: %v (%q)", res, msg)
	}
}

func TestSemanticUpdateRefusesWhatMustBeAskedFirst(t *testing.T) {
	deepSandbox(t, "", "", nil)
	srv := newDeepFakeServer(t)
	_, _, mock := deepSandbox(t, srv.URL+"/v1", srv.URL, nil)
	app := &App{w: mock}

	// off: nothing is sent, and the screen is told which code
	app.SemanticUpdateAsync("a", `{"enabled": false, "model": {"baseUrl": "`+srv.URL+`", "model": "bge-m3"}}`, false, false)
	if _, msg := resultOf(t, mock, "a"); msg != "not_enabled" {
		t.Errorf("off: %q", msg)
	}
	// a host that is not this machine, not allowed: refused before any text is sent
	app.SemanticUpdateAsync("b", sectionFor("https://api.example.com/v1", nil), false, false)
	if _, msg := resultOf(t, mock, "b"); !strings.HasPrefix(msg, "consent_required: api.example.com") {
		t.Errorf("not allowed: %q", msg)
	}
}

func TestSemanticUpdateCanBeCancelledAndOnlyOneRunsAtATime(t *testing.T) {
	srv := newDeepFakeServer(t)
	app, _, mock := deepSandbox(t, srv.URL+"/v1", srv.URL, nil)
	srv.mu.Lock()
	srv.embedGate = make(chan struct{}) // the model waits: the run is "going"
	srv.mu.Unlock()
	atomic.StoreInt32(&srv.embedWaits, 0)

	if app.CancelSemanticUpdate() {
		t.Errorf("nothing is running yet")
	}
	app.SemanticUpdateAsync("r1", sectionFor(srv.URL, nil), false, false)
	waitUntil(t, "the run to reach the model", 5*time.Second, func() bool { return atomic.LoadInt32(&srv.embedWaits) >= 1 })

	app.SemanticUpdateAsync("r2", sectionFor(srv.URL, nil), false, false)
	if _, msg := resultOf(t, mock, "r2"); msg != "locked" {
		t.Errorf("a second run while one is going: %q", msg)
	}
	if !app.CancelSemanticUpdate() {
		t.Fatalf("a run was going")
	}
	srv.mu.Lock()
	gate := srv.embedGate
	srv.embedGate = nil
	srv.mu.Unlock()
	close(gate)
	if _, msg := resultOf(t, mock, "r1"); msg != "cancelled" {
		t.Errorf("the cancelled run: %q", msg)
	}
	waitUntil(t, "the run to be over", 5*time.Second, func() bool { return !app.CancelSemanticUpdate() })
}
