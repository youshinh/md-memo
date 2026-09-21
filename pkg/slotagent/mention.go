package slotagent

import (
	"sort"
	"strings"
)

// Where a finished run's text goes: OutputModeReplace overwrites the slot (every legacy form),
// OutputModeBelow keeps the instruction line and lets the frontend put the result under it.
const (
	OutputModeReplace = "replace"
	OutputModeBelow   = "below"
)

// ResolveAgentName maps the name after "@" in a slot to a key of cfg.Agents. An exact key wins,
// then a case-insensitive key, then an alias; ties are broken by the smallest key so the answer
// never depends on map order.
func ResolveAgentName(cfg SlotConfig, name string) (string, bool) {
	name = strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(name), "@"))
	if name == "" || len(cfg.Agents) == 0 {
		return "", false
	}
	if _, ok := cfg.Agents[name]; ok {
		return name, true
	}
	keys := make([]string, 0, len(cfg.Agents))
	for k := range cfg.Agents {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		if strings.EqualFold(k, name) {
			return k, true
		}
	}
	for _, k := range keys {
		for _, a := range cfg.Agents[k].Aliases {
			if strings.EqualFold(strings.TrimSpace(a), name) {
				return k, true
			}
		}
	}
	return "", false
}

// fillDefaultAliases gives the built-in agents their default aliases when a config written
// before aliases existed redefines them without any. An explicit list (even an empty one) is
// kept as is, and a default alias that is already another agent's key or explicit alias is
// skipped so the defaults never take a name away from the user.
func fillDefaultAliases(agents map[string]AgentDef) {
	taken := make(map[string]bool, len(agents)*2)
	for k, def := range agents {
		taken[strings.ToLower(k)] = true
		for _, a := range def.Aliases {
			taken[strings.ToLower(strings.TrimSpace(a))] = true
		}
	}
	defaults := DefaultSlotConfig().Agents
	for k, def := range agents {
		if def.Aliases != nil {
			continue
		}
		d, ok := defaults[k]
		if !ok {
			continue
		}
		var keep []string
		for _, a := range d.Aliases {
			if !taken[strings.ToLower(a)] {
				keep = append(keep, a)
			}
		}
		if len(keep) > 0 {
			def.Aliases = keep
			agents[k] = def
		}
	}
}
