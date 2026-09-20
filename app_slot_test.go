package main

import (
	"context"
	"strings"
	"sync"
	"testing"
	"time"
)

type dummyWebView struct {
	dispatched []func()
	evals      []string
}

func (d *dummyWebView) Dispatch(f func()) {
	d.dispatched = append(d.dispatched, f)
	f()
}

func (d *dummyWebView) Eval(js string) {
	d.evals = append(d.evals, js)
}

func TestApp_ParseSlotsRPC(t *testing.T) {
	app := &App{}
	app.InitSlotEngine()

	doc := "# Note\n\n- Summary: {{ code: fmt.Println(\"hello\") }}\n\n[? research quantum ]"
	resp, err := app.ParseSlotsRPC(doc, 20, "")
	if err != nil {
		t.Fatalf("ParseSlotsRPC failed: %v", err)
	}

	if len(resp.AllSlots) != 2 {
		t.Fatalf("expected 2 slots, got %d", len(resp.AllSlots))
	}
	if resp.TargetSlot == nil {
		t.Fatalf("expected targetSlot to be detected near offset 20")
	}
	if resp.TargetSlot.Role != "code" {
		t.Errorf("expected role 'code', got %q", resp.TargetSlot.Role)
	}
	if !resp.TargetSlot.IsInline {
		t.Errorf("expected targetSlot to be inline")
	}
}

func TestApp_RunSlotAgentAsync_SimulatedAgent(t *testing.T) {
	dw := &dummyWebView{}
	app := &App{w: dw}
	app.InitSlotEngine()

	// Use powershell to echo output quickly
	configJSON := `{
		"version": 2,
		"default_agent": "mock",
		"agents": {
			"mock": {
				"command": "powershell",
				"args": ["-NoProfile", "-Command", "param($inst); Write-Output 'Slot Result 42'", "{instruction}"]
			}
		},
		"slot_profiles": [
			{
				"trigger_open": "{{",
				"trigger_close": "}}",
				"name": "calc",
				"agent": "mock"
			}
		]
	}`

	doc := "# Calc\n\n{{ calc: 20 + 22 }}\n"
	reqID := "test-slot-req-1"

	app.RunSlotAgentAsync(reqID, "", doc, 15, configJSON)

	// Wait up to 3 seconds for async execution to dispatch
	deadline := time.Now().Add(3 * time.Second)
	foundResult := false
	for time.Now().Before(deadline) {
		for _, ev := range dw.evals {
			if strings.Contains(ev, "__onSlotAgentResult") && strings.Contains(ev, "Slot Result 42") {
				foundResult = true
				break
			}
		}
		if foundResult {
			break
		}
		time.Sleep(50 * time.Millisecond)
	}

	if !foundResult {
		t.Fatalf("did not receive __onSlotAgentResult callback with expected output. Evals: %v", dw.evals)
	}
}

func TestApp_CancelSlotAgent(t *testing.T) {
	app := &App{}
	app.InitSlotEngine()

	reqID := "cancel-test"
	ctx, cancel := context.WithCancel(context.Background())
	_ = ctx
	_ = cancel

	// Canceling a non-existent or completed reqID shouldn't panic
	app.CancelSlotAgent(reqID)
}

// TestApp_SlotEngine_ConcurrentInitIsSafe hammers the lazy slot-engine initialization from
// many goroutines at once, mirroring how InitSlotEngine, CancelSlotAgent, and
// GetSlotHoverPeek can all race on first use in real usage (e.g. a slot request and a stray
// hover-peek poll arriving back to back). Before the slotEngine() accessor, InitSlotEngine's
// `if a.slotRunner == nil { ... }` check-and-set on slotRunner/pipelineEngine ran with no
// lock, so two concurrent first calls could interleave and hand back a runner and pipeline
// that were not each other's match, or race the plain pointer writes. This only proves "no
// panic, no torn pair" - -race is unavailable on this machine (no gcc).
func TestApp_SlotEngine_ConcurrentInitIsSafe(t *testing.T) {
	app := &App{}

	const workers = 16
	runners := make([]interface{}, workers)
	pipelines := make([]interface{}, workers)
	var wg sync.WaitGroup
	wg.Add(workers)
	for i := 0; i < workers; i++ {
		i := i
		go func() {
			defer wg.Done()
			runner, pipeline := app.slotEngine()
			runners[i] = runner
			pipelines[i] = pipeline
		}()
	}
	wg.Wait()

	for i := 0; i < workers; i++ {
		if runners[i] == nil || pipelines[i] == nil {
			t.Fatalf("worker %d got a nil runner or pipeline", i)
		}
		if runners[i] != runners[0] {
			t.Errorf("worker %d got a different runner than worker 0; concurrent init produced more than one instance", i)
		}
		if pipelines[i] != pipelines[0] {
			t.Errorf("worker %d got a different pipeline than worker 0; concurrent init produced more than one instance", i)
		}
	}

	// CancelSlotAgent / GetSlotHoverPeek must also be safe to call standalone, without any
	// prior explicit InitSlotEngine call, and must not panic.
	app2 := &App{}
	var wg2 sync.WaitGroup
	wg2.Add(2)
	go func() {
		defer wg2.Done()
		app2.CancelSlotAgent("never-registered")
	}()
	go func() {
		defer wg2.Done()
		_ = app2.GetSlotHoverPeek("never-registered")
	}()
	wg2.Wait()
}
