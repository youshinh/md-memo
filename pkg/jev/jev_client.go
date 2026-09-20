package jev

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"net/http"
	"os"
	"sort"
	"strconv"
	"strings"
	"time"
)

// Official TypeSafe AI Jev endpoint
const DefaultTypeSafeEndpoint = "https://api.typesafe.ai"

// ClientConfig holds configuration for communicating with Jev Engine.
type ClientConfig struct {
	Endpoint      string        `json:"endpoint"`
	APIKey        string        `json:"api_key"`
	TypeSafeKey   string        `json:"typesafe_key"`
	OpenRouterKey string        `json:"openrouter_key"`
	Model         string        `json:"model"`
	Timeout       time.Duration `json:"timeout"`

	// AllowGenericEnvKeys opts this client in to picking up *generic*, non-app-specific
	// credentials from the process environment - currently OPENROUTER_API_KEY, which is
	// commonly exported for unrelated tools. When false (the default, and what the GUI
	// uses) only credentials the user explicitly configured for MD-Memo are honoured:
	// the settings fields (action.apiKey / action.baseUrl) and the app-specific env vars
	// JEV_API_URL / JEV_API_KEY / TYPESAFE_API_KEY. This is what keeps Quick Actions -
	// which auto-fires a few seconds after typing stops and ships a ~2000 character
	// excerpt of the user's note as context - strictly local-first unless the user asked
	// for a remote engine. The headless CLI (`md-memo jev ...`) sets it true to preserve
	// its documented behaviour for scripts and E2E harnesses.
	AllowGenericEnvKeys bool `json:"allow_generic_env_keys"`
}

// Client interacts with the Jev probabilistic prediction engine.
type Client struct {
	cfg        ClientConfig
	httpClient *http.Client
}

// NewClient creates a new Client instance.
//
// Endpoint resolution is deliberately conservative: the built-in TypeSafe endpoint is only
// used as a fallback when a TypeSafe/Jev credential is actually present (from settings or
// from the app-specific env vars). With nothing configured the endpoint stays empty, which
// makes Predict/SystemOne take their local paths without performing any network I/O at all.
func NewClient(cfg ClientConfig) *Client {
	if cfg.TypeSafeKey == "" {
		cfg.TypeSafeKey = os.Getenv("TYPESAFE_API_KEY")
		if cfg.TypeSafeKey == "" {
			cfg.TypeSafeKey = os.Getenv("JEV_API_KEY")
		}
	}
	if cfg.OpenRouterKey == "" && cfg.AllowGenericEnvKeys {
		cfg.OpenRouterKey = os.Getenv("OPENROUTER_API_KEY")
	}
	if cfg.Model == "" {
		cfg.Model = os.Getenv("JEV_MODEL")
		if cfg.Model == "" {
			cfg.Model = "jev-latest"
		}
	}
	if cfg.Endpoint == "" {
		cfg.Endpoint = os.Getenv("JEV_API_URL")
		if cfg.Endpoint == "" && cfg.TypeSafeKey != "" {
			// A TypeSafe/Jev key is configured but no endpoint: default to the official host.
			cfg.Endpoint = DefaultTypeSafeEndpoint
		}
	}
	if cfg.Timeout <= 0 {
		cfg.Timeout = 10 * time.Second
	}

	return &Client{
		cfg: cfg,
		httpClient: &http.Client{
			Timeout: cfg.Timeout,
		},
	}
}

// SetHTTPClient replaces the HTTP client used for every remote call. It exists so callers
// (and in particular tests) can inject a custom transport - e.g. one that fails the test if
// it is ever invoked, which is how the "no configuration means no network" contract of
// Predict/SystemOne is asserted. Passing nil is a no-op.
func (c *Client) SetHTTPClient(h *http.Client) {
	if h == nil {
		return
	}
	c.httpClient = h
}

