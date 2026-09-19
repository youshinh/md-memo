package jev

import (
	"testing"
)

func TestOrthogonalSelector_SelectTriad(t *testing.T) {
	selector := NewOrthogonalSelector()

	candidates := []Candidate{
		{ActionType: "ai", Command: "fix typo in comment", Description: "タイポ修正", Scope: "local"},
		{ActionType: "ai", Command: "refactor memory cache", Description: "キャッシュ改善", Scope: "local"},
		{ActionType: "sh", Command: "git diff --stat", Description: "差分統計確認", Scope: "local"},
		{ActionType: "sh", Command: "grep -rn TODO .", Description: "TODO検索", Scope: "local"},
		{ActionType: "doc", Command: "update API reference in docs/", Description: "API仕様書更新", Scope: "global"},
	}

	selected := selector.SelectTriad(candidates)
	if len(selected) != 3 {
		t.Fatalf("expected exactly 3 orthogonal candidates, got %d", len(selected))
	}

	// Slot 1: Local x Generative (ai)
	if selected[0].ActionType != "ai" || selected[0].Scope != "local" {
		t.Errorf("Slot 1 mismatch: %+v", selected[0])
	}

	// Slot 2: Local x Deterministic (sh)
	if selected[0].Command == selected[1].Command {
		t.Errorf("Duplicate command between slot 1 and 2")
	}
	if selected[1].ActionType != "sh" || selected[1].Scope != "local" {
		t.Errorf("Slot 2 mismatch: %+v", selected[1])
	}

	// Slot 3: Global x Documentation (doc)
	if selected[2].ActionType != "doc" || selected[2].Scope != "global" {
		t.Errorf("Slot 3 mismatch: %+v", selected[2])
	}
}

func TestOrthogonalSelector_HomogeneityTrapEscape(t *testing.T) {
	selector := NewOrthogonalSelector()

	// Homogeneous input: only AI code suggestions
	homogeneous := []Candidate{
		{ActionType: "ai", Command: "fix nil pointer check", Description: "AI Fix 1", Scope: "local"},
		{ActionType: "ai", Command: "add unit test for handler", Description: "AI Fix 2", Scope: "local"},
		{ActionType: "ai", Command: "optimize string concatenation", Description: "AI Fix 3", Scope: "local"},
	}

	selected := selector.SelectTriad(homogeneous)
	if len(selected) != 3 {
		t.Fatalf("expected 3 orthogonal candidates even with homogeneous input, got %d", len(selected))
	}

	// Should not have 3 identical action types
	types := make(map[string]bool)
	for _, c := range selected {
		types[c.ActionType] = true
	}
	if len(types) < 2 {
		t.Errorf("homogeneity trap not avoided, action types: %+v", selected)
	}
}
