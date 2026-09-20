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
	if len(candidates) == 0 {
		return []Candidate{
			{
				ActionType:  "ai",
				Command:     "{{ このメモの内容からアクションプランとタスクを立案 }}",
				Description: "Antigravity に計画立案を依頼 (agy)",
				Scope:       "local",
			},
			{
				ActionType:  "sh",
				Command:     "git status -s",
				Description: "リポジトリ変更状態の一覧確認 (git status)",
				Scope:       "local",
			},
			{
				ActionType:  "doc",
				Command:     "{{ カレントメモの要点を3行で簡潔にまとめる }}",
				Description: "要点の3行サマリー作成 (Docs)",
				Scope:       "global",
			},
		}
	}

	// If exactly 3 distinct candidates with orthogonal action types are provided, retain them directly
	if len(candidates) == 3 && candidates[0].Command != "" && candidates[1].Command != "" && candidates[2].Command != "" {
		if candidates[0].Command != candidates[1].Command && candidates[1].Command != candidates[2].Command && candidates[0].Command != candidates[2].Command {
			typeCount := make(map[string]bool)
			for _, c := range candidates {
				typeCount[c.ActionType] = true
			}
			if len(typeCount) >= 2 {
				return candidates
			}
		}
	}

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

		// Check Slot 1: Local x Generative (ai / slot)
		if !filled[0] && axis1 == "generative" && axis2 == "local" && (c.ActionType == "ai" || c.ActionType == "slot") {
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

		// Check Slot 3: Global x Documentation (doc / global)
		if !filled[2] && (c.ActionType == "doc" || (axis1 == "generative" && axis2 == "global") || c.Scope == "global") {
			result[2] = c
			filled[2] = true
			usedCommands[c.Command] = true
			continue
		}
	}

	// Escape Homogeneity Trap: Fill empty slots with unused candidates or localized fallbacks
	if !filled[0] {
		result[0] = findOrFallback(candidates, usedCommands, "ai", "local", Candidate{
			ActionType:  "ai",
			Command:     "{{ このメモの内容からアクションプランとタスクを立案 }}",
			Description: "Antigravity に計画立案を依頼 (agy)",
			Scope:       "local",
		})
		filled[0] = true
	}

	if !filled[1] {
		result[1] = findOrFallback(candidates, usedCommands, "sh", "local", Candidate{
			ActionType:  "sh",
			Command:     "git status -s",
			Description: "リポジトリ変更状態の一覧確認 (git status)",
			Scope:       "local",
		})
		filled[1] = true
	}

	if !filled[2] {
		result[2] = findOrFallback(candidates, usedCommands, "doc", "global", Candidate{
			ActionType:  "doc",
			Command:     "{{ カレントメモの要点を3行で簡潔にまとめる }}",
			Description: "要点の3行サマリー作成 (Docs)",
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
		if !used[c.Command] && (c.ActionType == targetType || (targetType == "ai" && c.ActionType == "slot") || (targetType == "doc" && c.Scope == "global")) {
			used[c.Command] = true
			return c
		}
	}
	used[fallback.Command] = true
	return fallback
}
