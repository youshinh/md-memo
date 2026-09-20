package jev

import (
	"testing"
)

func TestASTCommandVerifier_DestructiveCommands(t *testing.T) {
	v := NewASTCommandVerifier()

	destructive := []string{
		"rm -rf /",
		"rm -rf /*",
		"mkfs.ext4 /dev/sda1",
		"dd if=/dev/zero of=/dev/sda",
		":(){ :|:& };:",
		"wipefs -a /dev/sda",
		"fdisk /dev/sda",
	}

	for _, cmd := range destructive {
		res, err := v.Verify(cmd)
		if err != nil {
			t.Fatalf("unexpected error for %q: %v", cmd, err)
		}
		if res.IsSafe {
			t.Errorf("expected command %q to be rejected as dangerous, but got IsSafe=true", cmd)
		}
		if res.Reason == "" {
			t.Errorf("expected reason to be provided for %q", cmd)
		}
	}
}

func TestASTCommandVerifier_UnquotedVariableExpansion(t *testing.T) {
	v := NewASTCommandVerifier()

	unquoted := []string{
		"cat $UNQUOTED_FILE",
		"ls -la ${MY_DIR}",
		"git checkout $BRANCH",
	}

	for _, cmd := range unquoted {
		res, err := v.Verify(cmd)
		if err != nil {
			t.Fatalf("unexpected error for %q: %v", cmd, err)
		}
		if res.IsSafe {
			t.Errorf("expected unquoted variable in %q to be rejected, but got IsSafe=true", cmd)
		}
	}

	quoted := []string{
		`cat "$QUOTED_FILE"`,
		`ls -la "${MY_DIR}"`,
	}

	for _, cmd := range quoted {
		res, err := v.Verify(cmd)
		if err != nil {
			t.Fatalf("unexpected error for %q: %v", cmd, err)
		}
		if !res.IsSafe {
			t.Errorf("expected safely quoted variable in %q to be accepted, got error: %s", cmd, res.Reason)
		}
	}
}

func TestASTCommandVerifier_SystemDirectoryRedirect(t *testing.T) {
	v := NewASTCommandVerifier()

	systemRedirects := []string{
		"echo malicious > /etc/passwd",
		"cat log.txt >> /bin/sh",
		"echo 0 > /proc/sys/kernel",
		"echo test > /boot/vmlinuz",
		"echo test > /var/run/test.pid",
		"echo test > /usr/bin/tool",
	}

	for _, cmd := range systemRedirects {
		res, err := v.Verify(cmd)
		if err != nil {
			t.Fatalf("unexpected error for %q: %v", cmd, err)
		}
		if res.IsSafe {
			t.Errorf("expected redirect to system path in %q to be blocked, but got IsSafe=true", cmd)
		}
	}

	safeRedirects := []string{
		"echo hello > output.txt",
		"cat report.md >> ./docs/summary.md",
		"git diff > diff.patch",
	}

	for _, cmd := range safeRedirects {
		res, err := v.Verify(cmd)
		if err != nil {
			t.Fatalf("unexpected error for %q: %v", cmd, err)
		}
		if !res.IsSafe {
			t.Errorf("expected safe redirect in %q to be accepted, got error: %s", cmd, res.Reason)
		}
	}
}

func TestASTCommandVerifier_SafeReadOnlyCommands(t *testing.T) {
	v := NewASTCommandVerifier()

	safeCommands := []string{
		"git status",
		"git diff --stat",
		"cat README.md",
		"grep -rn 'func' .",
		"go test -v ./...",
		"sort file.txt | uniq",
	}

	for _, cmd := range safeCommands {
		res, err := v.Verify(cmd)
		if err != nil {
			t.Fatalf("unexpected error for %q: %v", cmd, err)
		}
		if !res.IsSafe {
			t.Errorf("expected %q to be safe, got rejected: %s", cmd, res.Reason)
		}
	}
}

func TestASTCommandVerifier_EmptyOrInvalid(t *testing.T) {
	v := NewASTCommandVerifier()

	res, err := v.Verify("")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if res.IsSafe {
		t.Errorf("empty command should not be safe")
	}

	res, err = v.Verify("echo 'unterminated quote")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if res.IsSafe {
		t.Errorf("syntax error command should not be safe")
	}
}

