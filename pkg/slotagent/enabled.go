package slotagent

import (
	"fmt"
	"sort"
	"strings"
)

// Switching agents off. An agent with `enabled: false`, or whose key is listed under `disabled_agents`, is disabled: it
// is left out of the config every consumer sees, so the Auto selector, the quick selector, snippets, profiles and
// recipes can never choose it, and the built-in defaults never bring it back. The keys stay on the wire
// (SlotConfig.DisabledAgents) so a note that names one gets a clear message (RunProblemFor) instead of "skill not found"
// or a run by some other agent.
//
// finalizeAgents is the one step that applies all this; it runs at the end of complementSlotConfig, MergeSlotConfig and
// (for what the page adds) App.buildActiveSlotConfig. frontend/js/slot_agent.js (finalizeAgentConfig) does the same for
// the page's own copy: keep the two in step (tests/agent_switch_parity_test.mjs).

// agentFallbackOrder is the order in which the default agent is chosen when default_agent names a disabled agent: the
// first of these that is enabled, then the other agents by key. It is the order the manual and the agents.yaml template
// list the built-in agents in.
var agentFallbackOrder = []string{"claude-code", "hermes", "codex", "agy"}

// IsEnabled is false only for enabled: false.
func (d AgentDef) IsEnabled() bool {
	return d.Enabled == nil || *d.Enabled
}

// disabledKeys returns the agents cfg switches off: lower-case key -> the key as it is shown (the spelling of an agents
// entry, else the built-in agent's, else the one written in disabled_agents). nil when nothing is switched off.
func disabledKeys(cfg SlotConfig) map[string]string {
	// The usual case, nothing switched off, costs one look at the agents and allocates nothing.
	anyOff := len(cfg.DisabledAgents) > 0
	for _, def := range cfg.Agents {
		if !def.IsEnabled() {
			anyOff = true
			break
		}
	}
	if !anyOff {
		return nil
	}
	var off map[string]string
	add := func(key string) {
		k := strings.TrimSpace(key)
		if k == "" {
			return
		}
		lower := strings.ToLower(k)
		if _, ok := off[lower]; ok {
			return
		}
		if off == nil {
			off = make(map[string]string)
		}
		off[lower] = k
	}
	keys := make([]string, 0, len(cfg.Agents))
	for k := range cfg.Agents {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		if !cfg.Agents[k].IsEnabled() {
			add(k)
		}
	}
	for _, k := range cfg.DisabledAgents {
		lower := strings.ToLower(strings.TrimSpace(k))
		if _, ok := off[lower]; !ok {
			for _, b := range agentFallbackOrder {
				if b == lower {
					k = b // "AGY" in the list is still the built-in agy
				}
			}
			add(k)
		}
	}
	// A listed key that names an agents entry takes that entry's spelling.
	for _, k := range keys {
		if _, ok := off[strings.ToLower(k)]; ok {
			off[strings.ToLower(k)] = k
		}
	}
	return off
}

// DisabledAgentKey reports whether name (an agents key, with or without "@", any case) is an agent cfg switched off, and
// returns the key as listed. Aliases do not count: a disabled agent's aliases are free again.
func (c SlotConfig) DisabledAgentKey(name string) (string, bool) {
	name = strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(name), "@"))
	if name == "" {
		return "", false
	}
	k, ok := disabledKeys(c)[strings.ToLower(name)]
	return k, ok
}

// finalizeAgents applies enabled: false and disabled_agents to cfg and returns the config every consumer works on:
//   - Agents holds only enabled agents (their aliases go with them), DisabledAgents the sorted keys that were switched
//     off (either spelling, merged), nil when none;
//   - a default_agent that names a disabled agent (or, when claude-code is disabled, one that names nothing usable, which
//     would otherwise fall back to claude-code) becomes the first usable enabled agent (agentFallbackOrder), "" when
//     there is none, and DefaultAgentDisabled remembers what the file said.
//
// keepDisabled (for a config that is written back to disk, ParseAgentConfigFileForSave): the disabled definitions stay in
// Agents, marked enabled: false, so saving loses nothing. cfg itself is not modified (maps are copied).
func finalizeAgents(cfg SlotConfig, keepDisabled bool) SlotConfig {
	prevDefault := cfg.DefaultAgentDisabled // a second pass over a finalised config keeps what the first one noted
	cfg.DefaultAgentDisabled = ""
	off := disabledKeys(cfg)
	if len(off) == 0 {
		cfg.DisabledAgents = nil
		return cfg
	}

	enabled := make(map[string]AgentDef, len(cfg.Agents))
	kept := enabled
	if keepDisabled {
		kept = make(map[string]AgentDef, len(cfg.Agents))
	}
	for k, def := range cfg.Agents {
		if _, isOff := off[strings.ToLower(k)]; isOff {
			if keepDisabled {
				no := false
				def.Enabled = &no
				kept[k] = def
			}
			continue
		}
		enabled[k] = def
		if keepDisabled {
			kept[k] = def
		}
	}

	names := make([]string, 0, len(off))
	for _, k := range off {
		names = append(names, k)
	}
	sort.Strings(names)
	cfg.DisabledAgents = names

	if def := strings.TrimSpace(cfg.DefaultAgent); def != "" {
		if shown, isOff := off[strings.ToLower(def)]; isOff {
			cfg.DefaultAgentDisabled = shown
			cfg.DefaultAgent = firstUsableAgent(enabled)
		} else if _, ccOff := off["claude-code"]; ccOff && enabled[def].Command == "" {
			cfg.DefaultAgent = firstUsableAgent(enabled)
		}
	}
	if shown, still := off[strings.ToLower(prevDefault)]; cfg.DefaultAgentDisabled == "" && prevDefault != "" && still {
		cfg.DefaultAgentDisabled = shown
	}
	cfg.Agents = kept
	return cfg
}

