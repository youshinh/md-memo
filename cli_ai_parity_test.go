package main

import (
	"testing"

	"md-memo/pkg/jev"
)

// baselineCases freezes what the CLI run gate (validateCliCommand) and the strict verifier
// (jev.ASTCommandVerifier) decided BEFORE the guard was unified into jev.VerifyCommand. The refactor is
// meant to keep every one of these verdicts or make it stricter, never looser: a command that was
// refused must still be refused, and one that needed a confirmation must still need at least that.
var baselineCases = []struct {
	cmd        string
	reviewed   string // validateCliCommand(cmd).RiskLevel
	strictSafe bool   // ASTCommandVerifier.Verify(cmd).IsSafe
	strictRule string // ASTCommandVerifier.Verify(cmd).Rule
}{
	{cmd: "sort", reviewed: "safe", strictSafe: true, strictRule: ""},
	{cmd: "sort -r", reviewed: "safe", strictSafe: true, strictRule: ""},
	{cmd: "sort -u", reviewed: "safe", strictSafe: true, strictRule: ""},
	{cmd: "uniq", reviewed: "safe", strictSafe: true, strictRule: ""},
	{cmd: "jq .", reviewed: "safe", strictSafe: true, strictRule: ""},
	{cmd: "jq -c .", reviewed: "safe", strictSafe: true, strictRule: ""},
	{cmd: "tr a-z A-Z", reviewed: "safe", strictSafe: true, strictRule: ""},
	{cmd: "tr A-Z a-z", reviewed: "safe", strictSafe: true, strictRule: ""},
	{cmd: "wc -l", reviewed: "safe", strictSafe: true, strictRule: ""},
	{cmd: "wc -w", reviewed: "safe", strictSafe: true, strictRule: ""},
	{cmd: "base64 -d", reviewed: "safe", strictSafe: true, strictRule: ""},
	{cmd: "base64", reviewed: "safe", strictSafe: true, strictRule: ""},
	{cmd: "npx prettier --parser markdown", reviewed: "safe", strictSafe: true, strictRule: ""},
	{cmd: "duckdb -box", reviewed: "safe", strictSafe: true, strictRule: ""},
	{cmd: "sqlite3 -header -column", reviewed: "safe", strictSafe: true, strictRule: ""},
	{cmd: "psql -f -", reviewed: "safe", strictSafe: true, strictRule: ""},
	{cmd: "mysql -t", reviewed: "safe", strictSafe: true, strictRule: ""},
	{cmd: "ping 127.0.0.1 -n 4", reviewed: "safe", strictSafe: true, strictRule: ""},
	{cmd: "git status", reviewed: "safe", strictSafe: true, strictRule: ""},
	{cmd: "git diff --stat", reviewed: "safe", strictSafe: true, strictRule: ""},
	{cmd: "git log --oneline | head", reviewed: "safe", strictSafe: true, strictRule: ""},
	{cmd: "cat access.log | grep ERROR | wc -l", reviewed: "safe", strictSafe: true, strictRule: ""},
	{cmd: "ls -la", reviewed: "safe", strictSafe: true, strictRule: ""},
	{cmd: "echo hello", reviewed: "safe", strictSafe: true, strictRule: ""},
	{cmd: "grep -rn 'func' .", reviewed: "safe", strictSafe: true, strictRule: ""},
	{cmd: "go test -v ./...", reviewed: "safe", strictSafe: true, strictRule: ""},
	{cmd: "sort file.txt | uniq", reviewed: "safe", strictSafe: true, strictRule: ""},
	{cmd: "cat README.md", reviewed: "safe", strictSafe: true, strictRule: ""},
	{cmd: "for f in *.txt; do echo $f; done", reviewed: "safe", strictSafe: false, strictRule: "unquoted-var"},
	{cmd: "make build > /dev/null", reviewed: "safe", strictSafe: true, strictRule: ""},
	{cmd: "echo hi > /dev/stderr", reviewed: "safe", strictSafe: true, strictRule: ""},
	{cmd: "ls 2> /dev/null", reviewed: "safe", strictSafe: true, strictRule: ""},
	{cmd: "echo hello > output.txt", reviewed: "safe", strictSafe: true, strictRule: ""},
	{cmd: "cat report.md >> ./docs/summary.md", reviewed: "safe", strictSafe: true, strictRule: ""},
	{cmd: "git diff > diff.patch", reviewed: "safe", strictSafe: true, strictRule: ""},
	{cmd: "cat \"$QUOTED_FILE\"", reviewed: "safe", strictSafe: true, strictRule: ""},
	{cmd: "ls -la \"${MY_DIR}\"", reviewed: "safe", strictSafe: true, strictRule: ""},
	{cmd: "f=\"$1\"; cat \"$f\" | wc -l", reviewed: "safe", strictSafe: true, strictRule: ""},
	{cmd: "git commit -m 'update docs'", reviewed: "safe", strictSafe: true, strictRule: ""},
	{cmd: "git push origin main", reviewed: "safe", strictSafe: true, strictRule: ""},
	{cmd: "jq -r '(.[0] | keys_unsorted) as $keys | $keys, map([.[]])[] | @tsv' | column -t -s $'\\t'", reviewed: "safe", strictSafe: true, strictRule: ""},
	{cmd: "printf '%s %s\\n' \"$(date +%F)\" \"$1\" >> \"$HOME/md-memo-saves.log\"", reviewed: "safe", strictSafe: true, strictRule: ""},
	{cmd: "curl -s https://ipinfo.io/json", reviewed: "safe", strictSafe: true, strictRule: ""},
	{cmd: "curl -s https://example.com/data.json | jq .", reviewed: "safe", strictSafe: true, strictRule: ""},
	{cmd: "curl -s https://example.com/data.json | python -m json.tool", reviewed: "safe", strictSafe: true, strictRule: ""},
	{cmd: "command -v git >/dev/null", reviewed: "safe", strictSafe: true, strictRule: ""},
	{cmd: "if [ -n \"$1\" ]; then echo ok; fi", reviewed: "safe", strictSafe: true, strictRule: ""},
	{cmd: "find . -name '*.tmp' -print", reviewed: "safe", strictSafe: true, strictRule: ""},
	{cmd: "xargs echo", reviewed: "safe", strictSafe: true, strictRule: ""},
	{cmd: "sudo apt-get update", reviewed: "safe", strictSafe: true, strictRule: ""},
	{cmd: "env FOO=1 make test", reviewed: "safe", strictSafe: true, strictRule: ""},
	{cmd: "time make", reviewed: "safe", strictSafe: true, strictRule: ""},
	{cmd: "bash -c 'echo hi'", reviewed: "safe", strictSafe: true, strictRule: ""},
	{cmd: "sh -c \"ls -la\"", reviewed: "safe", strictSafe: true, strictRule: ""},
	{cmd: "eval \"ls\"", reviewed: "safe", strictSafe: true, strictRule: ""},
	{cmd: "Get-ChildItem | Where-Object { $_.Length -gt 1MB } | Sort-Object Length", reviewed: "safe", strictSafe: false, strictRule: "unquoted-var"},
	{cmd: "Get-Process | Select-Object -First 5", reviewed: "safe", strictSafe: true, strictRule: ""},
	{cmd: "Get-Date", reviewed: "safe", strictSafe: true, strictRule: ""},
	{cmd: "$input | Sort-Object -Descending", reviewed: "safe", strictSafe: false, strictRule: "unquoted-var"},
	{cmd: "1..10 | ForEach-Object { $_ * 2 }", reviewed: "safe", strictSafe: false, strictRule: "unquoted-var"},
	{cmd: "Remove-Item -Path ./tmp -Recurse -Force", reviewed: "warning", strictSafe: true, strictRule: ""},
	{cmd: "Stop-Computer", reviewed: "warning", strictSafe: true, strictRule: ""},
	{cmd: "Restart-Computer -Force", reviewed: "warning", strictSafe: true, strictRule: ""},
	{cmd: "format C: /fs:NTFS /q", reviewed: "blocked", strictSafe: false, strictRule: "destructive"},
	{cmd: "diskpart /s clean.txt", reviewed: "blocked", strictSafe: false, strictRule: "destructive"},
	{cmd: "rm -rf / --no-preserve-root", reviewed: "blocked", strictSafe: false, strictRule: "destructive"},
	{cmd: "rm -rf /", reviewed: "blocked", strictSafe: false, strictRule: "destructive"},
	{cmd: "rm -rf /*", reviewed: "blocked", strictSafe: false, strictRule: "destructive"},
	{cmd: "rm -rf ~", reviewed: "blocked", strictSafe: false, strictRule: "destructive"},
	{cmd: "rm -fr /", reviewed: "blocked", strictSafe: false, strictRule: "destructive"},
	{cmd: "mkfs.ext4 /dev/sda1", reviewed: "blocked", strictSafe: false, strictRule: "destructive"},
	{cmd: "dd if=/dev/zero of=/dev/sda", reviewed: "blocked", strictSafe: false, strictRule: "destructive"},
	{cmd: "dd if=/dev/zero of=/dev/nvme0n1", reviewed: "blocked", strictSafe: false, strictRule: "destructive"},
	{cmd: ":(){ :|:& };:", reviewed: "blocked", strictSafe: false, strictRule: "fork-bomb"},
	{cmd: "%0|%0", reviewed: "blocked", strictSafe: true, strictRule: ""},
	{cmd: "chmod -R 777 /", reviewed: "blocked", strictSafe: true, strictRule: ""},
	{cmd: "reg delete HKLM\\Software\\X /f", reviewed: "blocked", strictSafe: true, strictRule: ""},
	{cmd: "reg delete HKCU\\Software\\X", reviewed: "safe", strictSafe: true, strictRule: ""},
	{cmd: "wipefs -a /dev/sda1", reviewed: "blocked", strictSafe: false, strictRule: "destructive"},
	{cmd: "fdisk /dev/sda", reviewed: "blocked", strictSafe: false, strictRule: "destructive"},
	{cmd: "parted /dev/sda", reviewed: "blocked", strictSafe: false, strictRule: "destructive"},
	{cmd: "mkswap /dev/sda2", reviewed: "blocked", strictSafe: false, strictRule: "destructive"},
	{cmd: "sfdisk /dev/sda", reviewed: "blocked", strictSafe: false, strictRule: "destructive"},
	{cmd: "echo $x; wipefs -a /dev/sda1", reviewed: "blocked", strictSafe: false, strictRule: "destructive"},
	{cmd: "rm a.txt; fdisk /dev/sda", reviewed: "blocked", strictSafe: false, strictRule: "destructive"},
	{cmd: "rm a.txt; mkfs.ext4 /dev/sdb1", reviewed: "blocked", strictSafe: false, strictRule: "destructive"},
	{cmd: "shutdown /s /t 0", reviewed: "warning", strictSafe: true, strictRule: ""},
	{cmd: "shutdown -h now", reviewed: "warning", strictSafe: true, strictRule: ""},
	{cmd: "rm temp.txt", reviewed: "warning", strictSafe: false, strictRule: "destructive"},
	{cmd: "rm -r build", reviewed: "warning", strictSafe: false, strictRule: "destructive"},
	{cmd: "rmdir /s /q build", reviewed: "warning", strictSafe: true, strictRule: ""},
	{cmd: "del /f /q x.txt", reviewed: "warning", strictSafe: true, strictRule: ""},
	{cmd: "erase /s x", reviewed: "warning", strictSafe: true, strictRule: ""},
	{cmd: "drop database prod", reviewed: "warning", strictSafe: true, strictRule: ""},
	{cmd: "truncate table users", reviewed: "warning", strictSafe: true, strictRule: ""},
	{cmd: "ssh host", reviewed: "warning", strictSafe: true, strictRule: ""},
	{cmd: "telnet host 25", reviewed: "warning", strictSafe: true, strictRule: ""},
	{cmd: "ftp host", reviewed: "warning", strictSafe: true, strictRule: ""},
	{cmd: "vim notes.md", reviewed: "warning", strictSafe: true, strictRule: ""},
	{cmd: "nano notes.md", reviewed: "warning", strictSafe: true, strictRule: ""},
	{cmd: "vi x", reviewed: "warning", strictSafe: true, strictRule: ""},
	{cmd: "git commit", reviewed: "warning", strictSafe: true, strictRule: ""},
	{cmd: "git commit --amend", reviewed: "safe", strictSafe: true, strictRule: ""},
	{cmd: "echo 127.0.0.1 example.test >> /etc/hosts", reviewed: "warning", strictSafe: false, strictRule: "protected-redirect"},
	{cmd: "echo x > /etc/hosts", reviewed: "warning", strictSafe: false, strictRule: "protected-redirect"},
	{cmd: "echo test > /usr/bin/tool", reviewed: "warning", strictSafe: false, strictRule: "protected-redirect"},
	{cmd: "echo 0 > /proc/sys/kernel", reviewed: "warning", strictSafe: false, strictRule: "protected-redirect"},
	{cmd: "cat log.txt >> /bin/sh", reviewed: "warning", strictSafe: false, strictRule: "protected-redirect"},
	{cmd: "echo x > /dev/sda", reviewed: "warning", strictSafe: false, strictRule: "protected-redirect"},
	{cmd: "echo x > /boot/vmlinuz", reviewed: "warning", strictSafe: false, strictRule: "protected-redirect"},
	{cmd: "echo 'unterminated quote", reviewed: "safe", strictSafe: false, strictRule: "parse"},
	{cmd: "", reviewed: "blocked", strictSafe: false, strictRule: "empty"},
	{cmd: "   ", reviewed: "blocked", strictSafe: false, strictRule: "empty"},
	{cmd: "cat $UNQUOTED_FILE", reviewed: "safe", strictSafe: false, strictRule: "unquoted-var"},
	{cmd: "ls -la ${MY_DIR}", reviewed: "safe", strictSafe: false, strictRule: "unquoted-var"},
	{cmd: "git checkout $BRANCH", reviewed: "safe", strictSafe: false, strictRule: "unquoted-var"},
	{cmd: "#!/bin/sh\nf=\"$1\"\nif [ -n \"$f\" ]; then\n  cat \"$f\" | wc -l\nfi\n", reviewed: "safe", strictSafe: true, strictRule: ""},
	{cmd: "#!/bin/sh\nrm -f \"$1\"\n", reviewed: "warning", strictSafe: false, strictRule: "destructive"},
}

