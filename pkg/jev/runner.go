package jev

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"os/exec"
	"runtime"
	"strings"
	"time"
)

// PipelineRunner handles verified command execution and external agent dispatching.
type PipelineRunner struct {
	verifier   CommandVerifier
	router     *DecisionRouter
	timeout    time.Duration
	llmHandler func(ctx context.Context, prompt string) (string, error)
}

// NewPipelineRunner creates a new PipelineRunner instance.
func NewPipelineRunner(verifier CommandVerifier, timeout time.Duration) *PipelineRunner {
	if timeout <= 0 {
		timeout = 15 * time.Second
	}
	return &PipelineRunner{
		verifier: verifier,
		router:   NewDecisionRouter(),
		timeout:  timeout,
	}
}

// SetLLMHandler registers a fallback or direct LLM execution handler for "ai" and "doc" candidates.
func (p *PipelineRunner) SetLLMHandler(h func(ctx context.Context, prompt string) (string, error)) {
	p.llmHandler = h
}

// Execute runs the candidate through the 2-level decision tree and verified pipeline.
func (p *PipelineRunner) Execute(parentCtx context.Context, c Candidate, bufferContext string) (JevExecuteResult, error) {
	ctx, cancel := context.WithTimeout(parentCtx, p.timeout)
	defer cancel()

	decision := p.router.Route(c)

	if decision.Level1Method == "deterministic" {
		return p.executeDeterministic(ctx, c)
	}

	return p.executeGenerative(ctx, c, bufferContext)
}

func (p *PipelineRunner) executeDeterministic(ctx context.Context, c Candidate) (JevExecuteResult, error) {
	// 1. Mandatory AST Static Verification Gate
	valRes, err := p.verifier.Verify(c.Command)
	if err != nil {
		return JevExecuteResult{
			Success:    false,
			Error:      fmt.Sprintf("検証エラー: %v", err),
			ActionType: c.ActionType,
		}, err
	}

	if !valRes.IsSafe {
		return JevExecuteResult{
			Success:    false,
			Error:      fmt.Sprintf("安全性ガードレールにより拒否: %s", valRes.Reason),
			ActionType: c.ActionType,
		}, fmt.Errorf("command blocked by guardrail: %s", valRes.Reason)
	}

	// 2. Build OS-appropriate command execution
	var cmd *exec.Cmd
	if runtime.GOOS == "windows" {
		cmd = exec.CommandContext(ctx, "powershell", "-NoProfile", "-NonInteractive", "-Command", c.Command)
	} else {
		cmd = exec.CommandContext(ctx, "sh", "-c", c.Command)
	}

	// 3. Streaming with io.Pipe
	pr, pw := io.Pipe()
	cmd.Stdout = pw
	cmd.Stderr = pw

	var outBuf bytes.Buffer
	readDone := make(chan struct{})

	go func() {
		defer close(readDone)
		_, _ = io.Copy(&outBuf, pr)
	}()

	startErr := cmd.Start()
	if startErr != nil {
		_ = pw.Close()
		_ = pr.Close()
		return JevExecuteResult{
			Success:    false,
			Error:      startErr.Error(),
			ActionType: c.ActionType,
		}, startErr
	}

	waitErr := cmd.Wait()
	_ = pw.Close()
	<-readDone

	rawOutput := strings.TrimSpace(strings.ReplaceAll(outBuf.String(), "\r\n", "\n"))

	if waitErr != nil {
		errMsg := waitErr.Error()
		if ctx.Err() == context.DeadlineExceeded {
			errMsg = fmt.Sprintf("実行がタイムアウトしました (15秒超過): %v", waitErr)
		}
		return JevExecuteResult{
			Success:    false,
			Output:     rawOutput,
			Error:      errMsg,
			Markdown:   FormatMarkdownExecutionResult(c, rawOutput, false),
			ActionType: c.ActionType,
		}, waitErr
	}

	return JevExecuteResult{
		Success:    true,
		Output:     rawOutput,
		Markdown:   FormatMarkdownExecutionResult(c, rawOutput, true),
		ActionType: c.ActionType,
	}, nil
}

func (p *PipelineRunner) executeGenerative(ctx context.Context, c Candidate, bufferContext string) (JevExecuteResult, error) {
	prompt := fmt.Sprintf("[%s] %s\n\nContext:\n%s", c.ActionType, c.Command, bufferContext)

	var output string
	var err error

	if p.llmHandler != nil {
		output, err = p.llmHandler(ctx, prompt)
	} else {
		// Clean mock response format if no external handler injected
		output = fmt.Sprintf("Completed action: %s\n(Generative task processed successfully)", c.Command)
	}

	if err != nil {
		return JevExecuteResult{
			Success:    false,
			Error:      err.Error(),
			ActionType: c.ActionType,
		}, err
	}

	return JevExecuteResult{
		Success:    true,
		Output:     output,
		Markdown:   FormatMarkdownExecutionResult(c, output, true),
		ActionType: c.ActionType,
	}, nil
}

// FormatMarkdownExecutionResult formats the command and its output into standard Markdown.
func FormatMarkdownExecutionResult(c Candidate, output string, success bool) string {
	var sb strings.Builder
	statusMark := "x"
	if !success {
		statusMark = " "
	}

	sb.WriteString(fmt.Sprintf("\n- [%s] %s %s\n", statusMark, c.ActionType, c.Command))

	if strings.TrimSpace(output) == "" {
		return sb.String()
	}

	// Format as blockquote if short, or fenced code block if multi-line / structured
	lines := strings.Split(output, "\n")
	if len(lines) <= 3 && !strings.Contains(output, "```") {
		for _, line := range lines {
			sb.WriteString(fmt.Sprintf("  > %s\n", line))
		}
	} else {
		sb.WriteString("  ```\n")
		for _, line := range lines {
			sb.WriteString(fmt.Sprintf("  %s\n", line))
		}
		sb.WriteString("  ```\n")
	}

	return sb.String()
}
