package main

import (
	"context"
	"encoding/json"
	"fmt"
	"sync/atomic"
	"time"

	"md-memo/pkg/jev"
	"md-memo/pkg/llm"
)

// InitJevEngine initializes the Jev client, AST verifier, orthogonal selector, and runner.
func (a *App) InitJevEngine() {
	a.jevMu.Lock()
	defer a.jevMu.Unlock()

	if a.jevVerifier == nil {
		a.jevVerifier = jev.NewASTCommandVerifier()
	}
	if a.jevClient == nil {
		clientCfg := jev.ClientConfig{
			Timeout: 5 * time.Second,
		}
		if cfgStr, err := a.GetConfig(); err == nil && cfgStr != "" {
			var rootCfg map[string]interface{}
			if err := json.Unmarshal([]byte(cfgStr), &rootCfg); err == nil {
				if actRaw, ok := rootCfg["action"]; ok {
					if actMap, ok := actRaw.(map[string]interface{}); ok {
						if k, ok := actMap["apiKey"].(string); ok && k != "" {
							clientCfg.APIKey = k
							clientCfg.OpenRouterKey = k
							clientCfg.TypeSafeKey = k
						}
						if m, ok := actMap["model"].(string); ok && m != "" {
							clientCfg.Model = m
						}
						if u, ok := actMap["baseUrl"].(string); ok && u != "" {
							clientCfg.Endpoint = u
						}
					}
				}
			}
		}
		a.jevClient = jev.NewClient(clientCfg)
	}
	if a.jevSelector == nil {
		a.jevSelector = jev.NewOrthogonalSelector()
	}
	if a.jevRunner == nil {
		a.jevRunner = jev.NewPipelineRunner(a.jevVerifier, 20*time.Second)
		// Connect LLM handler for generative AI tasks
		a.jevRunner.SetLLMHandler(func(ctx context.Context, prompt string) (string, error) {
			cfgStr, _ := a.GetConfig()
			var rootCfg map[string]interface{}
			_ = json.Unmarshal([]byte(cfgStr), &rootCfg)

			var cfg llm.Config
			if llmRaw, ok := rootCfg["llm"]; ok {
				llmBytes, _ := json.Marshal(llmRaw)
				_ = json.Unmarshal(llmBytes, &cfg)
			} else {
				_ = json.Unmarshal([]byte(cfgStr), &cfg)
			}

			if cfg.BaseURL != "" && llm.IsOllamaURL(cfg.BaseURL) && !llm.CheckOllamaHealth(cfg.BaseURL) {
				_ = a.EnsureOllamaRunning(6 * time.Second)
			}

			return llm.Query(prompt, cfg)
		})
	}
	if a.jevAgentRouter == nil {
		a.jevAgentRouter = jev.NewAgentRouter(a.jevClient, 0.85)
	}
}

// ReloadJevConfig resets the Jev client and router to pick up updated configuration.
func (a *App) ReloadJevConfig() {
	a.jevMu.Lock()
	a.jevClient = nil
	a.jevAgentRouter = nil
	a.jevMu.Unlock()
	a.InitJevEngine()
}

// JevPredict infers autonomous action candidates and selects 3 orthogonal slots.
func (a *App) JevPredict(contextText string, cursorOffset int) (*jev.JevPredictResponse, error) {
	a.InitJevEngine()

	req := jev.JevPredictRequest{
		BufferContext: contextText,
		CursorOffset:  cursorOffset,
		GrammarSchema: jev.TaskActionEBNF,
		MaxCandidates: 10,
	}

	rawResp, err := a.jevClient.Predict(context.Background(), req)
	if err != nil {
		return nil, err
	}

	// Filter with MAP-Elites Orthogonal Selector
	triad := a.jevSelector.SelectTriad(rawResp.Candidates)

	return &jev.JevPredictResponse{
		Candidates: triad,
		RawGrammar: rawResp.RawGrammar,
	}, nil
}

// JevExecute executes a selected candidate through verified pipeline and decision routing.
func (a *App) JevExecute(candidateJSON string, contextText string) (*jev.JevExecuteResult, error) {
	a.InitJevEngine()

	var candidate jev.Candidate
	if err := json.Unmarshal([]byte(candidateJSON), &candidate); err != nil {
		return &jev.JevExecuteResult{
			Success: false,
			Error:   fmt.Sprintf("JSONデコードエラー: %v", err),
		}, err
	}

	result, err := a.jevRunner.Execute(context.Background(), candidate, contextText)
	return &result, err
}

// JevExecuteAsync executes a candidate in a background goroutine and dispatches result to webview without blocking UI thread.
func (a *App) JevExecuteAsync(reqID, candidateJSON, contextText string) {
	a.InitJevEngine()

	go func() {
		var candidate jev.Candidate
		if err := json.Unmarshal([]byte(candidateJSON), &candidate); err != nil {
			a.dispatchJevResult(reqID, &jev.JevExecuteResult{
				Success: false,
				Error:   fmt.Sprintf("JSONデコードエラー: %v", err),
			})
			return
		}

		result, err := a.jevRunner.Execute(context.Background(), candidate, contextText)
		if err != nil && result.Error == "" {
			result.Error = err.Error()
		}
		a.dispatchJevResult(reqID, &result)
	}()
}

func (a *App) dispatchJevResult(reqID string, res *jev.JevExecuteResult) {
	if atomic.LoadInt32(&a.isDestroyed) != 0 || a.w == nil {
		return
	}
	resJSON, _ := json.Marshal(res)

	a.w.Dispatch(func() {
		if atomic.LoadInt32(&a.isDestroyed) == 0 {
			js := fmt.Sprintf("if (window.__onJevResult) { window.__onJevResult(%q, %s); }", reqID, string(resJSON))
			a.w.Eval(js)
		}
	})
}

// JevVerify provides standalone AST verification for a shell command string.
func (a *App) JevVerify(cmdStr string) (jev.ValidationResult, error) {
	a.InitJevEngine()
	return a.jevVerifier.Verify(cmdStr)
}

// JevDispatchAgent evaluates the task and determines whether to execute directly or escalate to an LLM agent.
func (a *App) JevDispatchAgent(input string) (*jev.ExecutionPlan, error) {
	a.InitJevEngine()
	return a.jevAgentRouter.Dispatch(context.Background(), input)
}

// JevPruneContext extracts relevant blocks from raw markdown to optimize token consumption.
func (a *App) JevPruneContext(rawMarkdown string, query string) string {
	a.InitJevEngine()
	return a.jevAgentRouter.PruneContext(rawMarkdown, query)
}

// JevEvaluateLoopConvergence assesses the multi-step agent loop for early stopping and completion.
func (a *App) JevEvaluateLoopConvergence(task jev.AgentTask, currentStep int, lastOutput string) (bool, float64) {
	a.InitJevEngine()
	return a.jevAgentRouter.EvaluateLoopConvergence(task, currentStep, lastOutput)
}
