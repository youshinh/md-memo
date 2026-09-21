package slotagent

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime/debug"
	"strings"
	"sync"
	"time"

	"md-memo/pkg/boundedbuf"
	"md-memo/pkg/procutil"
)

// MaxAgentOutputBytes caps how much stdout/stderr a single agent run retains in memory.
// It matches the 10MB order of magnitude used for piped stdin on the CLI side; beyond it a
// single truncation marker is appended and further output is drained but discarded.
const MaxAgentOutputBytes = 10 * 1024 * 1024

// AgentExecutionResult contains the final output, exit code, and error details of an agent run.
type AgentExecutionResult struct {
	Output     string `json:"output"`
	RawOutput  string `json:"rawOutput"` // stdout as captured: same size cap, whitespace untouched
	ErrorMsg   string `json:"errorMsg"`
	ExitCode   int    `json:"exitCode"`
	TimedOut   bool   `json:"timedOut"`
	DurationMs int64  `json:"durationMs"`
}

// HoverPeekBuffer safely keeps track of the latest output line produced by an agent process.
type HoverPeekBuffer struct {
	mu       sync.RWMutex
	lastLine string
}

func (b *HoverPeekBuffer) Set(line string) {
	b.mu.Lock()
	defer b.mu.Unlock()
	trimmed := strings.TrimSpace(line)
	if trimmed != "" {
		b.lastLine = trimmed
	}
}

func (b *HoverPeekBuffer) Get() string {
	b.mu.RLock()
	defer b.mu.RUnlock()
	return b.lastLine
}

// Runner manages external agent CLI process executions, timeouts, and hover peeks.
type Runner struct {
	activeCancels sync.Map // reqID -> context.CancelFunc
	hoverPeeks    sync.Map // reqID -> *HoverPeekBuffer
}

// NewRunner creates a new Runner instance.
func NewRunner() *Runner {
	return &Runner{}
}

// GetHoverPeek retrieves the latest stdout/stderr line for the given request ID.
func (r *Runner) GetHoverPeek(reqID string) string {
	if val, ok := r.hoverPeeks.Load(reqID); ok {
		if buf, ok := val.(*HoverPeekBuffer); ok {
			return buf.Get()
		}
	}
	return ""
}

// Cancel cancels a running agent process by its request ID.
func (r *Runner) Cancel(reqID string) {
	if val, ok := r.activeCancels.Load(reqID); ok {
		if cancel, ok := val.(context.CancelFunc); ok {
			cancel()
		}
		r.activeCancels.Delete(reqID)
	}
}

// Register associates reqID with the cancel function of the context a run is executing
// under, so a later Cancel(reqID) actually stops it. Callers that build their own context
// (rather than going through ExecuteSlotAsync) must call this immediately after
// context.WithTimeout and pair it with a deferred Unregister - otherwise Cancel has nothing
// to look up and the run continues until its timeout.
func (r *Runner) Register(reqID string, cancel context.CancelFunc) {
	if reqID == "" || cancel == nil {
		return
	}
	r.activeCancels.Store(reqID, cancel)
}

// Unregister drops the cancel function recorded for reqID. It is safe to call when nothing
// was registered, and safe to call after Cancel already removed the entry.
func (r *Runner) Unregister(reqID string) {
	if reqID == "" {
		return
	}
	r.activeCancels.Delete(reqID)
}