// Timeout reports the per-request timeout this client was configured with. Callers that run
// Predict/SystemOne on a background goroutine use it to build a context with the same budget.
func (c *Client) Timeout() time.Duration {
	return c.cfg.Timeout
}

type remotePredictResponse struct {
	Text       string      `json:"text"`
	Candidates []Candidate `json:"candidates,omitempty"`
}

// Predict calls the Jev Engine with EBNF grammar constraints or falls back to internal heuristics.
//
// Privacy contract: req.BufferContext is an excerpt of the user's note. It is only ever sent
// over the network when the user explicitly configured a remote engine (an OpenRouter/TypeSafe
// key or a base URL in settings, or one of the app-specific env vars JEV_API_URL / JEV_API_KEY /
// TYPESAFE_API_KEY). With nothing configured both remote branches below are skipped and this
// performs zero network I/O.
func (c *Client) Predict(ctx context.Context, req JevPredictRequest) (*JevPredictResponse, error) {
	if req.GrammarSchema == "" {
		req.GrammarSchema = TaskActionEBNF
	}

	// 1. Try OpenRouter if API key is configured
	if key := c.getOpenRouterKey(); key != "" {
		resp, err := c.predictOpenRouter(ctx, key, req)
		if err == nil && len(resp.Candidates) > 0 {
			return resp, nil
		}
	}

	// 2. Try custom remote Jev server
	if c.cfg.Endpoint != "" && !strings.Contains(c.cfg.Endpoint, "openrouter.ai") {
		resp, err := c.predictRemote(ctx, req)
		if err == nil && len(resp.Candidates) > 0 {
			return resp, nil
		}
	}

	// 3. Fallback to deterministic local heuristic prediction
	return c.predictLocal(req), nil
}

func (c *Client) getOpenRouterKey() string {
	if c.cfg.OpenRouterKey != "" {
		return c.cfg.OpenRouterKey
	}
	if strings.HasPrefix(c.cfg.APIKey, "sk-or-v1-") {
		return c.cfg.APIKey
	}
	if c.cfg.AllowGenericEnvKeys {
		return os.Getenv("OPENROUTER_API_KEY")
	}
	return ""
}

type openRouterMessage struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

type openRouterRequest struct {
	Model    string              `json:"model"`
	Messages []openRouterMessage `json:"messages"`
}

type openRouterResponse struct {
	Choices []struct {
		Message struct {
			Content string `json:"content"`
		} `json:"message"`
	} `json:"choices"`
	Error *struct {
		Message string `json:"message"`
	} `json:"error,omitempty"`
}

func (c *Client) predictOpenRouter(ctx context.Context, apiKey string, req JevPredictRequest) (*JevPredictResponse, error) {
	model := c.cfg.Model
	if model == "" {
		model = "jev-latest"
	}

	sysPrompt := fmt.Sprintf("You are the Jev probabilistic prediction engine for md-memo. Based on the user's buffer context, predict the next 3 orthogonal actions strictly following the EBNF grammar:\n%s\nDo not include any conversational filler, markdown formatting blocks, or explanations. Only output task items.", req.GrammarSchema)

	payload := openRouterRequest{
		Model: model,
		Messages: []openRouterMessage{
			{Role: "system", Content: sysPrompt},
			{Role: "user", Content: fmt.Sprintf("Context:\n%s", req.BufferContext)},
		},
	}

	payloadBytes, err := json.Marshal(payload)
	if err != nil {
		return nil, err
	}

	httpReq, err := http.NewRequestWithContext(ctx, "POST", "https://openrouter.ai/api/v1/chat/completions", bytes.NewReader(payloadBytes))
	if err != nil {
		return nil, err
	}
	httpReq.Header.Set("Authorization", "Bearer "+apiKey)
	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("HTTP-Referer", "https://github.com/youshinh/md-memo")
	httpReq.Header.Set("X-Title", "MD-Memo")

	resp, err := c.httpClient.Do(httpReq)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	bodyBytes, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}

	var orResp openRouterResponse
	if err := json.Unmarshal(bodyBytes, &orResp); err != nil {
		return nil, err
	}

	if orResp.Error != nil && orResp.Error.Message != "" {
		return nil, fmt.Errorf("openrouter error: %s", orResp.Error.Message)
	}

	if len(orResp.Choices) == 0 {
		return nil, fmt.Errorf("no completion choices from openrouter")
	}

	candidates := ParseTaskActionItems(orResp.Choices[0].Message.Content)
	return &JevPredictResponse{
		Candidates: candidates,
		RawGrammar: req.GrammarSchema,
	}, nil
}

