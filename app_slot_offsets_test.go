package main

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
	"unicode/utf16"
	"unicode/utf8"

	"md-memo/pkg/slotagent"
)

// utf16Slice is text[start:end] the way JS substring sees it (UTF-16 code units), built
// independently of the helpers under test.
func utf16Slice(text string, start, end int) string {
	u := utf16.Encode([]rune(text))
	return string(utf16.Decode(u[start:end]))
}

// utf16IndexOf is the UTF-16 index of the first occurrence of sub in text.
func utf16IndexOf(text, sub string) int {
	i := strings.Index(text, sub)
	if i < 0 {
		return -1
	}
	return len(utf16.Encode([]rune(text[:i])))
}

func TestUTF16ByteConversion_AgreesWithRuneCounting(t *testing.T) {
	texts := []string{"", "abc", "あいう{{ x }}", "a😀b", "行1\r\n行2😀\r\n{{ z }}", "混在a😀あ𠮷z"}
	for _, s := range texts {
		for b := 0; b <= len(s); b++ {
			if b < len(s) && !isRuneStart(s[b]) {
				continue
			}
			want := len(utf16.Encode([]rune(s[:b])))
			if got := byteToUTF16(s, b); got != want {
				t.Errorf("byteToUTF16(%q, %d) = %d, want %d", s, b, got, want)
			}
			if got := utf16ToByte(s, want); got != b {
				t.Errorf("utf16ToByte(%q, %d) = %d, want %d", s, want, got, b)
			}
		}
	}
}

func isRuneStart(b byte) bool { return b&0xC0 != 0x80 }

func TestUTF16ByteConversion_ClampsAndRoundsDown(t *testing.T) {
	s := "a😀b" // bytes: a=0 emoji=1..4 b=5; UTF-16: a=0 emoji=1..2 b=3
	toByte := []struct{ in, want int }{{-3, 0}, {0, 0}, {1, 1}, {2, 1}, {3, 5}, {4, 6}, {99, 6}}
	for _, c := range toByte {
		if got := utf16ToByte(s, c.in); got != c.want {
			t.Errorf("utf16ToByte(%q, %d) = %d, want %d", s, c.in, got, c.want)
		}
	}
	toU16 := []struct{ in, want int }{{-1, 0}, {0, 0}, {1, 1}, {2, 1}, {3, 1}, {4, 1}, {5, 3}, {6, 4}, {99, 4}}
	for _, c := range toU16 {
		if got := byteToUTF16(s, c.in); got != c.want {
			t.Errorf("byteToUTF16(%q, %d) = %d, want %d", s, c.in, got, c.want)
		}
	}
	if utf16ToByte("", 5) != 0 || byteToUTF16("", 5) != 0 {
		t.Errorf("empty string must clamp to 0")
	}
	// An invalid byte counts as one unit, like the replacement character JS would hold.
	if got := byteToUTF16("a\xffb", 3); got != 3 {
		t.Errorf("byteToUTF16 over an invalid byte = %d, want 3", got)
	}
}

// refUTF16 is the obvious rune-walking reference: UTF-16 units of every rune that fits
// entirely below byte offset off.
func refUTF16(s string, off int) int {
	if off <= 0 {
		return 0
	}
	n := 0
	for i, r := range s {
		if i+utf8.RuneLen(r) > off {
			break
		}
		n += len(utf16.Encode([]rune{r}))
	}
	return n
}

func TestUTF16Cursor_OrderIndependent(t *testing.T) {
	s := "行1\r\n😀行2😀\r\n{{ z }}日本語"
	c := newUTF16Cursor(s)
	// Ascending, descending, repeated, mid-rune and out-of-range queries on ONE cursor.
	offsets := []int{0, 7, 3, len(s), 12, 1, 20, 2, 999, -4, 5, 5, 6}
	for _, off := range offsets {
		if got, want := c.toUTF16(off), refUTF16(s, off); got != want {
			t.Errorf("cursor.toUTF16(%d) = %d, reference says %d", off, got, want)
		}
		if got, want := byteToUTF16(s, off), refUTF16(s, off); got != want {
			t.Errorf("byteToUTF16(%q, %d) = %d, reference says %d", s, off, got, want)
		}
	}
	ascii := newUTF16Cursor("plain ascii")
	if ascii.toUTF16(5) != 5 || ascii.toUTF16(500) != 11 {
		t.Errorf("ASCII fast path wrong")
	}
}

