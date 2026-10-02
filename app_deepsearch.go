package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"time"
	"unicode/utf8"

	"md-memo/pkg/cli"
	"md-memo/pkg/deepsearch"
	"md-memo/pkg/lazyre"
	"md-memo/pkg/llm"
	"md-memo/pkg/search"
	"md-memo/pkg/semindex"
)

// The window side of the semantic search panel and of the deep search (docs/design/deep-search-2026-10.md):
//
//	SearchScrapsSemanticAsync  the panel's semantic mode: the notes close in meaning, in the shape of the plain search's results
//	DeepSearchPlanAsync        search, cut the excerpts out, say what would be sent where; nothing is sent to a model yet
//	DeepSearchRunAsync         send the planned excerpts to the text model and lay the answer out as a note
//	CancelDeepSearch           drop the answer of a run in progress
//
// The three async calls answer through window.__onDeepSearchResult(reqID, result, errMsg) (one callback; the shim's __mdmemoSettle).
// An error is a sentence, except for the codes the window acts on: "cancelled", "superseded" (a newer search replaced this one),
// "consent_required", "model_not_configured" and "plan_expired". A plan that found no note has no plan_id and no sources.

const (
	deepPlanTTL        = 15 * time.Minute
	deepPlanMax        = 8
	deepDefaultSources = 10
	deepMaxSources     = 30
	deepPlanTimeout    = 25 * time.Second // the window gives up at 30 s
	deepAnswerRoom     = 2048             // tokens left for the answer in the context window asked of a local model
	deepAnswerWaitSec  = 540              // how long the model may take to answer (the ask bar's two minutes are too short for 12,000 tokens on a slow machine)
)

// ---- the model the deep search uses, and where it is -----------------------------------------------------------------------------

// deepTextSettings is config.json's "text" model (the one the ask bar uses) and the cloud hosts the person has allowed
// (general.cloudConsent), read from the file the window saves to.
type deepTextSettings struct {
	llm.Config
	consent map[string]bool
}

func (a *App) deepTextSettings() deepTextSettings {
	var raw struct {
		Text    llm.Config `json:"text"`
		General struct {
			CloudConsent map[string]interface{} `json:"cloudConsent"`
		} `json:"general"`
	}
	if s := strings.TrimSpace(a.readConfigCached()); s != "" {
		_ = json.Unmarshal([]byte(strings.TrimPrefix(s, "\xEF\xBB\xBF")), &raw) // a field of the wrong type leaves the rest filled
	}
	t := deepTextSettings{Config: raw.Text, consent: map[string]bool{}}
	t.BaseURL = strings.TrimSpace(t.BaseURL)
	t.Model = strings.TrimSpace(t.Model)
	for host, v := range raw.General.CloudConsent {
		if truthyConsent(v) && !strings.Contains(host, "@") { // a key with credentials in it is never matched (as in the window)
			t.consent[strings.ToLower(host)] = true
		}
	}
	return t
}

func truthyConsent(v interface{}) bool {
	switch x := v.(type) {
	case string:
		return strings.TrimSpace(x) != ""
	case bool:
		return x
	}
	return false
}

// configured is the window's test too: both a server address and a model are set (nothing is guessed for a deep search).
func (t deepTextSettings) configured() bool { return t.BaseURL != "" && t.Model != "" }

// destination is where the text goes: the host as a consent is stored under it (the host with its port; "http://host" for plain
// http), and whether that is this very machine. Only the loopback is local here, stricter than the ask bar, which also lets a
// local-network machine pass: a deep search sends many notes at once.
func (t deepTextSettings) destination() (key string, local bool) {
	return semindex.DestinationOf(t.BaseURL, t.Model)
}

func (t deepTextSettings) consentGiven() bool {
	key, local := t.destination()
	return local || t.consent[strings.ToLower(key)]
}

// ---- plans ---------------------------------------------------------------------------------------------------------------------

// deepPlan is what a planned deep search holds until it runs: the question and the excerpts (with the secrets already taken out).
type deepPlan struct {
	id       string
	created  time.Time
	query    string
	semantic bool
	sources  []deepsearch.Source
	stats    deepsearch.Stats

	mu     sync.Mutex
	cancel context.CancelFunc // of the run in progress
}

type deepPlanStore struct {
	mu    sync.Mutex
	seq   int
	plans map[string]*deepPlan
}

