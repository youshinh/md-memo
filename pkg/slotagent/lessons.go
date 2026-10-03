package slotagent

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode"
	"unicode/utf8"

	"md-memo/pkg/appdir"
	"md-memo/pkg/atomicfile"
	"md-memo/pkg/lazyre"
)

// Lessons (docs/design/lessons-2026-10.md): a few short rules a person approved after an agent's run failed, kept in one Markdown file
// per agent and put in front of that agent's instruction on its next runs.
//
//	<settings folder>/lessons/<agent key>.md
//	    # Lessons for claude-code
//	    <!-- md-memo lessons: one rule per "- " line. Edit or delete freely; other lines are ignored. -->
//	    - Do not include ADF.h: the build fails on this machine. <!-- 2026-10-03 -->
//
// Nothing here runs until an agent is started (one stat of the file) or the person asks for a list or saves a rule. MD-Memo writes the
// file only when a person saves a proposal (AppendLessons); no command line or JSON-RPC method writes it, because that would let an agent
// change its own future instructions without anybody approving.

const (
	// LessonsMaxFileBytes is how much of a file is read: its end, because the newest rules are the last lines.
	LessonsMaxFileBytes = 64 * 1024
	// LessonMaxChars is the longest rule (in characters); a longer line is ignored.
	LessonMaxChars = 300
	// LessonsApplyMax and LessonsApplyMaxChars bound what one run gets: the newest rules, at most this many and this many characters
	// in all. The older ones are counted as skipped.
	LessonsApplyMax      = 30
	LessonsApplyMaxChars = 4000
	// LessonsFileMax is how many rules one file may hold: a save past it is refused (ErrTooManyLessons).
	LessonsFileMax = 200
	// LessonsSaveMax is how many rules one save adds; LessonsProposeMax how many a model may propose.
	LessonsSaveMax    = 5
	LessonsProposeMax = 2
	// lessonsEditMaxBytes: a file bigger than this is not rewritten (it would have to be read whole).
	lessonsEditMaxBytes = 1 << 20
	// lessonsListMax bounds a list of the lessons folder.
	lessonsListMax = 200
)

// LessonsBlockHeading is the first line of what is put in front of an agent's instruction.
const LessonsBlockHeading = "Lessons from earlier runs on this machine (written or approved by the user; follow them):"

// ErrTooManyLessons is the refusal of a save that would take a file past LessonsFileMax rules. Its text is the code the window acts on.
var ErrTooManyLessons = errors.New("too_many")

// Why a proposed rule is refused (the second result of CleanLessonRule).
const (
	LessonEmpty         = "empty"
	LessonTooLong       = "too_long"
	LessonCommentMarker = "comment_marker"
	LessonRewrite       = "instruction_rewrite"
	LessonSecret        = "secret"
)

// LessonsDir is the folder of the lessons files. It only computes the path.
func LessonsDir() string { return filepath.Join(appdir.AppConfigDir(), "lessons") }

// isDeviceName: the names Windows treats as devices (CON.md is the console, not a file).
func isDeviceName(s string) bool {
	switch strings.ToLower(s) {
	case "con", "prn", "aux", "nul",
		"com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8", "com9",
		"lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9":
		return true
	}
	return false
}

// LessonsFileStem is the file name (without .md) of an agent's lessons: the key with every character other than A-Z a-z 0-9 . _ -
// turned into _ (so a key can never name a path), and a device name of Windows made harmless.
func LessonsFileStem(key string) string {
	var b strings.Builder
	n := 0
	for _, r := range key {
		if n >= 100 {
			break
		}
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == '.', r == '_', r == '-':
			b.WriteRune(r)
		default:
			b.WriteByte('_')
		}
		n++
	}
	stem := b.String()
	if isDeviceName(strings.SplitN(stem, ".", 2)[0]) {
		stem = "_" + stem
	}
	return stem
}

// LessonsPath is the file of an agent's lessons in dir ("" for an empty key).
func LessonsPath(dir, key string) string {
	if strings.TrimSpace(key) == "" {
		return ""
	}
	return filepath.Join(dir, LessonsFileStem(key)+".md")
}

