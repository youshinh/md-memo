package slotagent

import (
	"sort"
	"strings"
)

// What MD-Memo tells the user about agent definitions before they rely on them. Nothing here changes a definition: the
// user's agents.yaml is theirs, so a definition that is out of date or dangerous is reported, never rewritten.
//
// Keep the shell lists in step with frontend/js/agent_risk.js (SHELL_COMMANDS / SHELL_COMMAND_SWITCHES).

// Kinds of AgentIssue.
const (
	// IssueOutdatedDefault: the definition is one MD-Memo shipped earlier and has since replaced (legacyAgentDefaults).
	IssueOutdatedDefault = "outdated-default"
	// IssueShellAppend: the command is a shell (or takes a command switch) and the instruction is appended to its
	// arguments, where the shell runs it as code.
	IssueShellAppend = "shell-append"
	// IssueDefaultDisabled: default_agent names an agent that is disabled, so another one is the default (Detail).
	IssueDefaultDisabled = "default-disabled"
)

// AgentIssue is one thing about an agent definition that the user should look at.
type AgentIssue struct {
	Agent string `json:"agent"` // the agents key
	Kind  string `json:"kind"`  // IssueOutdatedDefault, IssueShellAppend or IssueDefaultDisabled
	// Detail: for IssueOutdatedDefault the built-in agent the definition copies ("claude-code", "codex", "agy"); for
	// IssueShellAppend the shell or the command switch that was found ("powershell", "-c"); for IssueDefaultDisabled the
	// agent that is the default instead ("" when every agent is disabled).
	Detail string `json:"detail"`
	// Suggested: for IssueOutdatedDefault, the current built-in definition to copy over the old one.
	Suggested *AgentDef `json:"suggested,omitempty"`
}

// legacyDefault is an agent definition MD-Memo once shipped and no longer does.
type legacyDefault struct {
	name    string // the built-in agent it was
	command string
	args    []string
}

// legacyAgentDefaults is the one record of retired built-in definitions: the Go default (DefaultSlotConfig), the frontend
// default (slot_agent.js) and the agents.yaml template ("Open agents.yaml") as shipped up to v1.8.0. A user definition
// that still equals one of these (command and args, exactly) is reported by FindAgentIssues.
var legacyAgentDefaults = []legacyDefault{
	// claude-code, all three copies: Claude Code has no --prompt option and its --file takes file_id:path resources, so the
	// instruction never reached it as a prompt. Replaced by print mode (-p).
	{name: "claude-code", command: "claude", args: []string{"--file", "{file}", "--prompt", "{instruction}"}},
	// codex, all three copies: Codex CLI has no --execute or --file option. Replaced by `codex exec`.
	{name: "codex", command: "codex", args: []string{"--execute", "--file", "{file}"}},
	// agy, the Go and frontend default: skipped every permission prompt.
	{name: "agy", command: "agy", args: []string{"-p", "対象ノート: {file}\n指示: {instruction}", "--dangerously-skip-permissions"}},
	// agy, the agents.yaml template: the same flag, without the note path.
	{name: "agy", command: "agy", args: []string{"-p", "{instruction}", "--dangerously-skip-permissions"}},
}

// shellCommands join the arguments after their command switch into one command line; shellCommandSwitches are those
// switches (compared case-insensitively). An instruction appended after them is executed as code.
var (
	shellCommands        = map[string]bool{"powershell": true, "pwsh": true, "cmd": true, "sh": true, "bash": true, "zsh": true}
	shellCommandSwitches = map[string]bool{"-command": true, "/c": true, "-c": true}
)

// appendAllowed is false only for append_instruction: false.
func (d AgentDef) appendAllowed() bool {
	return d.AppendInstruction == nil || *d.AppendInstruction
}

// AppendsInstruction reports whether a run adds the instruction as the last argument: no argument holds "{instruction}"
// and append_instruction is not false.
func (d AgentDef) AppendsInstruction() bool {
	if !d.appendAllowed() {
		return false
	}
	for _, a := range d.Args {
		if strings.Contains(a, "{instruction}") {
			return false
		}
	}
	return true
}