var deepPlans = &deepPlanStore{plans: map[string]*deepPlan{}}

// put keeps a plan and returns its id. Plans older than deepPlanTTL go, and the oldest go when there are more than deepPlanMax.
func (s *deepPlanStore) put(p *deepPlan, now time.Time) string {
	s.mu.Lock()
	defer s.mu.Unlock()
	for id, old := range s.plans {
		if now.Sub(old.created) > deepPlanTTL {
			delete(s.plans, id)
		}
	}
	for len(s.plans) >= deepPlanMax {
		oldest := ""
		for id, old := range s.plans {
			if oldest == "" || old.created.Before(s.plans[oldest].created) {
				oldest = id
			}
		}
		delete(s.plans, oldest)
	}
	s.seq++
	p.id = fmt.Sprintf("p_%d_%d", now.Unix(), s.seq)
	p.created = now
	s.plans[p.id] = p
	return p.id
}

func (s *deepPlanStore) get(id string, now time.Time) *deepPlan {
	s.mu.Lock()
	defer s.mu.Unlock()
	p := s.plans[id]
	if p != nil && now.Sub(p.created) > deepPlanTTL {
		delete(s.plans, id)
		return nil
	}
	return p
}

func (s *deepPlanStore) drop(id string) {
	s.mu.Lock()
	delete(s.plans, id)
	s.mu.Unlock()
}

// ---- JSON the window reads -----------------------------------------------------------------------------------------------------

type deepSourceJSON struct {
	N         int    `json:"n"`
	Label     string `json:"label"`
	Date      string `json:"date,omitempty"`
	Rel       string `json:"rel"`
	Chars     int    `json:"chars"`
	StartLine int    `json:"start_line"`
	EndLine   int    `json:"end_line"`
}

type deepStatsJSON struct {
	Used       int `json:"used"`
	Ignored    int `json:"ignored"`
	AI         int `json:"ai"`
	Unreadable int `json:"unreadable"`
	Merged     int `json:"merged"`
	Budget     int `json:"budget"`
	TotalChars int `json:"total_chars"`
	Masked     int `json:"masked"`
}

type deepDestinationJSON struct {
	Model        string `json:"model"`
	Host         string `json:"host"`
	Local        bool   `json:"local"`
	ConsentKey   string `json:"consent_key"`
	ConsentGiven bool   `json:"consent_given"`
}

type deepPlanJSON struct {
	PlanID          string              `json:"plan_id"`
	Query           string              `json:"query"`
	ModelConfigured bool                `json:"model_configured"`
	Semantic        bool                `json:"semantic"`
	Notes           []string            `json:"notes"`
	Sources         []deepSourceJSON    `json:"sources"`
	Stats           deepStatsJSON       `json:"stats"`
	EstTokens       int                 `json:"est_tokens"`
	Destination     deepDestinationJSON `json:"destination"`
}

type deepRunStatsJSON struct {
	Sources     int    `json:"sources"`
	Cited       int    `json:"cited"`
	Verified    int    `json:"verified"`
	Unverified  int    `json:"unverified"`
	InvalidRefs int    `json:"invalid_refs"`
	Model       string `json:"model"`
}

type deepRunJSON struct {
	Title    string           `json:"title"`
	Markdown string           `json:"markdown"`
	Stats    deepRunStatsJSON `json:"stats"`
}

// deepLimit is how many notes a deep search starts from: 10 unless asked, 30 at most.
func deepLimit(limit int) int {
	switch {
	case limit <= 0:
		return deepDefaultSources
	case limit > deepMaxSources:
		return deepMaxSources
	}
	return limit
}

// ---- the plan ------------------------------------------------------------------------------------------------------------------

// buildDeepPlan searches (by meaning; by words when the semantic search cannot be used, and the notes say why), cuts the excerpts out
// of the files and keeps them under a plan id. Nothing is sent to a model. With no text model set up it answers at once with
// model_configured false and does no search.
func (a *App) buildDeepPlan(ctx context.Context, query string, limit int) (deepPlanJSON, error) {
	return a.planDeepSearch(ctx, query, limit, true)
}

