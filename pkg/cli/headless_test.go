package cli

import (
	"bytes"
	"strings"
	"testing"
)

func TestHeadlessJevVerifySafeText(t *testing.T) {
	var stdout, stderr bytes.Buffer
	runner := NewHeadlessRunner(&stdout, &stderr)

	code, err := runner.Run([]string{"jev", "verify", "--text", "echo hello"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if code != 0 {
		t.Errorf("expected exit code 0 for safe command, got %d", code)
	}
	if !strings.Contains(stdout.String(), "[SAFE]") {
		t.Errorf("expected [SAFE] in stdout, got: %s", stdout.String())
	}
}

func TestHeadlessJevVerifyBlockedText(t *testing.T) {
	var stdout, stderr bytes.Buffer
	runner := NewHeadlessRunner(&stdout, &stderr)

	code, err := runner.Run([]string{"jev", "verify", "--text", "rm -rf /"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if code != 1 {
		t.Errorf("expected exit code 1 for dangerous command, got %d", code)
	}
	if !strings.Contains(stderr.String(), "[BLOCKED]") {
		t.Errorf("expected [BLOCKED] in stderr, got: %s", stderr.String())
	}
}

func TestHeadlessJevVerifyJSON(t *testing.T) {
	var stdout, stderr bytes.Buffer
	runner := NewHeadlessRunner(&stdout, &stderr)

	code, err := runner.Run([]string{"jev", "verify", "--json", "echo safe"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if code != 0 {
		t.Errorf("expected exit code 0, got %d", code)
	}
	if !strings.Contains(stdout.String(), `"isSafe": true`) {
		t.Errorf("expected JSON isSafe output, got: %s", stdout.String())
	}
}

func TestHeadlessAgentPrune(t *testing.T) {
	var stdout, stderr bytes.Buffer
	runner := NewHeadlessRunner(&stdout, &stderr)

	code, err := runner.Run([]string{"agent", "prune", "--json", "--query", "authentication"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if code != 0 {
		t.Errorf("expected exit code 0, got %d", code)
	}
	if !strings.Contains(stdout.String(), `"pruned_length"`) {
		t.Errorf("expected pruned_length in JSON, got: %s", stdout.String())
	}
}

func TestHeadlessJevScore(t *testing.T) {
	var stdout, stderr bytes.Buffer
	runner := NewHeadlessRunner(&stdout, &stderr)

	// 1. JSON score for safe command
	code, err := runner.Run([]string{"jev", "score", "--json", "git status"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if code != 0 {
		t.Errorf("expected exit code 0, got %d", code)
	}
	if !strings.Contains(stdout.String(), `"score"`) || !strings.Contains(stdout.String(), `"probabilities"`) {
		t.Errorf("expected score JSON output, got: %s", stdout.String())
	}

	// 2. Plain text score for destructive command
	stdout.Reset()
	code, err = runner.Run([]string{"jev", "score", "--text", "rm -rf /"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if code != 0 {
		t.Errorf("expected exit code 0, got %d", code)
	}
	if !strings.Contains(stdout.String(), "[DESTRUCTIVE]") {
		t.Errorf("expected [DESTRUCTIVE] label in stdout, got: %s", stdout.String())
	}
}

func TestHeadlessJevDispatch(t *testing.T) {
	var stdout, stderr bytes.Buffer
	runner := NewHeadlessRunner(&stdout, &stderr)

	code, err := runner.Run([]string{"jev", "dispatch", "--json", "git status"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if code != 0 {
		t.Errorf("expected exit code 0, got %d", code)
	}
	if !strings.Contains(stdout.String(), `"action_type": "direct"`) {
		t.Errorf("expected direct action_type in JSON, got: %s", stdout.String())
	}
}
