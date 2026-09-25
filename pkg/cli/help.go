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
//
// Every flag that takes a value must be listed, or its value is taken for the start of the text:
// out (buffer get), from, to, limit (scrap list/search), date (scrap path).
var valueFlags = map[string]bool{
	"tab": true, "expected-hash": true, "expected-gen": true, "start": true, "end": true,
	"query": true, "file": true, "mode": true, "input": true,
	"out": true, "from": true, "to": true, "limit": true, "date": true,
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

	if !IsSubcommand(first) {
		// `md-memo rpc --help`, `md-memo pipe -h`, and any other word an agent may guess
		// (`md-memo config --help`): the explicit help flag right after it is a request for
		// usage, not for a GUI start. A file name followed by -h is not a realistic call.
		if len(args) > 1 && isHelpFlag(args[1]) && !strings.HasPrefix(first, "-") {
			if text := SubcommandUsage(first); text != "" {
				return text, true
			}
			return TopLevelUsage(version), true
		}
		return "", false
	}
	text := SubcommandUsage(first)

	if hasNoAction(first) { // no action word: `ocr <imagePath>`, `info`: only leading flags can ask
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
  buffer get --out <file> [--bom] [--selection] [--tab <id>]
                                             Write the note to a file as UTF-8 and print only
                                             its path, size and hash (no console code page)
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
  info [--json]                              Where things are: version, config and scrap folders,
                                             today's scrap file, inbox, autosave, app running?
  --headless <jev|agent|ocr|info ...>        Same commands with an explicit "no GUI" marker

Output and exit codes:
  Text at a terminal; JSON when stdout is piped or redirected. --json or --text overrides.
  Exit code 0 = success, 1 = error (message on stderr as "Error: ..."). jev verify: see above.
  Flags come BEFORE the text: md-memo buffer append --tab 2 "- [ ] task".
  Put -- before text that starts with a dash, e.g. md-memo jev verify -- -rf.
  Text may also come from stdin: echo "more" | md-memo buffer append

Safe editing of the open note (optimistic lock):
  md-memo buffer get --json                              keep "hash" from the result
  md-memo buffer set --expected-hash <hash> "<new text>" refused with "conflict" if the note changed meanwhile
  On a conflict, read again and redo the edit. Never drop --expected-hash to make it work.

` + pipeHelp + `
` + rpcHelp + `
Help for one command: md-memo help buffer   (also: buffer --help, tab -h, ...)
Help for the other surfaces: md-memo help pipe | md-memo help rpc
Manual: https://youshinh.github.io/md-memo/manual.html#headless-cli
Agent skill (repository, and the release zip from v1.7.1): skills/md-memo/SKILL.md
`
}

// pipeHelp is the "text in through a pipe" surface. It is part of the top-level usage and also
// what `md-memo help pipe` prints.
const pipeHelp = `Piping text in (appends to today's scrap; the note you have open is not touched):
  <command> | md-memo [title words]    Max 10 MB. The title words become the heading of the entry.
  The window is brought to the front. If MD-Memo is NOT running, this STARTS it (a window
  opens) and then appends: an agent should do that only when the user asked. To edit the open
  note instead, use buffer (above).
  md-memo <file.md>                    Opens the file in a new tab (running app: no second window).
`

// rpcHelp is the JSON-RPC surface the buffer/tab/ui commands are built on. It is part of the
// top-level usage and also what `md-memo help rpc` prints. Keep it in step with
// pkg/ipc and app_rpc.go (skills/md-memo/references/interfaces.md section 2 has the details).
const rpcHelp = `JSON-RPC 2.0 over local TCP (what buffer/tab/ui use; call it directly from code):
  Find it:   <config>/md-memo/ipc-session.json = {"pid", "port", "token", "started_at"}
             Windows: %APPDATA%\md-memo\   macOS: ~/Library/Application Support/md-memo/
             No file (or a dead pid) = MD-Memo is not running. The port is usually 49152 but can
             differ: always read it from the file.
  Talk:      connect to 127.0.0.1:<port>; send one JSON object per line, read one JSON line back
             (max 11 MB per line; give every request an "id"):
             {"jsonrpc":"2.0","id":1,"method":"buffer.get","params":{},"auth":"<token>"}
  Methods:   buffer.get {tab_id?}                 buffer.get_selection {tab_id?}
             buffer.set {content, expected_hash?} buffer.replace_selection {content, tab_id?}
             buffer.append {content}              tab.list      tab.switch {tab_id}
             buffer.replace {start_line, start_col, end_line, end_col, content, expected_hash?}
             ui.activate  ui.toggle_split  ui.eval {expression}
  Errors:    -32001 conflict (hash mismatch or the selection moved: read again and redo)
             -32003 no active selection      -32602 bad params      -32601 unknown method
             -32603 failed inside the app or timed out (5 s)        -32000 wrong "auth" token
  Any program on this PC can reach the port, and ui.eval is full control of the UI: use it only
  when the user asked for it.
`

// SubcommandUsage is the help of one command word ("buffer", "tab", "ui", "jev", "agent",
// "ocr") or of one of the two non-command surfaces ("pipe", "rpc"), or "" for anything else.
func SubcommandUsage(name string) string {
	switch name {
	case "pipe":
		return pipeHelp
	case "rpc":
		return rpcHelp
	case "buffer":
		return `md-memo buffer <get|set|append|replace|replace-selection> [options] [text]

Reads and edits the note that is open in the RUNNING app (start MD-Memo first).

  buffer get [--selection] [--tab <id>] [--json|--text]
      Print the note. --selection prints only the selected text (error "no active selection"
      when nothing is selected). JSON: {content, hash, generation, length, line_count, ...}.
  buffer get --out <file> [--bom] [--selection] [--tab <id>] [--json|--text]
      Write the note to <file> instead of printing it, and print only what was written:
      JSON {path, bytes, hash, generation?}, or one line of text at a terminal. This process
      writes the file itself as UTF-8 WITHOUT a byte order mark (--bom adds one), so Japanese and
      other non-ASCII text arrives intact; a pipe through a shell does not promise that (Windows
      PowerShell 5.1 re-encodes piped text with the console code page). The text is written
      exactly as buffer get would print it. The path is taken relative to the current folder,
      the folder must already exist, a directory is refused, an existing file is replaced in
      one step. --selection writes only the selected text (hash is then the hash of that text).
      hash is the one buffer set --expected-hash expects.
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
	case "info":
		return `md-memo info [--json|--text]

Runs on its own (MD-Memo need not be running). Reads config.json; creates and changes nothing.
Says where MD-Memo keeps things and how it is set up, so nobody has to guess a path.

JSON (piped, or --json), one object:
  version              the app version
  config_dir           the md-memo settings folder
  config_file          its config.json (may not exist yet: defaults apply)
  scrap_dir            the folder of the daily scraps (config: scraps.scrapDir)
  today_scrap_path     today's scrap file, YYYY-MM-DD.md inside scrap_dir (never created here)
  today_scrap_exists   whether that file exists
  inbox_dir            the hot folder (config: inbox.dir), also when it is switched off
  inbox_enabled        whether the hot folder is watched (config: inbox.enabled)
  autosave             whether open files are saved on their own (config: general.autoSave)
  gui_running          true when a live app answers on the port in ipc-session.json
                       (the file is only read: a stale one is left alone)
No secret is printed: no API key, token, session token or remote URL.
Exit 0 ok, 1 error.
`
	}
	return ""
}
