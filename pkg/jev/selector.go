package jev

// NewOrthogonalSelector constructs a MAP-Elites selector configured with the 3 orthogonal slots.
func NewOrthogonalSelector() *OrthogonalSelector {
	return &OrthogonalSelector{
		Slots: []Slot{
			{Axis1: "generative", Axis2: "local"},       // Slot 1: Local x Generative
			{Axis1: "deterministic", Axis2: "local"},    // Slot 2: Local x Deterministic
			{Axis1: "generative", Axis2: "global"},      // Slot 3: Global x Documentation
		},
	}
}

// SelectTriad projects raw candidates into the 2D feature space and picks the best unique candidate for each slot.
func (s *OrthogonalSelector) SelectTriad(candidates []Candidate) []Candidate {
	usedCommands := make(map[string]bool)
	result := make([]Candidate, 3)
	filled := make([]bool, 3)

	// Classify and fill slots
	for _, c := range candidates {
		if usedCommands[c.Command] {
			continue
		}

		axis1 := classifyAxis1(c)
		axis2 := classifyAxis2(c)

		// Check Slot 1: Local x Generative (ai)
		if !filled[0] && axis1 == "generative" && axis2 == "local" && c.ActionType == "ai" {
			result[0] = c
			filled[0] = true
			usedCommands[c.Command] = true
			continue
		}

		// Check Slot 2: Local x Deterministic (sh)
		if !filled[1] && axis1 == "deterministic" && axis2 == "local" && c.ActionType == "sh" {
			result[1] = c
			filled[1] = true
			usedCommands[c.Command] = true
			continue
		}

		// Check Slot 3: Global x Documentation (doc)
		if !filled[2] && (c.ActionType == "doc" || (axis1 == "generative" && axis2 == "global")) {
			result[2] = c
			filled[2] = true
			usedCommands[c.Command] = true
			continue
		}
	}

	// Escape Homogeneity Trap: Fill empty slots with deterministic orthogonal fallbacks
	if !filled[0] {
		result[0] = findOrFallback(candidates, usedCommands, "ai", "local", Candidate{
			ActionType:  "ai",
			Command:     "refactor current block for readability and tests",
			Description: "カレントコードの整理とテスト作成 (AI駆動)",
			Scope:       "local",
		})
		filled[0] = true
	}

	if !filled[1] {
		result[1] = findOrFallback(candidates, usedCommands, "sh", "local", Candidate{
			ActionType:  "sh",
			Command:     "git diff --stat",
			Description: "Unix CLIによる変更差分確認 (CLI駆動)",
			Scope:       "local",
		})
		filled[1] = true
	}

	if !filled[2] {
		result[2] = findOrFallback(candidates, usedCommands, "doc", "global", Candidate{
			ActionType:  "doc",
			Command:     "update issue summary and docs/changelog.md",
			Description: "仕様ドキュメントおよびIssueサマリ更新 (Docs)",
			Scope:       "global",
		})
		filled[2] = true
	}

	return result
}

func classifyAxis1(c Candidate) string {
	if c.ActionType == "sh" {
		return "deterministic"
	}
	return "generative"
}

func classifyAxis2(c Candidate) string {
	if c.Scope == "global" || c.ActionType == "doc" {
		return "global"
	}
	return "local"
}

func findOrFallback(candidates []Candidate, used map[string]bool, targetType, targetScope string, fallback Candidate) Candidate {
	for _, c := range candidates {
		if !used[c.Command] && c.ActionType == targetType {
			used[c.Command] = true
			return c
		}
	}
	used[fallback.Command] = true
	return fallback
}
