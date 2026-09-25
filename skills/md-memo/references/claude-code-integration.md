# Wiring MD-Memo to Claude Code (`{{ @cc ... }}`) safely

Read this before you create or change an agent in `agents.yaml` that starts Claude Code, or before you add a command-limited agent (a "runner"). It is the measured part of that job: what goes wrong, why, how to avoid it, how to check.

**Basis and limits.** Everything below was measured by the maintainer on Windows with a Claude Code CLI of 2026-09-25 (`claude --help` reported version 2.1.225 at the time), driving it from MD-Memo slots. Nothing here was run on macOS or Linux. Claude Code changes its flags and permission behaviour between versions: before you rely on a flag, run `claude --help` and try the flag on a throwaway note. Each item says whether it is a **Fact** (observed) or an **Inference**. This repository's own tests never start Claude Code, so none of this is covered by CI.

**Cost.** Every real check below runs `claude -p`, which uses the user's Claude Code quota. Say so before you run them and run each once.

## 0. What MD-Memo does on its own side (1.9.0)

Some of the traps below are handled or reported by MD-Memo itself since 1.9.0 (details in `interfaces.md` 3.1.3 and `setup-guide.md` (c)):

- The built-in `claude-code` agent is now `claude -p "<note path and instruction>"` (before: `--file {file} --prompt {instruction}`, which Claude Code does not accept), `codex` is `codex exec {instruction}`, and `agy` no longer carries `--dangerously-skip-permissions`. An `agents.yaml` written earlier keeps its old definitions (the merge never overrides a user's definition); Settings -> Agent lists them under "Agent definitions to review" and offers the new definition to copy.
- Before an agent whose arguments contain a skip-permissions flag (or a shell that would run the instruction as code) runs, MD-Memo asks the user once per exact command line.
- `agents.<name>.append_instruction: false` stops the instruction being appended as the last argument.

Not in 1.9.0: a per-agent `enabled: false` (so item 1 below still needs the stub workaround) and long-path expansion of the temp note (item 6).

## 1. The shape of a read-only `claude-code` agent

A definition that lets Claude Code read the note and the scraps folder, optionally search the web, and nothing else. It is the maintainer's working shape, given here as a pattern (paths are examples):

```yaml
agents:
  claude-code:
    description: "Claude Code, read-only (notes and web)"
    command: C:/Users/you/.local/bin/claude.exe        # full path, not `claude`
    aliases: [claude, cc]
    args:
      - -p
      - --tools
      - Read,Grep,Glob,WebSearch,WebFetch              # drop the web tools if you do not want the web
      - --allowedTools
      - WebSearch,WebFetch,Read(C:/Users/you/AppData/Local/Temp/md-memo-slot-*.md)
      - --disallowedTools
      - Read(**/.env),Read(**/*.cnf)                   # your secret-file patterns
      - --permission-mode
      - dontAsk
      - --strict-mcp-config
      - --no-session-persistence
      - --setting-sources
      - user
      - --add-dir
      - D:/notes/scraps
      - --append-system-prompt
      - "Answer in plain Markdown. Target note: {file}"
      - "Request: {instruction}"                       # one argument, with a prefix (item 4)
```

Why each part is there is in the items below: `-p` (3), the `Request:` prefix (4), no bare `Read` allow rule (5), the temp-note rule (6), `--setting-sources user` and `dontAsk` (10), `--add-dir` (12). `--strict-mcp-config` and `--no-session-persistence` keep MCP servers and session files out of a read-only run. Do not add a permission-skipping flag (`--dangerously-skip-permissions`, `--permission-mode bypassPermissions` or an auto mode): MD-Memo asks the user once per command line before it runs an agent that has one, and nothing in this setup needs it.

## 2. Traps, each with a check

### 1. A built-in agent comes back after you delete it
- **Fact.** `hermes`, `codex`, `agy` and `claude-code` are added again to the merged configuration whenever `agents.yaml` does not define them, with their built-in definition (in versions up to 1.8.0 `agy` had a skip-permissions flag).
- **Do.** Do not delete: override. A definition that cannot start anything useful and says so, e.g. `python -c "import sys; print('disabled by policy'); sys.exit(1)" "{instruction}"`, with `aliases: []` so the default aliases (`gemini`, `antigravity`) go too. Write `{instruction}` yourself (item 2).
- **Check.** Run one note line per overridden agent (`{{ @codex test }}`); the result must be the "disabled" message, and a hostile instruction such as `"; echo PWNED"` must not appear as command output.

### 2. The instruction is appended when `args` has no `{instruction}`
- **Fact.** Without a `{instruction}` placeholder in `args`, MD-Memo appends the instruction as the last argument. For `powershell -Command`, `cmd /c`, `sh -c` and the like, the note text is then run as code.
- **Do.** Never use those as a stub. Either pass the text as an explicit last argument to a program that treats it as data (`python -c "<code>" "{instruction}"`), or set `append_instruction: false` (1.9.0) for an agent that works from `{file}` alone. MD-Memo 1.9.0 also warns in Settings when a shell would receive an appended instruction.
- **Check.** Send `{{ @agentname echo PWNED2 }}` to the agent: nothing may run.

### 3. `--file` and `--prompt` are not Claude Code flags
- **Fact.** Old templates and examples (and the built-in default up to 1.8.0) used `claude --file {file} --prompt {instruction}`. Claude Code's non-interactive mode is `-p "<prompt>"`; `--file` means "file resources to download at start-up" (`file_id:path`).
- **Do.** Use `-p` and put the instruction (with the prefix of item 4) as the final argument.
- **Check.** A summary request on a small note returns text and exit code 0.

### 4. A bare instruction can become an option or a sub-command
- **Fact.** If the last argument is exactly what the note says, an instruction such as `--version` or `update` is read by Claude Code as its own option or sub-command.
- **Do.** Always prefix and pass as ONE argument: `"Request: {instruction}"`.
- **Check.** Write `{{ @cc --version }}`: the answer must not be Claude Code's version string.

### 5. A bare `Read`, `Grep` or `Glob` allow rule is not limited to a folder
- **Fact.** An allow rule that names only the tool (no path) lets Claude read outside the working folder and the `--add-dir` folders.
- **Do.** Do not allow bare `Read`/`Grep`/`Glob`. The working folder and every `--add-dir` are readable without any rule. Allow only the extra places, with a path (item 6).
- **Check.** Ask for a file outside those folders; nothing of it may appear in the result.

### 6. An 8.3 short path cannot be allowed
- **Fact.** For an unsaved note MD-Memo writes `md-memo-slot-*.md` to the temp folder and gives its path as `{file}`. When `%TEMP%` is an 8.3 path (`C:\Users\LONGNA~1\AppData\Local\Temp\...`, typical for long user names), a `Read(<long path>/md-memo-slot-*.md)` allow rule does not match it and `dontAsk` refuses the read. **Inference:** rules compare path strings, so the short and the long form of one folder are two different paths.
- **Do.** Start Claude Code through a small launcher that turns the temp-folder part of every argument into the long form first (Windows: `GetLongPathNameW`), then runs the fixed full path of `claude.exe`. MD-Memo may do this expansion itself in a later version: check `interfaces.md`.
- **Check.** Put a note in the temp folder by its 8.3 path and ask for a summary that must contain a number from the note.

### 7. A command that only reads can slip past allow rules (and how it really went)
- **Fact (first observation).** With Bash allowed for a prefix, `hostname` (read-only) and `$(...)` substitutions appeared to run although no rule allowed them, even with a PreToolUse hook that should have stopped them.
- **Fact (cause, found later, item 8).** The hook never ran: its command line had Windows backslashes and failed with exit 127, which Claude Code treats as "do not block". The hook logic was right.
- **Do.** Any agent that has Bash gets, next to its allow rules, a PreToolUse hook that limits the FORM of the command (section 3), and its hook command is written as item 8 says.
- **Check.** Ask the agent to run three things, with its prompt temporarily changed to "try the command as asked": `hostname`, `echo x > somefile`, `echo "$(hostname)"`. All three must be blocked, no file may appear and the host name must not be printed. If one gets through, do not accept it as a known limit: treat it as item 8 again.

### 8. A failing hook does not stop anything
- **Fact.** Claude Code blocks only when a hook exits with code 2. A crash, a start-up failure (exit 127), a time-out or any other exit code lets the command through (fail-open). On Windows, a hook command containing `C:\path\hook.py` failed with exit 127 because the command is run through Git Bash and the backslashes act as escapes.
- **Do.** (a) Write the hook command as the full path of `python.exe -I <hook.py> ...` with FORWARD slashes everywhere, in double quotes so a path with spaces survives. (b) In the hook script catch every exception (`except BaseException`) and exit 2. (c) Never build the command with a path function's raw backslash output.
- **Check.** Run the generated hook command by hand as `bash -c "<command> <an input that must be refused>"`: the exit code must be 2. Scan every `hooks.*[].hooks[].command` in `agents.yaml`, the runner settings files and `~/.claude/settings.json` for a backslash.

### 9. Cancelling in MD-Memo stops only the launcher
- **Fact.** If a launcher sits between MD-Memo and `claude.exe`, cancelling or a time-out ends the launcher; `claude.exe` and anything below it can keep running (child processes do not die with their parent on Windows).
- **Do.** The launcher puts itself into a job object with "kill on close" before it starts `claude.exe`, and starts it by the fixed full path (no PATH search, so a look-alike earlier in PATH or in the working folder is never picked).
- **Check.** Start a long run, cancel it, look for a remaining `claude` process. This was covered by a unit test only, not by a real cancel.

### 10. Project settings of the note's folder leak in
- **Fact.** By default Claude Code also reads `.claude/settings.json` and `settings.local.json` of the folder it starts in, so hooks and permissions from an unrelated project apply. The user's global `defaultMode` applies too.
- **Do.** `--setting-sources user` on every agent, and `--permission-mode dontAsk` written explicitly on every agent (do not rely on the global default).
- **Check.** Scan all generated agents for both flags.

### 11. MD-Memo's own settings folder holds secrets
- **Fact.** `config.json` holds API keys and tokens; `session.json` holds unsaved notes. `agents.yaml` sits in the same folder.
- **Do.** Claude Code must not read or print them: a `Read(<config folder>/config.json*)` deny rule plus a hook are what the maintainer used. To let an agent SEE settings, use `md-memo config get [key.path]` (1.9.0): it prints the file with every secret replaced by `<set>` / `<unset>`. Settings are changed by the user in MD-Memo's Settings dialog, not by an agent.
- **Check.** Ask Claude Code to print `config.json`: it must be refused.

### 12. Bash does not keep a `cd` outside the project
- **Fact.** In Claude Code's Bash tool the working folder returns to the start folder after each command when you `cd` outside the project (PowerShell keeps it).
- **Do.** List every folder an agent must read in `--add-dir`; do not build on `cd`.
- **Check.** Run the runner's real task and see which folders it reached.

### 13. `agents.yaml` opened as a tab is autosaved half-typed
- **Fact.** With `agents.yaml` open as a tab, autosave writes intermediate typing. A broken file makes MD-Memo fall back to its built-in agents, which used to include skip-permissions flags.
- **Do.** Do not leave `agents.yaml` open as a tab except for the moment of editing; validate the YAML (and the checks above) BEFORE you write it, keep a dated backup beside it, and restart MD-Memo only after the checks pass (it reads `agents.yaml` at start-up).
- **Check.** After writing, run your static checks again and look at Settings -> Agent: the agents you defined must be listed, with no "Agent definitions to review" for them.

## 3. Runners: an agent that may run only certain commands

`claude-code` above has no Bash. A **runner** is an agent that has Bash but may run only commands that start with a fixed prefix (a query tool, an internal CLI). Use one only for a concrete job that needs a command.

**The command-line tool behind it is the real safety boundary.** Allow rules and hooks say "nothing but this prefix"; they do not say the prefix is safe. The tool must be a fixed, human-reviewed program, not something the agent writes, and it should:
- validate its input with an allow-list (writes, dangerous functions, targets you did not list are refused; do not rely on a deny-list alone);
- cap the size of the answer and the running time;
- keep its own local log of what was asked and what happened;
- never print connection strings, keys or passwords, on standard output, standard error or in the log;
- run one call at a time (serialise, or refuse a second one);
- offer a harmless `--dry-run` or `--ping` so that wiring can be tested without touching the real target.

**Settings file of a runner** (passed with `--settings <file>`; a sketch of what the maintainer generated):
- `permissions.allow`: `Skill`, the temp-note read rule (item 6), and one `Bash(<prefix>:*)` for each allowed prefix;
- `permissions.deny`: `WebFetch`, `WebSearch`, `Edit`, `Write`, `NotebookEdit`, and `Read(...)` for your secret-file patterns;
- `hooks.PreToolUse` with matcher `Bash`: the hook of item 8 with the list of allowed prefixes.

**The prefix** is compared as text from the start. Cut it at the smallest piece that stays safe with anything after it: fix `--target prod`, leave the query as later arguments. Never allow a broad prefix such as `python`. The runner's agent line looks like the one in section 1 with `--tools Read,Grep,Glob,Bash,Skill`, `--settings <file>`, the same `dontAsk`, `--setting-sources user` and `Request:` prefix, and a system prompt that states the role, the argument format and what to refuse.

**What the hook must refuse after the prefix.** Beyond a prefix match, refuse these outside quotes in the rest of the command: `; & | < > ( ) $` a backtick, a line break, `{ } * ? ~ # [ ]` and a backslash; inside double quotes refuse `$` and a backtick (an escaped `\$` is fine); inside single quotes anything is fine (the shell expands nothing). That closes "allowed prefix, then a chained command, a redirect or a substitution".

**Anti-patterns.** A wide prefix. Giving a runner `Edit`/`Write`/`WebFetch`/`WebSearch` back. Relying on allow rules without the hook (item 7). Using a tool that the agent itself wrote or changed without a fixed review.

**Check (three shapes, once per runner).** The triple of item 7 must be blocked; then a normal call with the allowed prefix must work; then run the tool's own `--dry-run`.

## 4. Rules for the agent that does this setup

- Do not read `config.json` or `session.json`, do not print them, and do not ask the user to paste keys. Use `md-memo config get`.
- Do not use `md-memo ui eval` and do not suggest it: it runs arbitrary JavaScript in MD-Memo.
- Do not start, quit or restart MD-Memo, and do not press Ctrl+Enter in a note: the user does it. The slots run agents.
- Do not write a permission-skipping flag into anything you generate.
- Back up every file you change next to it with a dated name, and tell the user how to put it back. Files typically involved: MD-Memo's `agents.yaml`, `~/.claude/settings.json`, any launcher or wrapper script.
- Before the first real run, list what will be written where and wait for the user's yes. Say that the checks use quota.

## 5. A checklist to end with

Static (free): every generated agent has `--permission-mode dontAsk` and `--setting-sources user`; no skip flag anywhere; no bare `Read`/`Grep`/`Glob` allow; every hook command has forward slashes only; `agents.yaml` parses; Settings -> Agent shows no unexpected "definitions to review".

Real (one `claude -p` call each): a summary works (rc 0); a request for a file outside the folders returns nothing of it; `--version` as an instruction is not read as an option; each overridden built-in answers "disabled"; a note in the 8.3 temp path can be summarised; for each runner the triple of item 7 is blocked.

Then the user restarts MD-Memo, types a snippet or `{{ @cc ... }}` in a note and runs it with Ctrl+Enter.
