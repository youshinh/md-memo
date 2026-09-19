package main

import (
	"context"
	"strings"
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