// jpDoc has Japanese text, emoji (surrogate pairs) and CRLF line ends before both slots, so
// any byte-vs-UTF-16 mix-up moves them.
const jpDoc = "日本語のメモです。😀\r\n二行目 🎉🎉\r\n\r\n{{ code: A }}\r\n中間のテキスト\r\n{{ @claude 調べて }}\r\n末尾"

func TestParseSlotsRPC_ReturnsUTF16Offsets(t *testing.T) {
	app := &App{}
	resp, err := app.ParseSlotsRPC(jpDoc, 0, "")
	if err != nil {
		t.Fatalf("ParseSlotsRPC failed: %v", err)
	}
	if len(resp.AllSlots) != 2 {
		t.Fatalf("expected 2 slots, got %d", len(resp.AllSlots))
	}
	for i, want := range []string{"{{ code: A }}", "{{ @claude 調べて }}"} {
		m := resp.AllSlots[i]
		if got := utf16Slice(jpDoc, m.StartOffset, m.EndOffset); got != want {
			t.Errorf("slot %d UTF-16 range holds %q, want %q (offsets %d..%d)", i, got, want, m.StartOffset, m.EndOffset)
		}
	}
}

func TestParseSlotsRPC_CursorIsUTF16(t *testing.T) {
	doc := strings.Repeat("日本語", 4) + "\n{{ a }}\n" + strings.Repeat("日本語😀", 4) + "\n{{ b }}\n"
	app := &App{}

	inB := utf16IndexOf(doc, "{{ b }}") + 3
	resp, err := app.ParseSlotsRPC(doc, inB, "")
	if err != nil {
		t.Fatalf("ParseSlotsRPC failed: %v", err)
	}
	if resp.TargetSlot == nil || resp.TargetSlot.Instruction != "b" {
		t.Fatalf("cursor inside slot b must target b, got %+v", resp.TargetSlot)
	}
	if !resp.AllSlots[1].IsTarget || resp.AllSlots[0].IsTarget {
		t.Errorf("IsTarget flags wrong: %+v", resp.AllSlots)
	}

	inA := utf16IndexOf(doc, "{{ a }}") + 3
	resp, _ = app.ParseSlotsRPC(doc, inA, "")
	if resp.TargetSlot == nil || resp.TargetSlot.Instruction != "a" {
		t.Errorf("cursor inside slot a must target a, got %+v", resp.TargetSlot)
	}

	// Between the slots: the next slot after the caret, as before.
	between := utf16IndexOf(doc, "{{ a }}") + len("{{ a }}") + 3
	resp, _ = app.ParseSlotsRPC(doc, between, "")
	if resp.TargetSlot == nil || resp.TargetSlot.Instruction != "b" {
		t.Errorf("cursor between slots must fall forward to b, got %+v", resp.TargetSlot)
	}

	// Past the end (or out of range): first slot, as before.
	resp, _ = app.ParseSlotsRPC(doc, 100000, "")
	if resp.TargetSlot == nil || resp.TargetSlot.Instruction != "a" {
		t.Errorf("cursor past the end must fall back to the first slot, got %+v", resp.TargetSlot)
	}
	resp, _ = app.ParseSlotsRPC(doc, -5, "")
	if resp.TargetSlot == nil || resp.TargetSlot.Instruction != "a" {
		t.Errorf("negative cursor must fall forward to the first slot, got %+v", resp.TargetSlot)
	}
}

func TestParseSlotsRPC_ASCIIOffsetsAreUnchanged(t *testing.T) {
	doc := "# Note\n\n- Summary: {{ code: fmt.Println(\"hello\") }}\n\n[? research quantum ]\n"
	want := slotagent.ParseSlots(doc, slotagent.DefaultSlotConfig())
	resp, err := (&App{}).ParseSlotsRPC(doc, 20, "")
	if err != nil || len(resp.AllSlots) != len(want) || len(want) != 2 {
		t.Fatalf("err=%v slots=%d want=%d", err, len(resp.AllSlots), len(want))
	}
	for i, w := range want {
		if got := resp.AllSlots[i]; got.StartOffset != w.StartOffset || got.EndOffset != w.EndOffset {
			t.Errorf("slot %d offsets = %d..%d, byte offsets are %d..%d (identical for ASCII)", i, got.StartOffset, got.EndOffset, w.StartOffset, w.EndOffset)
		}
	}
}

