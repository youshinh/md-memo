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
	a.initJevEngineLocked()
}

// initJevEngineLocked fills in every Jev collaborator that is still nil. Caller holds jevMu.
func (a *App) initJevEngineLocked() {
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
	// Reset and rebuild in ONE critical section so no reader can ever observe a nil client.
	a.jevMu.Lock()
	defer a.jevMu.Unlock()
	a.jevClient = nil
	a.jevAgentRouter = nil
	a.initJevEngineLocked()
}

// jevEngine ensures the Jev subsystem is initialized and returns a consistent snapshot of its
// collaborators (client, verifier, selector, runner, agent router) taken under jevMu. Every
// read site uses these returned locals instead of the bare a.jevXxx fields: InitJevEngine
// only fills in fields that are still nil, and ReloadJevConfig nils jevClient/jevAgentRouter
// under the same lock before rebuilding them, so a caller that read a.jevClient directly after
// InitJevEngine() returned (but without holding jevMu) could observe a nil client set by a
// concurrent ReloadJevConfig. Taking the whole snapshot in one critical section closes that
// window: callers either see the fully-formed old engine or the fully-formed new one.
func (a *App) jevEngine() (client *jev.Client, verifier *jev.ASTCommandVerifier, selector *jev.OrthogonalSelector, runner *jev.PipelineRunner, router *jev.AgentRouter) {
	a.jevMu.Lock()
	defer a.jevMu.Unlock()
	a.initJevEngineLocked()
	return a.jevClient, a.jevVerifier, a.jevSelector, a.jevRunner, a.jevAgentRouter
}

// JevPredict infers autonomous action candidates and selects 3 orthogonal slots.
func (a *App) JevPredict(contextText string, cursorOffset int) (*jev.JevPredictResponse, error) {
	client, _, selector, _, _ := a.jevEngine()

	req := jev.JevPredictRequest{
		BufferContext: contextText,
		CursorOffset:  cursorOffset,
		GrammarSchema: jev.TaskActionEBNF,
		MaxCandidates: 10,
	}

	rawResp, err := client.Predict(context.Background(), req)
	if err != nil {
		return nil, err
	}

	// Filter with MAP-Elites Orthogonal Selector
	triad := selector.SelectTriad(rawResp.Candidates)

	return &jev.JevPredictResponse{
		Candidates: triad,
		RawGrammar: rawResp.RawGrammar,
	}, nil
}

// JevPredictAsync runs prediction on a background goroutine and delivers the result through
// window.__onJevPredictResult, so the UI thread is never blocked. JevPredict (the synchronous
// bind) is kept for the headless/RPC callers; the WebView shim routes window.backend.jevPredict
// here instead, because Quick Actions auto-fires while the user is typing and a remote engine
// (or a slow local one) would otherwise freeze the whole window for the duration of the call.
func (a *App) JevPredictAsync(reqID, contextText string, cursorOffset int) {
	client, _, selector, _, _ := a.jevEngine()

	go func() {
		// An unrecovered panic on this goroutine ends the whole process: report it as an ordinary failure instead.
		defer func() {
			if r := recover(); r != nil {
				a.dispatchJevPredictResult(reqID, nil, fmt.Sprintf("内部エラー: %v", r))
			}
		}()
		if client == nil || selector == nil {
			a.dispatchJevPredictResult(reqID, nil, "Jevエンジンが初期化されていません")
			return
		}

		timeout := client.Timeout()
		if timeout <= 0 {
			timeout = 5 * time.Second
		}
		ctx, cancel := context.WithTimeout(context.Background(), timeout)
		defer cancel()

		rawResp, err := client.Predict(ctx, jev.JevPredictRequest{
			BufferContext: contextText,
			CursorOffset:  cursorOffset,
			GrammarSchema: jev.TaskActionEBNF,
			MaxCandidates: 10,
		})
		if err != nil {
			a.dispatchJevPredictResult(reqID, nil, err.Error())
			return
		}

		a.dispatchJevPredictResult(reqID, &jev.JevPredictResponse{
			Candidates: selector.SelectTriad(rawResp.Candidates),
			RawGrammar: rawResp.RawGrammar,
		}, "")
	}()
}

func (a *App) dispatchJevPredictResult(reqID string, res *jev.JevPredictResponse, errMsg string) {
	if atomic.LoadInt32(&a.isDestroyed) != 0 || a.w == nil {
		return
	}
	resJSON, _ := json.Marshal(res)
	errJSON, _ := json.Marshal(errMsg)

	js := fmt.Sprintf("if (window.__onJevPredictResult) { window.__onJevPredictResult(%q, %s, %s); }", reqID, string(resJSON), string(errJSON))
	a.dispatchEval(js)
}

// JevExecute executes a selected candidate through verified pipeline and decision routing.
func (a *App) JevExecute(candidateJSON string, contextText string) (*jev.JevExecuteResult, error) {
	_, _, _, runner, _ := a.jevEngine()

	var candidate jev.Candidate
	if err := json.Unmarshal([]byte(candidateJSON), &candidate); err != nil {
		return &jev.JevExecuteResult{
			Success: false,
			Error:   fmt.Sprintf("JSONデコードエラー: %v", err),
		}, err
	}

	result, err := runner.Execute(context.Background(), candidate, contextText)
	return &result, err
}

// JevExecuteAsync executes a candidate in a background goroutine and dispatches result to webview without blocking UI thread.
func (a *App) JevExecuteAsync(reqID, candidateJSON, contextText string) {
	_, _, _, runner, _ := a.jevEngine()

	go func() {
		defer func() {
			if r := recover(); r != nil {
				a.dispatchJevResult(reqID, &jev.JevExecuteResult{Success: false, Error: fmt.Sprintf("内部エラー: %v", r)})
			}
		}()
		var candidate jev.Candidate
		if err := json.Unmarshal([]byte(candidateJSON), &candidate); err != nil {
			a.dispatchJevResult(reqID, &jev.JevExecuteResult{
				Success: false,
				Error:   fmt.Sprintf("JSONデコードエラー: %v", err),
			})
			return
		}

		result, err := runner.Execute(context.Background(), candidate, contextText)
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

	js := fmt.Sprintf("if (window.__onJevResult) { window.__onJevResult(%q, %s); }", reqID, string(resJSON))
	a.dispatchEval(js)
}

// JevVerify provides standalone AST verification for a shell command string.
func (a *App) JevVerify(cmdStr string) (jev.ValidationResult, error) {
	_, verifier, _, _, _ := a.jevEngine()
	return verifier.Verify(cmdStr)
}

// JevDispatchAgent evaluates the task and determines whether to execute directly or escalate to an LLM agent.
func (a *App) JevDispatchAgent(input string) (*jev.ExecutionPlan, error) {
	_, _, _, _, router := a.jevEngine()
	return router.Dispatch(context.Background(), input)
}

// JevPruneContext extracts relevant blocks from raw markdown to optimize token consumption.
func (a *App) JevPruneContext(rawMarkdown string, query string) string {
	_, _, _, _, router := a.jevEngine()
	return router.PruneContext(rawMarkdown, query)
}

// JevEvaluateLoopConvergence assesses the multi-step agent loop for early stopping and completion.
func (a *App) JevEvaluateLoopConvergence(task jev.AgentTask, currentStep int, lastOutput string) (bool, float64) {
	_, _, _, _, router := a.jevEngine()
	return router.EvaluateLoopConvergence(task, currentStep, lastOutput)
}