// planDeepSearch is buildDeepPlan; keep false (the JSON-RPC dry run, deepsearch.plan) does not store the plan, so it has no plan_id
// and cannot be run, and a person's plan that waits for a confirmation is never pushed out of the store by it.
func (a *App) planDeepSearch(ctx context.Context, query string, limit int, keep bool) (deepPlanJSON, error) {
	query = strings.TrimSpace(query)
	out := deepPlanJSON{Query: query, Notes: []string{}, Sources: []deepSourceJSON{}}
	if query == "" {
		return out, errors.New("the question is empty")
	}
	limit = deepLimit(limit)

	text := a.deepTextSettings()
	out.ModelConfigured = text.configured()
	key, local := text.destination()
	out.Destination = deepDestinationJSON{
		Model: text.Model, Host: strings.TrimPrefix(key, "http://"), Local: local, ConsentKey: key, ConsentGiven: local || text.consentGiven(),
	}
	if !out.ModelConfigured {
		return out, nil
	}

	res, err := cli.ScrapSearch(ctx, cli.ScrapSearchParams{Text: query, Semantic: true, Limit: limit})
	if err != nil && ctx.Err() == nil && cli.IsParamError(err) {
		// the semantic search is off, not set up, or its host has not been allowed: the notes that hold the words, best first
		out.Notes = append(out.Notes, err.Error())
		res, err = cli.ScrapSearch(ctx, cli.ScrapSearchParams{Text: query, Ranked: true, Limit: limit})
	}
	if err != nil {
		return out, err
	}
	if ctx.Err() != nil {
		return out, ctx.Err()
	}
	out.Semantic = res.Semantic
	for _, n := range res.Notes {
		if !countedNote.MatchString(n) { // the counts of the panel's list say nothing about what is sent
			out.Notes = append(out.Notes, n)
		}
	}

	scrapDir := cli.LoadConfig().ScrapDirResolved() // the folder the hits' rel is relative to
	hits := make([]deepsearch.Hit, 0, len(res.Matches))
	for _, m := range res.Matches {
		if m.Rel == "" { // outside the scrap folder
			continue
		}
		hits = append(hits, deepsearch.Hit{Rel: m.Rel, Line: m.Line, EndLine: m.EndLine, Score: m.Score, Date: m.Date, Heading: m.Heading})
	}
	sources, stats := deepsearch.BuildSources(hits, deepsearch.Options{
		ScrapDir: scrapDir, MaxSources: limit,
		Excluded: semindex.Excluded(scrapDir), URL: cli.FileURL, Label: cli.LinkLabel,
	})
	plan := &deepPlan{query: query, semantic: out.Semantic, sources: sources, stats: stats}
	out.Stats = deepStatsJSON{
		Used: stats.Used, Ignored: stats.Ignored, AI: stats.AI, Unreadable: stats.Unreadable, Merged: stats.Merged, Budget: stats.Budget,
		TotalChars: stats.TotalChars, Masked: stats.Masked,
	}
	for _, s := range sources {
		out.Sources = append(out.Sources, deepSourceJSON{N: s.N, Label: s.Label, Date: s.Date, Rel: s.Rel, Chars: s.Chars, StartLine: s.StartLine, EndLine: s.EndLine})
	}
	out.EstTokens = deepsearch.EstimateTokens(deepsearch.BuildPrompt(query, sources, deepsearch.DetectLang(query)))
	if keep && len(sources) > 0 {
		out.PlanID = deepPlans.put(plan, time.Now())
	}
	return out, nil
}

// DeepSearchPlanAsync is buildDeepPlan on a goroutine; the result goes to window.__onDeepSearchResult.
func (a *App) DeepSearchPlanAsync(reqID, query string, limit int) {
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), deepPlanTimeout)
		defer cancel()
		plan, err := a.buildDeepPlan(ctx, query, limit)
		a.dispatchDeepSearchResult(reqID, plan, err)
	}()
}

// ---- the run -------------------------------------------------------------------------------------------------------------------

// deepNumCtx is the context window to ask a local model for: the prompt, room for the answer, rounded up to 1,024 tokens, between
// 4,096 and 32,768 (more asks for memory the machine may not have; a bigger prompt is cut by the model's own limit).
func deepNumCtx(promptTokens int) int {
	n := (promptTokens + deepAnswerRoom + 1023) / 1024 * 1024
	if n < 4096 {
		n = 4096
	}
	if n > 32768 {
		n = 32768
	}
	return n
}

