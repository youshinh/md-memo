package jev

import (
	"fmt"
	"path"
	"strings"

	"mvdan.cc/sh/v3/syntax"
)

// tier says how serious a finding is independently of the mode; Mode decides what each tier means.
//
//	tier            ModeStrict   ModeReviewed        ModeUnattended
//	tierDisk        block        block               block
//	tierRemove      block        warn (ask first)    block
//	tierHygiene     block        not applied         block
//	tierHeuristic   warn         warn                block
//	tierUnattended  not applied  not applied         block
type tier int

const (
	tierDisk       tier = iota // disk-level destruction, a user-blocked command
	tierRemove                 // rm / find -delete / a redirect into a system directory
	tierHygiene                // an unquoted variable expansion
	tierHeuristic              // pipe into an interpreter, a string that cannot be analysed
	tierUnattended             // sudo, eval: fine when someone is watching, not when nobody is
)

// finding is one thing the AST walk noticed. sev orders findings of the same level: the most severe is
// the one reported, so a mild finding early in a command can never hide a worse one later
// (`rm a; wipefs /dev/sda`). Ties keep the first.
type finding struct {
	rule, subject, reason string
	sev                   int
	tier                  tier
}

func (f finding) levelFor(mode Mode) (Level, bool) {
	switch f.tier {
	case tierDisk:
		return LevelBlock, true
	case tierRemove:
		if mode == ModeReviewed {
			return LevelWarn, true
		}
		return LevelBlock, true
	case tierHygiene:
		if mode == ModeReviewed {
			return LevelSafe, false
		}
		return LevelBlock, true
	case tierHeuristic:
		if mode == ModeUnattended {
			return LevelBlock, true
		}
		return LevelWarn, true
	case tierUnattended:
		if mode == ModeUnattended {
			return LevelBlock, true
		}
		return LevelSafe, false
	}
	return LevelSafe, false
}

// reasonFor words a finding for the mode. In reviewed mode a remove-tier finding is a question to a
// person ("really delete?"), not a refusal, so it says that.
func (f finding) reasonFor(mode Mode, lvl Level) string {
	if mode == ModeReviewed && lvl == LevelWarn && f.tier == tierRemove {
		if f.rule == "protected-redirect" {
			return fmt.Sprintf("システムディレクトリ %q への書き込みの可能性があります (Write into a system directory)", f.subject)
		}
		return "ファイル削除の可能性があります (File deletion)"
	}
	return f.reason
}

// pickBest reduces findings to the one verdict for mode: the highest level, then the highest severity,
// then the earliest.
func pickBest(fs []finding, mode Mode) Verdict {
	best := Verdict{Level: LevelSafe}
	bestSev := -1
	for _, f := range fs {
		lvl, applies := f.levelFor(mode)
		if !applies {
			continue
		}
		if lvl > best.Level || (lvl == best.Level && f.sev > bestSev) {
			best = Verdict{Level: lvl, Rule: f.rule, Subject: f.subject, Reason: f.reasonFor(mode, lvl)}
			bestSev = f.sev
		}
	}
	return best
}

type astOptions struct {
	// allowUnquotedVars disables the "unquoted-var" rule. It is a style/injection-hygiene rule, used as
	// is for one-click Quick Actions and hooks, but too strict where the user reviews the command.
	allowUnquotedVars bool
	rules             *Rules
}

// maxNestDepth bounds how far a string handed to `bash -c` / `eval` is followed. Deeper than this is
// reported as opaque instead of analysed.
const maxNestDepth = 3

// analyzeSource parses src as bash and reports everything the rules notice. A fresh *syntax.Parser is
// used per call: mvdan.cc/sh/v3's Parser keeps internal lexer state across a Parse call and is not safe
// for concurrent reuse, and the verifiers are shared between concurrently running requests.
func analyzeSource(src string, opts *astOptions, depth int) ([]finding, error) {
	parser := syntax.NewParser(syntax.KeepComments(true), syntax.Variant(syntax.LangBash))
	file, err := parser.Parse(strings.NewReader(src), "")
	if err != nil {
		return nil, err
	}
	w := &walker{opts: opts, depth: depth}
	w.walk(file, false)
	return w.out, nil
}

type walker struct {
	opts  *astOptions
	depth int
	out   []finding
}

func (w *walker) add(f finding) { w.out = append(w.out, f) }