// PrepareCommand builds an exec.Cmd with placeholder replacements and headless flags.
func PrepareCommand(ctx context.Context, agentDef AgentDef, filePath, instruction, systemInstruction string) (*exec.Cmd, error) {
	if agentDef.Command == "" {
		return nil, fmt.Errorf("agent command is not configured")
	}

	// If system instruction is provided, combine with instruction if appropriate
	fullInstruction := instruction
	if systemInstruction != "" {
		fullInstruction = fmt.Sprintf("%s\n\nTask: %s", systemInstruction, instruction)
	}

	// Check if args contain {file}
	hasFilePlaceholder := false
	for _, arg := range agentDef.Args {
		if strings.Contains(arg, "{file}") {
			hasFilePlaceholder = true
			break
		}
	}

	// If {file} was not present in args, but the instruction explicitly refers to the current note/memo,
	// ensure the agent knows the target file path
	if !hasFilePlaceholder && filePath != "" &&
		(strings.Contains(fullInstruction, "このメモ") || strings.Contains(fullInstruction, "このノート") || strings.Contains(fullInstruction, "カレントメモ")) &&
		!strings.Contains(fullInstruction, filePath) {
		fullInstruction = fmt.Sprintf("対象ノートファイル: %s\n指示: %s", filePath, fullInstruction)
	}

	var resolvedArgs []string
	hasInstructionPlaceholder := false

	for _, arg := range agentDef.Args {
		replaced := arg
		if strings.Contains(replaced, "{file}") {
			replaced = strings.ReplaceAll(replaced, "{file}", filePath)
		}
		if strings.Contains(replaced, "{instruction}") {
			replaced = strings.ReplaceAll(replaced, "{instruction}", fullInstruction)
			hasInstructionPlaceholder = true
		}
		resolvedArgs = append(resolvedArgs, replaced)
	}

	// If {instruction} placeholder was not used in args, append it as last argument
	if !hasInstructionPlaceholder && strings.TrimSpace(fullInstruction) != "" {
		resolvedArgs = append(resolvedArgs, fullInstruction)
	}

	cmd := exec.CommandContext(ctx, agentDef.Command, resolvedArgs...)

	// Setup working directory and environment variables
	workDir := ""
	if filePath != "" {
		workDir = FindProjectRoot(filePath)
	} else {
		if cwd, err := os.Getwd(); err == nil {
			workDir = cwd
		}
	}

	if workDir != "" {
		if fi, err := os.Stat(workDir); err == nil && fi.IsDir() {
			cmd.Dir = workDir
			// Automatically load .env from project root if present
			envPath := filepath.Join(workDir, ".env")
			if envMap, err := LoadEnvFile(envPath); err == nil && len(envMap) > 0 {
				cmd.Env = MergeProcessEnv(os.Environ(), envMap)
			}
		}
	}

	// Setup platform-specific orphan process termination
	procutil.KillTreeOnCancel(cmd)

	return cmd, nil
}

// Execute runs an agent command synchronously (within goroutine), monitoring stdout/stderr for Hover Peek.
func (r *Runner) Execute(ctx context.Context, reqID string, agentDef AgentDef, filePath, instruction, sysInstruction string) *AgentExecutionResult {
	startTime := time.Now()
	peekBuf := &HoverPeekBuffer{}
	peekBuf.Set("エージェント起動中...")
	r.hoverPeeks.Store(reqID, peekBuf)
	defer r.hoverPeeks.Delete(reqID)

	cmd, err := PrepareCommand(ctx, agentDef, filePath, instruction, sysInstruction)
	if err != nil {
		return &AgentExecutionResult{
			ExitCode:   1,
			ErrorMsg:   err.Error(),
			DurationMs: time.Since(startTime).Milliseconds(),
		}
	}

	stdoutPipe, err := cmd.StdoutPipe()
	if err != nil {
		return &AgentExecutionResult{
			ExitCode:   1,
			ErrorMsg:   fmt.Sprintf("Failed to open stdout pipe: %v", err),
			DurationMs: time.Since(startTime).Milliseconds(),
		}
	}

	stderrPipe, err := cmd.StderrPipe()
	if err != nil {
		return &AgentExecutionResult{
			ExitCode:   1,
			ErrorMsg:   fmt.Sprintf("Failed to open stderr pipe: %v", err),
			DurationMs: time.Since(startTime).Milliseconds(),
		}
	}

	if err := cmd.Start(); err != nil {
		return &AgentExecutionResult{
			ExitCode:   1,
			ErrorMsg:   fmt.Sprintf("エージェント起動失敗: %v", err),
			DurationMs: time.Since(startTime).Milliseconds(),
		}
	}

	// Bounded accumulators: a chatty agent could otherwise grow these without limit. They
	// keep draining the pipes (so the child never blocks on a full pipe) and simply stop
	// retaining past the cap. Hover peek is unaffected - it only ever holds one line.
	stdoutBuf := boundedbuf.New(MaxAgentOutputBytes)
	stderrBuf := boundedbuf.New(MaxAgentOutputBytes)
	var wg sync.WaitGroup

	// Stream stdout to capture output & update hover peek
	wg.Add(1)
	go func() {
		defer wg.Done()
		reader := bufio.NewReader(stdoutPipe)
		for {
			line, err := reader.ReadString('\n')
			if len(line) > 0 {
				_, _ = stdoutBuf.WriteString(line)
				peekBuf.Set(line)
			}
			if err != nil {
				break
			}
		}
	}()

	// Stream stderr to capture error logs & update hover peek
	wg.Add(1)
	go func() {
		defer wg.Done()
		reader := bufio.NewReader(stderrPipe)
		for {
			line, err := reader.ReadString('\n')
			if len(line) > 0 {
				_, _ = stderrBuf.WriteString(line)
				peekBuf.Set(line)
			}
			if err != nil {
				break
			}
		}
	}()

	wg.Wait()
	waitErr := cmd.Wait()

	durationMs := time.Since(startTime).Milliseconds()
	timedOut := ctx.Err() == context.DeadlineExceeded
	canceled := ctx.Err() == context.Canceled

	// Ensure OS memory is freed after external agent finishes
	defer debug.FreeOSMemory()

	exitCode := 0
	errMsg := ""

	if timedOut {
		exitCode = 124
		errMsg = "⚠ エラー: タイムアウト (再試行: Ctrl+Enter)"
	} else if canceled {
		exitCode = 130
		errMsg = "⚠ キャンセルされました"
	} else if waitErr != nil {
		if exitErr, ok := waitErr.(*exec.ExitError); ok {
			exitCode = exitErr.ExitCode()
		} else {
			exitCode = 1
		}
		rawStderr := strings.TrimSpace(stderrBuf.String())
		// Capture up to 1000 characters from stderr
		if len(rawStderr) > 1000 {
			rawStderr = rawStderr[:1000] + "..."
		}
		if rawStderr != "" {
			errMsg = fmt.Sprintf("⚠ エラー: %s", rawStderr)
		} else {
			errMsg = fmt.Sprintf("⚠ エラー: Exit Code %d", exitCode)
		}
	}

	rawStdout := stdoutBuf.String()

	return &AgentExecutionResult{
		Output:     strings.TrimSpace(rawStdout),
		RawOutput:  rawStdout,
		ErrorMsg:   errMsg,
		ExitCode:   exitCode,
		TimedOut:   timedOut,
		DurationMs: durationMs,
	}
}

