package main

import (
	"strings"
	"testing"
	"time"
)

func TestRunCommandFilter(t *testing.T) {
	app := &App{}

	cmd := "sort"
	input := "banana\napple\ncherry\n"
	res, err := app.RunCommandFilter(cmd, input)
	if err != nil {
		t.Fatalf("RunCommandFilter failed: %v", err)
	}
	if res.ExitCode != 0 {
		t.Fatalf("expected exit code 0, got %d. stderr: %s", res.ExitCode, res.Error)
	}

	expected := "apple\nbanana\ncherry"
	trimmedOut := strings.TrimSpace(strings.ReplaceAll(res.Output, "\r\n", "\n"))
	if trimmedOut != expected {
		t.Errorf("expected sorted output %q, got %q", expected, trimmedOut)
	}
}

func TestRunCommandFilterPowerShellDirect(t *testing.T) {
	app := &App{}
	cmdStr := `1..2 | ForEach-Object { "128.0.0.$_" }`
	res, err := app.RunCommandFilter(cmdStr, "")
	if err != nil {
		t.Fatalf("RunCommandFilter failed: %v", err)
	}
	if res.ExitCode != 0 {
		t.Fatalf("expected exit code 0, got %d. stderr: %s", res.ExitCode, res.Error)
	}
	if !strings.Contains(res.Output, "128.0.0.1") || !strings.Contains(res.Output, "128.0.0.2") {
		t.Errorf("expected output to contain 128.0.0.1 and 128.0.0.2, got %q", res.Output)
	}
}

func TestRunCommandFilterError(t *testing.T) {
	app := &App{}

	// Invalid command should return non-zero exit code or error
	cmd := "nonexistent_cli_tool_xyz_12345"
	res, err := app.RunCommandFilter(cmd, "test")
	if err == nil && res != nil && res.ExitCode == 0 {
		t.Errorf("expected command error for invalid CLI, but succeeded with exit code 0")
	}
}

type mockWebView struct {
	dispatched []func()
	evals      []string
	doneCh     chan string
}

func (m *mockWebView) Dispatch(f func()) {
	m.dispatched = append(m.dispatched, f)
	f()
}

func (m *mockWebView) Eval(js string) {
	m.evals = append(m.evals, js)
	select {
	case m.doneCh <- js:
	default:
	}
}

func TestRunCommandFilterAsync(t *testing.T) {
	mock := &mockWebView{doneCh: make(chan string, 1)}
	app := &App{w: mock}

	reqID := "test_req_1"
	cmd := "sort"
	input := "orange\napple\nbanana\n"

	app.RunCommandFilterAsync(reqID, cmd, input)

	select {
	case js := <-mock.doneCh:
		if !strings.Contains(js, reqID) {
			t.Errorf("expected js to contain reqID %q, got: %s", reqID, js)
		}
		if !strings.Contains(js, "apple") {
			t.Errorf("expected js to contain sorted output 'apple', got: %s", js)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for RunCommandFilterAsync result")
	}
}

func TestCancelCommandFilter(t *testing.T) {
	mock := &mockWebView{doneCh: make(chan string, 1)}
	app := &App{w: mock}

	reqID := "test_cancel_req"
	// Long-running command
	cmd := "ping 127.0.0.1 -n 10"

	app.RunCommandFilterAsync(reqID, cmd, "test")

	// Allow goroutine to start and spawn process
	time.Sleep(100 * time.Millisecond)

	start := time.Now()
	app.CancelCommandFilter(reqID)

	select {
	case js := <-mock.doneCh:
		elapsed := time.Since(start)
		if elapsed > 3*time.Second {
			t.Errorf("cancellation took too long: %v", elapsed)
		}
		if !strings.Contains(js, reqID) {
			t.Errorf("expected cancelled callback to contain reqID, got: %s", js)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for cancelled command to return")
	}
}
