package cli

import "strings"

// This file answers `md-memo --help`, `md-memo -h`, `md-memo help [command]` and
// `md-memo --version` before main() reaches any GUI, single-instance or pipe logic. Those flags
// used to fall straight through to a normal GUI start, so an agent probing the CLI
// would open (or raise) the user's window instead of getting usage text.

// isHelpFlag reports whether arg is one of the flag spellings that ask for help. Go's flag
// package treats -h, -help and --help alike, so they all count here too.
func isHelpFlag(arg string) bool {
	return arg == "-h" || arg == "--help" || arg == "-help"
}

// valueFlags are the flags of the subcommands that take a separate value ("--tab 3"). The
// scan for a help flag must step over that value instead of mistaking it for the start of the
// command's text.
var valueFlags = map[string]bool{
	"tab": true, "expected-hash": true, "expected-gen": true, "start": true, "end": true,
	"query": true, "file": true, "mode": true, "input": true,
}

// leadingHelpFlag reports whether a help flag sits among the LEADING flags of args. It stops at
// "--" or at the first argument that is not a flag (the command's own text begins there), so
// `buffer append hello -h` still appends "hello -h" and `jev verify ls -h` still judges "ls -h".
func leadingHelpFlag(args []string) bool {
	for i := 0; i < len(args); i++ {
		a := args[i]
		if a == "--" || a == "-" || !strings.HasPrefix(a, "-") {
			return false
		}
		if isHelpFlag(a) {
			return true
		}
		name := strings.TrimLeft(a, "-")
		if !strings.Contains(name, "=") && valueFlags[name] {
			i++
		}
	}
	return false
}

// HelpRequest decides whether args (os.Args[1:]) ask for help or the version. When they do it
// returns the text to print on stdout; the caller prints it and exits 0. It never touches the
// filesystem, the network or a running instance.
//
// `jev verify` is deliberately never intercepted past its action word. Its exit status is a
// verdict (0 = safe), and a hook that passes an unquoted command through it must keep
// failing closed: `md-memo jev verify -h && rm -rf /` has always been rejected by the flag
// parser, and printing help with exit 0 there would turn it into "safe".
func HelpRequest(args []string, version string) (string, bool) {
	if len(args) == 0 {
		return "", false
	}
	first := args[0]

	switch first {
	case "--version", "-version", "-v", "-V":
		return VersionLine(version), true
	case "--help", "-h", "-help":
		return TopLevelUsage(version), true
	case "help":
		if len(args) > 1 {
			if text := SubcommandUsage(args[1]); text != "" {
				return text, true
			}
		}
		return TopLevelUsage(version), true
	}

	if !isSubcommand(first) {
		return "", false
	}
	text := SubcommandUsage(first)

	if first == "ocr" { // no action word: `ocr <imagePath>`, so only leading flags can ask
		if leadingHelpFlag(args[1:]) {
			return text, true
		}
		return "", false
	}
	if len(args) < 2 {
		return "", false
	}
	if isHelpFlag(args[1]) || args[1] == "help" {
		return text, true
	}
	if first != "jev" && leadingHelpFlag(args[2:]) {
		return text, true
	}
	return "", false
}

// isSubcommand mirrors main's dispatch table.
func isSubcommand(arg string) bool {
	switch arg {
	case "buffer", "tab", "ui", "jev", "agent", "ocr":
		return true
	}
	return false
}

// VersionLine is what `md-memo --version` prints.
func VersionLine(version string) string {
	return "md-memo " + version + "\n"
}

// TopLevelUsage is the text of `md-memo --help`. Keep it in step with the real flags and
// behaviour in client.go, headless.go and ocr.go; help_test.go pins the command names.
func TopLevelUsage(version string) string {
	return `md-memo ` + version + ` - Markdown scratchpad (GUI app with a scriptable command line)

Usage:
  md-memo                              Start MD-Memo, or bring the running window to the front
  md-memo <file.md>                    Open a file in a new tab
  <command> | md-memo [title words]    Append the piped text (max 10 MB) to today's scrap
  md-memo <command> [options]          Run one of the commands below
  md-memo help [command]               Show this help, or the help of one command
  md-memo --help | -h                  Same as help
  md-memo --version | -v               Print the version

Commands that read and edit the OPEN NOTE (they talk to the running app; start MD-Memo first,
otherwise: "Error: md-memo is not running", exit 1):
  buffer get [--selection] [--tab <id>]      Print the note (or only the selected text)
  buffer set [--expected-hash <h>] [text]    Replace the whole note
  buffer append [text]                       Add text at the end
  buffer replace --start L:C --end L:C [--expected-hash <h>] [text]
                                             Replace a range (1-based line:column)
  buffer replace-selection [text]            Replace the selected text
  tab list                                   List the open tabs (ids, titles, paths)
  tab switch <id>                            Activate a tab (use an id from tab list)
  ui activate                                Bring the window to the front
  ui toggle-split                            Toggle the split view
  ui eval <javascript>                       Run JavaScript in the page (powerful: full control of the UI)

Commands that run on their own (MD-Memo need not be running):
  jev verify [--mode m] <command...>         Judge a shell command with the built-in guard
                                             (m: strict | reviewed | unattended)
                                             exit code: 0 safe, 1 blocked, 2 warning
  jev score <command...>                     Expected destructive impact (0 = safe .. 2)
  jev predict [--input <task>] [words...]    Suggest next actions for a task line
  jev dispatch <input...>                    Decide whether to handle it directly or escalate
  agent prune [--query <q>] [--file <path>]  Cut Markdown down to the sections relevant to q
                                             (reads stdin when --file is not given)
  ocr [--json] <imagePath>                   Read the text of an image and append it to today's scrap
  --headless <jev|agent|ocr ...>             Same commands with an explicit "no GUI" marker

Output and exit codes:
  Text at a terminal; JSON when stdout is piped or redirected. --json or --text overrides.
  Exit code 0 = success, 1 = error (message on stderr as "Error: ..."). jev verify: see above.
  Flags come BEFORE the text: md-memo buffer append --tab 2 "- [ ] task".
  Put -- before text that starts with a dash, e.g. md-memo jev verify -- -rf.
  Text may also come from stdin: echo "more" | md-memo buffer append

Help for one command: md-memo help buffer   (also: buffer --help, tab -h, ...)
Manual: https://youshinh.github.io/md-memo/manual.html#headless-cli
Agent skill (repository): skills/md-memo/SKILL.md
`
}