// LessonsEnabled: false only for `lessons: false` in the agent's definition. MD-Memo reads it and never writes it.
func (d AgentDef) LessonsEnabled() bool { return d.Lessons == nil || *d.Lessons }

// ---- reading -------------------------------------------------------------------------------------------------------------------

// LessonsFile is what a lessons file holds.
type LessonsFile struct {
	Path   string
	Exists bool
	Rules  []string // the valid rules, oldest (top of the file) first
}

// lessonsStat is os.Stat; a test counts the calls (an agent without lessons costs exactly one).
var lessonsStat = os.Stat

// ReadLessons reads the rules of an agent's file. A file that does not exist costs one stat and nothing else; one that does is read
// from its last 64 KB. Unreadable is the same as absent: a run must never fail because of its lessons.
func ReadLessons(dir, key string) LessonsFile {
	return readLessonsFile(LessonsPath(dir, key))
}

// readLessonsFile is ReadLessons for a file whose path is known ("" is no file).
func readLessonsFile(path string) LessonsFile {
	f := LessonsFile{Path: path}
	if f.Path == "" {
		return f
	}
	fi, err := lessonsStat(f.Path)
	if err != nil || !fi.Mode().IsRegular() {
		return f
	}
	f.Exists = true
	data, partial := readLessonsTail(f.Path, fi.Size())
	f.Rules = parseLessons(data, partial)
	return f
}

// readLessonsTail reads the last LessonsMaxFileBytes of the file. partial says it started in the middle of the file, so its first
// line may be cut.
func readLessonsTail(path string, size int64) (data []byte, partial bool) {
	f, err := os.Open(path)
	if err != nil {
		return nil, false
	}
	defer f.Close()
	if size > LessonsMaxFileBytes {
		if _, err := f.Seek(size-LessonsMaxFileBytes, io.SeekStart); err != nil {
			return nil, false
		}
		partial = true
	}
	data, _ = io.ReadAll(io.LimitReader(f, LessonsMaxFileBytes))
	return data, partial
}

// parseLessons picks the rules out of a file's text: the lines that start with "- ". A line that was cut by the 64 KB window is not
// one (partial: the first line is dropped).
func parseLessons(data []byte, partial bool) []string {
	if partial {
		if i := bytes.IndexByte(data, '\n'); i >= 0 {
			data = data[i+1:]
		} else {
			return nil
		}
	}
	text := strings.TrimPrefix(string(data), "\xEF\xBB\xBF")
	var rules []string
	for _, line := range strings.Split(text, "\n") {
		line = strings.TrimRight(line, "\r")
		if !strings.HasPrefix(line, "- ") {
			continue
		}
		if rule, ok := readableRule(line[2:]); ok {
			rules = append(rules, rule)
		}
	}
	return rules
}

// readableRule is the text of a rule line as an agent is given it: control characters taken out, the provenance comment at the end
// (<!-- 2026-10-03 -->) removed, and a line with any other comment marker, or longer than LessonMaxChars, refused.
func readableRule(s string) (string, bool) {
	s = stripControl(s)
	s = strings.TrimSpace(s)
	if strings.HasSuffix(s, "-->") {
		if i := strings.LastIndex(s, "<!--"); i >= 0 && strings.Count(s[i:], "-->") == 1 {
			s = strings.TrimSpace(s[:i])
		}
	}
	if s == "" || strings.Contains(s, "<!--") || strings.Contains(s, "-->") || utf8.RuneCountInString(s) > LessonMaxChars {
		return "", false
	}
	return s, true
}

// stripControl takes the control characters out of s (a tab becomes a space).
func stripControl(s string) string {
	clean := true
	for _, r := range s {
		if unicode.IsControl(r) {
			clean = false
			break
		}
	}
	if clean {
		return s
	}
	var b strings.Builder
	for _, r := range s {
		switch {
		case r == '\t':
			b.WriteByte(' ')
		case unicode.IsControl(r):
		default:
			b.WriteRune(r)
		}
	}
	return b.String()
}

