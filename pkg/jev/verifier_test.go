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