func (c *Client) predictRemote(ctx context.Context, req JevPredictRequest) (*JevPredictResponse, error) {
	payloadBytes, err := json.Marshal(req)
	if err != nil {
		return nil, err
	}

	url := strings.TrimRight(c.cfg.Endpoint, "/") + "/predict"
	httpReq, err := http.NewRequestWithContext(ctx, "POST", url, bytes.NewReader(payloadBytes))
	if err != nil {
		return nil, err
	}
	httpReq.Header.Set("Content-Type", "application/json")
	if c.cfg.APIKey != "" {
		httpReq.Header.Set("Authorization", "Bearer "+c.cfg.APIKey)
	}

	resp, err := c.httpClient.Do(httpReq)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("remote jev server returned status %d", resp.StatusCode)
	}

	bodyBytes, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}

	var remoteResp remotePredictResponse
	if err := json.Unmarshal(bodyBytes, &remoteResp); err != nil {
		return nil, err
	}

	var candidates []Candidate
	if len(remoteResp.Candidates) > 0 {
		candidates = remoteResp.Candidates
	} else if remoteResp.Text != "" {
		candidates = ParseTaskActionItems(remoteResp.Text)
	}

	return &JevPredictResponse{
		Candidates: candidates,
		RawGrammar: req.GrammarSchema,
	}, nil
}

