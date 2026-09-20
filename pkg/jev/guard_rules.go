package jev

import (
	"fmt"
	"regexp"
	"strings"
)

// Limits on user rules. Rules come from files an agent can write, so they are bounded: a rule file must
// not be able to make every verification slow or memory hungry.
const (
	maxRuleEntries    = 100
	maxRulePatterns   = 32
	maxRulePatternLen = 256
	maxRuleNameLen    = 64
)

// PatternSpec is one user-supplied blocked pattern. Regex is RE2 (linear time, so a hostile pattern
// cannot stall the checker).
type PatternSpec struct {
	ID     string
	Regex  string
	Reason string
}

// Rules are extra restrictions layered on top of the built-in guard (they come from jev.json and a
// project's .jev.json). They can only make a verdict stricter: there is deliberately no field that
// allows, permits or exempts anything, so a rules file written by an agent can never loosen the guard.
// A nil *Rules means "no extra rules" and is valid everywhere.
type Rules struct {
	blockCmds map[string]bool
	warnCmds  map[string]bool
	protected []string
	patterns  []rxRule
}

// NewRules validates and compiles a rule set.
//
//   - blockCommands / warnCommands are command names (a path or an extension is ignored, and matching
//     also sees the command behind sudo, xargs, bash -c and the like). A blocked command is refused in
//     every mode; a warned command asks first in ModeStrict and ModeReviewed and is refused in
//     ModeUnattended.
//   - protectedPaths are directories that redirects must not write into. The caller expands "~".
//   - patterns are regular expressions matched against the whole command; a hit is refused.
func NewRules(blockCommands, warnCommands, protectedPaths []string, patterns []PatternSpec) (*Rules, error) {
	if len(blockCommands) > maxRuleEntries || len(warnCommands) > maxRuleEntries || len(protectedPaths) > maxRuleEntries {
		return nil, fmt.Errorf("too many entries (at most %d per list)", maxRuleEntries)
	}
	if len(patterns) > maxRulePatterns {
		return nil, fmt.Errorf("too many patterns (at most %d)", maxRulePatterns)
	}

	r := &Rules{}
	var err error
	if r.blockCmds, err = ruleNames("block_commands", blockCommands); err != nil {
		return nil, err
	}
	if r.warnCmds, err = ruleNames("warn_commands", warnCommands); err != nil {
		return nil, err
	}
	for i, p := range protectedPaths {
		p = strings.TrimSpace(p)
		if p == "" {
			return nil, fmt.Errorf("protected_paths[%d]: empty path", i)
		}
		r.protected = append(r.protected, normalizeRulePath(p))
	}
	for i, p := range patterns {
		if !validRuleID(p.ID) {
			return nil, fmt.Errorf("block_patterns[%d]: id %q must be 1-%d characters of letters, digits, '_', '-', '.' or ':'", i, p.ID, maxRuleNameLen)
		}
		if p.Regex == "" || len(p.Regex) > maxRulePatternLen {
			return nil, fmt.Errorf("block_patterns[%d] (%s): regex must be 1-%d characters", i, p.ID, maxRulePatternLen)
		}
		re, err := regexp.Compile(p.Regex)
		if err != nil {
			return nil, fmt.Errorf("block_patterns[%d] (%s): invalid regex: %v", i, p.ID, err)
		}
		reason := strings.TrimSpace(p.Reason)
		if reason == "" {
			reason = fmt.Sprintf("jev.json のパターン %q に一致したため拒否されました (Blocked by jev.json pattern)", p.ID)
		}
		r.patterns = append(r.patterns, rxRule{id: p.ID, re: re, reason: reason})
	}
	return r, nil
}

// Empty reports whether the rule set changes nothing.
func (r *Rules) Empty() bool {
	return r == nil || (len(r.blockCmds) == 0 && len(r.warnCmds) == 0 && len(r.protected) == 0 && len(r.patterns) == 0)
}

// blockedName reports the rule's own name for a command that the block list names ("terraform" for
// terraform.exe), so a verdict quotes what the user wrote in jev.json.
func (r *Rules) blockedName(base, stem string) (string, bool) {
	if r == nil {
		return "", false
	}
	if r.blockCmds[base] {
		return base, true
	}
	if r.blockCmds[stem] {
		return stem, true
	}
	return "", false
}

func (r *Rules) warnedName(base, stem string) (string, bool) {
	if r == nil {
		return "", false
	}
	if r.warnCmds[base] {
		return base, true
	}
	if r.warnCmds[stem] {
		return stem, true
	}
	return "", false
}

// knows reports whether either list names the command, so a wrapper scan looks for it too.
func (r *Rules) knows(base, stem string) bool {
	_, blocked := r.blockedName(base, stem)
	_, warned := r.warnedName(base, stem)
	return blocked || warned
}

// protects reports whether path (already lower-cased and slash-normalised) is inside a user-protected
// directory.
func (r *Rules) protects(path string) bool {
	if r == nil {
		return false
	}
	for _, dir := range r.protected {
		if path == dir || strings.HasPrefix(path, strings.TrimSuffix(dir, "/")+"/") {
			return true
		}
	}
	return false
}

func ruleNames(field string, in []string) (map[string]bool, error) {
	if len(in) == 0 {
		return nil, nil
	}
	out := make(map[string]bool, len(in))
	for i, n := range in {
		n = strings.TrimSpace(n)
		if n == "" || len(n) > maxRuleNameLen || strings.ContainsAny(n, " \t\r\n") {
			return nil, fmt.Errorf("%s[%d]: %q must be a single command name of at most %d characters", field, i, n, maxRuleNameLen)
		}
		base, stem := commandBase(n)
		out[base] = true
		out[stem] = true
	}
	return out, nil
}

func normalizeRulePath(p string) string {
	return normalizePath(p)
}

func validRuleID(id string) bool {
	if id == "" || len(id) > maxRuleNameLen {
		return false
	}
	for _, c := range id {
		switch {
		case c >= 'a' && c <= 'z', c >= 'A' && c <= 'Z', c >= '0' && c <= '9', c == '_', c == '-', c == '.', c == ':':
		default:
			return false
		}
	}
	return true
}