func TestParseSlotsRPC_AgentMentionFields(t *testing.T) {
	app := &App{}
	resp, err := app.ParseSlotsRPC(jpDoc, utf16IndexOf(jpDoc, "@claude"), "")
	if err != nil {
		t.Fatalf("ParseSlotsRPC failed: %v", err)
	}
	if resp.TargetSlot == nil {
		t.Fatal("no target slot")
	}
	m := *resp.TargetSlot
	if m.AgentName != "claude-code" || m.SkillName != "" || m.OutputMode != slotagent.OutputModeBelow || m.Instruction != "調べて" {
		t.Errorf("agent mention slot = %+v", m)
	}
	legacy := resp.AllSlots[0]
	if legacy.OutputMode != slotagent.OutputModeReplace || legacy.AgentName != "" {
		t.Errorf("legacy slot = %+v", legacy)
	}

	b, _ := json.Marshal(m)
	var keys map[string]any
	_ = json.Unmarshal(b, &keys)
	for _, k := range []string{"agentName", "outputMode", "startOffset", "endOffset"} {
		if _, ok := keys[k]; !ok {
			t.Errorf("SlotParseMatch JSON lacks %q: %s", k, b)
		}
	}
	// A skill mention is untouched: skillName set, no agent, replace mode.
	resp, _ = app.ParseSlotsRPC("{{ @code-review app.go }}", 3, "")
	if s := resp.TargetSlot; s == nil || s.SkillName != "code-review" || s.AgentName != "" || s.OutputMode != slotagent.OutputModeReplace {
		t.Errorf("skill mention slot = %+v", resp.TargetSlot)
	}
}

// slotCapture is a WebViewInstance that decodes every slot-agent result the App dispatches.
type slotCapture struct {
	results chan capturedSlotResult
}

type capturedSlotResult struct {
	res SlotExecutionResult
	raw string
}

func newSlotCapture() *slotCapture { return &slotCapture{results: make(chan capturedSlotResult, 8)} }

func (c *slotCapture) Dispatch(f func()) { f() }

func (c *slotCapture) Eval(js string) {
	const prefix = "if (window.__onSlotAgentResult) { window.__onSlotAgentResult("
	const suffix = "); }"
	if !strings.HasPrefix(js, prefix) || !strings.HasSuffix(js, suffix) {
		return
	}
	raw := js[len(prefix) : len(js)-len(suffix)]
	var r SlotExecutionResult
	if err := json.Unmarshal([]byte(raw), &r); err != nil {
		return
	}
	c.results <- capturedSlotResult{res: r, raw: raw}
}

func (c *slotCapture) wait(t *testing.T) capturedSlotResult {
	t.Helper()
	select {
	case r := <-c.results:
		return r
	case <-time.After(15 * time.Second):
		t.Fatal("no slot result was dispatched")
		return capturedSlotResult{}
	}
}

type execCall struct {
	agent       slotagent.AgentDef
	file        string
	instruction string
	sys         string
}

// stubSlotExecute replaces the agent process with a canned result and records what it was asked to run.
func stubSlotExecute(t *testing.T, result *slotagent.AgentExecutionResult) func() []execCall {
	t.Helper()
	var mu sync.Mutex
	var calls []execCall
	orig := slotExecute
	slotExecute = func(_ context.Context, _ *slotagent.Runner, _ string, def slotagent.AgentDef, file, instruction, sys string) *slotagent.AgentExecutionResult {
		mu.Lock()
		calls = append(calls, execCall{agent: def, file: file, instruction: instruction, sys: sys})
		mu.Unlock()
		res := *result
		return &res
	}
	t.Cleanup(func() { slotExecute = orig })
	return func() []execCall {
		mu.Lock()
		defer mu.Unlock()
		return append([]execCall(nil), calls...)
	}
}

func runSlot(t *testing.T, doc string, cursorUTF16 int, configJSON string) (capturedSlotResult, string) {
	t.Helper()
	view := newSlotCapture()
	app := &App{w: view}
	notePath := filepath.Join(t.TempDir(), "note.md")
	app.RunSlotAgentAsync("req-"+t.Name(), notePath, doc, cursorUTF16, configJSON)
	return view.wait(t), notePath
}