// predictLocal provides instant, zero-latency local candidates based on buffer context.
func (c *Client) predictLocal(req JevPredictRequest) *JevPredictResponse {
	ctx := strings.ToLower(req.BufferContext)
	var candidates []Candidate

	// 1. Agent & Autonomous Research context
	if strings.Contains(ctx, "agent") || strings.Contains(ctx, "agy") || strings.Contains(ctx, "claude") ||
		strings.Contains(ctx, "調査") || strings.Contains(ctx, "調べて") || strings.Contains(ctx, "リサーチ") ||
		strings.Contains(ctx, "実装") || strings.Contains(ctx, "作って") || strings.Contains(ctx, "自律") ||
		strings.Contains(ctx, "コード") || strings.Contains(ctx, "code") {
		candidates = append(candidates,
			Candidate{
				ActionType:  "ai",
				Command:     "{{ このメモの指示に従って実装・調査を実行 }}",
				Description: "エージェントにタスクを委任",
				Scope:       "local",
			},
			Candidate{
				ActionType:  "sh",
				Command:     "git status -s",
				Description: "リポジトリ変更状態の一覧確認 (git status)",
				Scope:       "local",
			},
			Candidate{
				ActionType:  "doc",
				Command:     "[? カレントのトピックについてWeb調査と一次ソース確認を実施 ]",
				Description: "自律リサーチスロットの挿入 ([? ... ])",
				Scope:       "global",
			},
		)
	} else if strings.Contains(ctx, "git") || strings.Contains(ctx, "diff") || strings.Contains(ctx, "commit") ||
		strings.Contains(ctx, "push") || strings.Contains(ctx, "branch") || strings.Contains(ctx, "変更") ||
		strings.Contains(ctx, "コミット") || strings.Contains(ctx, "プッシュ") || strings.Contains(ctx, "ブランチ") ||
		strings.Contains(ctx, "差分") || strings.Contains(ctx, "リポジトリ") || strings.Contains(ctx, "履歴") {
		// 2. Git & Repository context
		candidates = append(candidates,
			Candidate{
				ActionType:  "ai",
				Command:     "{{ 直近の変更内容からコミットメッセージ案を作成 }}",
				Description: "コミットメッセージの起草 (AI)",
				Scope:       "local",
			},
			Candidate{
				ActionType:  "sh",
				Command:     "git status -s",
				Description: "リポジトリ変更状態の一覧確認 (git status)",
				Scope:       "local",
			},
			Candidate{
				ActionType:  "sh",
				Command:     "git diff --stat",
				Description: "変更ファイル統計と差分の確認 (git diff)",
				Scope:       "global",
			},
		)
	} else if strings.Contains(ctx, "予定") || strings.Contains(ctx, "休み") || strings.Contains(ctx, "お出かけ") ||
		strings.Contains(ctx, "タスク") || strings.Contains(ctx, "todo") || strings.Contains(ctx, "計画") ||
		strings.Contains(ctx, "メモ") || strings.Contains(ctx, "今日") || strings.Contains(ctx, "明日") ||
		strings.Contains(ctx, "明後日") || strings.Contains(ctx, "アイデア") || strings.Contains(ctx, "task") ||
		strings.Contains(ctx, "相談") || strings.Contains(ctx, "整理") {
		// 3. Daily Notes, Tasks, and Schedule context
		candidates = append(candidates,
			Candidate{
				ActionType:  "ai",
				Command:     "{{ このメモの内容からアクションプランとタスクを立案 }}",
				Description: "エージェントに計画立案を依頼",
				Scope:       "local",
			},
			Candidate{
				ActionType:  "sh",
				Command:     "git status -s",
				Description: "リポジトリ変更状態の一覧確認 (git status)",
				Scope:       "local",
			},
			Candidate{
				ActionType:  "doc",
				Command:     "{{ カレントメモの予定・タスクを整理して箇条書きチェックリスト化 }}",
				Description: "予定の構造化チェックリスト作成 (Docs)",
				Scope:       "global",
			},
		)
	} else if strings.Contains(ctx, "test") || strings.Contains(ctx, "assert") || strings.Contains(ctx, "テスト") || strings.Contains(ctx, "検証") {
		// 4. Testing context
		candidates = append(candidates,
			Candidate{
				ActionType:  "ai",
				Command:     "{{ 未テストのエッジケースに対するユニットテストを生成 }}",
				Description: "エッジケース向けユニットテストの生成 (AI)",
				Scope:       "local",
			},
			Candidate{
				ActionType:  "sh",
				Command:     "go test -v ./...",
				Description: "テストスイートの全実行 (go test)",
				Scope:       "local",
			},
			Candidate{
				ActionType:  "sh",
				Command:     "git status -s",
				Description: "変更ファイル状態の確認 (git status)",
				Scope:       "global",
			},
		)
	}

	// Default baseline orthogonal set if context matches are generic
	if len(candidates) < 3 {
		candidates = append(candidates,
			Candidate{
				ActionType:  "ai",
				Command:     "{{ カレントノートの指示を実行 }}",
				Description: "エージェントにタスク実行を依頼",
				Scope:       "local",
			},
			Candidate{
				ActionType:  "sh",
				Command:     "git status -s",
				Description: "リポジトリ変更状態の一覧確認 (git status)",
				Scope:       "local",
			},
			Candidate{
				ActionType:  "doc",
				Command:     "{{ カレント箇所の文章を推敲し読みやすい構成に整形 }}",
				Description: "文章の推敲と構造リファクタリング (Docs)",
				Scope:       "global",
			},
		)
	}

	return &JevPredictResponse{
		Candidates: candidates,
		RawGrammar: req.GrammarSchema,
	}
}

