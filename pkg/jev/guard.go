package jev

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"sync"
)

// Mode selects how strictly VerifyCommand judges a command. The same rules run in every mode; the
// mode only decides how serious each finding is, because who is watching differs:
//
//   - ModeStrict:     one-click execution with nobody reviewing (Quick Actions, `md-memo jev verify`).
//   - ModeReviewed:   a person sees the command before it runs (the Ctrl+Shift+B bar, the AI CLI bar).
//   - ModeUnattended: no person at all (hooks). Nothing is merely a warning there.
type Mode int

const (
	ModeStrict Mode = iota
	ModeReviewed
	ModeUnattended
)

func (m Mode) String() string {
	switch m {
	case ModeReviewed:
		return "reviewed"
	case ModeUnattended:
		return "unattended"
	default:
		return "strict"
	}
}

// ParseMode maps the --mode flag value to a Mode.
func ParseMode(s string) (Mode, bool) {
	switch strings.ToLower(strings.TrimSpace(s)) {
	case "strict":
		return ModeStrict, true
	case "reviewed":
		return ModeReviewed, true
	case "unattended":
		return ModeUnattended, true
	}
	return ModeStrict, false
}

// Level is the outcome of a check: run it, ask first, or refuse.
type Level int

const (
	LevelSafe Level = iota
	LevelWarn
	LevelBlock
)

func (l Level) String() string {
	switch l {
	case LevelWarn:
		return "warn"
	case LevelBlock:
		return "block"
	default:
		return "safe"
	}
}

// MarshalJSON writes the level as "safe" / "warn" / "block" so machine readers do not depend on the
// numeric values.
func (l Level) MarshalJSON() ([]byte, error) {
	return []byte(strconv.Quote(l.String())), nil
}

// Verdict is what VerifyCommand returns. Rule names the guardrail rule that decided ("empty",
// "fork-bomb", "parse", "destructive", "wrapper", "protected-redirect", "unquoted-var", "pipe-to-shell",
// "opaque", "eval", "privilege", "user-rule", or the id of a blocked-pattern such as "rm-rf-root"),
// Subject is the offending command name, variable or path, and Reason is a human sentence in the same
// Japanese-then-English style the rest of the app uses. All three are empty for LevelSafe.
type Verdict struct {
	Level   Level  `json:"level"`
	Rule    string `json:"rule,omitempty"`
	Subject string `json:"subject,omitempty"`
	Reason  string `json:"reason,omitempty"`
	// ParseFailed is true when the command could not be parsed as bash at all (only ModeStrict and
	// ModeUnattended treat that as a refusal; ModeReviewed falls back to the pattern checks).
	ParseFailed bool `json:"parseFailed,omitempty"`
}

// Safe reports whether nothing was found.
func (v Verdict) Safe() bool { return v.Level == LevelSafe }

// ValidationResult converts the verdict to the older result type used by CommandVerifier and the
// `jev verify --json` output. IsSafe is true only for LevelSafe: a warning is "not safe to run without
// a look".
func (v Verdict) ValidationResult(cmd string) ValidationResult {
	return ValidationResult{
		IsSafe:      v.Level == LevelSafe,
		Reason:      v.Reason,
		Command:     cmd,
		ParseFailed: v.ParseFailed,
		Rule:        v.Rule,
		Subject:     v.Subject,
		Level:       v.Level.String(),
	}
}

// VerifyCommand is the single safety judgement for shell commands. `md-memo jev verify`, the filter
// registry, the GUI run gate and the hook runner all go through it, so a command can never pass one
// of them and fail another. rules may be nil; it can only make the verdict stricter (see Rules).
//
// It is a static check of bash text, not a sandbox: it cannot see inside another script or binary, and
// a string assembled at run time is reported as "opaque" rather than followed.
func VerifyCommand(cmd string, mode Mode, rules *Rules) Verdict {
	return verifyCommand(cmd, mode, rules, false)
}