func TestRunSlotAgentAsync_ReplaceMode_UTF16OffsetsRawOutputAndLegacyText(t *testing.T) {
	calls := stubSlotExecute(t, &slotagent.AgentExecutionResult{Output: "done", RawOutput: "  done  \r\n"})
	cursor := utf16IndexOf(jpDoc, "{{ code: A }}") + 4

	got, _ := runSlot(t, jpDoc, cursor, "")
	r := got.res
	if r.Status != "completed" || r.Type != "slot" {
		t.Fatalf("status/type = %q/%q", r.Status, r.Type)
	}
	if s := utf16Slice(jpDoc, r.StartOffset, r.EndOffset); s != "{{ code: A }}" {
		t.Errorf("offsets %d..%d hold %q, want the legacy slot", r.StartOffset, r.EndOffset, s)
	}
	if r.OldContent != "{{ code: A }}" {
		t.Errorf("OldContent = %q", r.OldContent)
	}
	if r.NewContent != "done" {
		t.Errorf("legacy NewContent must stay the trimmed output, got %q", r.NewContent)
	}
	if r.Output != "  done  \r\n" {
		t.Errorf("Output must be the raw stdout, got %q", r.Output)
	}
	if r.OutputMode != slotagent.OutputModeReplace {
		t.Errorf("OutputMode = %q", r.OutputMode)
	}
	for _, k := range []string{`"output":`, `"outputMode":"replace"`, `"newContent":"done"`} {
		if !strings.Contains(got.raw, k) {
			t.Errorf("result JSON lacks %s: %s", k, got.raw)
		}
	}

	c := calls()
	if len(c) != 1 {
		t.Fatalf("expected 1 agent run, got %d", len(c))
	}
	prof := slotagent.DefaultSlotConfig().SlotProfiles[0]
	if c[0].instruction != "A" || c[0].sys != prof.SystemInstruction || c[0].agent.Command != "claude" {
		t.Errorf("legacy run changed: %+v", c[0])
	}
}

func TestRunSlotAgentAsync_CursorIsUTF16(t *testing.T) {
	calls := stubSlotExecute(t, &slotagent.AgentExecutionResult{Output: "ok", RawOutput: "ok\n"})
	doc := strings.Repeat("日本語😀", 5) + "\n{{ a }}\n" + strings.Repeat("日本語😀", 5) + "\n{{ b }}\n"
	cursor := utf16IndexOf(doc, "{{ b }}") + 3

	got, _ := runSlot(t, doc, cursor, "")
	c := calls()
	if len(c) != 1 || c[0].instruction != "b" {
		t.Fatalf("cursor in slot b must run b, ran %+v", c)
	}
	if s := utf16Slice(doc, got.res.StartOffset, got.res.EndOffset); s != "{{ b }}" {
		t.Errorf("result range holds %q", s)
	}
}

func TestRunSlotAgentAsync_AgentMention_BelowMode(t *testing.T) {
	calls := stubSlotExecute(t, &slotagent.AgentExecutionResult{Output: "結果", RawOutput: "  結果\n\n"})
	doc := "日本語😀\r\n{{ @cc 調べて }}\r\n<!-- md-memo:run ab12 -->\r\n続き"
	cursor := utf16IndexOf(doc, "@cc") + 1

	got, notePath := runSlot(t, doc, cursor, "")
	r := got.res
	if r.Status != "completed" || r.OutputMode != slotagent.OutputModeBelow {
		t.Fatalf("status=%q mode=%q", r.Status, r.OutputMode)
	}
	if s := utf16Slice(doc, r.StartOffset, r.EndOffset); s != "{{ @cc 調べて }}" {
		t.Errorf("task range holds %q", s)
	}
	if r.NewContent != r.OldContent || r.OldContent != "{{ @cc 調べて }}" {
		t.Errorf("Go must replace nothing: NewContent=%q OldContent=%q", r.NewContent, r.OldContent)
	}
	if r.Output != "  結果\n\n" {
		t.Errorf("Output = %q, want the raw stdout", r.Output)
	}

	c := calls()
	if len(c) != 1 {
		t.Fatalf("expected 1 agent run, got %d", len(c))
	}
	if c[0].agent.Command != "claude" || c[0].instruction != "調べて" {
		t.Errorf("run = %+v", c[0])
	}
	if c[0].sys != "" {
		t.Errorf("an explicit @agent must not inherit the {{ }} profile's code-only instruction, got %q", c[0].sys)
	}
	onDisk, err := os.ReadFile(notePath)
	if err != nil || string(onDisk) != doc {
		t.Errorf("the note text (task line + run marker) must reach the agent unchanged: err=%v, %q", err, onDisk)
	}
}

