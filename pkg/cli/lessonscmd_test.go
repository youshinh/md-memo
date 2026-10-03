package cli

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"md-memo/pkg/appdir"
	"md-memo/pkg/slotagent"
)

// `md-memo lessons list` (docs/design/lessons-2026-10.md section 6): the lessons files of the agents, read-only. The JSON-RPC method
// lessons.list answers with LessonsList too (app_lessons_test.go has the method).

func putLessons(t *testing.T, stem, text string) string {
	t.Helper()
	path := filepath.Join(slotagent.LessonsDir(), stem+".md")
	writeFile(t, path, text)
	return path
}

func TestLessonsListWithNothingSavedCreatesNothing(t *testing.T) {
	withTempHome(t)
	out, _, code, err := runHeadless(t, "lessons", "list", "--json")
	if err != nil || code != 0 || strings.TrimSpace(out) != "[]" {
		t.Fatalf("empty folder: code %d err %v out %q", code, err, out)
	}
	out, _, code, err = runHeadless(t, "lessons", "list", "--text")
	if err != nil || code != 0 || !strings.HasPrefix(out, "No lessons files in ") || !strings.Contains(out, slotagent.LessonsDir()) {
		t.Errorf("text: code %d err %v out %q", code, err, out)
	}
	// one agent that has no file: an object, not an error
	out, _, code, err = runHeadless(t, "lessons", "list", "--agent", "claude", "--json")
	if err != nil || code != 0 {
		t.Fatalf("--agent: code %d err %v", code, err)
	}
	var one slotagent.LessonsInfo
	if json.Unmarshal([]byte(out), &one) != nil || one.Agent != "claude-code" || one.Exists || one.Count != 0 || one.Disabled ||
		one.Path != filepath.Join(slotagent.LessonsDir(), "claude-code.md") {
		t.Errorf("an agent without a file: %s", out)
	}
	if exists(appdir.AppConfigDir()) {
		t.Error("lessons list created the settings folder")
	}
	out, _, _, _ = runHeadless(t, "lessons", "list", "--agent", "claude", "--text")
	if !strings.HasPrefix(out, "claude-code: no file  ") {
		t.Errorf("text for an agent without a file: %q", out)
	}
}

func TestLessonsListDescribesEachFile(t *testing.T) {
	withTempHome(t)
	writeFile(t, filepath.Join(appdir.AppConfigDir(), "agents.yaml"), `
version: 2
agents:
  hermes:
    command: ollama
    args: ["run", "hermes3", "{instruction}"]
    lessons: false
`)
	var many strings.Builder
	for i := 1; i <= 33; i++ {
		fmt.Fprintf(&many, "- rule %02d <!-- 2026-10-03 -->\n", i)
	}
	cc := putLessons(t, "claude-code", many.String())
	hm := putLessons(t, "hermes", "- one\n- two\n")
	putLessons(t, "notes", "# nothing\n")
	writeFile(t, filepath.Join(slotagent.LessonsDir(), "readme.txt"), "- not a lessons file\n")

	out, _, code, err := runHeadless(t, "lessons", "list", "--json")
	if err != nil || code != 0 {
		t.Fatalf("code %d err %v", code, err)
	}
	var list []slotagent.LessonsInfo
	if err := json.Unmarshal([]byte(out), &list); err != nil || len(list) != 3 {
		t.Fatalf("list: %v %s", err, out)
	}
	want := []slotagent.LessonsInfo{
		{Agent: "claude-code", Path: cc, Exists: true, Count: 33, Applied: 30, Skipped: 3},
		{Agent: "hermes", Path: hm, Exists: true, Count: 2, Disabled: true},
		{Agent: "notes", Path: filepath.Join(slotagent.LessonsDir(), "notes.md"), Exists: true},
	}
	for i := range want {
		if list[i] != want[i] {
			t.Errorf("entry %d:\n%+v\nwant\n%+v", i, list[i], want[i])
		}
	}
	for _, key := range []string{`"agent"`, `"path"`, `"exists"`, `"count"`, `"applied"`, `"skipped"`, `"disabled"`} {
		if !strings.Contains(out, key) {
			t.Errorf("JSON lacks %s: %s", key, out)
		}
	}

	// by alias, JSON and text
	out, _, _, _ = runHeadless(t, "lessons", "list", "--agent", "cc", "--json")
	var one slotagent.LessonsInfo
	if json.Unmarshal([]byte(out), &one) != nil || one != want[0] {
		t.Errorf("--agent cc: %s", out)
	}
	out, _, _, _ = runHeadless(t, "lessons", "list", "--text")
	for _, line := range []string{
		"claude-code: 33 rules, 30 applied, 3 left out as too many  " + cc,
		"hermes: 2 rules, not applied (lessons: false)  " + hm,
		"notes: 0 rules, 0 applied  " + filepath.Join(slotagent.LessonsDir(), "notes.md"),
	} {
		if !strings.Contains(out, line+"\n") {
			t.Errorf("text lacks %q:\n%s", line, out)
		}
	}
	// flags may come before or after
	out2, _, code, err := runHeadless(t, "lessons", "list", "--json", "--agent=hermes")
	if err != nil || code != 0 || !strings.Contains(out2, `"disabled": true`) {
		t.Errorf("--agent=hermes: %v %d %s", err, code, out2)
	}
}

