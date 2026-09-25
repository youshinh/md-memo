package main

import (
	"encoding/json"
	"strings"

	"md-memo/pkg/slotagent"
)

// Agent safety: what the frontend needs to ask before a risky agent runs (ParseSlotsRPC's runAgent) and to tell the
// user about agent definitions worth a look (GetActiveSlotConfigJSON's agent_issues). The checks themselves live in
// pkg/slotagent/safety.go and frontend/js/agent_risk.js.

// runAgentInfo is the agent a run of target starts (nil target: a recipe resumed from an approved gate), as the
// response fields of ParseSlotsRPC.
func runAgentInfo(cfg slotagent.SlotConfig, target *slotagent.SlotMatch) (string, *slotagent.AgentDef) {
	key, def := slotagent.RunAgentFor(cfg, target)
	return key, &def
}

func hasApprovedGate(gates []slotagent.ApprovalGate) bool {
	for _, g := range gates {
		if g.IsApproved {
			return true
		}
	}
	return false
}

// agentIssues checks the agents that can run: cfg's (agents.yaml, or the built-in defaults), and the definitions
// config.json carries of its own (the frontend sends those with every run when there is no agents.yaml). One issue is
// listed once even when both places hold it.
func (a *App) agentIssues(cfg slotagent.SlotConfig) []slotagent.AgentIssue {
	issues := slotagent.FindAgentIssues(cfg.Agents)
	raw := a.readConfigCached()
	if !strings.Contains(raw, `"agents"`) {
		return issues
	}
	var fromConfig struct {
		Agents map[string]slotagent.AgentDef `json:"agents"`
	}
	if err := json.Unmarshal([]byte(raw), &fromConfig); err != nil || len(fromConfig.Agents) == 0 {
		return issues
	}
	seen := make(map[string]bool, len(issues))
	for _, is := range issues {
		seen[is.Agent+"\x00"+is.Kind+"\x00"+is.Detail] = true
	}
	for _, is := range slotagent.FindAgentIssues(fromConfig.Agents) {
		if k := is.Agent + "\x00" + is.Kind + "\x00" + is.Detail; !seen[k] {
			seen[k] = true
			issues = append(issues, is)
		}
	}
	return issues
}
