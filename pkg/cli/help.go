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
// out (buffer get), as and encoding (buffer save), title and path (tab new), from, to, limit (scrap
// list/search), date (scrap path).
var valueFlags = map[string]bool{
	"tab": true, "expected-hash": true, "expected-gen": true, "start": true, "end": true,
	"query": true, "file": true, "mode": true, "input": true,
	"out": true, "from": true, "to": true, "limit": true, "date": true, "dir": true,
	"as": true, "encoding": true, "title": true, "path": true,
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
		// (`md-memo share --help`): the explicit help flag right after it is a request for
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
  buffer set [--tab <id>] [--expected-hash <h>] [text]
                                             Replace the whole note (--tab: that tab, not on screen)
  buffer append [--tab <id>] [text]          Add text at the end
  buffer replace [--tab <id>] --start L:C --end L:C [--expected-hash <h>] [text]
                                             Replace a range (1-based line:column)
  buffer replace-selection [text]            Replace the selected text
  buffer save [--tab <id>] [--as <file>] [--encoding utf-8|sjis] [--overwrite]
                                             Write the note to a file: no dialog, only .md .markdown
                                             .txt, never replaces a file unless --overwrite
  tab list                                   List the open tabs (ids, titles, paths)
  tab switch <id>                            Activate a tab (use an id from tab list)
  tab new [--title <t>] [--path <file>] [--background]
                                             Open a tab (a new note, or an existing file) and print its id
  tab close <id> [--if-saved]                Close a tab; exit 1 and the reason when it stays open
  tab pdf [<file>] [-o <file.pdf>] [--tab <id>] [--paper a4|a3|b5|letter] [--landscape]
          [--margin normal|narrow] [--scale N] [--pages 1-3,5] [--header-footer] [--overwrite]
                                             A note as a PDF file (Windows): the app prints its preview
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
  agent install-skill [--claude | --codex | --dir <path>] [--force] [--link]
                                             Install the agent skill built into this program (works
                                             without the repository, also after a Homebrew install)
  ocr [--json] <imagePath>                   Read the text of an image and append it to today's scrap
  info [--json]                              Where things are: version, config and scrap folders,
                                             today's scrap file, inbox, autosave, app running?
  scrap path [--date YYYY-MM-DD]             Path of a day's scrap file (default today); creates nothing
  scrap list [--from D] [--to D] [--lines]   The daily scrap files (YYYY-MM-DD.md), newest first
  scrap search <text> [--from D] [--to D] [--limit N] [--ranked] [--semantic]
                                             Search the scraps; every hit names its nearest heading
                                             (--ranked: notes that hold the words, best first;
                                             --semantic: notes close in meaning, see scrap index)
  scrap index [--status] [--rebuild] [--dry-run]
                                             Build or update the semantic index (experimental; off
                                             unless semantic.enabled is set in config.json)
  config get [<key.path>] [--json]           Show config.json with every API key, token and password
                                             hidden (safe to run and to show to an agent)
  --headless <jev|agent|ocr|info|scrap|config ...>
                                             Same commands with an explicit "no GUI" marker

Output and exit codes:
  Text at a terminal; JSON when stdout is piped or redirected. --json or --text overrides.
  Exit code 0 = success, 1 = error (message on stderr as "Error: ..."). jev verify: see above.
  buffer flags come BEFORE the text: md-memo buffer append --tab 2 "- [ ] task".
  (info, scrap, config, buffer save and tab new / close take their flags before or after their words.)
  Put -- before text that starts with a dash, e.g. md-memo jev verify -- -rf.
  Text may also come from stdin: echo "more" | md-memo buffer append
  Windows scripts, agents and CI: md-memo.exe is a windowed program, so PowerShell and cmd do not wait
  for it and may lose its exit code and output. md-memo-cli.exe (next to it in the zip) runs every
  command above as a console program and never starts the app; use it there.

Safe editing of the open note (optimistic lock):
  md-memo buffer get --json                              keep "hash" from the result
  md-memo buffer set --expected-hash <hash> "<new text>" refused with "conflict" if the note changed meanwhile
  On a conflict, read again and redo the edit. Never drop --expected-hash to make it work.

` + pipeHelp + `
` + rpcHelp + `
Help for one command: md-memo help buffer   (also: buffer --help, tab -h, ...)
Help for the other surfaces: md-memo help pipe | md-memo help rpc
Manual: https://youshinh.github.io/md-memo/manual.html#headless-cli
Agent skill: md-memo agent install-skill (built in), or skills/md-memo/SKILL.md (repository, and the release zip from v1.7.1)
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
  From code, with the session token, and without starting the app or raising its window: the
  JSON-RPC method scrap.append {content | content_base64, title?} does the same append (see rpc).
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
  Token:     "auth" (the "token" of the session file) is REQUIRED for every method except the
             reads buffer.get, buffer.get_selection and tab.list, which accept it or none and
             refuse only a wrong one. Without it: -32000. (Older builds ran writes without a token.)
             The one-line legacy messages of "cmd | md-memo" and "md-memo <file>" are a separate
             channel and are not authenticated.
  Methods:   buffer.get {tab_id?}                 buffer.get_selection {tab_id?}
             buffer.set {content, tab_id?, expected_hash?, expected_generation?}
             buffer.append {content, tab_id?}     buffer.replace_selection {content, tab_id?}
             buffer.replace {start_line, start_col, end_line, end_col, content, tab_id?,
                             expected_hash?, expected_generation?}
             buffer.save {tab_id?, path?, encoding?, overwrite?}    writes a file, opens no dialog
             tab.list      tab.switch {tab_id}
             tab.new {title?, path?, content?, background?}         -> {id, title, path, existing}
             tab.close {tab_id, if_saved?}                          -> {closed, reason?}
             ui.activate  ui.toggle_split  ui.eval {expression}
             The note, the caret and the view (all need the token):
             buffer.cursor {tab_id?} -> {start, end, has_selection, line, col, end_line, end_col, length}
             buffer.select {tab_id?, start, end?  |  start_line, start_col, end_line?, end_col?, scroll?, focus?}
             buffer.find {pattern, regex?, case_sensitive?, whole_word?, limit?, tab_id?}  -> matches with offsets, lines, columns
             buffer.replace_all {pattern, replace, regex?, case_sensitive?, whole_word?, expected_hash?, tab_id?}  one write
             ui.state  ui.set_view {preview?: off|full|side, split?, zen?}  task.list  task.cancel {id}
             ui.open_panel {name, query?, mode?}   shows a panel; for scraps_search, mode exact|meaning and query
                  put the notes search in that mode with that text and start it (a search: the Deep search button stays the person's)
             The scraps and the machine (all need the token; the first four answer like the commands of the same name):
             app.info  config.get {key?}  scrap.path {date?}  scrap.list {from?, to?, lines?}
             scrap.search {text, from?, to?, limit?, ranked?, semantic?, kind?, path?, update?}
             scrap.open {date?, background?}   opens that day's file in a tab
             scrap.append {content | content_base64, title?, cwd?, activate?, format?: text|markdown}
                  = cmd | md-memo [title words], with a token (markdown: the content is not put in a text fence)
             git.status  git.sync    (the scrap folder's Git sync; sync pushes the notes, only when the person asked)
             filter.validate {command}  filter.run {command, input?, confirm_warning?, timeout_ms?}   a shell command over some text,
                  through the command bar's guard: a blocked command is refused, a warned one needs confirm_warning
             print.pdf {out, tab_id?, paper?, landscape?, margin?, scale?, pages?, header_footer?, overwrite?}   (Windows)
                  a note as a PDF file: out is an absolute path ending in .pdf, in a folder that exists, never replaced
                  unless overwrite; shows the tab's preview for the print and puts the view back; answers in 8 s at most
                  -> {path, bytes, pages, tab_id}
             deepsearch.plan {query, limit?}   a dry run of a deep search: which notes (rel, label, lines, chars), the sizes, and where the
                  excerpts would go (destination: this PC, or a host and whether it is allowed); sends nothing, keeps nothing. The deep
                  search itself is the person's to run (ui.open_panel scraps_search, mode meaning)
             The buffer writes act on tab_id (an id from tab.list) WITHOUT showing that tab; without
             tab_id, on the active tab of the primary pane. Their result has tab_id, hash and
             previous_hash. The selection methods act on the tab shown in a pane.
  Errors:    -32001 conflict (hash mismatch, the selection moved, or the note changed while saving:
                    read again and redo)
             -32002 no such tab / no such file (tab_id from tab.list)
             -32003 no active selection      -32602 bad params (the message names the rule)
             -32601 unknown method           -32000 missing or wrong "auth" token
             -32603 failed inside the app or timed out (5 s)
  Any program on this PC can reach the port, and ui.eval is full control of the UI: use it only
  when the user asked for it.
`

// SubcommandUsage is the help of one command word of the registry ("buffer", "tab", "ui", "jev",
// "agent", "ocr", "info", "scrap", "config") or of one of the two non-command surfaces ("pipe",
// "rpc"), or "" for anything else.
func SubcommandUsage(name string) string {
	switch name {
	case "pipe":
		return pipeHelp
	case "rpc":
		return rpcHelp
	case "buffer":
		return `md-memo buffer <get|set|append|replace|replace-selection|save> [options] [text]

Reads and edits the note that is open in the RUNNING app (start MD-Memo first).

  buffer get [--selection] [--tab <id>] [--json|--text]
      Print the note. --selection prints only the selected text (error "no active selection"
      when nothing is selected). JSON: {tab_id, content, hash, generation, length, line_count, ...}.
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
  buffer set [--tab <id>] [--expected-hash <h>] [--expected-gen <n>] [text]
      Replace the whole note. With --expected-hash the write is refused ("conflict") when the
      note changed since you read it: read with buffer get --json, keep hash, write back.
  buffer append [--tab <id>] [text]
      Add text at the end of the note.
  buffer replace [--tab <id>] --start L:C --end L:C [--expected-hash <h>] [text]
      Replace the range from L:C to L:C (1-based line and column). Both default to 1:1, so
      omitting --end INSERTS at the start of the note.
  buffer replace-selection [text]
      Replace the selected text ("no active selection" when there is none).
  buffer save [--tab <id>] [--as <file>] [--encoding utf-8|sjis] [--overwrite] [--json|--text]
      Write the note to a file and bind the tab to it (later autosaves go there). Never opens a
      dialog, never creates a folder. --as is taken from the current folder if relative; without
      it the tab's own file is written (a tab with no file: error "tab has no file"). Only .md,
      .markdown and .txt; no network (UNC) paths, no Windows device names, no ":" streams. An
      existing file is refused ("refused overwrite") unless --overwrite, except the tab's own
      file. --encoding: utf-8 (default; a tab already bound to a file keeps its encoding) or sjis
      (also shift_jis, shift-jis, cp932): a character Shift_JIS cannot hold is an error that lists
      where, nothing is replaced with "?". No BOM; line endings stay LF. JSON: {tab_id, path,
      bytes, hash, encoding, created}; text: "Saved <path> (<n> bytes)". Flags may follow words.
      If the note is edited during the save the file is written, the tab is NOT bound, and the
      error says so ("conflict").

--tab <id> (set, append, replace, get, save) names a tab from tab list. The writes change that
tab WITHOUT making it the active one, taking the focus or moving the user's caret; a tab that is
not on screen has no undo history (the result's previous_hash lets you check what it was). An
unknown id is an error ("no such tab"). get --selection and replace-selection act on the tab shown
in the focused pane: a tab that is not shown has no selection.

Text: the words after the flags, joined by single spaces; when there are none, standard input
is read if it is piped. Flags go BEFORE the text; put -- first for text that starts with a dash.
Output: text at a terminal, JSON when piped; --json / --text override. Exit 0 ok, 1 error.
`
	case "tab":
		return `md-memo tab <list|switch|new|close|pdf> [options]

Works on the RUNNING app (start MD-Memo first).

  tab list [--json|--text]     List the open tabs: id, title, path, whether active or modified.
  tab switch <id>              Make a tab the active one. Use an id printed by tab list: an
                               unknown id is an error ("no such tab").
  tab new [--title <t>] [--path <file>] [--background] [--json|--text]
                               Open a tab and print its id (JSON: {id, title, path, existing}).
                               Without --path it is a new note (fill it with buffer set --tab <id>);
                               with --path (relative to the current folder) an existing file is
                               read like a file opened from Explorer, and a file that is already
                               open is NOT opened twice: the existing tab's id comes back
                               ("existing": true). --background: the tab appears but is not
                               selected, nothing on screen moves. No text is read from stdin.
  tab close <id> [--if-saved] [--json|--text]
                               Close a tab. Exit 0 and "Closed <id>" only when it is closed.
                               A clean tab closes. A tab with unsaved changes gets the save prompt
                               in the window and the command does NOT wait: exit 1, reason "prompt".
                               With --if-saved nothing is ever asked: the tab closes only when it is
                               bound to a file whose current content equals the tab's text (line
                               endings ignored), otherwise exit 1, reason "unsaved" (a tab with no
                               file is never closed this way). JSON: {closed, reason?}.
                               An unknown id is an error. Flags may follow the id.
  tab pdf [<file>] [-o|--out <file.pdf>] [--tab <id>] [--paper a4|a3|b5|letter] [--landscape]
          [--margin normal|narrow] [--scale N] [--pages 1-3,5] [--header-footer] [--overwrite] [--json|--text]
                               Save a note as a PDF, made by the running app from its preview (white
                               paper, black text, pictures in colour, diagrams light, nothing cut):
                               the same as Save as PDF in the print panel. Which note: <file> (opened
                               in a background tab for the print and closed again; a file that was
                               already open is left open), --tab <id>, or the active tab. --out is
                               required unless <file> is given (then the PDF goes next to it, as
                               <name>.pdf). Never replaces a PDF unless --overwrite. Margin: normal
                               is 20 mm, narrow 10 mm. --header-footer: the file's name above, its
                               folder and the page number below (off by default). The view is put
                               back afterwards. Windows only (a Mac: use the print dialog of the
                               preview); a note must be Markdown, and a huge one can take longer
                               than the 8 s the app allows (an error; the file may still appear).
                               JSON: {path, bytes, pages, tab_id}.

Output: text at a terminal, JSON when piped. Exit 0 ok, 1 error (or a tab that stays open).
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
		return `md-memo agent <prune|install-skill> [options]

Runs on its own (MD-Memo need not be running).

  agent prune [--query <q>] [--file <path>] [--json]
      Keep only the Markdown sections that match the query words, so a long note fits an
      agent's context. Reads the text from --file, or from stdin when --file is not given (it
      waits if stdin is a terminal). JSON: {original_length, pruned_length, ratio, content}.

  agent install-skill [--claude | --codex | --dir <path>] [--force] [--link] [--json|--text]
      Install the agent skill (SKILL.md and references/, about 320 KB) that is built into this
      program, so an agent such as Claude Code can read it. No repository or zip needed: this is
      the way for a Homebrew install, which does not carry the folder. It does not run
      MD-Memo, an agent or the network, and it never reads config.json.
        --claude       Claude Code: ~/.claude/skills/md-memo, or $CLAUDE_CONFIG_DIR/skills/md-memo
                       (the default when no target is given)
        --codex        Codex: $CODEX_HOME/skills/md-memo, else ~/.codex/skills/md-memo.
                       UNVERIFIED: that Codex reads skills from there depends on your Codex
                       version; use --dir if it does not.
        --dir <path>   Into <path>/md-memo (a leading ~ is your home folder)
        --force        Replace what is there even if it was edited, has no marker, comes from a
                       newer md-memo, or is a link. The lost changes are listed.
        --link         Make md-memo a link to a skills/md-memo folder on disk (beside the program,
                       or in the current folder or above: a checkout) so the agent always reads
                       the checkout's text. Not on Windows (links need administrator rights or
                       Developer Mode).
      The copy is made in a temporary sibling folder and renamed into place. A small file,
      .md-memo-skill-version, records the md-memo version and a hash of the content. Run again:
      identical content prints "already up to date" (exit 0); an older copy nobody edited is
      replaced; a folder that was edited, or has no marker, is left alone with the differing
      files listed (exit 1) until you pass --force. Prints where it installed. JSON when piped
      ({action, path, version, hash, files, bytes, target, base}); --json / --text override.
      Exit 0 ok, 1 error.
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
	case "scrap":
		return `md-memo scrap <path|list|search|index> [options]

Runs on its own (MD-Memo need not be running). The scrap folder comes from config.json
(scraps.scrapDir; default ~/Documents/md-memo/scraps). path, list and search create and change
nothing; index writes only the semantic index, which is kept outside the scrap folder.
Dates are YYYY-MM-DD ("Error: invalid date ..." otherwise). Flags may come before or after the
words; put -- before a search text that starts with a dash.

  scrap path [--date YYYY-MM-DD] [--json]
      The path of that day's scrap file (default: today), whether or not it exists yet. It prints
      the bare path even when piped, so $(md-memo scrap path) works; --json gives {date, path, exists}.
  scrap list [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--lines] [--json|--text]
      The daily files (named YYYY-MM-DD.md) directly inside the folder, newest first; other files
      are not listed. JSON: an array of {date, path, size, modified, lines?}; modified is RFC 3339,
      --lines adds the line count (it reads every file). A missing folder gives an empty list.
  scrap search <text> [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--limit N] [--ranked]
              [--semantic [--kind note,log] [--path <pattern>] [--update]] [--json|--text]
      With --ranked: finds NOTES (an entry of a scrap, between two "---" rules or headings) that hold
      the WORDS of the text, on any lines and in any order, best first; "納期 図面" finds a note that
      mentions both. Words are separated by spaces ("quotes" keep a phrase together); in Japanese, a run
      of kanji, katakana or Latin letters is a word and the hiragana particles between them separate
      words. When no note holds every word, the notes that hold at least half of them are listed
      (partial: true). One hit per note: the line with the most words; --limit counts notes. JSON adds
      "ranked": true and, per match, "score" (higher is better) and "partial". Without --ranked:
      Case-insensitive search for the text in every .md file under the folder (sub-folders too,
      folders starting with . skipped): the daily files newest day first, then any other .md file
      by path; stopping after --limit matches (default 100). With --from or --to only files
      named YYYY-MM-DD.md inside the range are searched.
      JSON: {query, count, truncated, matches: [{file, date?, line, text, heading?, heading_line?}]}.
      file is a full path, line is 1-based, date is set when the file name is a date, truncated
      says there were more matches than --limit. heading is the nearest Markdown heading at or
      above the line and heading_line its line number (headings inside code fences do not
      count); text piped in with md-memo is filed under "## [HH:MM:SS] title". Read the
      surrounding lines with the file path and the line numbers.
      With --semantic (experimental): finds notes close in MEANING to the text, best first, one hit
      per note, from the semantic index (see scrap index); "the idea about sustainable building
      materials" finds a note that never says those words. --from/--to bound the day (daily files
      only), --kind keeps notes or piped logs (note, log; AI results are not indexed), --path keeps
      files whose path inside the scrap folder, or whose name, matches a pattern (sub/*.md).
      Files changed since the index was last updated are not in it: their notes are searched by
      words and fill what is left under --limit; --update first brings the index up to date (at
      most 3 seconds). Without --limit a semantic search shows 10 notes (the word searches 100), and
      notes that score below --cutoff (default 0.85) of the best note's score are left out, "notes"
      saying how many; --cutoff 0 keeps them. (The cut is a share of the best score, never a fixed
      score: a model's scores are not comparable between questions or models, and a score is not a
      percentage to show a person.) When the index is empty or made with another model, or the embedding model
      cannot be reached, the search falls back to the ranked word search and says why in "notes".
      Exit 1 when the feature is off or a cloud host has not been allowed. JSON: the fields above
      plus "semantic": true, "pending" (files not in the index), "left_out" (notes the cut-off
      left out), "notes", and per match "kind"
      (note or log), "end_line", "cosine", "context" (the whole note) and "source" ("semantic",
      or "words" for a file that is not indexed yet).
      Every match of every kind of search also has rel (the file's path inside the scrap folder),
      url (its file:// URL), label (the day and heading) and link ([label](url), ready to paste).
  scrap index [--status] [--rebuild] [--dry-run] [--force] [--settle MIN] [--yes] [--json|--text]
      Builds or updates the semantic index of the scrap folder (experimental). Off unless
      config.json has "semantic": {"enabled": true, "model": {"baseUrl": ..., "model": ...}} (for
      example baseUrl http://localhost:11434 and model bge-m3 with Ollama running; a local model
      needs no key). Only the files that changed since the last run are read, and only chunk
      texts that were never embedded are sent to the model, so a run with nothing new costs
      nothing; an interrupted run keeps what it did and goes on the next time. The index lives in
      <settings folder>/index/<id>, never in the scrap folder (the id follows the Git remote of the
      scrap folder, else its path), and can be deleted at any time: it is derived data.
      --status shows the settings, the index and how many files are not in it, and calls no model.
      --dry-run counts what would be embedded and writes nothing. --rebuild makes the index again
      (needed when the model or the chunking changed; the old one is used until the new one is
      done). --force reads every file again. --settle leaves files changed less than MIN minutes
      ago. A model that is not on this machine is used only for a host named in
      semantic.privacy.cloudConsent, its API key comes from semantic.model.apiKey, the key of a
      text or vision model on the same host, or the environment variable MD_MEMO_EMBED_API_KEY,
      and a run that would send more than 1000 chunk texts needs --yes. JSON: {scrap_dir,
      index_dir, model, local, files, files_changed, files_removed, chunks, chunks_new,
      chunks_reused, embedded, seconds, ...}.

Output: text at a terminal, JSON when piped; --json / --text override. Exit 0 ok (no result is
not an error), 1 error.
`
	case "config":
		return `md-memo config get [<key.path>] [--json|--text]

Runs on its own (MD-Memo need not be running). Shows config.json with every secret hidden, so it
is the safe way to look at the settings, also for an AI agent (never read config.json itself: it
holds API keys and tokens).

  config get                 The whole file.
  config get vision          One section (an object).
  config get scraps.scrapDir One value. Names are joined with dots; a number picks an array item.
                             An unknown name: "Error: no such key", exit 1.

Hidden: every string below a key whose name contains apikey, api_key, api-key, token, secret,
password or passwd (at any depth) is shown as "<set>" when it has a value and "<unset>" when it
is empty, with no part of the value; user:password@ in a URL is removed, and so are the values
of key=, token=, ... in a URL query. Numbers and true/false are shown as they are.
Output: JSON (an object or array is pretty-printed; a single value is JSON too when piped, or
bare with --text, which is what a script wants). Exit 0 ok, 1 error (also when config.json is
not valid JSON).
`
	}
	return ""
}