// verifyCommand is VerifyCommand plus the one knob the older ASTCommandVerifier exposes.
func verifyCommand(cmd string, mode Mode, rules *Rules, allowUnquotedVars bool) Verdict {
	trimmed := strings.TrimSpace(cmd)
	if trimmed == "" {
		return Verdict{Level: LevelBlock, Rule: "empty", Reason: "コマンドが空です (Empty command)"}
	}
	if blockTables().forkBomb.MatchString(trimmed) {
		return Verdict{Level: LevelBlock, Rule: "fork-bomb", Reason: "フォーク爆弾パターンを検知しました (Fork bomb detected)"}
	}
	if mode == ModeReviewed {
		return verifyReviewed(trimmed, rules)
	}
	return verifyAutomated(trimmed, mode, rules, allowUnquotedVars)
}

// verifyReviewed is the gate for commands a person sees first. The order is deliberate and is the one
// the GUI gate always had: the pattern block list, then the AST's block tier, then the warnings. A
// warning-level regex match (their patterns are loose, e.g. "/s" also matches "/dev/sda") must never
// be able to downgrade a disk-level command to a mere confirmation.
func verifyReviewed(cmd string, rules *Rules) Verdict {
	if v, ok := matchBlockedPattern(cmd, rules); ok {
		return v
	}

	// The AST grammar is bash, and the command is always analysed with it. This gate used to skip the AST
	// for anything that "looks like PowerShell", but that test also matches plain bash ({} in
	// `find -exec rm {} \;`, $( ) and ${ }), which switched the whole analysis off for exactly the
	// commands it exists for. The skip protected against reading "$_.Length" as an unquoted variable,
	// and this mode does not apply that rule, so it is not needed: real PowerShell either parses to
	// something harmless or fails to parse, and a parse failure is "not analysed", not "unsafe" (the
	// patterns still apply).
	var best Verdict
	if fs, err := analyzeSource(cmd, &astOptions{allowUnquotedVars: true, rules: rules}, 0); err == nil {
		best = pickBest(fs, ModeReviewed)
	}
	if best.Level == LevelBlock {
		return best
	}

	w := warnTables()
	for _, r := range w.rules {
		if r.re.MatchString(cmd) {
			return Verdict{Level: LevelWarn, Rule: r.id, Reason: r.reason}
		}
	}
	// A commit without -m opens an editor and hangs a captured-stdout run.
	if w.gitCommit.MatchString(cmd) && !w.gitCommitMsg.MatchString(cmd) {
		return Verdict{Level: LevelWarn, Rule: "interactive-git-commit", Reason: "対話型エディタが起動しハングする可能性があります (Interactive git commit)"}
	}

	if best.Level == LevelWarn {
		return best
	}
	return Verdict{Level: LevelSafe}
}

// verifyAutomated is the gate for commands nobody looks at (ModeStrict, ModeUnattended). Findings are
// mapped to levels by pickBest; the difference between the two modes is entirely in that mapping.
func verifyAutomated(cmd string, mode Mode, rules *Rules, allowUnquotedVars bool) Verdict {
	fs, err := analyzeSource(cmd, &astOptions{allowUnquotedVars: allowUnquotedVars, rules: rules}, 0)
	if err != nil {
		return Verdict{
			Level:       LevelBlock,
			Rule:        "parse",
			Reason:      fmt.Sprintf("構文解析エラー: %v (Bash syntax parse error)", err),
			ParseFailed: true,
		}
	}
	best := pickBest(fs, mode)
	if best.Level == LevelBlock {
		return best
	}
	if v, ok := matchBlockedPattern(cmd, rules); ok {
		return v
	}
	return best
}

// reasonBlockedPattern is the sentence every pattern-list hit carries. It is the text the GUI gate has
// always shown for these, so users see no change.
const reasonBlockedPattern = "重大なシステム破壊を引き起こす可能性があるためブロックされました (Blocked dangerous command)"

// rxRule is one compiled pattern with the id that machine readers see as Verdict.Rule.
type rxRule struct {
	id     string
	re     *regexp.Regexp
	reason string
}

type blockSet struct {
	forkBomb *regexp.Regexp
	rules    []rxRule
}