// Select chooses what one run is given: the newest rules (the end of the file), at most LessonsApplyMax and LessonsApplyMaxChars
// characters in all, in the order of the file. skipped is how many older rules are left out.
func (f LessonsFile) Select() (applied []string, skipped int) {
	start, chars := len(f.Rules), 0
	for i := len(f.Rules) - 1; i >= 0; i-- {
		c := utf8.RuneCountInString(f.Rules[i])
		if len(f.Rules)-i > LessonsApplyMax || chars+c > LessonsApplyMaxChars {
			break
		}
		chars += c
		start = i
	}
	return f.Rules[start:], start
}

// LessonsBlock is the text put in front of an agent's instruction.
func LessonsBlock(rules []string) string {
	var b strings.Builder
	b.WriteString(LessonsBlockHeading)
	for _, r := range rules {
		b.WriteString("\n- ")
		b.WriteString(r)
	}
	return b.String()
}

// ApplyLessons puts the lessons of agent key in front of sys (a blank line between them when sys is not empty) and says how many rules
// it applied and how many it left out as too many. An agent with `lessons: false`, a file that does not exist or holds no rule leaves
// sys as it is.
func ApplyLessons(dir, key string, def AgentDef, sys string) (out string, applied, skipped int) {
	if !def.LessonsEnabled() {
		return sys, 0, 0
	}
	f := ReadLessons(dir, key)
	if !f.Exists {
		return sys, 0, 0
	}
	rules, skipped := f.Select()
	if len(rules) == 0 {
		return sys, 0, skipped
	}
	block := LessonsBlock(rules)
	if sys != "" {
		block += "\n\n" + sys
	}
	return block, len(rules), skipped
}

// ---- what is reported ----------------------------------------------------------------------------------------------------------

// LessonsInfo describes one agent's file: the answer of `md-memo lessons list`, of the JSON-RPC method lessons.list and of the window's
// lessonsInfo. Count is the rules the file holds, Applied and Skipped what a run would get and leave out (both 0 when the agent has
// `lessons: false`, Disabled).
type LessonsInfo struct {
	Agent    string `json:"agent"`
	Path     string `json:"path"`
	Exists   bool   `json:"exists"`
	Count    int    `json:"count"`
	Applied  int    `json:"applied"`
	Skipped  int    `json:"skipped"`
	Disabled bool   `json:"disabled"`
}

func lessonsInfoOf(path, key string, def AgentDef) LessonsInfo {
	f := readLessonsFile(path)
	info := LessonsInfo{Agent: key, Path: f.Path, Exists: f.Exists, Count: len(f.Rules), Disabled: !def.LessonsEnabled()}
	if !info.Disabled {
		rules, skipped := f.Select()
		info.Applied, info.Skipped = len(rules), skipped
	}
	return info
}

// ResolveLessonsAgent is the key an agent name stands for: a key or alias of cfg, else the name as given (a page may know an agent that
// agents.yaml does not).
func ResolveLessonsAgent(cfg SlotConfig, name string) string {
	if key, ok := ResolveAgentName(cfg, name); ok {
		return key
	}
	return strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(name), "@"))
}

// LessonsInfoFor describes the file of one agent (a key or an alias).
func LessonsInfoFor(dir string, cfg SlotConfig, agent string) LessonsInfo {
	key := ResolveLessonsAgent(cfg, agent)
	return lessonsInfoOf(LessonsPath(dir, key), key, cfg.Agents[key])
}

// ListLessonsInfo describes every file of the lessons folder (never nil; a folder that does not exist is an empty list). A file whose
// name is an agent's gets that agent's key and its `lessons:` switch; any other keeps the file's name.
func ListLessonsInfo(dir string, cfg SlotConfig) []LessonsInfo {
	out := []LessonsInfo{}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return out
	}
	byStem := map[string]string{}
	keys := make([]string, 0, len(cfg.Agents))
	for k := range cfg.Agents {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		if _, taken := byStem[LessonsFileStem(k)]; !taken {
			byStem[LessonsFileStem(k)] = k
		}
	}
	for _, e := range entries {
		name := e.Name()
		if e.IsDir() || strings.HasPrefix(name, ".") || !strings.EqualFold(filepath.Ext(name), ".md") {
			continue
		}
		stem := name[:len(name)-len(".md")]
		key := stem
		if k, ok := byStem[stem]; ok {
			key = k
		}
		out = append(out, lessonsInfoOf(filepath.Join(dir, name), key, cfg.Agents[key]))
		if len(out) >= lessonsListMax {
			break
		}
	}
	return out
}

