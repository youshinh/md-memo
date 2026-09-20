package main

import (
	"encoding/json"
	"net/http"
	"strings"
	"sync"
	"testing"

	"md-memo/pkg/jev"
)

// noNetworkRoundTripper fails the test the moment any HTTP request is attempted. Quick
// Actions auto-fires while the user types and ships an excerpt of the note as context, so
// "nothing configured means nothing leaves the machine" is a contract worth asserting here
// (at the App layer) and not only inside pkg/jev.
type noNetworkRoundTripper struct{ t *testing.T }

func (n noNetworkRoundTripper) RoundTrip(req *http.Request) (*http.Response, error) {
	n.t.Helper()
	n.t.Fatalf("unexpected outbound HTTP request to %s during Jev prediction", req.URL.String())
	return nil, nil
}

// forbidJevNetwork installs the failing transport on the App's Jev client. TestMain has
// already redirected the config directory to a temp dir and cleared every JEV_*/TYPESAFE_*/
// OPENROUTER_* variable, so the client must have resolved to a purely local configuration.
func forbidJevNetwork(t *testing.T, app *App) {
	t.Helper()
	app.jevMu.Lock()
	client := app.jevClient
	app.jevMu.Unlock()
	if client == nil {
		t.Fatal("InitJevEngine did not create a Jev client")
	}
	client.SetHTTPClient(&http.Client{Transport: noNetworkRoundTripper{t: t}})
}

func TestApp_JevPredictAndExecute(t *testing.T) {
	app := &App{}
	app.InitJevEngine()
	forbidJevNetwork(t, app)

	// 1. Predict
	doc := "# API Service\n\nFix authentication bug in handler."
	resp, err := app.JevPredict(doc, len(doc))
	if err != nil {
		t.Fatalf("JevPredict failed: %v", err)
	}

	if len(resp.Candidates) != 3 {
		t.Fatalf("expected 3 orthogonal candidates, got %d", len(resp.Candidates))
	}

	// Verify orthogonal slots
	if resp.Candidates[0].ActionType != "ai" {
		t.Errorf("Slot 1 should be ai, got %s", resp.Candidates[0].ActionType)
	}
	if resp.Candidates[1].ActionType != "sh" {
		t.Errorf("Slot 2 should be sh, got %s", resp.Candidates[1].ActionType)
	}
	if resp.Candidates[2].ActionType != "doc" {
		t.Errorf("Slot 3 should be doc, got %s", resp.Candidates[2].ActionType)
	}

	// 2. Execute safe shell command
	candJSON, _ := json.Marshal(jev.Candidate{
		ActionType: "sh",
		Command:    "echo 'jev integration test passed'",
	})

	execRes, err := app.JevExecute(string(candJSON), doc)
	if err != nil {
		t.Fatalf("JevExecute failed: %v", err)
	}
	if !execRes.Success {
		t.Fatalf("expected execution success, got error: %s", execRes.Error)
	}
	if !strings.Contains(execRes.Output, "jev integration test passed") {
		t.Errorf("expected output to contain message, got: %q", execRes.Output)
	}

	// 3. Execute dangerous shell command (Should be blocked by AST guardrail)
	dangJSON, _ := json.Marshal(jev.Candidate{
		ActionType: "sh",
		Command:    "rm -rf /",
	})
	dangRes, _ := app.JevExecute(string(dangJSON), doc)
	if dangRes != nil && dangRes.Success {
		t.Fatalf("destructive command must be blocked")
	}

	// 4. Standalone Verify
	valRes, err := app.JevVerify("cat $UNQUOTED_VAR")
	if err != nil {
		t.Fatalf("JevVerify failed: %v", err)
	}
	if valRes.IsSafe {
		t.Errorf("unquoted variable must fail verification")
	}

	// 5. Agent Dispatch (Direct vs Escalated)
	planDirect, err := app.JevDispatchAgent("git status")
	if err != nil {
		t.Fatalf("JevDispatchAgent failed: %v", err)
	}
	if planDirect.ShouldEscalate {
		t.Errorf("git status should not escalate")
	}

	planEscalate, err := app.JevDispatchAgent("全アーキテクチャの大規模リファクタリング計画")
	if err != nil {
		t.Fatalf("JevDispatchAgent failed: %v", err)
	}
	if !planEscalate.ShouldEscalate {
		t.Errorf("complex task should escalate")
	}

	// 6. Context Pruning
	pruned := app.JevPruneContext("# Header\nContent\n## Target\nKeyword match here", "Keyword")
	if !strings.Contains(pruned, "Keyword match here") {
		t.Errorf("expected pruned context to contain keyword")
	}

	// 7. Loop Convergence
	task := jev.AgentTask{ID: "t-1", Prompt: "test"}
	stop, prog := app.JevEvaluateLoopConvergence(task, 1, "task completed successfully")
	if !stop || prog < 1.0 {
		t.Errorf("expected loop convergence completion")
	}
}

