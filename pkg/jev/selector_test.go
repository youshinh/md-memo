package jev

import (
	"context"
	"reflect"
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

func TestOrthogonalSelector_ListsTheMostProbableFirst(t *testing.T) {
	selector := NewOrthogonalSelector()

	// Jev scored the pool: the docs candidate wins clearly, the AI plan is a distant second and the
	// shell candidate got nothing. Slot membership is unchanged (one candidate per slot, the first
	// of each kind in the given order); only the listing order follows the probabilities.
	candidates := []Candidate{
		{ActionType: "doc", Command: "checklist", Description: "チェックリスト化", Scope: "global", Confidence: 0.95},
		{ActionType: "ai", Command: "plan", Description: "計画立案", Scope: "local", Confidence: 0.05},
		{ActionType: "ai", Command: "delegate", Description: "委任", Scope: "local"},
		{ActionType: "sh", Command: "git status -s", Description: "状態確認", Scope: "local"},
	}

	got := selector.SelectTriad(candidates)
	want := []string{"checklist", "plan", "git status -s"}
	if !reflect.DeepEqual(commandsOf(got), want) {
		t.Errorf("triad = %v, want %v", commandsOf(got), want)
	}
}

func TestOrthogonalSelector_UnscoredAndTiedKeepSlotOrder(t *testing.T) {
	selector := NewOrthogonalSelector()

	// The built-in rules give no Confidence, and Jev can return the same probability for options it
	// cannot tell apart: in both cases the slot order (AI, shell, docs) stands.
	for _, tc := range []struct {
		name       string
		confidence float64
	}{
		{"unscored", 0},
		{"tied", 0.2},
	} {
		t.Run(tc.name, func(t *testing.T) {
			candidates := []Candidate{
				{ActionType: "doc", Command: "checklist", Scope: "global", Confidence: tc.confidence},
				{ActionType: "sh", Command: "git status -s", Scope: "local", Confidence: tc.confidence},
				{ActionType: "ai", Command: "plan", Scope: "local", Confidence: tc.confidence},
				{ActionType: "ai", Command: "delegate", Scope: "local", Confidence: tc.confidence},
			}

			got := selector.SelectTriad(candidates)
			want := []string{"plan", "git status -s", "checklist"}
			if !reflect.DeepEqual(commandsOf(got), want) {
				t.Errorf("triad = %v, want the slot order %v", commandsOf(got), want)
			}
		})
	}
}

func TestPredict_SystemOne_TriadLeadsWithJevsPick(t *testing.T) {
	// A note about a day's schedule: Jev's clear pick is the docs checklist, which the panel used to
	// show third, behind the AI slot and a shell command it had scored near zero.
	const pick = "カレントメモの予定・タスクを整理して箇条書きチェックリスト化"

	client, _ := newSpyClient(t, ClientConfig{Endpoint: "https://api.typesafe.ai", TypeSafeKey: testTSKey}, rankingReply(t, pick, 0.9, 0.85))
	resp, err := client.Predict(context.Background(), JevPredictRequest{BufferContext: planNoteExcerpt})
	if err != nil {
		t.Fatalf("Predict returned an error: %v", err)
	}

	triad := NewOrthogonalSelector().SelectTriad(resp.Candidates)
	if len(triad) != 3 {
		t.Fatalf("triad has %d candidates, want 3", len(triad))
	}
	if triad[0].ActionType != "doc" || triad[0].Confidence != 0.9 {
		t.Errorf("first = %+v, want the docs checklist at 0.9", triad[0])
	}

	kinds := map[string]bool{}
	for _, c := range triad {
		kinds[c.ActionType] = true
	}
	if !kinds["ai"] || !kinds["sh"] || !kinds["doc"] {
		t.Errorf("triad %v lost one of the three kinds", commandsOf(triad))
	}
}