func TestRunSlotAgentAsync_AgentMention_FailureKeepsTaskLine(t *testing.T) {
	stubSlotExecute(t, &slotagent.AgentExecutionResult{Output: "part", RawOutput: "part\n", ExitCode: 3, ErrorMsg: "boom"})
	doc := "{{ @claude 失敗する }}\n<!-- md-memo:run ab12 -->\n"

	got, _ := runSlot(t, doc, 4, "")
	r := got.res
	if r.Status != "failed" || r.ExitCode != 3 || r.ErrorMsg != "boom" {
		t.Errorf("failure result = %+v", r)
	}
	if r.OutputMode != slotagent.OutputModeBelow || r.NewContent != r.OldContent {
		t.Errorf("below mode must not format an error slot: mode=%q new=%q old=%q", r.OutputMode, r.NewContent, r.OldContent)
	}
	if r.Output != "part\n" {
		t.Errorf("partial output must still be reported raw, got %q", r.Output)
	}
}

func TestRunSlotAgentAsync_AgentMention_EmptyInstructionIsRefused(t *testing.T) {
	calls := stubSlotExecute(t, &slotagent.AgentExecutionResult{Output: "should not run"})
	doc := "日本語😀\n{{ @claude }}\n"

	got, _ := runSlot(t, doc, utf16IndexOf(doc, "@claude"), "")
	r := got.res
	if r.Status != "failed" || r.ExitCode == 0 || r.ErrorMsg == "" {
		t.Errorf("an agent mention without an instruction must fail visibly, got %+v", r)
	}
	if r.OutputMode != slotagent.OutputModeBelow || r.NewContent != r.OldContent || r.OldContent != "{{ @claude }}" {
		t.Errorf("the task line must stay as it is: mode=%q old=%q new=%q", r.OutputMode, r.OldContent, r.NewContent)
	}
	if s := utf16Slice(doc, r.StartOffset, r.EndOffset); s != "{{ @claude }}" {
		t.Errorf("range holds %q", s)
	}
	if n := len(calls()); n != 0 {
		t.Errorf("no agent may be started with an empty prompt, got %d run(s)", n)
	}

	// An agent that never reads {instruction} (codex works from the note file) may run bare.
	stubSlotExecute(t, &slotagent.AgentExecutionResult{Output: "ran", RawOutput: "ran\n"})
	got, _ = runSlot(t, "{{ @codex }}", 4, "")
	if got.res.Status != "completed" || got.res.Output != "ran\n" {
		t.Errorf("a file-based agent must still run without an instruction, got %+v", got.res)
	}
}

func TestRunSlotAgentAsync_AgentMention_UnknownCommandIsAnErrorNotAFallback(t *testing.T) {
	calls := stubSlotExecute(t, &slotagent.AgentExecutionResult{ExitCode: 1, ErrorMsg: "agent command is not configured"})
	cfg := `{"version":2,"default_agent":"other","agents":{"other":{"command":"other-cli"},"blank":{"command":"","aliases":["bl"]}}}`

	got, _ := runSlot(t, "{{ @bl x }}", 4, cfg)
	c := calls()
	if len(c) != 1 || c[0].agent.Command != "" {
		t.Fatalf("a named agent without a command must not silently run the default agent, ran %+v", c)
	}
	if got.res.Status != "failed" {
		t.Errorf("status = %q", got.res.Status)
	}
}

func TestRunSlotAgentAsync_LegacyFailureAndInlineFormatUnchanged(t *testing.T) {
	stubSlotExecute(t, &slotagent.AgentExecutionResult{ExitCode: 2, ErrorMsg: "boom"})
	got, _ := runSlot(t, "日本語😀\n{{ code: x }}\n", 12, "")
	r := got.res
	if want := "{{ ⚠ エラー: boom (再試行: Ctrl+Enter) }}"; r.NewContent != want {
		t.Errorf("legacy error text = %q, want %q", r.NewContent, want)
	}
	if r.Status != "failed" || r.OutputMode != slotagent.OutputModeReplace {
		t.Errorf("status=%q mode=%q", r.Status, r.OutputMode)
	}

	stubSlotExecute(t, &slotagent.AgentExecutionResult{Output: "line1\nline2", RawOutput: "line1\nline2\n"})
	got, _ = runSlot(t, "- メモ {{ code: x }} 後", 8, "")
	r = got.res
	if r.NewContent != "line1 line2" {
		t.Errorf("inline expansion must flatten newlines as before, got %q", r.NewContent)
	}
	if r.Output != "line1\nline2\n" {
		t.Errorf("Output stays raw for inline slots, got %q", r.Output)
	}
}