// FinalizeAgents is finalizeAgents for a caller that merged agents into a config itself (App.buildActiveSlotConfig adds
// the definitions the page sends): apply the switches once more, at the end.
func FinalizeAgents(cfg SlotConfig) SlotConfig {
	return finalizeAgents(cfg, false)
}

// firstUsableAgent is the enabled agent with a command that comes first in agentFallbackOrder, else the smallest key
// ("" when no agent has a command).
func firstUsableAgent(agents map[string]AgentDef) string {
	for _, k := range agentFallbackOrder {
		if agents[k].Command != "" {
			return k
		}
	}
	keys := make([]string, 0, len(agents))
	for k, def := range agents {
		if def.Command != "" {
			keys = append(keys, k)
		}
	}
	if len(keys) == 0 {
		return ""
	}
	sort.Strings(keys)
	return keys[0]
}

// Kinds of RunProblem.
const (
	// ProblemDisabled: the run names an agent that is disabled ({{ @agy ... }}, or a profile whose agent is one).
	ProblemDisabled = "disabled"
	// ProblemNoneEnabled: every agent is disabled, so there is none to run.
	ProblemNoneEnabled = "none-enabled"
	// ProblemMissing: the agent's program was not found in PATH. Only says the program is missing; whether it can serve
	// the agent (an Ollama model that is not pulled yet, say) is not looked at.
	ProblemMissing = "missing"
)

// RunProblem is why a run cannot start, found before any process is started and before the note is touched. The
// frontend words it in the UI language from Kind, Agent and Command; Message is the same in English and Japanese, for
// callers without a dictionary.
type RunProblem struct {
	Kind    string `json:"kind"`
	Agent   string `json:"agent,omitempty"`
	Command string `json:"command,omitempty"`
	Message string `json:"message"`
}

// NewRunProblem builds a RunProblem with its Message.
func NewRunProblem(kind, agent, command string) *RunProblem {
	en, ja := problemSentences(kind, agent, command)
	return &RunProblem{Kind: kind, Agent: agent, Command: command, Message: en + " / " + ja}
}

// problemSentences: the English sentence and the Japanese one for a problem. frontend/js/i18n.js has the same texts
// (agentRunDisabled, agentRunNoneEnabled, agentRunMissing).
func problemSentences(kind, agent, command string) (string, string) {
	switch kind {
	case ProblemDisabled:
		return fmt.Sprintf(`Agent "%s" is disabled in agents.yaml (enabled: false)`, agent),
			fmt.Sprintf(`エージェント「%s」は agents.yaml で無効です (enabled: false)`, agent)
	case ProblemNoneEnabled:
		return "No agent is enabled: every agent is disabled in agents.yaml (enabled: false)",
			"有効なエージェントがありません: agents.yaml のすべてのエージェントが無効です (enabled: false)"
	case ProblemMissing:
		return fmt.Sprintf(`Agent "%s" needs "%s", which was not found in PATH. Install it or choose another agent in agents.yaml.`, agent, command),
			fmt.Sprintf(`エージェント「%s」には「%s」が必要ですが、PATH に見つかりません。インストールするか、agents.yaml で別のエージェントを選んでください。`, agent, command)
	}
	return "The agent cannot run", "エージェントを実行できません"
}

// RunProblemFor says why a run of target (nil: an approved gate resuming a recipe) cannot start because of what is
// switched off, or nil. The agent is the one RunAgentFor names: an "@agent" or a profile's agent that is disabled is an
// error and is never swapped for another agent, and with every agent disabled nothing runs.
func RunProblemFor(cfg SlotConfig, target *SlotMatch) *RunProblem {
	key, def := RunAgentFor(cfg, target)
	if def.Command != "" {
		return nil
	}
	if key == "" {
		return NewRunProblem(ProblemNoneEnabled, "", "")
	}
	if shown, off := cfg.DisabledAgentKey(key); off {
		return NewRunProblem(ProblemDisabled, shown, "")
	}
	return nil
}