// runDeepSearch sends a plan's excerpts to the text model and lays the answer out as a note. Nothing goes out unless the model's
// host is this machine or the person has allowed it (checked here again, whatever the window believes).
func (a *App) runDeepSearch(planID, lang string) (deepRunJSON, error) {
	var out deepRunJSON
	plan := deepPlans.get(planID, time.Now())
	if plan == nil {
		return out, errors.New("plan_expired")
	}
	text := a.deepTextSettings()
	if !text.configured() {
		return out, errors.New("model_not_configured")
	}
	if !text.consentGiven() {
		return out, errors.New("consent_required")
	}
	if lang != "ja" && lang != "en" {
		lang = deepsearch.DetectLang(plan.query)
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	plan.mu.Lock()
	if plan.cancel != nil {
		plan.mu.Unlock()
		return out, errors.New("a deep search of this plan is already running")
	}
	plan.cancel = cancel
	plan.mu.Unlock()
	defer func() {
		plan.mu.Lock()
		plan.cancel = nil
		plan.mu.Unlock()
	}()

	prompt := deepsearch.BuildPrompt(plan.query, plan.sources, lang)
	cfg := text.Config
	cfg.SystemPrompt = "" // the ask bar's instructions have no place here: the prompt carries the rules
	cfg.Temperature = 0.2
	cfg.NumCtx = deepNumCtx(deepsearch.EstimateTokens(prompt))
	if cfg.TimeoutSec < deepAnswerWaitSec { // a slow machine reads a long prompt for minutes; the window gives up at deepAnswerWaitSec + 60
		cfg.TimeoutSec = deepAnswerWaitSec
	}
	if llm.IsOllamaURL(cfg.BaseURL) && !llm.CheckOllamaHealth(cfg.BaseURL) {
		_ = a.EnsureOllamaRunning(6 * time.Second)
	}

	type answer struct {
		text string
		err  error
	}
	done := make(chan answer, 1)
	go func() {
		t, err := llm.Query(prompt, cfg)
		done <- answer{t, err}
	}()
	var ans answer
	select {
	case ans = <-done:
	case <-ctx.Done(): // the request to the model cannot be taken back; its answer is dropped
		return out, errors.New("cancelled")
	}
	if ctx.Err() != nil {
		return out, errors.New("cancelled")
	}
	if ans.err != nil {
		return out, ans.err
	}
	if strings.TrimSpace(ans.text) == "" {
		return out, errors.New("the model answered nothing")
	}

	resolved := deepsearch.Resolve(ans.text, plan.sources, lang)
	md := deepsearch.Compose(resolved, plan.sources, deepsearch.Meta{
		Query: plan.query, Lang: lang, Model: text.Model, When: time.Now(), Semantic: plan.semantic,
		SourcesSent: len(plan.sources), TotalChars: plan.stats.TotalChars, Masked: plan.stats.Masked,
	})
	deepPlans.drop(planID)
	return deepRunJSON{
		Title: deepsearch.Title(plan.query, lang), Markdown: md,
		Stats: deepRunStatsJSON{
			Sources: len(plan.sources), Cited: len(resolved.Cited), Verified: resolved.Verified, Unverified: resolved.Unverified,
			InvalidRefs: resolved.InvalidRefs, Model: text.Model,
		},
	}, nil
}

// DeepSearchRunAsync is runDeepSearch on a goroutine; the result goes to window.__onDeepSearchResult.
func (a *App) DeepSearchRunAsync(reqID, planID, lang string) {
	go func() {
		out, err := a.runDeepSearch(planID, lang)
		a.dispatchDeepSearchResult(reqID, out, err)
	}()
}

// CancelDeepSearch drops the answer of the run in progress of a plan: its promise is rejected with "cancelled". It tells whether a run
// was going.
func (a *App) CancelDeepSearch(planID string) bool {
	plan := deepPlans.get(planID, time.Now())
	if plan == nil {
		return false
	}
	plan.mu.Lock()
	cancel := plan.cancel
	plan.mu.Unlock()
	if cancel == nil {
		return false
	}
	cancel()
	return true
}

// ---- the panel's semantic mode -------------------------------------------------------------------------------------------------

// semanticPanelJSON is the answer of the panel's semantic mode. Semantic false: the notes were picked by words (Notes says why).
// Pending and LeftOut are counts the window words itself in the UI language (files the index does not hold yet, which were searched
// by words; notes left out for scoring far below the best one); Notes carries only what has no count, in English.
type semanticPanelJSON struct {
	Semantic  bool                  `json:"semantic"`
	Pending   int                   `json:"pending"`
	LeftOut   int                   `json:"leftOut"`
	Truncated bool                  `json:"truncated"`
	Notes     []string              `json:"notes"`
	Results   []search.SearchResult `json:"results"`
}

// countedNote is a note the search words as a sentence of the command line ("--cutoff 0 shows them") for a count that the answer
// carries as a number: the window says it in its own words, so the sentence is not repeated there.
var countedNote = lazyre.New(`^\d+ (?:lower-scoring notes were left out|files are not indexed yet)`)

// panelLineText is the text of a hit as one line of at most 240 characters (a hit is a chunk of a note, which spans lines).
func panelLineText(s string) string {
	s = strings.Join(strings.Fields(s), " ")
	if utf8.RuneCountInString(s) > 240 {
		s = string([]rune(s)[:240]) + "…"
	}
	return s
}

// semanticPanelResult puts the hits of a semantic search in the shape of the plain search's results: one entry per file, the files
// in the order of their best hit. Hits of the word search that the semantic search falls back to say so in Source.
func semanticPanelResult(res cli.ScrapSearchResult) semanticPanelJSON {
	out := semanticPanelJSON{Semantic: res.Semantic, Pending: res.Pending, LeftOut: res.LeftOut, Truncated: res.Truncated, Notes: []string{}, Results: []search.SearchResult{}}
	for _, n := range res.Notes {
		if !countedNote.MatchString(n) {
			out.Notes = append(out.Notes, n)
		}
	}
	at := map[string]int{}
	for _, m := range res.Matches {
		score := m.Score
		if score <= 0 {
			score = m.Cosine
		}
		source := m.Source
		if source == "" {
			source = "words"
		}
		match := search.SearchMatch{
			LineNumber: m.Line, LineText: panelLineText(m.Text), Heading: m.Heading, HeadingLine: m.HeadingLine,
			Score: score, Partial: m.Partial, EndLine: m.EndLine, Source: source,
		}
		i, ok := at[m.File]
		if !ok {
			i = len(out.Results)
			at[m.File] = i
			out.Results = append(out.Results, search.SearchResult{FilePath: m.File, FileName: filepath.Base(m.File)})
		}
		out.Results[i].Matches = append(out.Results[i].Matches, match)
	}
	return out
}

// SearchScrapsSemanticAsync is the search panel's semantic mode: the notes close in meaning to the query, up to limit (10 unless asked,
// 30 at most). A newer search (of either mode) replaces it: its promise is rejected with "superseded". Features that are off, a cloud
// host that has not been allowed and a model that is not set up are rejected with a sentence; a model that cannot be reached now
// answers by words, and the notes say so.
func (a *App) SearchScrapsSemanticAsync(reqID, query string, limit int) {
	ctx, cancel := context.WithCancel(context.Background())
	a.searchMu.Lock()
	if a.searchCancel != nil {
		a.searchCancel()
	}
	a.searchSeq++
	seq := a.searchSeq
	a.searchCancel = cancel
	a.searchMu.Unlock()

	go func() {
		defer cancel()
		res, err := cli.ScrapSearch(ctx, cli.ScrapSearchParams{Text: query, Semantic: true, Limit: deepLimit(limit)})
		a.searchMu.Lock()
		if a.searchSeq == seq {
			a.searchCancel = nil
		}
		a.searchMu.Unlock()
		if ctx.Err() != nil {
			a.dispatchDeepSearchResult(reqID, nil, errors.New("superseded"))
			return
		}
		if err != nil {
			a.dispatchDeepSearchResult(reqID, nil, err)
			return
		}
		a.dispatchDeepSearchResult(reqID, semanticPanelResult(res), nil)
	}()
}

// dispatchDeepSearchResult settles the window's promise of reqID (the shim's __mdmemoSettle).
func (a *App) dispatchDeepSearchResult(reqID string, result interface{}, err error) {
	if atomic.LoadInt32(&a.isDestroyed) != 0 || a.w == nil {
		return
	}
	errMsg := ""
	if err != nil {
		errMsg = err.Error()
	}
	resJSON, _ := json.Marshal(result)
	errJSON, _ := json.Marshal(errMsg)
	a.dispatchEval(fmt.Sprintf("if (window.__onDeepSearchResult) { window.__onDeepSearchResult(%q, %s, %s); }", reqID, resJSON, errJSON))
}
