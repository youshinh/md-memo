package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"md-memo/pkg/slotagent"
)

// The lessons of an agent go in front of its instruction in a single-slot run (docs/design/lessons-2026-10.md section 3). The agent
// process is never started here: slotExecute is stubbed (stubSlotExecute) and records the system instruction it was given.

const lessonsTestSlot = "{{ code: A }}"

// runSlotAt runs the slot at cursor with the note at notePath and returns the result the page gets.
func runSlotAt(t *testing.T, notePath, doc string, cursor int, configJSON string) capturedSlotResult {
	t.Helper()
	view := newSlotCapture()
	app := &App{w: view}
	app.RunSlotAgentAsync("req-"+t.Name(), notePath, doc, cursor, configJSON)
	return view.wait(t)
}

func TestSingleSlotRunIsToldTheLessonsOfItsAgentFirst(t *testing.T) {
	lessonSettings(t)
	keepLesson(t, "claude-code", "Do not include ADF.h: the build fails here.", "Use make -j1")
	calls := stubSlotExecute(t, &slotagent.AgentExecutionResult{Output: "done", RawOutput: "done\n"})
	block := slotagent.LessonsBlockHeading + "\n- Do not include ADF.h: the build fails here.\n- Use make -j1"
	profile := slotagent.DefaultSlotConfig().SlotProfiles[0].SystemInstruction

	// the {{ }} slot: the block, a blank line, then the profile's own instruction; the task comes after both (PrepareCommand)
	got := runSlotAt(t, filepath.Join(t.TempDir(), "note.md"), lessonsTestSlot, 4, "")
	c := calls()
	if len(c) != 1 || c[0].sys != block+"\n\n"+profile || c[0].instruction != "A" {
		t.Fatalf("run: %+v", c)
	}
	if got.res.LessonsApplied != 2 || got.res.LessonsSkipped != 0 || got.res.Status != "completed" {
		t.Errorf("result: %+v", got.res)
	}
	if !strings.Contains(got.raw, `"lessonsApplied":2`) || strings.Contains(got.raw, "lessonsSkipped") {
		t.Errorf("the page is told how many were applied (and nothing about the others when none were left out): %s", got.raw)
	}

	// an agent named outright: no profile instruction, so the block is all of it
	runSlotAt(t, filepath.Join(t.TempDir(), "note.md"), "{{ @cc 調べて }}", 4, "")
	if c = calls(); len(c) != 2 || c[1].sys != block || c[1].agent.Command != "claude" {
		t.Errorf("@cc: %+v", c)
	}
	// ... by its key or by another alias: the same file
	runSlotAt(t, filepath.Join(t.TempDir(), "note.md"), "{{ @Claude-Code 調べて }}", 4, "")
	if c = calls(); len(c) != 3 || c[2].sys != block {
		t.Errorf("@Claude-Code: %+v", c)
	}
	// the agent of another file is not told these
	runSlotAt(t, filepath.Join(t.TempDir(), "note.md"), "{{ @codex run it }}", 4, "")
	if c = calls(); len(c) != 4 || c[3].sys != "" || c[3].agent.Command != "codex" {
		t.Errorf("@codex: %+v", c[len(c)-1])
	}
}