// A CLI agent that exits 0 having written nothing (a tool call auto-denied in headless mode,
// with the reason on stderr - exactly what a real `agy -p` run did) must be reported as a
// failure, not merged as a silent, invisible no-op that leaves "実行中..." on the page forever.
func TestRunSlotAgentAsync_ExitZeroWithNoOutputIsStillAFailure(t *testing.T) {
	stubSlotExecute(t, &slotagent.AgentExecutionResult{
		ExitCode: 0,
		ErrorMsg: "⚠ エラー: no output produced — a tool required the \"command\" permission",
	})
	got, _ := runSlot(t, "日本語😀\n{{ code: x }}\n", 12, "")
	r := got.res
	if r.Status != "failed" {
		t.Errorf("Status = %q, want \"failed\" even though ExitCode is 0", r.Status)
	}
	if !strings.Contains(r.NewContent, "no output produced") {
		t.Errorf("the placeholder must be replaced with the agent's own explanation, got %q", r.NewContent)
	}
	if r.NewContent == r.OldContent {
		t.Error("the placeholder must not be left in place")
	}
}

func TestRunSlotAgentAsync_SkillMentionStillReplacesAndComposesInstruction(t *testing.T) {
	calls := stubSlotExecute(t, &slotagent.AgentExecutionResult{Output: "ok", RawOutput: "ok"})

	// Missing skill: the legacy error text, no agent run.
	got, _ := runSlot(t, "{{ @no-such-skill x }}", 4, "")
	r := got.res
	if want := "{{ ⚠ スキル 'no-such-skill' が見つかりません (skills/no-such-skill/SKILL.md) }}"; r.NewContent != want {
		t.Errorf("missing-skill text = %q, want %q", r.NewContent, want)
	}
	if r.Status != "failed" || r.OutputMode != slotagent.OutputModeReplace {
		t.Errorf("status=%q mode=%q", r.Status, r.OutputMode)
	}
	if n := len(calls()); n != 0 {
		t.Errorf("no agent may run for a missing skill, got %d run(s)", n)
	}

	// Present skill: profile instruction + skill body, replace mode.
	view := newSlotCapture()
	app := &App{w: view}
	root := t.TempDir()
	skillDir := filepath.Join(root, "skills", "my-skill")
	if err := os.MkdirAll(skillDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(skillDir, "SKILL.md"), []byte("SKILL BODY"), 0o644); err != nil {
		t.Fatal(err)
	}
	app.RunSlotAgentAsync("req-skill", filepath.Join(root, "note.md"), "{{ @my-skill do it }}", 4, "")
	r = view.wait(t).res
	if r.OutputMode != slotagent.OutputModeReplace || r.NewContent != "ok" {
		t.Errorf("skill run result = %+v", r)
	}
	c := calls()
	if len(c) != 1 {
		t.Fatalf("expected 1 agent run, got %d", len(c))
	}
	prof := slotagent.DefaultSlotConfig().SlotProfiles[0]
	if want := prof.SystemInstruction + "\n\n" + "SKILL BODY"; c[0].sys != want || c[0].instruction != "do it" {
		t.Errorf("skill run = %+v, want sys %q", c[0], want)
	}
}

func TestRunSlotAgentAsync_RecipeAndGateOffsetsAreUTF16(t *testing.T) {
	// A recipe with no steps completes without touching any process.
	cfg := `{"version":2,"recipes":[{"trigger_open":"[>>","trigger_close":"]","name":"noop","steps":[]}]}`

	doc := "日本語😀\r\n[>> やって ]\r\n末尾"
	got, _ := runSlot(t, doc, utf16IndexOf(doc, "やって"), cfg)
	r := got.res
	if r.Type != "recipe" || r.OutputMode != slotagent.OutputModeReplace {
		t.Fatalf("type=%q mode=%q", r.Type, r.OutputMode)
	}
	if s := utf16Slice(doc, r.StartOffset, r.EndOffset); s != "[>> やって ]" {
		t.Errorf("recipe range holds %q", s)
	}
	if r.OldContent != "[>> やって ]" {
		t.Errorf("recipe OldContent = %q", r.OldContent)
	}

	gateDoc := "日本語😀🎉\n- [x] 次へ進む // approve\n末尾"
	got, _ = runSlot(t, gateDoc, 0, cfg)
	r = got.res
	if s := utf16Slice(gateDoc, r.StartOffset, r.EndOffset); s != "- [x] 次へ進む // approve" {
		t.Errorf("approval gate range holds %q (offsets %d..%d)", s, r.StartOffset, r.EndOffset)
	}
}