// ---- checking a rule -----------------------------------------------------------------------------------------------------------

// A model's proposal, or a person's edit of one, must not rewrite the agent's instructions: a rule that talks about ignoring earlier
// instructions or about the system prompt is refused. The wording is matched at word boundaries so that .gitignore and --ignore-scripts
// are fine.
var lessonRewriteRE = lazyre.New(`(?i)` +
	`\bsystem[ _-]?prompts?\b|\bdeveloper[ _-]?(?:message|prompt)s?\b|\bjailbreak\b|\bnew\s+instructions?\b|\byou\s+(?:are|must)\s+now\b|` +
	`\b(?:ignore|disregard|forget|override|bypass)\s+(?:(?:all|any|every|the|your|my|these|those|of)\s+)*(?:(?:previous|prior|above|earlier|preceding|safety|system|other|existing|original)\s+)*(?:instructions?|prompts?|rules?|guidelines?|constraints?|polic(?:y|ies)|directions?|commands?|messages?|restrictions?)\b|` +
	`\b(?:ignore|disregard|forget)\s+(?:everything|the\s+above|all\s+(?:of\s+)?(?:the\s+)?above|previous|prior|earlier|what\s+(?:you|i|was)\s)|` +
	`指示[^。\n]{0,12}(?:無視|忘れ|破棄|上書き)|(?:無視|忘れ)[^。\n]{0,12}(?:指示|命令|ルール|プロンプト)|システム\s*プロンプト|(?:以前|これまで|上記)の(?:指示|命令)`)

var lessonMarkerRE = lazyre.New(`^(?:[-*•・](?:\s+|$)|\(?\d{1,2}[.)）](?:\s+|$))+`)

// CleanLessonRule makes one line of a rule a model proposed or a person typed: whitespace (and any line break) collapsed to single
// spaces, control characters taken out, a leading "- ", "* " or "1. " dropped. The second result is "" for a rule that can be kept and
// otherwise why not: empty, too_long (over LessonMaxChars), comment_marker (<!-- or -->), instruction_rewrite.
func CleanLessonRule(raw string) (rule, reason string) {
	s := strings.Join(strings.Fields(stripControl(strings.NewReplacer("\r", " ", "\n", " ").Replace(raw))), " ")
	s = lessonMarkerRE.ReplaceAllString(s, "")
	s = strings.TrimSpace(s)
	switch {
	case s == "":
		return "", LessonEmpty
	case strings.Contains(s, "<!--") || strings.Contains(s, "-->"):
		return "", LessonCommentMarker
	case utf8.RuneCountInString(s) > LessonMaxChars:
		return "", LessonTooLong
	case lessonRewriteRE.MatchString(s):
		return "", LessonRewrite
	}
	return s, ""
}

// NormalizeLessonRule is a rule as two spellings of it compare equal: lower case, one space between words, no closing punctuation.
func NormalizeLessonRule(rule string) string {
	s := strings.ToLower(strings.Join(strings.Fields(rule), " "))
	return strings.TrimRight(s, " .。!！")
}

// LessonValidator makes the rule of a raw line (see CleanLessonRule); a caller may add checks of its own, such as a secret scan.
type LessonValidator func(raw string) (rule, reason string)

// ---- writing -------------------------------------------------------------------------------------------------------------------

// LessonsSaved is the answer of a save.
type LessonsSaved struct {
	Path  string `json:"path"`
	Count int    `json:"count"`
	Added int    `json:"added"`
}

// lessonsWriteMu makes a save one step: the file is read, the rules are added and the file is replaced, without another save between.
var lessonsWriteMu sync.Mutex

