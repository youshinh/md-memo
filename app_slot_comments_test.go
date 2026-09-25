package main

import (
	"strings"
	"testing"

	"md-memo/pkg/slotagent"
)

// A note where the caret can sit inside a comment while live slots exist before and after it: the old
// "nearest slot after the caret, else the first slot" fallback must never pick one of them.
const commentDoc = "日本語😀\n{{ code: before }}\n<!-- {{ @claude 隠した依頼 }} -->\n{{ code: after }}\n"

func TestParseSlotsRPC_CaretInsideCommentTargetsNothing(t *testing.T) {
	app := &App{}
	cursor := utf16IndexOf(commentDoc, "隠した") // UTF-16, after Japanese text and an emoji
	resp, err := app.ParseSlotsRPC(commentDoc, cursor, "")
	if err != nil {
		t.Fatal(err)
	}
	if resp.TargetSlot != nil {
		t.Fatalf("caret in a comment must target nothing, got %+v", resp.TargetSlot)
	}
	if !resp.CaretInComment {
		t.Errorf("caretInComment must be reported")
	}
	if len(resp.AllSlots) != 2 {
		t.Errorf("the commented slot is not a slot: %+v", resp.AllSlots)
	}
	for _, s := range resp.AllSlots {
		if s.IsTarget {
			t.Errorf("no slot may be the target: %+v", s)
		}
	}

	// The same note, caret on the live slot after the comment: that one, as before.
	resp, _ = app.ParseSlotsRPC(commentDoc, utf16IndexOf(commentDoc, "after"), "")
	if resp.TargetSlot == nil || resp.TargetSlot.Instruction != "after" || resp.CaretInComment {
		t.Errorf("caret on a live slot = %+v", resp.TargetSlot)
	}
	// Right after "-->" is outside the comment: the old fallback (the next slot) still applies there.
	resp, _ = app.ParseSlotsRPC(commentDoc, utf16IndexOf(commentDoc, " -->")+4, "")
	if resp.CaretInComment || resp.TargetSlot == nil || resp.TargetSlot.Instruction != "after" {
		t.Errorf("caret right after --> = %+v (inComment=%v)", resp.TargetSlot, resp.CaretInComment)
	}
}

func TestParseSlotsRPC_CaretInCommentInsideASlot(t *testing.T) {
	doc := "{{ code: run this <!-- but not with the caret here --> }}"
	resp, _ := (&App{}).ParseSlotsRPC(doc, strings.Index(doc, "caret"), "")
	if resp.TargetSlot != nil || !resp.CaretInComment {
		t.Errorf("caret inside a comment inside a slot: target=%+v inComment=%v", resp.TargetSlot, resp.CaretInComment)
	}
	resp, _ = (&App{}).ParseSlotsRPC(doc, strings.Index(doc, "run"), "")
	if resp.TargetSlot == nil {
		t.Errorf("the slot itself (holding a comment) stays runnable from outside the comment")
	}
}

func TestParseSlotsRPC_CaretInCommentHasNoWaitingGate(t *testing.T) {
	doc := "- [ ] 待ち // approve\n<!-- メモ -->\n"
	resp, _ := (&App{}).ParseSlotsRPC(doc, utf16IndexOf(doc, "メモ"), "")
	if resp.HasWaitingApproval {
		t.Errorf("a caret in a comment must not offer to resume a gate")
	}
	resp, _ = (&App{}).ParseSlotsRPC(doc, 0, "")
	if !resp.HasWaitingApproval {
		t.Errorf("outside the comment the gate still waits")
	}
	commented := "<!--\n- [ ] 待ち // approve\n-->\n"
	resp, _ = (&App{}).ParseSlotsRPC(commented, 0, "")
	if resp.HasWaitingApproval {
		t.Errorf("a commented-out gate does not wait")
	}
}

func TestRunSlotAgentAsync_CaretInsideCommentRunsNothing(t *testing.T) {
	calls := stubSlotExecute(t, &slotagent.AgentExecutionResult{Output: "must not run"})
	got, _ := runSlot(t, commentDoc, utf16IndexOf(commentDoc, "隠した"), "")
	r := got.res
	if r.Status != "completed" || r.StartOffset != 0 || r.EndOffset != 0 || r.NewContent != "" || r.OutputMode != slotagent.OutputModeReplace {
		t.Errorf("caret in a comment must give the no-op result, got %+v", r)
	}
	if len(calls()) != 0 {
		t.Errorf("nothing may run, got %+v", calls())
	}
}

func TestRunSlotAgentAsync_CommentedGateDoesNotResume(t *testing.T) {
	cfg := `{"version":2,"recipes":[{"trigger_open":"[>>","trigger_close":"]","name":"noop","steps":[]}]}`
	doc := "メモ\n<!--\n- [x] 次へ進む // approve\n-->\n"
	got, _ := runSlot(t, doc, 0, cfg)
	r := got.res
	if r.Type == "recipe" || r.StartOffset != 0 || r.EndOffset != 0 {
		t.Errorf("a commented-out approved gate must not resume the recipe, got %+v", r)
	}
}