// ExecuteSlotAsync starts the agent execution in a background goroutine, managing timeout and cancellation.
func (r *Runner) ExecuteSlotAsync(
	reqID string,
	agentDef AgentDef,
	filePath string,
	instruction string,
	sysInstruction string,
	timeoutSec int,
	onDone func(*AgentExecutionResult),
) {
	if timeoutSec <= 0 {
		timeoutSec = 180
	}

	ctx, cancel := context.WithTimeout(context.Background(), time.Duration(timeoutSec)*time.Second)
	r.activeCancels.Store(reqID, cancel)

	go func() {
		defer func() {
			cancel()
			r.activeCancels.Delete(reqID)
		}()

		res := r.Execute(ctx, reqID, agentDef, filePath, instruction, sysInstruction)
		if onDone != nil {
			onDone(res)
		}
	}()
}

// CreateTempNoteFile writes unsaved markdown content to a temporary file for agents that require a file path.
func CreateTempNoteFile(content string) (string, func(), error) {
	tmpFile, err := os.CreateTemp("", "md-memo-slot-*.md")
	if err != nil {
		return "", nil, err
	}
	filePath := tmpFile.Name()
	if _, err := io.WriteString(tmpFile, content); err != nil {
		_ = tmpFile.Close()
		_ = os.Remove(filePath)
		return "", nil, err
	}
	_ = tmpFile.Close()

	cleanup := func() {
		_ = os.Remove(filePath)
	}
	return filePath, cleanup, nil
}

// FindProjectRoot recursively searches upward from filePath to find the project root directory.
// A project root is identified by the presence of:
// - .md-memo/
// - agents.yaml, agents.yml, AGENTS.md, or agents.json
// - skills/
// - .git/
// If none are found, it returns the directory containing the file.
func FindProjectRoot(filePath string) string {
	if filePath == "" {
		cwd, err := os.Getwd()
		if err == nil {
			return cwd
		}
		return "."
	}

	absPath, err := filepath.Abs(filePath)
	if err != nil {
		absPath = filePath
	}

	// If filePath is a directory, start from it; otherwise start from its parent directory
	startDir := absPath
	if fi, err := os.Stat(absPath); err == nil && !fi.IsDir() {
		startDir = filepath.Dir(absPath)
	} else if err != nil {
		startDir = filepath.Dir(absPath)
	}

	curr := startDir
	rootMarkers := []string{
		".md-memo",
		"agents.yaml",
		"agents.yml",
		"AGENTS.md",
		"agents.json",
		"skills",
		".git",
	}

	for {
		for _, marker := range rootMarkers {
			checkPath := filepath.Join(curr, marker)
			if _, err := os.Stat(checkPath); err == nil {
				return curr
			}
		}

		parent := filepath.Dir(curr)
		if parent == curr || parent == "" {
			// Reached filesystem root without finding markers
			break
		}
		curr = parent
	}

	return startDir
}