// walk visits node. quoted is true inside double quotes, where a parameter expansion is not word-split;
// it is reset for anything that starts a new command context ($(...), <(...)), because there the
// expansion is unquoted again. Command substitutions inside double quotes are therefore inspected:
// `echo "$(rm -rf /)"` runs the rm.
func (w *walker) walk(node syntax.Node, quoted bool) {
	syntax.Walk(node, func(n syntax.Node) bool {
		if n == nil {
			return true
		}
		switch x := n.(type) {
		case *syntax.CallExpr:
			w.call(x.Args, "")
		case *syntax.DblQuoted:
			for _, part := range x.Parts {
				w.walk(part, true)
			}
			return false
		case *syntax.CmdSubst:
			for _, st := range x.Stmts {
				w.walk(st, false)
			}
			return false
		case *syntax.ProcSubst:
			for _, st := range x.Stmts {
				w.walk(st, false)
			}
			return false
		case *syntax.ParamExp:
			if !quoted && !w.opts.allowUnquotedVars && x.Param != nil {
				name := x.Param.Value
				w.add(finding{
					rule: "unquoted-var", subject: name, sev: 1, tier: tierHygiene,
					reason: fmt.Sprintf("未クォート変数の展開 ($%s) を検知しました。意図しない展開やインジェクション防止のためダブルクォートで囲む必要があります (Unquoted variable expansion blocked)", name),
				})
			}
		case *syntax.Redirect:
			w.redirect(x)
		case *syntax.BinaryCmd:
			w.pipeline(x)
		}
		return true
	})
}

func (w *walker) redirect(r *syntax.Redirect) {
	switch r.Op {
	case syntax.RdrOut, syntax.AppOut, syntax.DplOut, syntax.ClbOut, syntax.RdrAll, syntax.AppAll:
	default:
		return
	}
	if r.Word == nil {
		return
	}
	target := wordToString(r.Word)
	if isProtectedSystemPath(target, w.opts.rules) {
		w.add(finding{
			rule: "protected-redirect", subject: target, sev: 2, tier: tierRemove,
			reason: fmt.Sprintf("システム重要ディレクトリ %q へのリダイレクト書き込みは物理的に遮断されています (Protected system path redirect blocked)", target),
		})
	}
}

// call inspects one simple command. via names the wrapper (sudo, xargs, find -exec, ...) this call was
// reached through, or is empty for a command that is run directly.
func (w *walker) call(args []*syntax.Word, via string) {
	if len(args) == 0 {
		return
	}
	head := wordToString(args[0])
	base, stem := commandBase(head)

	if r := w.opts.rules; r != nil {
		if name, ok := r.blockedName(base, stem); ok {
			w.add(finding{
				rule: "user-rule", subject: name, sev: 3, tier: tierDisk,
				reason: fmt.Sprintf("jev.json のルールにより %q は拒否されました (Blocked by jev.json rule)", name),
			})
			return
		}
		if name, ok := r.warnedName(base, stem); ok {
			w.add(finding{
				rule: "user-rule", subject: name, sev: 2, tier: tierHeuristic,
				reason: fmt.Sprintf("jev.json のルールにより %q は要確認です (Flagged by jev.json rule)", name),
			})
		}
	}

	name, sev := base, destructiveSeverity(base)
	if sev == 0 {
		name, sev = stem, destructiveSeverity(stem)
	}
	if sev > 0 {
		w.destructive(head, name, sev, via)
		return
	}

	switch base {
	case "sudo", "su", "doas", "pkexec":
		w.add(finding{
			rule: "privilege", subject: base, sev: 2, tier: tierUnattended,
			reason: fmt.Sprintf("権限昇格コマンド %q は無人実行では許可されません (Privilege escalation is not allowed in unattended mode)", base),
		})
	case "eval":
		w.add(finding{
			rule: "eval", subject: "eval", sev: 2, tier: tierUnattended,
			reason: "eval は無人実行では許可されません (eval is not allowed in unattended mode)",
		})
		w.eval(args)
		return
	case "find":
		w.find(args)
		return
	}

	if isCShell(base) {
		w.shellC(base, args)
	}
	if isWrapper(base) {
		w.wrapper(base, args)
	}
}

func (w *walker) destructive(head, name string, sev int, via string) {
	t := tierDisk
	if name == "rm" {
		t = tierRemove
	}
	f := finding{
		rule: "destructive", subject: name, sev: sev, tier: t,
		reason: fmt.Sprintf("破壊的コマンド %q は安全基準により実行を拒否されました (Destructive command blocked)", head),
	}
	if via != "" {
		f.rule = "wrapper"
		f.reason = fmt.Sprintf("%s 経由の破壊的コマンド %q を検知しました (Destructive command behind wrapper %s)", via, name, via)
	}
	w.add(f)
}