// blockTables holds the patterns that are always refused. They are compiled on first use, not at
// start-up: 24 patterns cost about 60 KiB of resident heap and half a millisecond, and most runs of the
// app (and most CLI calls) never validate a command.
var blockTables = sync.OnceValue(func() *blockSet {
	forkBomb := regexp.MustCompile(`:\(\)\s*\{\s*:\|:&\s*\};:`)
	block := func(id, expr string) rxRule {
		return rxRule{id: id, re: regexp.MustCompile(expr), reason: reasonBlockedPattern}
	}
	return &blockSet{
		forkBomb: forkBomb,
		rules: []rxRule{
			// Windows drive formatting / disk wiping
			block("format-drive", `(?i)\bformat\s+[a-z]:`),
			block("diskpart", `(?i)\bdiskpart\b`),
			// Unix root / home wipe: rm -rf / or rm -rf /* or rm -rf ~. The target may end at a quote, a
			// closing parenthesis, a backtick or an operator as well as at whitespace: `bash -c "rm -rf /"`
			// and `echo "$(rm -rf /)"` are the same wipe. (\x60 is the backtick, which a raw string cannot hold.)
			block("rm-rf-root", `(?i)\brm\s+-[a-z]*r[a-z]*f[a-z]*\s+.*(/|/\*|~|~\*)($|[\s)"';&|\x60])`),
			block("rm-rf-root", `(?i)\brm\s+-[a-z]*f[a-z]*r[a-z]*\s+.*(/|/\*|~|~\*)($|[\s)"';&|\x60])`),
			block("mkfs", `(?i)\bmkfs\b`),
			block("dd-device", `(?i)\bdd\s+if=.*of=/dev/(sd[a-z]|nvme|hd[a-z]|disk)`),
			// Fork bomb patterns
			{id: "fork-bomb", re: forkBomb, reason: reasonBlockedPattern},
			block("batch-fork-bomb", `(?i)%0\|%0`),
			// Root chmod
			block("chmod-root", `(?i)\bchmod\s+-[a-z]*R\s+777\s+/`),
			// Windows registry destructive deletes
			block("reg-delete", `(?i)\breg\s+delete\s+hk(lm|cr|u)\b`),
		},
	}
})

type warnSet struct {
	rules        []rxRule
	gitCommit    *regexp.Regexp
	gitCommitMsg *regexp.Regexp
}

// warnTables holds the reviewed-mode-only warnings: high-impact operations that warrant a confirmation
// dialog, and commands that would hang because they wait for interactive input. Also compiled lazily.
var warnTables = sync.OnceValue(func() *warnSet {
	warn := func(id, expr, reason string) rxRule {
		return rxRule{id: id, re: regexp.MustCompile(expr), reason: reason}
	}
	return &warnSet{
		rules: []rxRule{
			warn("power-state", `(?i)\b(shutdown|Stop-Computer|Restart-Computer)\b`, "システム終了・再起動の可能性があります (System power state change)"),
			warn("recursive-delete", `(?i)\b(Remove-Item|rm|del|rmdir|rd)\b.*(-r|-Recurse|/s)`, "再帰的なファイル・フォルダ削除の可能性があります (Recursive file deletion)"),
			warn("batch-delete", `(?i)\b(del|erase)\s+/[fqs]`, "強制・一括ファイル削除の可能性があります (Batch file deletion)"),
			warn("db-drop", `(?i)\b(drop\s+database|truncate\s+table)\b`, "データベースの破壊・全消去の可能性があります (Database drop/truncate)"),
			warn("interactive-remote", `(?i)\b(ssh|telnet|ftp)\b`, "対話型セッションのため完了せずハングする可能性があります (Interactive remote shell)"),
			warn("interactive-editor", `(?i)\b(nano|vim?|vi|pico)\b`, "対話型テキストエディタのためハングする可能性があります (Interactive text editor)"),
		},
		gitCommit:    regexp.MustCompile(`(?i)\bgit\s+commit\b`),
		gitCommitMsg: regexp.MustCompile(`(?i)\bgit\s+commit\b.*-[a-z]*m`),
	}
})

// matchBlockedPattern applies the always-refuse patterns, then the user's own (jev.json). It reports the
// first hit.
func matchBlockedPattern(cmd string, rules *Rules) (Verdict, bool) {
	for _, r := range blockTables().rules {
		if r.re.MatchString(cmd) {
			return Verdict{Level: LevelBlock, Rule: r.id, Reason: r.reason}, true
		}
	}
	if rules != nil {
		for _, r := range rules.patterns {
			if r.re.MatchString(cmd) {
				return Verdict{Level: LevelBlock, Rule: "user-rule:" + r.id, Reason: r.reason}, true
			}
		}
	}
	return Verdict{}, false
}