// AppendLessons adds rules at the end of the agent's file (made, with its folder and a two-line header, when it does not exist). Every
// rule is checked again here (validate; nil is CleanLessonRule): one that fails, or that is already in the file (compared by
// NormalizeLessonRule) or earlier in the same call, is not added, and at most LessonsSaveMax are. An error when nothing could be kept
// ("no rule to save" / the reason of the first refusal), and ErrTooManyLessons when the file would pass LessonsFileMax rules; the file
// is then untouched. The new lines are `- <rule> <!-- YYYY-MM-DD -->` in the file's own line ending (LF for a new file); the file is
// replaced through a temporary file and a rename.
func AppendLessons(dir, key string, rules []string, now time.Time, validate LessonValidator) (LessonsSaved, error) {
	path := LessonsPath(dir, key)
	if path == "" {
		return LessonsSaved{}, errors.New("the agent is required")
	}
	if validate == nil {
		validate = CleanLessonRule
	}
	var fresh []string
	seen := map[string]bool{}
	firstReason := ""
	for _, raw := range rules {
		rule, reason := validate(raw)
		if reason != "" {
			if firstReason == "" {
				firstReason = reason
			}
			continue
		}
		if n := NormalizeLessonRule(rule); !seen[n] {
			seen[n] = true
			fresh = append(fresh, rule)
		}
		if len(fresh) == LessonsSaveMax {
			break
		}
	}
	if len(fresh) == 0 {
		if len(rules) == 0 {
			return LessonsSaved{}, errors.New("there is no rule to save")
		}
		return LessonsSaved{}, fmt.Errorf("the rule cannot be saved (%s)", firstReason)
	}

	lessonsWriteMu.Lock()
	defer lessonsWriteMu.Unlock()

	var old []byte
	if fi, err := os.Stat(path); err == nil {
		if !fi.Mode().IsRegular() {
			return LessonsSaved{}, fmt.Errorf("%s is not a file", filepath.Base(path))
		}
		if fi.Size() > lessonsEditMaxBytes {
			return LessonsSaved{}, fmt.Errorf("%s is over 1 MB; trim it first", filepath.Base(path))
		}
		if old, err = os.ReadFile(path); err != nil {
			return LessonsSaved{}, fmt.Errorf("cannot read %s: %v", filepath.Base(path), err)
		}
	}
	have := parseLessons(old, false)
	known := make(map[string]bool, len(have))
	for _, r := range have {
		known[NormalizeLessonRule(r)] = true
	}
	var add []string
	for _, r := range fresh {
		if !known[NormalizeLessonRule(r)] {
			add = append(add, r)
		}
	}
	if len(add) == 0 {
		return LessonsSaved{Path: path, Count: len(have)}, nil
	}
	if len(have)+len(add) > LessonsFileMax {
		return LessonsSaved{}, ErrTooManyLessons
	}

	eol := "\n"
	if bytes.Contains(old, []byte("\r\n")) {
		eol = "\r\n"
	}
	var b bytes.Buffer
	b.Write(old)
	if len(old) == 0 {
		fmt.Fprintf(&b, "# Lessons for %s%s", headerKey(key), eol)
		fmt.Fprintf(&b, "<!-- md-memo lessons: one rule per \"- \" line. Edit or delete freely; other lines are ignored. -->%s", eol)
	} else if !bytes.HasSuffix(old, []byte("\n")) {
		b.WriteString(eol)
	}
	date := now.Format("2006-01-02")
	for _, r := range add {
		fmt.Fprintf(&b, "- %s <!-- %s -->%s", r, date, eol)
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return LessonsSaved{}, fmt.Errorf("cannot make the lessons folder: %v", err)
	}
	if err := atomicfile.Write(path, b.Bytes(), ".md-memo-lessons-*.tmp"); err != nil {
		return LessonsSaved{}, fmt.Errorf("cannot write %s: %v", filepath.Base(path), err)
	}
	return LessonsSaved{Path: path, Count: len(have) + len(add), Added: len(add)}, nil
}

// headerKey is the agent's key as the first line of a new file shows it: one line, at most 80 characters.
func headerKey(key string) string {
	s := strings.Join(strings.Fields(stripControl(key)), " ")
	if r := []rune(s); len(r) > 80 {
		s = string(r[:80])
	}
	return s
}