func TestASTCommandVerifier_ScoreCommand(t *testing.T) {
	v := NewASTCommandVerifier()

	// 1. Safe read-only command (expected score < 0.20)
	scoreSafe, err := v.ScoreCommand("git status")
	if err != nil {
		t.Fatalf("ScoreCommand failed: %v", err)
	}
	if scoreSafe.Score > 0.20 {
		t.Errorf("expected low risk score (< 0.20) for 'git status', got %f", scoreSafe.Score)
	}
	if len(scoreSafe.Probabilities) != 3 {
		t.Fatalf("expected 3 probabilities, got %d", len(scoreSafe.Probabilities))
	}

	// 2. Modifying command (expected score between 0.80 and 1.20)
	scoreMod, err := v.ScoreCommand("git commit -m 'update docs'")
	if err != nil {
		t.Fatalf("ScoreCommand failed: %v", err)
	}
	if scoreMod.Score < 0.70 || scoreMod.Score > 1.30 {
		t.Errorf("expected modifying risk score (~1.0) for 'git commit', got %f", scoreMod.Score)
	}

	// 3. Destructive command (expected score > 1.70)
	scoreDest, err := v.ScoreCommand("rm -rf /")
	if err != nil {
		t.Fatalf("ScoreCommand failed: %v", err)
	}
	if scoreDest.Score < 1.70 {
		t.Errorf("expected high risk score (> 1.70) for 'rm -rf /', got %f", scoreDest.Score)
	}
}

// Quick Actions run with one click, so the strict verifier must keep refusing these.
func TestASTCommandVerifier_StrictModeUnchanged(t *testing.T) {
	v := NewASTCommandVerifier()
	for _, cmd := range []string{"rm temp.txt", "cat $UNQUOTED_VAR", "echo x > /etc/hosts", "wipefs -a /dev/sda1"} {
		res, err := v.Verify(cmd)
		if err != nil {
			t.Fatalf("Verify(%q) returned error: %v", cmd, err)
		}
		if res.IsSafe {
			t.Errorf("strict verifier must reject %q", cmd)
		}
	}
}

func TestASTCommandVerifier_HarmlessRedirectTargets(t *testing.T) {
	v := NewASTCommandVerifier()
	for _, cmd := range []string{"make build > /dev/null", "echo hi > /dev/stderr", "ls 2> /dev/null"} {
		res, _ := v.Verify(cmd)
		if !res.IsSafe {
			t.Errorf("expected %q to be safe, got rule=%q reason=%s", cmd, res.Rule, res.Reason)
		}
	}
	// Real devices stay protected.
	if res, _ := v.Verify("echo x > /dev/sda"); res.IsSafe || res.Rule != "protected-redirect" {
		t.Errorf("redirect to /dev/sda must be rejected as protected-redirect, got %+v", res)
	}
}

func TestASTCommandVerifier_ReportsMostSevereViolation(t *testing.T) {
	v := NewASTCommandVerifier()
	cases := []struct {
		cmd, rule, subject string
	}{
		{"echo $x; wipefs -a /dev/sda1", "destructive", "wipefs"},
		{"rm a.txt; mkfs.ext4 /dev/sdb1", "destructive", "mkfs"},
		{"rm a.txt", "destructive", "rm"},
		{"cat $f", "unquoted-var", "f"},
	}
	for _, c := range cases {
		res, _ := v.Verify(c.cmd)
		if res.IsSafe || res.Rule != c.rule || res.Subject != c.subject {
			t.Errorf("Verify(%q): want rule=%q subject=%q, got %+v", c.cmd, c.rule, c.subject, res)
		}
	}
}

func TestASTCommandVerifier_AllowingUnquotedVars(t *testing.T) {
	v := NewASTCommandVerifierAllowingUnquotedVars()
	if res, _ := v.Verify("for f in *.txt; do echo $f; done"); !res.IsSafe {
		t.Errorf("unquoted variable must be allowed in this mode, got %+v", res)
	}
	if res, _ := v.Verify("echo $x; wipefs -a /dev/sda1"); res.IsSafe || res.Subject != "wipefs" {
		t.Errorf("destructive command must still be rejected in this mode, got %+v", res)
	}
}