// SubcommandUsage is the help of one command word ("buffer", "tab", "ui", "jev", "agent",
// "ocr"), or "" for anything else.
func SubcommandUsage(name string) string {
	switch name {
	case "buffer":
		return `md-memo buffer <get|set|append|replace|replace-selection> [options] [text]

Reads and edits the note that is open in the RUNNING app (start MD-Memo first).

  buffer get [--selection] [--tab <id>] [--json|--text]
      Print the note. --selection prints only the selected text (error "no active selection"
      when nothing is selected). JSON: {content, hash, generation, length, line_count, ...}.
  buffer set [--expected-hash <h>] [--expected-gen <n>] [text]
      Replace the whole note. With --expected-hash the write is refused ("conflict") when the
      note changed since you read it: read with buffer get --json, keep hash, write back.
  buffer append [text]
      Add text at the end of the note.
  buffer replace --start L:C --end L:C [--expected-hash <h>] [text]
      Replace the range from L:C to L:C (1-based line and column). Both default to 1:1, so
      omitting --end INSERTS at the start of the note.
  buffer replace-selection [text]
      Replace the selected text ("no active selection" when there is none).

Text: the words after the flags, joined by single spaces; when there are none, standard input
is read if it is piped. Flags go BEFORE the text; put -- first for text that starts with a dash.
Output: text at a terminal, JSON when piped; --json / --text override. Exit 0 ok, 1 error.
`
	case "tab":
		return `md-memo tab <list|switch> [options]

Works on the RUNNING app (start MD-Memo first).

  tab list [--json|--text]     List the open tabs: id, title, path, whether active or modified.
  tab switch <id>              Make a tab the active one. Use an id printed by tab list: an
                               unknown id is not rejected and leaves no valid active tab.

Output: text at a terminal, JSON when piped. Exit 0 ok, 1 error.
`
	case "ui":
		return `md-memo ui <activate|toggle-split|eval> [javascript]

Works on the RUNNING app (start MD-Memo first).

  ui activate            Bring the window to the front (also when it is hidden in the tray).
  ui toggle-split        Toggle the split editor.
  ui eval <javascript>   Run JavaScript in the page and print the JSON of the result.
                         Powerful: it can do anything the UI can, so use it only when asked.

Exit 0 ok, 1 error.
`
	case "jev":
		return `md-memo jev <verify|score|predict|dispatch> [options] <text>

Runs on its own (MD-Memo need not be running). Flags: --json, --text, --quiet.

  jev verify [--mode strict|reviewed|unattended] <command...>
      Judge a shell command with the built-in guard, before running it.
      Exit code: 0 safe, 1 blocked, 2 warning (not known to be destructive, cannot be vouched for).
      Fail closed: treat anything but 0 as "do not run".
  jev score <command...>
      Expected destructive impact: score 0 (safe) .. 2 (destructive).
  jev predict [--input <task>] [words...]
      Suggest the next actions for a task line. May use the network when a Jev endpoint or key
      is configured in the environment.
  jev dispatch <input...>
      Decide whether to handle the input directly or escalate it. Same network rule.

Flags go BEFORE the command text; put -- first for a command that starts with a dash.
Output: text at a terminal, JSON when piped; --json / --text override.
`
	case "agent":
		return `md-memo agent prune [--query <q>] [--file <path>] [--json]

Runs on its own (MD-Memo need not be running).

  agent prune    Keep only the Markdown sections that match the query words, so a long note
                 fits an agent's context. Reads the text from --file, or from stdin when
                 --file is not given (it waits if stdin is a terminal).
                 JSON: {original_length, pruned_length, ratio, content}.
`
	case "ocr":
		return `md-memo ocr [--json] <imagePath>

Runs on its own (MD-Memo need not be running; the Windows Send To menu uses it).

  Reads the text of one image with the cloud vision model from config.json (Windows: the
  on-device engine as a fallback) and APPENDS it to today's scrap. The image may leave the PC.
  Prints "OCR text appended to <note>"; JSON: {text, appended, path}.
  Nothing recognized: "(no text recognized)", nothing written, exit 0.
  Exit 1 with "Error: ..." on stderr when the file cannot be read or the OCR fails.
`
	}
	return ""
}
