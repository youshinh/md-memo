package jev

// The built-in candidate rules of Quick Actions. predictLocal picks one group by keyword; the
// TypeSafe path (predictSystemOne) offers every group to Jev and lets it rank them.

func localAgentCandidates() []Candidate {
	return []Candidate{
		{
			ActionType:  "ai",
			Command:     "{{ このメモの指示に従って実装・調査を実行 }}",
			Description: "エージェントにタスクを委任",
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
			Command:     "[? カレントのトピックについてWeb調査と一次ソース確認を実施 ]",
			Description: "自律リサーチスロットの挿入 ([? ... ])",
			Scope:       "global",
		},
	}
}

func localGitCandidates() []Candidate {
	return []Candidate{
		{
			ActionType:  "ai",
			Command:     "{{ 直近の変更内容からコミットメッセージ案を作成 }}",
			Description: "コミットメッセージの起草 (AI)",
			Scope:       "local",
		},
		{
			ActionType:  "sh",
			Command:     "git status -s",
			Description: "リポジトリ変更状態の一覧確認 (git status)",
			Scope:       "local",
		},
		{
			ActionType:  "sh",
			Command:     "git diff --stat",
			Description: "変更ファイル統計と差分の確認 (git diff)",
			Scope:       "global",
		},
	}
}

func localTaskCandidates() []Candidate {
	return []Candidate{
		{
			ActionType:  "ai",
			Command:     "{{ このメモの内容からアクションプランとタスクを立案 }}",
			Description: "エージェントに計画立案を依頼",
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
			Command:     "{{ カレントメモの予定・タスクを整理して箇条書きチェックリスト化 }}",
			Description: "予定の構造化チェックリスト作成 (Docs)",
			Scope:       "global",
		},
	}
}

func localTestCandidates() []Candidate {
	return []Candidate{
		{
			ActionType:  "ai",
			Command:     "{{ 未テストのエッジケースに対するユニットテストを生成 }}",
			Description: "エッジケース向けユニットテストの生成 (AI)",
			Scope:       "local",
		},
		{
			ActionType:  "sh",
			Command:     "go test -v ./...",
			Description: "テストスイートの全実行 (go test)",
			Scope:       "local",
		},
		{
			ActionType:  "sh",
			Command:     "git status -s",
			Description: "変更ファイル状態の確認 (git status)",
			Scope:       "global",
		},
	}
}

// localBaselineCandidates is the generic set used when no keyword rule matches.
func localBaselineCandidates() []Candidate {
	return []Candidate{
		{
			ActionType:  "ai",
			Command:     "{{ カレントノートの指示を実行 }}",
			Description: "エージェントにタスク実行を依頼",
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
			Command:     "{{ カレント箇所の文章を推敲し読みやすい構成に整形 }}",
			Description: "文章の推敲と構造リファクタリング (Docs)",
			Scope:       "global",
		},
	}
}

// localCandidatePool lists every candidate the built-in rules can produce, without duplicates
// (by Command): the ones the rules pick for req come first, so a ranking that cannot tell the
// options apart leaves that order alone, then the rest.
func (c *Client) localCandidatePool(req JevPredictRequest) []Candidate {
	groups := [][]Candidate{
		c.predictLocal(req).Candidates,
		localAgentCandidates(),
		localGitCandidates(),
		localTaskCandidates(),
		localTestCandidates(),
		localBaselineCandidates(),
	}

	seen := make(map[string]bool)
	var pool []Candidate
	for _, group := range groups {
		for _, cand := range group {
			if seen[cand.Command] {
				continue
			}
			seen[cand.Command] = true
			pool = append(pool, cand)
		}
	}
	return pool
}