func TestLessonsComeBeforeAProfileAndASkill(t *testing.T) {
	lessonSettings(t)
	keepLesson(t, "claude-code", "Keep it short")
	calls := stubSlotExecute(t, &slotagent.AgentExecutionResult{Output: "ok", RawOutput: "ok\n"})
	root := t.TempDir()
	skill := filepath.Join(root, "skills", "myskill", "SKILL.md")
	if err := os.MkdirAll(filepath.Dir(skill), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(skill, []byte("---\nname: myskill\n---\nSkill text for the agent."), 0o644); err != nil {
		t.Fatal(err)
	}
	profile := slotagent.DefaultSlotConfig().SlotProfiles[0].SystemInstruction

	runSlotAt(t, filepath.Join(root, "note.md"), "{{ @myskill do it }}", 4, "")
	c := calls()
	want := slotagent.LessonsBlockHeading + "\n- Keep it short\n\n" + profile + "\n\nSkill text for the agent."
	if len(c) != 1 || c[0].sys != want {
		t.Fatalf("lessons, the profile, the skill:\n%+v\nwant\n%q", c, want)
	}
	// PrepareCommand puts all of it before the task
	cmd, err := slotagent.PrepareCommand(context.Background(), slotagent.AgentDef{Command: "agent", Args: []string{"{instruction}"}}, "", c[0].instruction, c[0].sys)
	if err != nil {
		t.Fatal(err)
	}
	prompt := cmd.Args[len(cmd.Args)-1]
	if !strings.HasPrefix(prompt, slotagent.LessonsBlockHeading) || strings.Index(prompt, "Keep it short") > strings.Index(prompt, "Task: ") {
		t.Errorf("the prompt the agent gets:\n%s", prompt)
	}
}

func TestSingleSlotRunWithoutLessonsIsWhatItWas(t *testing.T) {
	lessonSettings(t)
	calls := stubSlotExecute(t, &slotagent.AgentExecutionResult{Output: "done", RawOutput: "done\n"})
	profile := slotagent.DefaultSlotConfig().SlotProfiles[0].SystemInstruction

	// no file: nothing changes, nothing is made, the page is told nothing
	got := runSlotAt(t, filepath.Join(t.TempDir(), "note.md"), lessonsTestSlot, 4, "")
	if c := calls(); len(c) != 1 || c[0].sys != profile {
		t.Errorf("no file: %+v", c)
	}
	if strings.Contains(got.raw, "lessons") || got.res.LessonsApplied != 0 {
		t.Errorf("result: %s", got.raw)
	}
	if _, err := os.Stat(slotagent.LessonsDir()); err == nil {
		t.Error("a run made the lessons folder")
	}

	// an empty file, and one with only the header
	for i, text := range []string{"", "# Lessons for claude-code\n<!-- md-memo lessons: one rule per \"- \" line. -->\n", "notes only\n* not a rule\n"} {
		if err := os.MkdirAll(slotagent.LessonsDir(), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(slotagent.LessonsPath(slotagent.LessonsDir(), "claude-code"), []byte(text), 0o644); err != nil {
			t.Fatal(err)
		}
		got = runSlotAt(t, filepath.Join(t.TempDir(), "note.md"), lessonsTestSlot, 4, "")
		if c := calls(); c[len(c)-1].sys != profile || strings.Contains(got.raw, "lessons") {
			t.Errorf("file %d: sys %q result %s", i, c[len(c)-1].sys, got.raw)
		}
	}

	// lessons: false on the agent
	keepLesson(t, "claude-code", "A rule that must not be used")
	cfg := `{"version":2,"default_agent":"claude-code","agents":{"claude-code":{"command":"claude","args":["-p","{instruction}"],"lessons":false}}}`
	got = runSlotAt(t, filepath.Join(t.TempDir(), "note.md"), lessonsTestSlot, 4, cfg)
	if c := calls(); c[len(c)-1].sys != profile || strings.Contains(got.raw, "lessons") {
		t.Errorf("lessons: false: sys %q result %s", c[len(c)-1].sys, got.raw)
	}
	// and without that key the very same file is used
	cfg = `{"version":2,"default_agent":"claude-code","agents":{"claude-code":{"command":"claude","args":["-p","{instruction}"]}}}`
	got = runSlotAt(t, filepath.Join(t.TempDir(), "note.md"), lessonsTestSlot, 4, cfg)
	if c := calls(); !strings.HasPrefix(c[len(c)-1].sys, slotagent.LessonsBlockHeading) || got.res.LessonsApplied != 1 {
		t.Errorf("no key: sys %q result %s", c[len(c)-1].sys, got.raw)
	}
}

func TestSingleSlotRunUsesTheDefaultAgentsLessonsAndCountsWhatWasLeftOut(t *testing.T) {
	lessonSettings(t)
	var rules []string
	for i := 1; i <= 35; i++ {
		rules = append(rules, fmt.Sprintf("rule %02d", i))
	}
	dir := slotagent.LessonsDir()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	var file strings.Builder
	for _, r := range rules {
		file.WriteString("- " + r + "\n")
	}
	if err := os.WriteFile(slotagent.LessonsPath(dir, "mock"), []byte(file.String()), 0o644); err != nil {
		t.Fatal(err)
	}
	calls := stubSlotExecute(t, &slotagent.AgentExecutionResult{ExitCode: 1, ErrorMsg: "boom", RawOutput: "partial"})

	// no agent is named and the profile names none: the default agent's file
	cfg := `{"version":2,"default_agent":"mock","agents":{"mock":{"command":"mockcmd","args":["{instruction}"]}},` +
		`"slot_profiles":[{"trigger_open":"{{","trigger_close":"}}","name":"x","agent":"","system_instruction":"PROFILE"}]}`
	got := runSlotAt(t, filepath.Join(t.TempDir(), "note.md"), "{{ A }}", 3, cfg)
	c := calls()
	if len(c) != 1 || c[0].agent.Command != "mockcmd" {
		t.Fatalf("run: %+v", c)
	}
	if !strings.HasPrefix(c[0].sys, slotagent.LessonsBlockHeading+"\n- rule 06\n") || !strings.HasSuffix(c[0].sys, "\n- rule 35\n\nPROFILE") || strings.Contains(c[0].sys, "rule 05") {
		t.Errorf("the newest 30 in the order of the file:\n%s", c[0].sys)
	}
	// a failed run is told to the page with the same counts
	if got.res.Status != "failed" || got.res.LessonsApplied != 30 || got.res.LessonsSkipped != 5 {
		t.Errorf("result: %+v", got.res)
	}
	if !strings.Contains(got.raw, `"lessonsApplied":30`) || !strings.Contains(got.raw, `"lessonsSkipped":5`) {
		t.Errorf("JSON: %s", got.raw)
	}
	t.Logf("slot result: %s", got.raw)
}

// The agent process of this test binary: a recipe's step is run for real (a recipe is not stubbed) and records the instruction it gets.
func TestLessonsHelperProcess(t *testing.T) {
	out := os.Getenv("MDMEMO_LESSONS_HELPER_OUT")
	if out == "" {
		return
	}
	_ = os.WriteFile(out, []byte(strings.Join(os.Args[1:], "\n")), 0o644)
	fmt.Print("step done")
	os.Exit(0)
}

func TestRecipesAreNotGivenLessons(t *testing.T) {
	lessonSettings(t)
	keepLesson(t, "mock", "A lesson that recipes must not see")
	out := filepath.Join(t.TempDir(), "args.txt")
	t.Setenv("MDMEMO_LESSONS_HELPER_OUT", out)
	cfg, _ := json.Marshal(map[string]interface{}{
		"version": 2, "default_agent": "mock", "timeout_seconds": 60,
		"agents": map[string]interface{}{"mock": map[string]interface{}{
			"command": os.Args[0], "args": []string{"-test.run=^TestLessonsHelperProcess$", "--", "{instruction}"},
		}},
		"recipes": []interface{}{map[string]interface{}{
			"trigger_open": "[>>", "trigger_close": "]", "name": "r", "steps": []string{"first step"}, "self_refine": false,
		}},
	})
	got := runSlotAt(t, filepath.Join(t.TempDir(), "note.md"), "[>> go ]", 4, string(cfg))
	if got.res.Type != "recipe" || got.res.Status != "completed" {
		t.Fatalf("result: %s", got.raw)
	}
	args, err := os.ReadFile(out)
	if err != nil {
		t.Fatalf("the step was not run: %v", err)
	}
	if !strings.Contains(string(args), "first step") || strings.Contains(string(args), "lesson") || strings.Contains(string(args), "Lessons from") {
		t.Errorf("the recipe step was given:\n%s", args)
	}
	if got.res.LessonsApplied != 0 || strings.Contains(got.raw, "lessons") {
		t.Errorf("a recipe result carries no lessons: %s", got.raw)
	}
}