// commandBase is the program name of a command: no folder (either separator, on every OS), lower case, no ".exe".
func commandBase(command string) string {
	c := strings.TrimSpace(command)
	if i := strings.LastIndexAny(c, `/\`); i >= 0 {
		c = c[i+1:]
	}
	c = strings.ToLower(c)
	return strings.TrimSuffix(c, ".exe")
}

// ShellAppendHazard returns what makes def run an appended instruction as code (the shell's name or its command
// switch), or "" when it does not: the instruction is not appended, or the command is not a shell.
func ShellAppendHazard(def AgentDef) string {
	if !def.AppendsInstruction() {
		return ""
	}
	if base := commandBase(def.Command); shellCommands[base] {
		return base
	}
	for _, a := range def.Args {
		if t := strings.TrimSpace(a); shellCommandSwitches[strings.ToLower(t)] {
			return t
		}
	}
	return ""
}

// sameCommandLine: the same command (surrounding spaces ignored) and exactly the same arguments.
func sameCommandLine(command string, args []string, other AgentDef) bool {
	if strings.TrimSpace(command) != strings.TrimSpace(other.Command) || len(args) != len(other.Args) {
		return false
	}
	for i := range args {
		if args[i] != other.Args[i] {
			return false
		}
	}
	return true
}

// legacyDefaultName returns the built-in agent whose retired definition def still is ("" when it is none, or when
// that is also today's built-in definition).
func legacyDefaultName(def AgentDef, current map[string]AgentDef) string {
	for _, l := range legacyAgentDefaults {
		if sameCommandLine(l.command, l.args, def) && !sameCommandLine(def.Command, def.Args, current[l.name]) {
			return l.name
		}
	}
	return ""
}

// FindAgentIssues lists, sorted by agent key, what the user should know about these agent definitions: copies of a
// retired built-in definition, and shells that would run an appended instruction as code.
func FindAgentIssues(agents map[string]AgentDef) []AgentIssue {
	return findAgentIssues(agents, DefaultSlotConfig().Agents)
}

// findAgentIssues is FindAgentIssues against the given built-in definitions (current).
func findAgentIssues(agents, current map[string]AgentDef) []AgentIssue {
	keys := make([]string, 0, len(agents))
	for k := range agents {
		keys = append(keys, k)
	}
	sort.Strings(keys)

	var issues []AgentIssue
	for _, k := range keys {
		def := agents[k]
		if name := legacyDefaultName(def, current); name != "" {
			issue := AgentIssue{Agent: k, Kind: IssueOutdatedDefault, Detail: name}
			if s, ok := current[name]; ok {
				issue.Suggested = &s
			}
			issues = append(issues, issue)
		}
		if found := ShellAppendHazard(def); found != "" {
			issues = append(issues, AgentIssue{Agent: k, Kind: IssueShellAppend, Detail: found})
		}
	}
	return issues
}

// RunAgentFor names the agent RunSlotAgentAsync starts for target (nil: an approved gate resuming a recipe) under cfg,
// and its definition, following the same rules: a recipe runs the default agent; a slot runs its "@agent", else its
// profile's agent, else the default agent, and an unusable choice (unknown, or no command) falls back to the default
// agent and then to the built-in claude-code. An "@agent" is never swapped for another one.
// The frontend uses the answer (ParseSlotsRPC's runAgent) to ask before a risky agent runs; app_slot_test.go checks that
// it names the definition the run really gets.
func RunAgentFor(cfg SlotConfig, target *SlotMatch) (string, AgentDef) {
	builtin := func() (string, AgentDef) {
		// The built-in claude-code is only a last resort, and never when it is switched off.
		if _, off := cfg.DisabledAgentKey("claude-code"); off {
			return "", AgentDef{}
		}
		return "claude-code", DefaultSlotConfig().Agents["claude-code"]
	}
	if target == nil || target.Type == "recipe" {
		def := cfg.Agents[cfg.DefaultAgent]
		if def.Command == "" {
			return builtin()
		}
		return cfg.DefaultAgent, def
	}
	name := cfg.DefaultAgent
	if target.DisabledAgent != "" {
		// "@agent" of a disabled agent: no definition to run (RunProblemFor says why)
		return target.DisabledAgent, AgentDef{}
	}
	if target.AgentName != "" {
		name = target.AgentName
	} else if target.Profile != nil && target.Profile.Agent != "" {
		name = target.Profile.Agent
		if _, ok := cfg.Agents[name]; !ok {
			if shown, off := cfg.DisabledAgentKey(name); off {
				return shown, AgentDef{} // a profile that names a disabled agent is not swapped for the default one
			}
		}
	}
	def, exists := cfg.Agents[name]
	if target.AgentName != "" {
		return name, def
	}
	if !exists || def.Command == "" {
		name = cfg.DefaultAgent
		def = cfg.Agents[cfg.DefaultAgent]
	}
	if def.Command == "" {
		return builtin()
	}
	return name, def
}