func (w *walker) opaque(outer string) {
	w.add(finding{
		rule: "opaque", subject: outer, sev: 2, tier: tierHeuristic,
		reason: fmt.Sprintf("%s に渡された文字列が動的、または解析できないため安全性を確認できません (Dynamic string passed to %s cannot be analyzed)", outer, outer),
	})
}

// wrapper looks past a command that only runs another command (sudo, env, xargs, timeout, ...). The
// wrapper's own flags are not parsed: the first later word that names something the guard cares about
// is treated as the real command, which errs on the side of catching too much (`time echo rm` is
// flagged; `sudo -u root rm x` is caught).
func (w *walker) wrapper(name string, args []*syntax.Word) {
	// `command -v git` only looks a command up.
	if name == "command" && len(args) > 1 {
		if lit, ok := literalWord(args[1]); ok && (lit == "-v" || lit == "-V") {
			return
		}
	}
	for i := 1; i < len(args); i++ {
		lit, ok := literalWord(args[i])
		if !ok {
			continue
		}
		base, stem := commandBase(lit)
		if w.interesting(base, stem) {
			w.call(args[i:], name)
			return
		}
	}
}

// interesting reports whether a word, met behind a wrapper, is a command the guard has an opinion on.
func (w *walker) interesting(base, stem string) bool {
	return destructiveSeverity(base) > 0 || destructiveSeverity(stem) > 0 ||
		isWrapper(base) || isCShell(base) || base == "eval" || base == "find" ||
		w.opts.rules.knows(base, stem)
}

// shellC follows the string given to `sh -c '...'` (and su -c, bash -lc, ...). A literal string is
// analysed as a command of its own; a string built at run time cannot be, and is reported as opaque.
func (w *walker) shellC(name string, args []*syntax.Word) {
	src, dynamic, found := shellCString(args[1:])
	if !found {
		return
	}
	if dynamic {
		w.opaque(name)
		return
	}
	w.nested(name, src)
}

func (w *walker) eval(args []*syntax.Word) {
	if len(args) < 2 {
		return
	}
	parts := make([]string, 0, len(args)-1)
	for _, a := range args[1:] {
		lit, ok := literalWord(a)
		if !ok {
			w.opaque("eval")
			return
		}
		parts = append(parts, lit)
	}
	w.nested("eval", strings.Join(parts, " "))
}

// nested analyses a command string handed to another shell. The always-refuse patterns are applied to
// it as well, because `bash -c "rm -rf /"` has to be refused exactly like `rm -rf /`.
func (w *walker) nested(outer, src string) {
	if w.depth >= maxNestDepth {
		w.opaque(outer)
		return
	}
	if v, ok := matchBlockedPattern(src, w.opts.rules); ok {
		w.add(finding{rule: v.Rule, subject: outer, sev: 3, tier: tierDisk, reason: v.Reason})
	}
	fs, err := analyzeSource(src, w.opts, w.depth+1)
	if err != nil {
		w.opaque(outer)
		return
	}
	for _, f := range fs {
		f.reason = "[" + outer + "] " + f.reason
		w.add(f)
	}
}

// find checks the two ways find deletes or runs things: -delete, and the command after -exec.
func (w *walker) find(args []*syntax.Word) {
	for i := 1; i < len(args); i++ {
		lit, ok := literalWord(args[i])
		if !ok {
			continue
		}
		switch lit {
		case "-delete":
			w.add(finding{
				rule: "destructive", subject: "find -delete", sev: 2, tier: tierRemove,
				reason: "find -delete による一括削除を検知しました (find -delete blocked)",
			})
		case "-exec", "-execdir", "-ok", "-okdir":
			end := i + 1
			for end < len(args) {
				if l, ok := literalWord(args[end]); ok && (l == ";" || l == "+") {
					break
				}
				end++
			}
			if i+1 < end {
				w.call(args[i+1:end], "find "+lit)
			}
			i = end
		}
	}
}