func TestApp_JevPredict_ScheduleAndNotesContext(t *testing.T) {
	app := &App{}
	app.InitJevEngine()
	forbidJevNetwork(t, app)

	doc := `おはようございます！何かお手伝いできることはありますか？
！今日もよろしくお願いします。
明日は休みなのでお出かけの予定はありますか？
予定表`

	resp, err := app.JevPredict(doc, len(doc))
	if err != nil {
		t.Fatalf("JevPredict failed: %v", err)
	}

	if len(resp.Candidates) != 3 {
		t.Fatalf("expected 3 candidates, got %d", len(resp.Candidates))
	}

	for i, c := range resp.Candidates {
		t.Logf("Candidate %d: ActionType=%s, Command=%s, Description=%s", i+1, c.ActionType, c.Command, c.Description)
	}

	// Must NOT contain the English fallback code refactor
	if strings.Contains(resp.Candidates[0].Command, "refactor current block") {
		t.Errorf("Candidate 0 should not be English refactor fallback: %s", resp.Candidates[0].Command)
	}

	// Must contain schedule/task planning or checklist
	if !strings.Contains(resp.Candidates[0].Command, "アクションプラン") && !strings.Contains(resp.Candidates[0].Command, "チェックリスト") {
		t.Errorf("Candidate 0 expected to relate to action plan or checklist, got: %s", resp.Candidates[0].Command)
	}
}

// TestJevEngine_ReloadRaceIsSafe hammers ReloadJevConfig concurrently with JevPredict and
// JevVerify to pin the fix for a latent data race in the Jev engine accessors: before the
// jevEngine() accessor existed, every Jev* method called InitJevEngine() and then read
// a.jevClient / a.jevVerifier / a.jevSelector / a.jevRunner / a.jevAgentRouter directly,
// without holding jevMu for the read itself. ReloadJevConfig nils jevClient/jevAgentRouter
// under jevMu and then calls InitJevEngine to rebuild them, so a reader unlucky enough to read
// those fields in that window could get a nil client and panic on the next dereference.
// jevEngine() closes that window by taking every collaborator as one snapshot under the lock.
//
// The test config directory is redirected to a per-test temp dir by TestMain and never has an
// API key or base URL configured, so Client.Predict always takes its local, network-free
// heuristic fallback (see the Predict doc comment in pkg/jev/jev_client.go); forbidJevNetwork
// is kept here as defense in depth. -race is unavailable on this machine (no gcc), so the only
// thing this test can assert is "no panic, no deadlock" - which is exactly the failure mode
// the fix addresses.
func TestJevEngine_ReloadRaceIsSafe(t *testing.T) {
	app := &App{}
	app.InitJevEngine()
	forbidJevNetwork(t, app)

	doc := "# Note\n\nDo something useful."

	const readers = 8
	const reloads = 50

	var wg sync.WaitGroup
	stop := make(chan struct{})

	wg.Add(readers)
	for i := 0; i < readers; i++ {
		go func() {
			defer wg.Done()
			for {
				select {
				case <-stop:
					return
				default:
				}
				if _, err := app.JevPredict(doc, len(doc)); err != nil {
					t.Errorf("JevPredict returned an error during concurrent reload: %v", err)
				}
				if _, err := app.JevVerify("echo hello"); err != nil {
					t.Errorf("JevVerify returned an error during concurrent reload: %v", err)
				}
			}
		}()
	}

	for i := 0; i < reloads; i++ {
		app.ReloadJevConfig()
	}
	close(stop)
	wg.Wait()
}
