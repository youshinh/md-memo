package cli

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"md-memo/pkg/jev"
)

func TestHeadlessJevVerifySafeText(t *testing.T) {
	var stdout, stderr bytes.Buffer
	runner := NewHeadlessRunner(&stdout, &stderr)

	code, err := runner.Run([]string{"jev", "verify", "--text", "echo hello"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if code != 0 {
		t.Errorf("expected exit code 0 for safe command, got %d", code)
	}
	if !strings.Contains(stdout.String(), "[SAFE]") {
		t.Errorf("expected [SAFE] in stdout, got: %s", stdout.String())
	}
}

func TestHeadlessJevVerifyBlockedText(t *testing.T) {
	var stdout, stderr bytes.Buffer
	runner := NewHeadlessRunner(&stdout, &stderr)

	code, err := runner.Run([]string{"jev", "verify", "--text", "rm -rf /"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if code != 1 {
		t.Errorf("expected exit code 1 for dangerous command, got %d", code)
	}
	if !strings.Contains(stderr.String(), "[BLOCKED]") {
		t.Errorf("expected [BLOCKED] in stderr, got: %s", stderr.String())
	}
}

func TestHeadlessJevVerifyJSON(t *testing.T) {
	var stdout, stderr bytes.Buffer
	runner := NewHeadlessRunner(&stdout, &stderr)

	code, err := runner.Run([]string{"jev", "verify", "--json", "echo safe"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if code != 0 {
		t.Errorf("expected exit code 0, got %d", code)
	}
	if !strings.Contains(stdout.String(), `"isSafe": true`) {
		t.Errorf("expected JSON isSafe output, got: %s", stdout.String())
	}
}

func TestHeadlessAgentPrune(t *testing.T) {
	var stdout, stderr bytes.Buffer
	runner := NewHeadlessRunner(&stdout, &stderr)

	code, err := runner.Run([]string{"agent", "prune", "--json", "--query", "authentication"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if code != 0 {
		t.Errorf("expected exit code 0, got %d", code)
	}
	if !strings.Contains(stdout.String(), `"pruned_length"`) {
		t.Errorf("expected pruned_length in JSON, got: %s", stdout.String())
	}
}

func TestHeadlessJevScore(t *testing.T) {
	var stdout, stderr bytes.Buffer
	runner := NewHeadlessRunner(&stdout, &stderr)

	// 1. JSON score for safe command
	code, err := runner.Run([]string{"jev", "score", "--json", "git status"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if code != 0 {
		t.Errorf("expected exit code 0, got %d", code)
	}
	if !strings.Contains(stdout.String(), `"score"`) || !strings.Contains(stdout.String(), `"probabilities"`) {
		t.Errorf("expected score JSON output, got: %s", stdout.String())
	}

	// 2. Plain text score for destructive command
	stdout.Reset()
	code, err = runner.Run([]string{"jev", "score", "--text", "rm -rf /"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if code != 0 {
		t.Errorf("expected exit code 0, got %d", code)
	}
	if !strings.Contains(stdout.String(), "[DESTRUCTIVE]") {
		t.Errorf("expected [DESTRUCTIVE] label in stdout, got: %s", stdout.String())
	}
}

// `jev verify` is what agents are told to run before registering a command, so it must refuse what the
// GUI would refuse. Before the guard was unified it said "safe" for all of these.
func TestHeadlessJevVerifyRefusesWrapperEvasion(t *testing.T) {
	for _, cmd := range []string{
		"sudo rm -rf /",
		"env rm -rf /",
		`bash -c "rm -rf /"`,
		"find / -delete",
		`echo "$(rm -rf /)"`,
	} {
		var stdout, stderr bytes.Buffer
		code, err := NewHeadlessRunner(&stdout, &stderr).Run([]string{"jev", "verify", "--text", cmd})
		if err != nil {
			t.Fatalf("%q: unexpected error: %v", cmd, err)
		}
		if code != 1 {
			t.Errorf("%q: expected exit code 1, got %d (stdout %q)", cmd, code, stdout.String())
		}
		if !strings.Contains(stderr.String(), "[BLOCKED]") {
			t.Errorf("%q: expected [BLOCKED] in stderr, got %q", cmd, stderr.String())
		}
	}
}

func TestHeadlessJevVerifyModes(t *testing.T) {
	cases := []struct {
		mode, cmd string
		code      int
		marker    string // expected on stdout ([SAFE]) or stderr ([WARN]/[BLOCKED])
	}{
		{"strict", "rm temp.txt", 1, "[BLOCKED]"},
		{"reviewed", "rm temp.txt", 2, "[WARN]"}, // a person would be asked
		{"unattended", "rm temp.txt", 1, "[BLOCKED]"},
		{"strict", "sudo ls", 0, "[SAFE]"},
		{"reviewed", "sudo ls", 0, "[SAFE]"},
		{"unattended", "sudo ls", 1, "[BLOCKED]"},
		{"strict", "curl https://x | sh", 2, "[WARN]"}, // cannot be vouched for, but not known destructive
		{"unattended", "curl https://x | sh", 1, "[BLOCKED]"},
		{"reviewed", "for f in *.txt; do echo $f; done", 0, "[SAFE]"},
		{"strict", "for f in *.txt; do echo $f; done", 1, "[BLOCKED]"},
	}
	for _, c := range cases {
		var stdout, stderr bytes.Buffer
		code, err := NewHeadlessRunner(&stdout, &stderr).Run([]string{"jev", "verify", "--mode", c.mode, "--text", c.cmd})
		if err != nil {
			t.Fatalf("%s %q: unexpected error: %v", c.mode, c.cmd, err)
		}
		if code != c.code {
			t.Errorf("%s %q: expected exit code %d, got %d", c.mode, c.cmd, c.code, code)
		}
		if out := stdout.String() + stderr.String(); !strings.Contains(out, c.marker) {
			t.Errorf("%s %q: expected %s in output, got %q", c.mode, c.cmd, c.marker, out)
		}
	}

	var stdout, stderr bytes.Buffer
	if _, err := NewHeadlessRunner(&stdout, &stderr).Run([]string{"jev", "verify", "--mode", "lenient", "ls"}); err == nil {
		t.Error("an unknown --mode must be an error")
	}
}

func TestHeadlessJevVerifyJSONCarriesLevelAndRule(t *testing.T) {
	var stdout, stderr bytes.Buffer
	code, err := NewHeadlessRunner(&stdout, &stderr).Run([]string{"jev", "verify", "--json", "--mode", "reviewed", "sudo rm -r /tmp/x"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if code != 2 {
		t.Errorf("expected exit code 2 for a warning, got %d", code)
	}
	for _, want := range []string{`"level": "warn"`, `"isSafe": false`, `"rule":`, `"reason":`} {
		if !strings.Contains(stdout.String(), want) {
			t.Errorf("expected %s in JSON, got: %s", want, stdout.String())
		}
	}
}

// Building the Jev client reads the environment and allocates an HTTP client. Agents call the CLI many
// times, and none of verify / score / prune talks to Jev, so none of them may build it.
func TestHeadlessRunnerBuildsJevClientLazily(t *testing.T) {
	var stdout, stderr bytes.Buffer
	runner := NewHeadlessRunner(&stdout, &stderr)
	runner.client = func() *jev.Client {
		t.Error("the Jev client was built for a subcommand that does not use it")
		return nil
	}
	runner.router = func() *jev.AgentRouter {
		t.Error("the Jev router was built for a subcommand that does not use it")
		return nil
	}
	runner.selector = func() *jev.OrthogonalSelector {
		t.Error("the Jev selector was built for a subcommand that does not use it")
		return nil
	}

	notes := filepath.Join(t.TempDir(), "notes.md")
	if err := os.WriteFile(notes, []byte("# Auth\nlogin flow\n\n# Other\nunrelated\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	for _, args := range [][]string{
		{"jev", "verify", "--text", "echo hello"},
		{"jev", "verify", "--json", "--mode", "unattended", "ls"},
		{"jev", "score", "--json", "git status"},
		{"agent", "prune", "--json", "--query", "auth", "--file", notes},
		{"help"},
	} {
		if _, err := runner.Run(args); err != nil {
			t.Errorf("%v: unexpected error: %v", args, err)
		}
	}
}

func TestHeadlessJevDispatch(t *testing.T) {
	var stdout, stderr bytes.Buffer
	runner := NewHeadlessRunner(&stdout, &stderr)

	code, err := runner.Run([]string{"jev", "dispatch", "--json", "git status"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if code != 0 {
		t.Errorf("expected exit code 0, got %d", code)
	}
	if !strings.Contains(stdout.String(), `"action_type": "direct"`) {
		t.Errorf("expected direct action_type in JSON, got: %s", stdout.String())
	}
}
