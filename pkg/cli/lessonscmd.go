package cli

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"md-memo/pkg/slotagent"
)

// `md-memo lessons list [--agent <key>]` (docs/design/lessons-2026-10.md section 6): which agents have a lessons file, how many rules each
// holds and how many a run would be given. It is read-only, and so is the JSON-RPC method lessons.list that answers the same: there is no
// command or method that writes a rule, because an agent could then change its own future instructions without a person approving it.
// Rules are saved from the window, after a person has read what a model proposed, or by editing the file.

// LessonsList describes the lessons files: of one agent (a key or an alias; the answer is one slotagent.LessonsInfo, also when the file is
// not there), or, with an empty agent, of every file in the lessons folder (a list, [] when there is none). It reads agents.yaml the way
// the app does, to resolve an alias and to see `lessons: false`; it creates nothing.
func LessonsList(agent string) (interface{}, error) {
	agent = strings.TrimSpace(agent)
	if len(agent) > 200 || strings.ContainsAny(agent, "\x00\r\n") {
		return nil, paramErr("invalid agent name")
	}
	cfg := lessonsSlotConfig()
	dir := slotagent.LessonsDir()
	if agent == "" {
		return slotagent.ListLessonsInfo(dir, cfg), nil
	}
	return slotagent.LessonsInfoFor(dir, cfg, agent), nil
}

// lessonsSlotConfig is the agents the app would run: the agents file next to the scraps or in the settings folder, else the built-in
// ones (App.buildActiveSlotConfig without the page's own additions).
func lessonsSlotConfig() slotagent.SlotConfig {
	cfg := LoadConfig()
	if file := slotagent.FindAgentConfigFile(cfg.ScrapDirResolved()); file != "" {
		if data, err := os.ReadFile(file); err == nil {
			if parsed, err := slotagent.ParseAgentConfigFile(data, filepath.Ext(file)); err == nil {
				return parsed
			}
		}
	}
	return slotagent.DefaultSlotConfig()
}

func (r *HeadlessRunner) runLessons(args []string) (int, error) {
	if len(args) == 0 {
		return 1, errors.New("lessons action required: list")
	}
	if args[0] != "list" {
		if isLessonsWriteWord(args[0]) {
			return 1, fmt.Errorf("lessons %s: the command line does not write lessons; they are saved from the window after a person approves them, or by editing the file", args[0])
		}
		return 1, fmt.Errorf("unknown lessons action: %s (use list)", args[0])
	}
	fs := newQuietFlagSet("lessons list")
	agent := fs.String("agent", "", "Only this agent (a key or an alias)")
	forceJSON := fs.Bool("json", false, "Force JSON output")
	forceText := fs.Bool("text", false, "Force plain text output")
	rest, err := parseInterspersed(fs, args[1:])
	if err != nil {
		return r.flagErr("lessons", err)
	}
	if len(rest) > 0 {
		return 1, fmt.Errorf("lessons list takes no arguments, got %q (use --agent <key>)", rest[0])
	}

	res, err := LessonsList(*agent) // the same answer as the JSON-RPC method lessons.list
	if err != nil {
		return 1, err
	}
	if ResolveFormatCustom(*forceJSON, *forceText, IsTerminal(os.Stdout)) == FormatJSON {
		PrintFormatted(r.stdout, FormatJSON, "", res)
		return 0, nil
	}
	var infos []slotagent.LessonsInfo
	switch v := res.(type) {
	case slotagent.LessonsInfo:
		infos = []slotagent.LessonsInfo{v}
	case []slotagent.LessonsInfo:
		infos = v
	}
	if len(infos) == 0 {
		fmt.Fprintf(r.stdout, "No lessons files in %s\n", slotagent.LessonsDir())
		return 0, nil
	}
	for _, in := range infos {
		fmt.Fprintln(r.stdout, lessonsTextLine(in))
	}
	return 0, nil
}

func isLessonsWriteWord(s string) bool {
	switch s {
	case "add", "append", "save", "set", "write", "remove", "delete", "edit", "clear":
		return true
	}
	return false
}

// lessonsTextLine is one agent in plain text: "claude-code: 3 rules, 3 applied  <path>".
func lessonsTextLine(in slotagent.LessonsInfo) string {
	var what string
	switch {
	case !in.Exists:
		what = "no file"
	case in.Disabled:
		what = fmt.Sprintf("%d %s, not applied (lessons: false)", in.Count, plural(in.Count, "rule", "rules"))
	default:
		what = fmt.Sprintf("%d %s, %d applied", in.Count, plural(in.Count, "rule", "rules"), in.Applied)
		if in.Skipped > 0 {
			what += fmt.Sprintf(", %d left out as too many", in.Skipped)
		}
	}
	return fmt.Sprintf("%s: %s  %s", in.Agent, what, in.Path)
}

func plural(n int, one, many string) string {
	if n == 1 {
		return one
	}
	return many
}