// SystemOne executes probabilistic inference (Choice, Noul, Score) via TypeSafe AI Jev API or
// local fallback. Callers build req.Questions but may leave req.Model blank; it is filled in
// from ClientConfig.Model (defaulted to "jev-latest" by NewClient) since the real API requires it.
func (c *Client) SystemOne(ctx context.Context, req SystemOneRequest) (*SystemOneResponse, error) {
	if req.Model == "" {
		req.Model = c.cfg.Model
	}

	// 1. Try TypeSafe AI official API if key is present
	key := c.getTypeSafeKey()
	if key != "" && c.cfg.Endpoint != "" {
		resp, err := c.callTypeSafeAPI(ctx, key, req)
		if err == nil && resp != nil {
			return resp, nil
		}
	}

	// 2. Deterministic local probabilistic inference fallback
	return c.systemOneLocal(req), nil
}

func (c *Client) getTypeSafeKey() string {
	if c.cfg.TypeSafeKey != "" {
		return c.cfg.TypeSafeKey
	}
	if key := os.Getenv("TYPESAFE_API_KEY"); key != "" {
		return key
	}
	return os.Getenv("JEV_API_KEY")
}

func (c *Client) callTypeSafeAPI(ctx context.Context, apiKey string, req SystemOneRequest) (*SystemOneResponse, error) {
	payloadBytes, err := json.Marshal(req)
	if err != nil {
		return nil, err
	}

	endpoint := strings.TrimRight(c.cfg.Endpoint, "/")
	if !strings.HasSuffix(endpoint, "/v1/systemone") {
		endpoint += "/v1/systemone"
	}

	httpReq, err := http.NewRequestWithContext(ctx, "POST", endpoint, bytes.NewReader(payloadBytes))
	if err != nil {
		return nil, err
	}
	httpReq.Header.Set("Authorization", "Bearer "+apiKey)
	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("User-Agent", "md-memo-jev/1.0")

	resp, err := c.httpClient.Do(httpReq)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("typesafe API error: status %d", resp.StatusCode)
	}

	bodyBytes, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}

	var soResp SystemOneResponse
	if err := json.Unmarshal(bodyBytes, &soResp); err != nil {
		return nil, err
	}

	return &soResp, nil
}

// stringifyValue renders a state/instructions value (string, object, or array per the API docs)
// as lowercase-able text for the local heuristic fallback to pattern-match against.
func stringifyValue(v interface{}) string {
	if v == nil {
		return ""
	}
	if str, ok := v.(string); ok {
		return str
	}
	if data, err := json.Marshal(v); err == nil {
		return string(data)
	}
	return ""
}

// choiceCriteriaOptions extracts the option names from a Choice question's Criteria
// (map[string]string per the API; also accepts map[string]interface{} in case a caller ever
// passes criteria decoded from JSON), sorted for deterministic output.
func choiceCriteriaOptions(criteria interface{}) []string {
	var opts []string
	switch m := criteria.(type) {
	case map[string]string:
		for k := range m {
			opts = append(opts, k)
		}
	case map[string]interface{}:
		for k := range m {
			opts = append(opts, k)
		}
	}
	sort.Strings(opts)
	return opts
}

// scoreCriteriaLevels extracts the ordered level descriptions from a Score question's Criteria
// ([]string per the API; also accepts []interface{}).
func scoreCriteriaLevels(criteria interface{}) []string {
	switch v := criteria.(type) {
	case []string:
		return v
	case []interface{}:
		levels := make([]string, 0, len(v))
		for _, item := range v {
			if s, ok := item.(string); ok {
				levels = append(levels, s)
			} else {
				levels = append(levels, stringifyValue(item))
			}
		}
		return levels
	default:
		return nil
	}
}

