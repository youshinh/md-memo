package main

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"testing"
	"time"
)

// The Cancel button of the task panel (frontend: TaskManager.cancelTask -> SlotAgent.cancelSlotExecution) ends with the
// backend call CancelSlotAgent(reqId). These tests run a slot through the entry point the app uses (RunSlotAgentAsync)
// against a process tree that only ends when it is killed, cancel it through CancelSlotAgent, and pin what the backend then
// delivers to the page: exactly one result, status "canceled", the original text back. The page's own tests
// (tests/slot_cancel_restore_test.mjs) feed the page exactly those answers (tests/fixtures/slot_cancel_answers.json).

// cancelAgentConfigJSON is the slot config the frontend would send (JSON.stringify(slotConfig)) for a machine whose default
// agent is a long-running process tree: a shell that starts a second shell that sleeps, like a launcher script that starts
// the real CLI. append_instruction is off so the sleeping shell is not handed the instruction as a command.
func cancelAgentConfigJSON(t *testing.T, recipeSteps []string, selfRefine bool, approvalStep int) string {
	t.Helper()
	var command string
	var args []string
	if runtime.GOOS == "windows" {
		exe, err := exec.LookPath("powershell.exe")
		if err != nil {
			t.Skipf("powershell.exe not available: %v", err)
		}
		command = exe
		args = []string{"-NoProfile", "-NonInteractive", "-Command",
			"powershell -NoProfile -NonInteractive -Command Start-Sleep -Seconds 120"}
	} else {
		exe, err := exec.LookPath("sh")
		if err != nil {
			t.Skipf("sh not available: %v", err)
		}
		command = exe
		args = []string{"-c", "sh -c 'sleep 120'"}
	}
	cfg := map[string]any{
		"version":         2,
		"default_agent":   "tree",
		"timeout_seconds": 180,
		"agents": map[string]any{
			"tree": map[string]any{"command": command, "args": args, "append_instruction": false, "aliases": []string{"tree"}},
		},
		"slot_profiles": []map[string]any{
			{"trigger_open": "{{", "trigger_close": "}}", "name": "code", "agent": "tree"},
		},
		"recipes": []map[string]any{
			{
				"trigger_open": "[>>", "trigger_close": "]", "name": "cancel-recipe", "steps": recipeSteps,
				"requires_approval_step": approvalStep, "self_refine": selfRefine,
			},
		},
	}
	b, err := json.Marshal(cfg)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

// startAndCancel starts a run, waits until its agent process is really running, cancels it through the entry point the
// task panel uses (CancelSlotAgent, twice: the page's cancel and TaskManager.cancelTask each send one) and returns the one
// result the backend then delivers to the page, decoded and as the JSON text the page receives.
func startAndCancel(t *testing.T, doc string, cursorUTF16 int, cfgJSON string) capturedSlotResult {
	t.Helper()
	view := newSlotCapture()
	app := &App{w: view}
	app.InitSlotEngine()
	reqID := "slot-cancel-" + strings.ReplaceAll(t.Name(), "/", "-")
	notePath := filepath.Join(t.TempDir(), "note.md")
	// A test that fails before its own cancel must not leave a two minute sleeper behind
	t.Cleanup(func() { app.CancelSlotAgent(reqID) })
	app.RunSlotAgentAsync(reqID, notePath, doc, cursorUTF16, cfgJSON)

	// The hover peek exists as soon as Execute starts; give the shell a moment to really spawn its child.
	deadline := time.Now().Add(10 * time.Second)
	for app.GetSlotHoverPeek(reqID) == "" {
		if time.Now().After(deadline) {
			t.Fatal("the agent process never started")
		}
		time.Sleep(20 * time.Millisecond)
	}
	time.Sleep(700 * time.Millisecond)

	started := time.Now()
	app.CancelSlotAgent(reqID)
	app.CancelSlotAgent(reqID) // the second cancel of a double cancel: nothing left to stop, nothing to report
	got := view.wait(t)
	if elapsed := time.Since(started); elapsed > 20*time.Second {
		t.Errorf("the run took %v to report after Cancel", elapsed)
	}
	t.Logf("the page receives: %s", got.raw)
	if got.res.ReqID != reqID {
		t.Errorf("result is for %q, want %q", got.res.ReqID, reqID)
	}

	// Exactly one final callback per run: nothing else follows (a second answer would be merged into the note again)
	select {
	case extra := <-view.results:
		t.Errorf("a second result followed the cancel: %s", extra.raw)
	case <-time.After(400 * time.Millisecond):
	}
	if peek := app.GetSlotHoverPeek(reqID); peek != "" {
		t.Errorf("the hover peek of the canceled run is still there: %q", peek)
	}
	return got
}

// The maintainer's report: a recipe run with Ctrl+Enter, Cancel in the task panel, the process stops and the note keeps
// its running placeholder. A recipe with several steps (and the self-refining, approval-gated shape of the built-in one) must
// answer a cancel like a one-step recipe (the fixture test below): the pipeline must not go on to another step or report an
// error text instead.
func TestRunSlotAgentAsync_RecipeCancel_MultiStepPipelinesReportCanceledAndTheOriginalText(t *testing.T) {
	cfgs := []struct {
		name string
		cfg  string
	}{
		{"two steps", cancelAgentConfigJSON(t, []string{"first", "second"}, false, 0)},
		{"self refine and approval gate", cancelAgentConfigJSON(t, []string{"a", "b", "c"}, true, 2)},
	}
	doc := "日本語😀\n[>> instruction ]\n末尾"
	cursor := utf16IndexOf(doc, "instruction")
	for _, c := range cfgs {
		c := c
		t.Run(c.name, func(t *testing.T) {
			got := startAndCancel(t, doc, cursor, c.cfg)
			r := got.res
			if r.Type != "recipe" {
				t.Fatalf("type = %q, want recipe", r.Type)
			}
			if r.Status != "canceled" {
				t.Errorf("Status = %q, want canceled", r.Status)
			}
			if r.OldContent != "[>> instruction ]" || r.NewContent != r.OldContent {
				t.Errorf("a canceled recipe must hand back the original text: old=%q new=%q", r.OldContent, r.NewContent)
			}
			if s := utf16Slice(doc, r.StartOffset, r.EndOffset); s != "[>> instruction ]" {
				t.Errorf("offsets %d..%d hold %q", r.StartOffset, r.EndOffset, s)
			}
		})
	}
}

// The answers the page's tests replay are the ones the backend really gives, for a recipe, a classic {{ }} slot and a
// {{ @agent }} task (the last two take the other branch of RunSlotAgentAsync: one process, no pipeline). Every field is pinned,
// so this also says that the state is "canceled", that the original text comes back (newContent == oldContent) and where the
// answer goes (replace / below). When it fails the backend's answer changed: update tests/fixtures/slot_cancel_answers.json
// (the page's cancel tests then run against the new answer).
func TestRunSlotAgentAsync_CancelAnswersMatchTheRecordedFixture(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("tests", "fixtures", "slot_cancel_answers.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fixture map[string]json.RawMessage
	if err := json.Unmarshal(raw, &fixture); err != nil {
		t.Fatal(err)
	}
	type entry struct {
		Note         string         `json:"note"`
		CursorMarker string         `json:"cursorMarker"`
		Answer       map[string]any `json:"answer"`
	}
	cfg := cancelAgentConfigJSON(t, []string{"do it"}, false, 0)
	for _, name := range []string{"recipe", "classic", "agentTask"} {
		name := name
		t.Run(name, func(t *testing.T) {
			var want entry
			if err := json.Unmarshal(fixture[name], &want); err != nil {
				t.Fatalf("fixture %q: %v", name, err)
			}
			got := startAndCancel(t, want.Note, utf16IndexOf(want.Note, want.CursorMarker), cfg)
			var have map[string]any
			if err := json.Unmarshal([]byte(got.raw), &have); err != nil {
				t.Fatal(err)
			}
			have["reqId"] = "REQ"
			if !reflect.DeepEqual(have, want.Answer) {
				t.Errorf("the backend's answer to a cancel changed\n have: %v\n want: %v\nupdate tests/fixtures/slot_cancel_answers.json", have, want.Answer)
			}
		})
	}
}