// pipeline flags `curl ... | sh`: fetching from the network and handing the result straight to an
// interpreter runs whatever the server sends. Shells are flagged unless they were given -c; script
// interpreters only when they read the script from stdin (python -m json.tool is fine).
func (w *walker) pipeline(b *syntax.BinaryCmd) {
	if b.Op != syntax.Pipe && b.Op != syntax.PipeAll {
		return
	}
	if b.X == nil || b.Y == nil {
		return
	}
	call, ok := b.Y.Cmd.(*syntax.CallExpr)
	if !ok {
		return
	}
	name, rest, isShell, found := interpreterOf(call.Args)
	if !found || !feedsStdinAsScript(isShell, rest) || !fetchesFromNetwork(b.X) {
		return
	}
	w.add(finding{
		rule: "pipe-to-shell", subject: name, sev: 2, tier: tierHeuristic,
		reason: fmt.Sprintf("ネットワークから取得した内容をインタプリタ (%s) へ直接渡しています (Pipe from the network into an interpreter)", name),
	})
}

// interpreterOf finds the interpreter a pipeline's right-hand side runs, looking past wrappers such as
// `sudo -u root bash`.
func interpreterOf(args []*syntax.Word) (name string, rest []*syntax.Word, isShell, found bool) {
	for i := 0; i < len(args); i++ {
		lit, ok := literalWord(args[i])
		if !ok {
			continue
		}
		base, stem := commandBase(lit)
		switch {
		case isShellName(base) || isShellName(stem):
			return base, args[i+1:], true, true
		case isScriptInterpreter(base) || isScriptInterpreter(stem):
			return base, args[i+1:], false, true
		}
		if i == 0 && !isWrapper(base) {
			return "", nil, false, false
		}
	}
	return "", nil, false, false
}

func feedsStdinAsScript(isShell bool, rest []*syntax.Word) bool {
	if isShell {
		for _, a := range rest {
			if lit, ok := literalWord(a); ok && isCFlag(lit) {
				return false
			}
		}
		return true
	}
	if len(rest) == 0 {
		return true
	}
	if len(rest) == 1 {
		if lit, ok := literalWord(rest[0]); ok && (lit == "-" || lit == "-s") {
			return true
		}
	}
	return false
}

func fetchesFromNetwork(stmt *syntax.Stmt) bool {
	found := false
	syntax.Walk(stmt, func(n syntax.Node) bool {
		if c, ok := n.(*syntax.CallExpr); ok && len(c.Args) > 0 {
			base, stem := commandBase(wordToString(c.Args[0]))
			if isFetcher(base) || isFetcher(stem) {
				found = true
			}
		}
		return !found
	})
	return found
}

// shellCString returns the string passed with -c. dynamic is true when the flag is present but the
// string is not a plain literal.
func shellCString(rest []*syntax.Word) (src string, dynamic, found bool) {
	for i, a := range rest {
		lit, ok := literalWord(a)
		if !ok || !isCFlag(lit) {
			continue
		}
		if i+1 >= len(rest) {
			return "", false, false
		}
		s, ok := literalWord(rest[i+1])
		if !ok {
			return "", true, true
		}
		return s, false, true
	}
	return "", false, false
}

// isCFlag reports whether s is a short-option cluster containing c: -c, -lc, -ec.
func isCFlag(s string) bool {
	if len(s) < 2 || s[0] != '-' || s[1] == '-' {
		return false
	}
	hasC := false
	for _, c := range s[1:] {
		switch {
		case c == 'c':
			hasC = true
		case c >= 'a' && c <= 'z', c >= 'A' && c <= 'Z':
		default:
			return false
		}
	}
	return hasC
}

// The name tables below are switches, not maps or slices: a package-level map is built at start-up,
// a switch costs nothing until it is called.

// destructiveSeverity rates the commands that are refused outright: 3 for disk-level destruction, 2 for
// rm (legitimate often enough that reviewed mode only asks). 0 means not destructive.
func destructiveSeverity(name string) int {
	switch name {
	case "rm":
		return 2
	case "dd", "mkfs", "fdisk", "wipefs", "format", "parted", "mkswap", "sfdisk", "diskpart":
		return 3
	}
	return 0
}

func isWrapper(name string) bool {
	switch name {
	case "sudo", "doas", "pkexec", "env", "command", "exec", "nohup", "nice", "ionice", "time",
		"timeout", "stdbuf", "setsid", "xargs", "watch", "builtin", "busybox":
		return true
	}
	return false
}

// isCShell reports commands that run the string given with -c.
func isCShell(name string) bool {
	switch name {
	case "sh", "bash", "zsh", "dash", "ksh", "fish", "ash", "su", "runuser":
		return true
	}
	return false
}

func isShellName(name string) bool {
	switch name {
	case "sh", "bash", "zsh", "dash", "ksh", "fish", "ash", "csh", "tcsh":
		return true
	}
	return false
}

func isScriptInterpreter(name string) bool {
	switch name {
	case "python", "python2", "python3", "perl", "ruby", "node", "php", "lua", "osascript", "pwsh", "powershell":
		return true
	}
	return false
}