var riskRank = map[string]int{"safe": 0, "warning": 1, "blocked": 2}

// stricterOnPurpose lists the baseline commands whose verdict changed deliberately, with the reason.
// Anything not listed here must be identical to the baseline.
//
// All three are the always-refuse patterns that only the reviewed gate used to apply. `md-memo jev
// verify` (strict) is what agents are told to run before registering a command, so it has to refuse
// what the GUI gate would refuse.
var stricterOnPurpose = map[string]string{
	"%0|%0":                           "batch fork bomb: the pattern list now applies in strict mode too",
	"chmod -R 777 /":                  "recursive chmod of the root: the pattern list now applies in strict mode too",
	"reg delete HKLM\\Software\\X /f": "registry hive delete: the pattern list now applies in strict mode too",
}

func TestStrictVerifierNeverLooserThanBaseline(t *testing.T) {
	v := jev.NewASTCommandVerifier()
	for _, c := range baselineCases {
		res, err := v.Verify(c.cmd)
		if err != nil {
			t.Fatalf("Verify(%q): %v", c.cmd, err)
		}
		switch {
		case !c.strictSafe && res.IsSafe:
			t.Errorf("strict verifier got LOOSER for %q: was refused (%s), now safe", c.cmd, c.strictRule)
		case !c.strictSafe && res.Rule != c.strictRule:
			t.Errorf("strict verifier reports a different rule for %q: baseline %q, now %q", c.cmd, c.strictRule, res.Rule)
		case c.strictSafe && !res.IsSafe:
			if _, ok := stricterOnPurpose[c.cmd]; !ok {
				t.Errorf("strict verifier changed for %q: was safe, now refused (rule %q) and not listed in stricterOnPurpose", c.cmd, res.Rule)
			}
		}
	}
}

func TestReviewedGateKeepsBaselineVerdicts(t *testing.T) {
	for _, c := range baselineCases {
		got := validateCliCommand(c.cmd).RiskLevel
		if got == c.reviewed {
			continue
		}
		if riskRank[got] < riskRank[c.reviewed] {
			t.Errorf("reviewed gate got LOOSER for %q: baseline %s, now %s", c.cmd, c.reviewed, got)
			continue
		}
		if _, ok := stricterOnPurpose[c.cmd]; !ok {
			t.Errorf("reviewed gate changed for %q: baseline %s, now %s (stricter, but not listed in stricterOnPurpose)", c.cmd, c.reviewed, got)
		}
	}
}
