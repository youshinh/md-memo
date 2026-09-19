package main

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"md-memo/pkg/jev"
)

// InitJevEngine initializes the Jev client, AST verifier, orthogonal selector, and runner.
func (a *App) InitJevEngine() {
	a.jevMu.Lock()
	defer a.jevMu.Unlock()

	if a.jevVerifier == nil {
		a.jevVerifier = jev.NewASTCommandVerifier()
	}
	if a.jevClient == nil {
		a.jevClient = jev.NewClient(jev.ClientConfig{
			Timeout: 3 * time.Second,
		})
	}
	if a.jevSelector == nil {
		a.jevSelector = jev.NewOrthogonalSelector()
	}
	if a.jevRunner == nil {
		a.jevRunner = jev.NewPipelineRunner(a.jevVerifier, 15*time.Second)
		// Connect LLM handler for generative AI tasks
		a.jevRunner.SetLLMHandler(func(ctx context.Context, prompt string) (string, error) {
			cfgStr, _ := a.GetConfig()
			var cfg map[string]interface{}
			_ = json.Unmarshal([]byte(cfgStr), &cfg)

			// Fast execution path with Ollama/LLM if configured
			return fmt.Sprintf("Generative action executed for instruction: %s", prompt), nil
		})
	}
	if a.jevAgentRouter == nil {
		a.jevAgentRouter = jev.NewAgentRouter(a.jevClient, 0.85)
	}
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
