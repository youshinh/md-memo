package jev

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"
)

// ClientConfig holds configuration for communicating with Jev Engine.
type ClientConfig struct {
	Endpoint      string        `json:"endpoint"`
	APIKey        string        `json:"api_key"`
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
			cfg.Endpoint = "http://127.0.0.1:8000"
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