func TestRunSlotAgentAsync_NoActionableSlot(t *testing.T) {
	calls := stubSlotExecute(t, &slotagent.AgentExecutionResult{})
	got, _ := runSlot(t, "ただのメモ😀\n", 3, "")
	r := got.res
	if r.Status != "completed" || r.StartOffset != 0 || r.EndOffset != 0 || r.NewContent != "" {
		t.Errorf("no-op result = %+v", r)
	}
	if !strings.Contains(got.raw, `"outputMode":"replace"`) {
		t.Errorf("no-op result should still carry the mode: %s", got.raw)
	}
	if len(calls()) != 0 {
		t.Errorf("nothing may run")
	}
}

func TestCheckAgentAvailability_ResolvesAliases(t *testing.T) {
	app := &App{}
	byKey := app.CheckAgentAvailability("claude-code")
	byAlias := app.CheckAgentAvailability("CC")
	if byKey.Command != "claude" || byAlias != byKey {
		t.Errorf("alias lookup = %+v, key lookup = %+v", byAlias, byKey)
	}
	if got := app.CheckAgentAvailability("no-such-agent"); got != (AgentAvailability{}) {
		t.Errorf("unknown agent = %+v, want the zero value", got)
	}
	if got := app.CheckAgentAvailability("  "); got != (AgentAvailability{}) {
		t.Errorf("blank agent = %+v, want the zero value", got)
	}
}

func writeGlobalAgentsYAML(t *testing.T, yaml string) {
	t.Helper()
	path := slotagent.GetDefaultAgentConfigPath()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(yaml), 0o644); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Remove(path) })
}

const agentsWithSnippetsYAML = `version: 2
default_agent: claude-code
agents:
  claude-code:
    command: "claude"
    args: ["--prompt", "{instruction}"]
    aliases: [claude, "クロード"]
snippets:
  - id: weekly
    label: "今週の振り返り"
    kind: llm
    trigger: "/weekly"
    body: "3点に要約: ${selection}"
  - id: disk
    label: "Disk free"
    kind: command
    os: win
    body: "Get-PSDrive"
`

type aliasProbe struct {
	Aliases []string `json:"aliases"`
}

func TestGetActiveSlotConfigJSON_CarriesAliasesAndSnippets(t *testing.T) {
	app := &App{}

	// Nothing configured: defaults, and snippets is an empty array (never null/absent).
	var empty struct {
		Agents   map[string]aliasProbe `json:"agents"`
		Snippets *[]map[string]any     `json:"snippets"`
	}
	if err := json.Unmarshal([]byte(app.GetActiveSlotConfigJSON()), &empty); err != nil {
		t.Fatalf("default config JSON: %v", err)
	}
	if empty.Snippets == nil || len(*empty.Snippets) != 0 {
		t.Errorf("default config must carry an empty snippets array, got %v", empty.Snippets)
	}
	if got := empty.Agents["claude-code"].Aliases; len(got) != 2 || got[0] != "claude" || got[1] != "cc" {
		t.Errorf("default claude-code aliases = %v", got)
	}

	writeGlobalAgentsYAML(t, agentsWithSnippetsYAML)
	app = &App{}
	var cfg struct {
		Agents   map[string]aliasProbe `json:"agents"`
		Snippets []map[string]any      `json:"snippets"`
	}
	if err := json.Unmarshal([]byte(app.GetActiveSlotConfigJSON()), &cfg); err != nil {
		t.Fatalf("config JSON: %v", err)
	}
	if got := cfg.Agents["claude-code"].Aliases; len(got) != 2 || got[0] != "claude" || got[1] != "クロード" {
		t.Errorf("file aliases = %v", got)
	}
	if len(cfg.Snippets) != 2 {
		t.Fatalf("snippets = %v", cfg.Snippets)
	}
	s0 := cfg.Snippets[0]
	if s0["id"] != "weekly" || s0["label"] != "今週の振り返り" || s0["kind"] != "llm" || s0["trigger"] != "/weekly" || s0["body"] != "3点に要約: ${selection}" {
		t.Errorf("snippet 0 = %v", s0)
	}
	if s1 := cfg.Snippets[1]; s1["os"] != "win" || s1["kind"] != "command" {
		t.Errorf("snippet 1 = %v", s1)
	}

	// The frontend always sends its own copy of the config back as configJSON: the file's
	// snippets must survive that override merge too.
	over := app.resolveActiveSlotConfig(`{"default_agent":"claude-code","agents":{"claude-code":{"command":"x"}}}`)
	if len(over.Snippets) != 2 {
		t.Errorf("snippets lost through the override merge: %+v", over.Snippets)
	}
}

