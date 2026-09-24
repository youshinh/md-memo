package llm

import (
	"context"
	"errors"
	"fmt"
	"os/exec"
	"runtime"
	"strings"
	"time"
)

var errAppleFMUnavailable = errors.New("apple foundation models CLI not available")

// currentGOOS, lookPathFM, runFMAvailable and runFMRespond are indirected so tests can stub
// the `fm` CLI and the host OS without needing a real macOS 27 machine (see applefm_test.go).
var (
	currentGOOS = runtime.GOOS

	lookPathFM = func() error {
		_, err := exec.LookPath("fm")
		return err
	}
	runFMAvailable = func(ctx context.Context) (string, error) {
		out, err := exec.CommandContext(ctx, "fm", "available").Output()
		return string(out), err
	}
	runFMRespond = func(ctx context.Context, prompt string) (string, error) {
		out, err := exec.CommandContext(ctx, "fm", "respond", prompt).Output()
		return string(out), err
	}
)

// IsAppleFMAvailable reports whether this machine can answer prompts with Apple's on-device
// Foundation Models CLI (macOS 27+, Apple Intelligence enabled, model already downloaded).
// Returns false immediately on any non-macOS platform without spawning a process.
func IsAppleFMAvailable() bool {
	if currentGOOS != "darwin" {
		return false
	}
	if lookPathFM() != nil {
		return false
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	out, err := runFMAvailable(ctx)
	if err != nil {
		return false
	}
	lower := strings.ToLower(out)
	return strings.Contains(lower, "available") && !strings.Contains(lower, "unavailable")
}

// queryAppleFM asks the on-device Apple Intelligence model to answer prompt via a single
// `fm respond` invocation -- no standing background process. It is only ever attempted by
// Query when the caller has no LLM endpoint configured at all, so it never overrides a
// deliberately-configured Ollama/OpenAI/Gemini endpoint.
func queryAppleFM(prompt string) (string, error) {
	if !IsAppleFMAvailable() {
		return "", errAppleFMUnavailable
	}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	out, err := runFMRespond(ctx, prompt)
	if err != nil {
		return "", fmt.Errorf("apple fm respond failed: %w", err)
	}
	out = strings.TrimSpace(out)
	if out == "" {
		return "", fmt.Errorf("apple fm respond returned empty output")
	}
	return out, nil
}