func TestLessonsHasNoWriteCommand(t *testing.T) {
	withTempHome(t)
	for _, args := range [][]string{
		{"lessons", "add", "claude", "x"}, {"lessons", "append"}, {"lessons", "save", "--agent", "claude"},
		{"lessons", "remove"}, {"lessons", "edit"}, {"lessons", "clear"},
	} {
		_, _, code, err := runHeadless(t, args...)
		if code != 1 || err == nil || !strings.Contains(err.Error(), "does not write lessons") {
			t.Errorf("%v: code %d err %v", args, code, err)
		}
	}
	for _, c := range []struct {
		args []string
		want string
	}{
		{[]string{"lessons"}, "action required"},
		{[]string{"lessons", "frobnicate"}, "unknown lessons action"},
		{[]string{"lessons", "list", "extra"}, "takes no arguments"},
		{[]string{"lessons", "list", "--bogus"}, "flag provided but not defined"},
		{[]string{"lessons", "list", "--agent"}, "needs an argument"},
	} {
		if _, _, code, err := runHeadless(t, c.args...); code != 1 || err == nil || !strings.Contains(err.Error(), c.want) {
			t.Errorf("%v: code %d err %v, want %q", c.args, code, err, c.want)
		}
	}
	if exists(slotagent.LessonsDir()) {
		t.Error("a refused command made the lessons folder")
	}
	// -h prints the usage
	out, _, code, err := runHeadless(t, "lessons", "list", "-h")
	if err != nil || code != 0 || out != SubcommandUsage("lessons") {
		t.Errorf("-h: code %d err %v", code, err)
	}
	if text, ok := HelpRequest([]string{"lessons", "list", "--agent", "claude", "--help"}, "1.0.0"); !ok || text != SubcommandUsage("lessons") {
		t.Errorf("--help after --agent <key>: %v", ok)
	}
	if _, ok := HelpRequest([]string{"lessons", "list", "--agent", "-h"}, "1.0.0"); ok {
		t.Error("the value of --agent is not a help flag")
	}
}

func TestLessonsListAnswersTheSameThroughTheFunction(t *testing.T) {
	withTempHome(t)
	putLessons(t, "codex", "- keep it\n")
	res, err := LessonsList("")
	list, ok := res.([]slotagent.LessonsInfo)
	if err != nil || !ok || len(list) != 1 || list[0].Agent != "codex" || list[0].Count != 1 {
		t.Fatalf("list: %v %#v", err, res)
	}
	res, err = LessonsList(" @codex ")
	if one, ok := res.(slotagent.LessonsInfo); err != nil || !ok || one != list[0] {
		t.Errorf("one: %v %#v", err, res)
	}
	for _, bad := range []string{"a\nb", strings.Repeat("x", 201), "a\x00b"} {
		if _, err := LessonsList(bad); !IsParamError(err) {
			t.Errorf("%q: %v", bad, err)
		}
	}
	// an agents file that does not parse is no reason to fail: the built-in agents are used
	if err := os.MkdirAll(appdir.AppConfigDir(), 0o755); err != nil {
		t.Fatal(err)
	}
	writeFile(t, filepath.Join(appdir.AppConfigDir(), "agents.yaml"), "agents: [this is: not: valid\n")
	if res, err = LessonsList("claude"); err != nil || res.(slotagent.LessonsInfo).Agent != "claude-code" {
		t.Errorf("broken agents file: %v %#v", err, res)
	}
}