func TestResolveActiveSlotConfig_CacheKeepsAliasesAndSnippetsIsolated(t *testing.T) {
	writeGlobalAgentsYAML(t, agentsWithSnippetsYAML)
	app := &App{}

	first := app.resolveActiveSlotConfig("")
	second := app.resolveActiveSlotConfig("") // served from the cache
	if len(second.Snippets) != 2 || len(second.Agents["claude-code"].Aliases) != 2 {
		t.Fatalf("cached config lost snippets/aliases: %+v", second)
	}
	second.Snippets[0].Body = "MUTATED"
	second.Agents["claude-code"].Aliases[0] = "MUTATED"
	second.Snippets = append(second.Snippets, slotagent.SnippetDef{ID: "extra"})

	third := app.resolveActiveSlotConfig("")
	if third.Snippets[0].Body != "3点に要約: ${selection}" || len(third.Snippets) != 2 {
		t.Errorf("a caller mutated the cached snippets: %+v", third.Snippets)
	}
	if third.Agents["claude-code"].Aliases[0] != "claude" {
		t.Errorf("a caller mutated the cached aliases: %v", third.Agents["claude-code"].Aliases)
	}
	if first.Snippets[0].Body != "3点に要約: ${selection}" {
		t.Errorf("the first copy was corrupted: %+v", first.Snippets)
	}
}

func TestCloneSlotConfig_CopiesAliasesAndSnippets(t *testing.T) {
	original := slotagent.SlotConfig{
		Agents: map[string]slotagent.AgentDef{
			"alpha": {Command: "echo", Aliases: []string{"a1", "a2"}},
			"quiet": {Command: "echo", Aliases: []string{}},
			"plain": {Command: "echo"},
		},
		Snippets: []slotagent.SnippetDef{{ID: "s1", Body: "b1"}, {ID: "s2", Body: "b2"}},
	}
	clone := cloneSlotConfig(original)

	clone.Agents["alpha"].Aliases[0] = "MUTATED"
	clone.Snippets[0].Body = "MUTATED"
	if original.Agents["alpha"].Aliases[0] != "a1" {
		t.Errorf("Aliases share memory with the clone")
	}
	if original.Snippets[0].Body != "b1" {
		t.Errorf("Snippets share memory with the clone")
	}
	if clone.Agents["quiet"].Aliases == nil {
		t.Errorf("an explicitly empty alias list must stay non-nil (it means \"none\")")
	}
	if clone.Agents["plain"].Aliases != nil {
		t.Errorf("an absent alias list must stay nil")
	}
	if got := cloneSlotConfig(slotagent.SlotConfig{Snippets: []slotagent.SnippetDef{}}); got.Snippets == nil {
		t.Errorf("an empty (non-nil) snippets slice must stay non-nil")
	}
}

// slotBenchDoc is a ~40 KB Japanese note (emoji included) with a task line every 8 lines.
func slotBenchDoc() string {
	var sb strings.Builder
	for i := 0; i < 400; i++ {
		sb.WriteString("日本語のメモの一行です。😀 これはベンチマーク用の文章。\n")
		if i%8 == 0 {
			sb.WriteString("{{ @claude 調べて }}\n")
		}
	}
	return sb.String()
}

func BenchmarkParseSlotsOnly(b *testing.B) {
	doc := slotBenchDoc()
	cfg := slotagent.DefaultSlotConfig()
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		_ = slotagent.ParseSlots(doc, cfg)
	}
}

func BenchmarkParseSlotsRPC_JapaneseNote(b *testing.B) {
	doc := slotBenchDoc()
	app := &App{}
	cursor := utf16IndexOf(doc, "{{ @claude 調べて }}") + 3
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		if _, err := app.ParseSlotsRPC(doc, cursor, ""); err != nil {
			b.Fatal(err)
		}
	}
}

func BenchmarkUTF16ConvertAllSlotOffsets(b *testing.B) {
	doc := slotBenchDoc()
	slots := slotagent.ParseSlots(doc, slotagent.DefaultSlotConfig())
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		conv := newUTF16Cursor(doc)
		for _, s := range slots {
			_ = conv.toUTF16(s.StartOffset)
			_ = conv.toUTF16(s.EndOffset)
		}
		_ = utf16ToByte(doc, len(doc)/2)
	}
}
