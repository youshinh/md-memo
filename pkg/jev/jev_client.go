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
}

// Client interacts with the Jev probabilistic prediction engine.
type Client struct {
	cfg        ClientConfig
	httpClient *http.Client
}

// NewClient creates a new Client instance.
func NewClient(cfg ClientConfig) *Client {
	if cfg.TypeSafeKey == "" {
		cfg.TypeSafeKey = os.Getenv("TYPESAFE_API_KEY")
		if cfg.TypeSafeKey == "" {
			cfg.TypeSafeKey = os.Getenv("JEV_API_KEY")
		}
	}
	if cfg.OpenRouterKey == "" {
		cfg.OpenRouterKey = os.Getenv("OPENROUTER_API_KEY")
	}
	if cfg.Model == "" {
		cfg.Model = os.Getenv("JEV_MODEL")
		if cfg.Model == "" {
			cfg.Model = "qwen/qwen3.8-27b"
		}
	}
	if cfg.Endpoint == "" {
		cfg.Endpoint = os.Getenv("JEV_API_URL")
		if cfg.Endpoint == "" {
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

type remotePredictResponse struct {
	Text       string      `json:"text"`
	Candidates []Candidate `json:"candidates,omitempty"`
}

// Predict calls the Jev Engine with EBNF grammar constraints or falls back to internal heuristics.
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
	return os.Getenv("OPENROUTER_API_KEY")
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
		model = "qwen/qwen3.8-27b"
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

	// Contextual heuristic matching
	if strings.Contains(ctx, "test") || strings.Contains(ctx, "assert") {
		candidates = append(candidates, Candidate{
			ActionType:  "sh",
			Command:     "go test -v ./...",
			Description: "テストスイートの全実行 (go test)",
			Scope:       "local",
		})
		candidates = append(candidates, Candidate{
			ActionType:  "ai",
			Command:     "generate unit tests for untested edge cases",
			Description: "エッジケース向けユニットテストの生成 (AI)",
			Scope:       "local",
		})
	} else if strings.Contains(ctx, "git") || strings.Contains(ctx, "diff") || strings.Contains(ctx, "commit") {
		candidates = append(candidates, Candidate{
			ActionType:  "sh",
			Command:     "git diff --stat",
			Description: "変更ファイル統計の確認 (git diff)",
			Scope:       "local",
		})
		candidates = append(candidates, Candidate{
			ActionType:  "doc",
			Command:     "generate release notes from git log -n 5",
			Description: "直近コミットからのリリースノート作成",
			Scope:       "global",
		})
	} else if strings.Contains(ctx, "bug") || strings.Contains(ctx, "error") || strings.Contains(ctx, "fail") {
		candidates = append(candidates, Candidate{
			ActionType:  "sh",
			Command:     "git log -p -n 1",
			Description: "直前コミット差分の詳細調査 (git log -p)",
			Scope:       "local",
		})
		candidates = append(candidates, Candidate{
			ActionType:  "ai",
			Command:     "analyze stack trace and suggest minimal bugfix",
			Description: "スタックトレース分析と最小修正案 (AI)",
			Scope:       "local",
		})
		candidates = append(candidates, Candidate{
			ActionType:  "doc",
			Command:     "create postmortem issue report template",
			Description: "障害報告書/ポストモーテムの作成",
			Scope:       "global",
		})
	}

	// Default baseline orthogonal set if context matches are generic
	if len(candidates) < 3 {
		candidates = append(candidates,
			Candidate{
				ActionType:  "ai",
				Command:     "refactor current section for clarity and performance",
				Description: "カレント箇所の構造リファクタリング (AI)",
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
				Command:     "summarize changes into docs/spec.md",
				Description: "仕様書ドキュメントの更新と反映 (Docs)",
				Scope:       "global",
			},
		)
	}

	return &JevPredictResponse{
		Candidates: candidates,
		RawGrammar: req.GrammarSchema,
	}
}

// SystemOne executes probabilistic inference (Choice, Noul, Score) via TypeSafe AI Jev API or local fallback.
func (c *Client) SystemOne(ctx context.Context, req SystemOneRequest) (*SystemOneResponse, error) {
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
	if !strings.HasSuffix(endpoint, "/v1/systemOne") {
		endpoint += "/v1/systemOne"
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

// systemOneLocal simulates TypeSafe AI Jev probabilistic inference using entropy & semantic priors.
func (c *Client) systemOneLocal(req SystemOneRequest) *SystemOneResponse {
	// Extract state text representation
	stateStr := ""
	if str, ok := req.State.(string); ok {
		stateStr = str
	} else if req.State != nil {
		if data, err := json.Marshal(req.State); err == nil {
			stateStr = string(data)
		}
	}
	stateLower := strings.ToLower(stateStr)

	resp := &SystemOneResponse{
		Choices: make(map[string]ChoiceResult),
		Nouls:   make(map[string]NoulResult),
		Scores:  make(map[string]ScoreResult),
	}

	// 1. Process Choices (Unordered classification + Shannon entropy concentration)
	for name, q := range req.Choices {
		n := len(q.Options)
		if n == 0 {
			continue
		}
		if n == 1 {
			resp.Choices[name] = ChoiceResult{
				Selected:      q.Options[0],
				Confidence:    1.0,
				Probabilities: map[string]float64{q.Options[0]: 1.0},
			}
			continue
		}

		// Calculate raw weights based on state token matches
		weights := make([]float64, n)
		totalWeight := 0.0
		for i, opt := range q.Options {
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
		selectedOpt := q.Options[0]
		entropy := 0.0

		for i, opt := range q.Options {
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

		resp.Choices[name] = ChoiceResult{
			Selected:      selectedOpt,
			Confidence:    confidence,
			Probabilities: probs,
		}
	}

	// 2. Process Nouls (Probability 0..1, no confidence field)
	for name, q := range req.Nouls {
		target := strings.ToLower(name + " " + q.Description)
		prob := 0.5 // Default maximum uncertainty

		if strings.Contains(target, "needs_llm") || strings.Contains(target, "escalate") {
			// Complex indicators
			if strings.Contains(stateLower, "全体") || strings.Contains(stateLower, "大規模") ||
				strings.Contains(stateLower, "アーキテクチャ") || strings.Contains(stateLower, "refactor whole") ||
				strings.Contains(stateLower, "multi-step") {
				prob = 0.95
			} else if strings.HasPrefix(stateLower, "git ") || strings.HasPrefix(stateLower, "ls") ||
				strings.HasPrefix(stateLower, "cat ") || strings.HasPrefix(stateLower, "go test") {
				prob = 0.05
			} else if len(strings.Fields(stateLower)) > 8 {
				prob = 0.75
			} else {
				prob = 0.25
			}
		} else if strings.Contains(target, "destructive") || strings.Contains(target, "danger") || strings.Contains(target, "risk") {
			if strings.Contains(stateLower, "rm ") || strings.Contains(stateLower, "dd ") ||
				strings.Contains(stateLower, "format ") || strings.Contains(stateLower, "drop table") {
				prob = 0.99
			} else if strings.Contains(stateLower, "git commit") || strings.Contains(stateLower, "sed -i") ||
				strings.Contains(stateLower, ">") {
				prob = 0.50
			} else {
				prob = 0.02
			}
		} else if strings.Contains(target, "safe") || strings.Contains(target, "read_only") {
			if strings.HasPrefix(stateLower, "git status") || strings.HasPrefix(stateLower, "git diff") ||
				strings.HasPrefix(stateLower, "ls") || strings.HasPrefix(stateLower, "cat") {
				prob = 0.98
			} else if strings.Contains(stateLower, "rm ") {
				prob = 0.01
			} else {
				prob = 0.60
			}
		}

		resp.Nouls[name] = prob
	}

	// 3. Process Scores (Ordered discrete scale -> Expected Value / Weighted Average)
	for name, q := range req.Scores {
		step := q.Step
		if step <= 0 {
			step = 1
		}
		if q.Max <= q.Min {
			q.Max = q.Min + 1
		}

		numSteps := ((q.Max - q.Min) / step) + 1
		probs := make([]float64, numSteps)

		// Determine probability mass distribution based on context
		target := strings.ToLower(name + " " + q.Description)
		if strings.Contains(target, "risk") || strings.Contains(target, "destructive") {
			if strings.Contains(stateLower, "rm ") || strings.Contains(stateLower, "mkfs") ||
				strings.Contains(stateLower, "format") || strings.Contains(stateLower, "diskpart") {
				// Highly destructive: concentrate on highest score (step index numSteps-1)
				probs[numSteps-1] = 0.90
				for k := 0; k < numSteps-1; k++ {
					probs[k] = 0.10 / float64(numSteps-1)
				}
			} else if strings.Contains(stateLower, ">") || strings.Contains(stateLower, "git commit") ||
				strings.Contains(stateLower, "sed") {
				// Medium risk: concentrate on middle step
				mid := numSteps / 2
				probs[mid] = 0.80
				rem := 0.20 / float64(numSteps-1)
				for k := 0; k < numSteps; k++ {
					if k != mid {
						probs[k] = rem
					}
				}
			} else {
				// Safe / Read-only: concentrate on lowest step (index 0)
				probs[0] = 0.92
				for k := 1; k < numSteps; k++ {
					probs[k] = 0.08 / float64(numSteps-1)
				}
			}
		} else {
			// Uniform distribution default
			u := 1.0 / float64(numSteps)
			for k := 0; k < numSteps; k++ {
				probs[k] = u
			}
		}

		// Calculate expected value (weighted average): E = sum(val_k * p_k)
		expectedValue := 0.0
		for k := 0; k < numSteps; k++ {
			val := float64(q.Min + k*step)
			expectedValue += val * probs[k]
		}

		resp.Scores[name] = ScoreResult{
			Score:         expectedValue,
			Probabilities: probs,
		}
	}

	return resp
}