// systemOneLocal simulates TypeSafe AI Jev probabilistic inference using entropy & semantic
// priors, when no remote System One endpoint is configured or reachable.
func (c *Client) systemOneLocal(req SystemOneRequest) *SystemOneResponse {
	stateLower := strings.ToLower(stringifyValue(req.State))

	resp := &SystemOneResponse{
		Model:   req.Model,
		Answers: make(map[string]SystemOneAnswer, len(req.Questions)),
	}

	for name, q := range req.Questions {
		switch q.Type {
		case QuestionChoice:
			resp.Answers[name] = systemOneLocalChoice(stateLower, q)
		case QuestionNoul:
			resp.Answers[name] = systemOneLocalNoul(name, stateLower, q)
		case QuestionScore:
			resp.Answers[name] = systemOneLocalScore(name, stateLower, q)
		}
	}

	return resp
}

// systemOneLocalChoice picks among Criteria's options by scoring state token overlap, and
// reports a confidence derived from how concentrated (low-entropy) that distribution is.
func systemOneLocalChoice(stateLower string, q SystemOneQuestion) SystemOneAnswer {
	options := choiceCriteriaOptions(q.Criteria)
	n := len(options)
	if n == 0 {
		return SystemOneAnswer{Type: QuestionChoice}
	}
	if n == 1 {
		return SystemOneAnswer{
			Type:          QuestionChoice,
			Choice:        options[0],
			Confidence:    1.0,
			Probabilities: map[string]float64{options[0]: 1.0},
		}
	}

	// Calculate raw weights based on state token matches
	weights := make([]float64, n)
	totalWeight := 0.0
	for i, opt := range options {
		optLower := strings.ToLower(opt)
		w := 1.0 // Base prior
		// Direct substring match
		if strings.Contains(stateLower, optLower) {
			w += 5.0
		}
		// Token overlap (split by whitespace, underscore, hyphen)
		tokens := strings.FieldsFunc(optLower, func(r rune) bool {
			return r == '_' || r == '-' || r == ' '
		})
		for _, token := range tokens {
			if len(token) >= 2 && strings.Contains(stateLower, token) {
				w += 3.0
			}
		}
		weights[i] = w
		totalWeight += w
	}

	// Normalize to probabilities & calculate Shannon entropy
	probs := make(map[string]float64, n)
	maxProb := -1.0
	selectedOpt := options[0]
	entropy := 0.0

	for i, opt := range options {
		p := weights[i] / totalWeight
		probs[opt] = p
		if p > maxProb {
			maxProb = p
			selectedOpt = opt
		}
		if p > 0 {
			entropy -= p * math.Log2(p)
		}
	}

	maxEntropy := math.Log2(float64(n))
	confidence := 1.0
	if maxEntropy > 0 {
		confidence = 1.0 - (entropy / maxEntropy)
		if confidence < 0 {
			confidence = 0
		} else if confidence > 1.0 {
			confidence = 1.0
		}
	}

	return SystemOneAnswer{
		Type:          QuestionChoice,
		Choice:        selectedOpt,
		Confidence:    confidence,
		Probabilities: probs,
	}
}