func isFetcher(name string) bool {
	switch name {
	case "curl", "wget", "fetch", "iwr", "irm", "invoke-webrequest", "invoke-restmethod", "nc", "ncat":
		return true
	}
	return false
}

// commandBase reduces a command word to its lower-case name without the directory, and to the stem
// before the first dot (mkfs.ext4 -> mkfs, rm.exe -> rm). Both / and \ separate directories so a
// Windows-style path is understood on any host.
func commandBase(s string) (base, stem string) {
	if i := strings.LastIndexAny(s, `/\`); i >= 0 {
		s = s[i+1:]
	}
	base = strings.ToLower(s)
	stem = base
	if i := strings.Index(base, "."); i > 0 {
		stem = base[:i]
	}
	return base, stem
}

// wordToString flattens a word to the text the shell would see, with parameter expansions left as
// "$name". Backslash escapes in unquoted text are removed the way the shell does (r\m is rm, \rm is rm).
func wordToString(w *syntax.Word) string {
	if w == nil {
		return ""
	}
	var sb strings.Builder
	for _, part := range w.Parts {
		switch p := part.(type) {
		case *syntax.Lit:
			sb.WriteString(unescapeLit(p.Value))
		case *syntax.SglQuoted:
			sb.WriteString(p.Value)
		case *syntax.DblQuoted:
			for _, sub := range p.Parts {
				if lit, ok := sub.(*syntax.Lit); ok {
					sb.WriteString(lit.Value)
				}
			}
		case *syntax.ParamExp:
			if p.Param != nil {
				sb.WriteString("$" + p.Param.Value)
			}
		}
	}
	return sb.String()
}

// literalWord is wordToString for words that are entirely fixed text. ok is false when any part is
// computed at run time (a variable, a command substitution, arithmetic), because then the word is not
// known until the command runs.
func literalWord(w *syntax.Word) (string, bool) {
	if w == nil {
		return "", false
	}
	var sb strings.Builder
	for _, part := range w.Parts {
		switch p := part.(type) {
		case *syntax.Lit:
			sb.WriteString(unescapeLit(p.Value))
		case *syntax.SglQuoted:
			sb.WriteString(p.Value)
		case *syntax.DblQuoted:
			for _, sub := range p.Parts {
				lit, ok := sub.(*syntax.Lit)
				if !ok {
					return "", false
				}
				sb.WriteString(lit.Value)
			}
		default:
			return "", false
		}
	}
	return sb.String(), true
}

// unescapeLit removes the backslash quoting from unquoted text: `\x` is `x`, and a backslash-newline
// line continuation disappears.
func unescapeLit(s string) string {
	if !strings.Contains(s, `\`) {
		return s
	}
	var sb strings.Builder
	for i := 0; i < len(s); i++ {
		if s[i] == '\\' && i+1 < len(s) {
			i++
			if s[i] == '\n' {
				continue
			}
		}
		sb.WriteByte(s[i])
	}
	return sb.String()
}

// System directories where redirection is strictly prohibited
var protectedSysDirs = []string{
	"/",
	"/etc",
	"/bin",
	"/sbin",
	"/usr",
	"/boot",
	"/dev",
	"/proc",
	"/sys",
	"/var/run",
	"/lib",
	"/lib64",
	`c:\windows`,
	`c:\program files`,
}

// isHarmlessRedirectTarget reports the pseudo-devices that are routinely used as redirect targets and
// never modify the system.
func isHarmlessRedirectTarget(lower string) bool {
	switch lower {
	case "/dev/null", "/dev/stdout", "/dev/stderr", "/dev/tty":
		return true
	}
	return false
}

// normalizePath brings a path to one comparable form on every host: forward slashes, cleaned, lower
// case. Backslashes are converted explicitly (filepath only does it on Windows), so `C:\Windows` in a
// command is recognised on any machine the guard runs on.
func normalizePath(p string) string {
	return strings.ToLower(path.Clean(strings.ReplaceAll(p, `\`, "/")))
}

func isProtectedSystemPath(p string, rules *Rules) bool {
	lower := normalizePath(p)

	if lower == "/" {
		return true
	}
	if isHarmlessRedirectTarget(lower) {
		return false
	}

	for _, dir := range protectedSysDirs {
		dirLower := normalizePath(dir)
		if lower == dirLower || strings.HasPrefix(lower, dirLower+"/") {
			return true
		}
	}

	return rules.protects(lower)
}
