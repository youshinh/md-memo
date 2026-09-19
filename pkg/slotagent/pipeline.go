package slotagent

import (
	"context"
	"fmt"
	"strings"
)

// PipelineStatus represents the state of a multi-step recipe pipeline.
type PipelineStatus string

const (
	PipelineStatusRunning            PipelineStatus = "running"
	PipelineStatusCompleted          PipelineStatus = "completed"
	PipelineStatusSuspended          PipelineStatus = "suspended"
	PipelineStatusFailed             PipelineStatus = "failed"
	PipelineStatusWaitingApproval    PipelineStatus = "waiting_approval"
)

// PipelineStepResult holds intermediate or final results of a step execution.
type PipelineStepResult struct {
	StepIndex   int            `json:"stepIndex"`
	TotalSteps  int            `json:"totalSteps"`
	StepPrompt  string         `json:"stepPrompt"`
	Output      string         `json:"output"`
	Status      PipelineStatus `json:"status"`
	SuspendGate string         `json:"suspendGate,omitempty"`
	ErrorMsg    string         `json:"errorMsg,omitempty"`
}

// PipelineEngine executes recipe pipelines with Human-in-the-loop gates and Evaluator-Optimizer refinement.
type PipelineEngine struct {
	runner *Runner
}

// NewPipelineEngine creates a new PipelineEngine.
func NewPipelineEngine(runner *Runner) *PipelineEngine {
	return &PipelineEngine{runner: runner}
}

// ExecuteRecipe runs the recipe pipeline up to the next approval gate or completion.
func (p *PipelineEngine) ExecuteRecipe(
	ctx context.Context,
	reqID string,
	recipe Recipe,
	defaultAgent AgentDef,
	filePath string,
	currentDocContent string,
	startingStep int,
	approvalStatus bool, // true if human checked - [x]
) *PipelineStepResult {
	totalSteps := len(recipe.Steps)
	if totalSteps == 0 {
		return &PipelineStepResult{
			StepIndex:  0,
			TotalSteps: 0,
			Status:     PipelineStatusCompleted,
		}
	}

	stepIdx := startingStep
	if stepIdx < 0 {
		stepIdx = 0
	}

	// If resuming from an approved gate, advance to next step
	if approvalStatus && stepIdx > 0 {
		// proceed with current step
	}

	for stepIdx < totalSteps {
		stepInstruction := recipe.Steps[stepIdx]

		// Check if this step is an approval gate
		isGateStep := (recipe.RequiresApprovalStep > 0 && stepIdx+1 == recipe.RequiresApprovalStep)

		// Execute step with self-refine if enabled on the step
		var stepOutput string
		if recipe.SelfRefine && stepIdx == 0 {
			// Evaluator-Optimizer loop (max 2 iterations)
			res := p.executeSelfRefineLoop(ctx, reqID, defaultAgent, filePath, stepInstruction)
			if res.ErrorMsg != "" && res.ExitCode != 0 {
				return &PipelineStepResult{
					StepIndex:  stepIdx + 1,
					TotalSteps: totalSteps,
					StepPrompt: stepInstruction,
					Status:     PipelineStatusFailed,
					ErrorMsg:   res.ErrorMsg,
				}
			}
			stepOutput = res.Output
		} else {
			res := p.runner.Execute(ctx, reqID, defaultAgent, filePath, stepInstruction, "")
			if res.ErrorMsg != "" && res.ExitCode != 0 {
				return &PipelineStepResult{
					StepIndex:  stepIdx + 1,
					TotalSteps: totalSteps,
					StepPrompt: stepInstruction,
					Status:     PipelineStatusFailed,
					ErrorMsg:   res.ErrorMsg,
				}
			}
			stepOutput = res.Output
		}

		// If this step requires human approval before proceeding to next step
		if isGateStep && stepIdx+1 < totalSteps {
			nextStepDesc := recipe.Steps[stepIdx+1]
			gateLine := fmt.Sprintf("\n- [ ] 次のステップ（%s）を実行する // approve", sanitizeGateDesc(nextStepDesc))
			return &PipelineStepResult{
				StepIndex:   stepIdx + 1,
				TotalSteps:  totalSteps,
				StepPrompt:  stepInstruction,
				Output:      stepOutput + gateLine,
				Status:      PipelineStatusWaitingApproval,
				SuspendGate: gateLine,
			}
		}

		stepIdx++
	}

	return &PipelineStepResult{
		StepIndex:  totalSteps,
		TotalSteps: totalSteps,
		Status:     PipelineStatusCompleted,
	}
}

// executeSelfRefineLoop performs Generator -> Evaluator -> Optimizer (max 2 iterations).
func (p *PipelineEngine) executeSelfRefineLoop(
	ctx context.Context,
	reqID string,
	agentDef AgentDef,
	filePath string,
	baseInstruction string,
) *AgentExecutionResult {
	// 1. Generator Phase
	genRes := p.runner.Execute(ctx, reqID, agentDef, filePath, baseInstruction, "初稿ドラフトを生成してください。")
	if genRes.ErrorMsg != "" && genRes.ExitCode != 0 {
		return genRes
	}
	currentDraft := genRes.Output

	// Loop up to 2 refinement passes
	for pass := 1; pass <= 2; pass++ {
		// 2. Evaluator Phase
		evalPrompt := fmt.Sprintf("【直前ドラフト】:\n%s\n\n上記の直前ドラフトに対する事実誤認、論理の飛躍、セキュリティ脆弱性、ボトルネックを批判的に検証・反証してください。", currentDraft)
		evalRes := p.runner.Execute(ctx, reqID, agentDef, filePath, evalPrompt, "批判的検証フェーズ (Evaluator)")
		if evalRes.ErrorMsg != "" && evalRes.ExitCode != 0 {
			break
		}

		critique := evalRes.Output
		if strings.TrimSpace(critique) == "" || strings.Contains(critique, "問題なし") || strings.Contains(critique, "脆弱性は見当たりません") {
			// Good enough, exit early
			break
		}

		// 3. Optimizer Phase
		optPrompt := fmt.Sprintf("【直前ドラフト】:\n%s\n\n【検証指摘事項】:\n%s\n\n上記の指摘事項を反映し、修正した完成成果物のみを出力してください。", currentDraft, critique)
		optRes := p.runner.Execute(ctx, reqID, agentDef, filePath, optPrompt, "改善フェーズ (Optimizer)")
		if optRes.ErrorMsg != "" && optRes.ExitCode != 0 {
			break
		}
		if strings.TrimSpace(optRes.Output) != "" {
			currentDraft = optRes.Output
		}
	}

	return &AgentExecutionResult{
		Output:   currentDraft,
		ExitCode: 0,
	}
}

func sanitizeGateDesc(desc string) string {
	desc = strings.TrimSpace(desc)
	if len(desc) > 30 {
		desc = desc[:30] + "..."
	}
	desc = strings.ReplaceAll(desc, "\n", " ")
	return desc
}