// systemOneLocalNoul estimates a 0..1 probability (no confidence field, per the real API) from
// keyword priors keyed on the question id and its Instructions text.
func systemOneLocalNoul(name, stateLower string, q SystemOneQuestion) SystemOneAnswer {
	target := strings.ToLower(name + " " + stringifyValue(q.Instructions))
	prob := 0.5 // Default maximum uncertainty

	switch {
	case strings.Contains(target, "needs_llm") || strings.Contains(target, "escalate"):
		switch {
		case strings.Contains(stateLower, "全体") || strings.Contains(stateLower, "大規模") ||
			strings.Contains(stateLower, "アーキテクチャ") || strings.Contains(stateLower, "refactor whole") ||
			strings.Contains(stateLower, "multi-step"):
			prob = 0.95
		case strings.HasPrefix(stateLower, "git ") || strings.HasPrefix(stateLower, "ls") ||
			strings.HasPrefix(stateLower, "cat ") || strings.HasPrefix(stateLower, "go test"):
			prob = 0.05
		case len(strings.Fields(stateLower)) > 8:
			prob = 0.75
		default:
			prob = 0.25
		}
	case strings.Contains(target, "destructive") || strings.Contains(target, "danger") || strings.Contains(target, "risk"):
		switch {
		case strings.Contains(stateLower, "rm ") || strings.Contains(stateLower, "dd ") ||
			strings.Contains(stateLower, "format ") || strings.Contains(stateLower, "drop table"):
			prob = 0.99
		case strings.Contains(stateLower, "git commit") || strings.Contains(stateLower, "sed -i") ||
			strings.Contains(stateLower, ">"):
			prob = 0.50
		default:
			prob = 0.02
		}
	case strings.Contains(target, "safe") || strings.Contains(target, "read_only"):
		switch {
		case strings.HasPrefix(stateLower, "git status") || strings.HasPrefix(stateLower, "git diff") ||
			strings.HasPrefix(stateLower, "ls") || strings.HasPrefix(stateLower, "cat"):
			prob = 0.98
		case strings.Contains(stateLower, "rm "):
			prob = 0.01
		default:
			prob = 0.60
		}
	}

	return SystemOneAnswer{Type: QuestionNoul, Noul: prob}
}

// systemOneLocalScore distributes probability mass over Criteria's ordered levels (index 0..n-1)
// based on keyword priors, then reports the probability-weighted mean level index as Score,
// matching how the real API defines Score ("probability-weighted mean" over level positions).
func systemOneLocalScore(name, stateLower string, q SystemOneQuestion) SystemOneAnswer {
	levels := scoreCriteriaLevels(q.Criteria)
	numSteps := len(levels)
	if numSteps < 2 {
		numSteps = 2 // Degenerate/missing criteria: fall back to a plain two-level scale.
	}
	probs := make([]float64, numSteps)

	target := strings.ToLower(name + " " + stringifyValue(q.Instructions))
	switch {
	case strings.Contains(target, "risk") || strings.Contains(target, "destructive"):
		switch {
		case strings.Contains(stateLower, "rm ") || strings.Contains(stateLower, "mkfs") ||
			strings.Contains(stateLower, "format") || strings.Contains(stateLower, "diskpart"):
			// Highly destructive: concentrate on the highest level.
			probs[numSteps-1] = 0.90
			for k := 0; k < numSteps-1; k++ {
				probs[k] = 0.10 / float64(numSteps-1)
			}
		case strings.Contains(stateLower, ">") || strings.Contains(stateLower, "git commit") ||
			strings.Contains(stateLower, "sed"):
			// Medium risk: concentrate on the middle level.
			mid := numSteps / 2
			probs[mid] = 0.80
			rem := 0.20 / float64(numSteps-1)
			for k := 0; k < numSteps; k++ {
				if k != mid {
					probs[k] = rem
				}
			}
		default:
			// Safe / read-only: concentrate on the lowest level.
			probs[0] = 0.92
			for k := 1; k < numSteps; k++ {
				probs[k] = 0.08 / float64(numSteps-1)
			}
		}
	default:
		// Uniform distribution default
		u := 1.0 / float64(numSteps)
		for k := 0; k < numSteps; k++ {
			probs[k] = u
		}
	}

	// Probability-weighted mean over level indices 0..numSteps-1.
	expectedValue := 0.0
	probsByIndex := make(map[string]float64, numSteps)
	legend := make(map[string]string, numSteps)
	for k := 0; k < numSteps; k++ {
		expectedValue += float64(k) * probs[k]
		key := strconv.Itoa(k)
		probsByIndex[key] = probs[k]
		if k < len(levels) {
			legend[key] = levels[k]
		}
	}

	return SystemOneAnswer{
		Type:          QuestionScore,
		Score:         expectedValue,
		Probabilities: probsByIndex,
		Legend:        legend,
	}
}
