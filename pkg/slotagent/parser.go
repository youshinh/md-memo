package slotagent

import (
	"regexp"
	"strings"
	"sync"
	"unicode/utf8"
)

// SlotMatch represents a parsed slot or recipe instance in markdown document.
type SlotMatch struct {
	Type          string // "slot" or "recipe"
	OpenDelimiter string // e.g. "{{", "[?", "【?", "[!", "[>>"
	CloseDelim    string // e.g. "}}", "]", "】", "!]"
	StartOffset   int    // byte start offset in document
	EndOffset     int    // byte end offset in document
	RawContent    string // content inside delimiters (trimmed)
	Role          string // role prefix if present, e.g. "code", "research", "@skill-name"
	SkillName     string // skill name if present without @, e.g. "code-review"
	AgentName     string // agents key when "@name" is an agent key or alias (SkillName stays empty)
	OutputMode    string // OutputModeBelow for the agent-mention form, else OutputModeReplace
	Instruction   string // actual prompt instruction without role prefix
	IsInline      bool   // true if text exists before or after slot on the same line
	Profile       *SlotProfile
	Recipe        *Recipe
}

// ApprovalGate represents a human approval checkbox row.
type ApprovalGate struct {
	StartOffset int
	EndOffset   int
	StepDesc    string
	IsApproved  bool // true if [x], false if [ ]
	RawLine     string
}

// ExcludedRange represents a section of text (code block, inline code, link) that must not be parsed as a slot.
type ExcludedRange struct {
	Start int
	End   int
}

// parserRegexes holds every pattern FindExcludedRanges/FindApprovalGates need. Compiling all 5 costs
// about 20 KiB and 180 allocs, wasted on every app start when no note is ever parsed for slots in that
// run, so they are compiled lazily on first use instead of at package init.
type parserRegexes struct {
	fencedCode   *regexp.Regexp
	inlineCode   *regexp.Regexp
	markdownLink *regexp.Regexp
	bareURL      *regexp.Regexp
	approvalGate *regexp.Regexp
}

var getParserRegexes = sync.OnceValue(func() *parserRegexes {
	return &parserRegexes{
		// Matches markdown fenced code blocks: ```...``` or ~~~...~~~
		fencedCode: regexp.MustCompile("(?s)(```[^\n]*\n.*?```|~~~[^\n]*\n.*?~~~)"),
		// Matches inline code: `...`
		inlineCode: regexp.MustCompile("`[^`\n]+`"),
		// Matches markdown links: [title](url)
		markdownLink: regexp.MustCompile(`\[([^\]]+)\]\(([^)]+)\)`),
		// Matches bare URLs: http:// or https:// (must not consume markdown slot/link brackets)
		bareURL: regexp.MustCompile(`https?://[^\s<>"'{}|\\^` + "`" + `\[\]]+`),
		// Matches Human-in-the-Loop approval gate lines
		approvalGate: regexp.MustCompile(`(?m)^[ \t]*-[ \t]*\[([ xX])\][ \t]*(.*?)[ \t]*//[ \t]*approve[ \t]*$`),
	}
})

// FindExcludedRanges returns non-overlapping byte ranges for code blocks, inline code, and links.
func FindExcludedRanges(content string) []ExcludedRange {
	var ranges []ExcludedRange
	re := getParserRegexes()

	// 1. Fenced code blocks
	for _, m := range re.fencedCode.FindAllStringIndex(content, -1) {
		ranges = append(ranges, ExcludedRange{Start: m[0], End: m[1]})
	}

	// 2. Inline code
	for _, m := range re.inlineCode.FindAllStringIndex(content, -1) {
		ranges = append(ranges, ExcludedRange{Start: m[0], End: m[1]})
	}

	// 3. Markdown links
	for _, m := range re.markdownLink.FindAllStringIndex(content, -1) {
		ranges = append(ranges, ExcludedRange{Start: m[0], End: m[1]})
	}

	// 4. Bare URLs
	for _, m := range re.bareURL.FindAllStringIndex(content, -1) {
		ranges = append(ranges, ExcludedRange{Start: m[0], End: m[1]})
	}

	// 5. Result blocks a BELOW-mode run left in the note: output text, never instructions.
	ranges = append(ranges, findResultBlocks(content)...)

	// 6. HTML comments (<!-- ... -->, not md-memo markers): a commented-out slot never runs. Same rules as the
	// frontend's html_comments.js (see comments.go).
	ranges = append(ranges, findHTMLComments(content)...)

	return ranges
}

const (
	resultBlockOpen  = "<!-- md-memo:res "
	resultBlockClose = "<!-- /md-memo:res -->"
)

// findResultBlocks returns the byte ranges of complete <!-- md-memo:res id --> ... <!-- /md-memo:res -->
// blocks. An unterminated block is not a block, so a stray opener never hides the rest of a note.
func findResultBlocks(content string) []ExcludedRange {
	var ranges []ExcludedRange
	idx := 0
	for {
		open := strings.Index(content[idx:], resultBlockOpen)
		if open == -1 {
			return ranges
		}
		open += idx
		closeAt := strings.Index(content[open:], resultBlockClose)
		if closeAt == -1 {
			return ranges
		}
		end := open + closeAt + len(resultBlockClose)
		ranges = append(ranges, ExcludedRange{Start: open, End: end})
		idx = end
	}
}

// isOffsetExcluded checks whether a given slot range [start, end) is inside any excluded range.
func isOffsetExcluded(start, end int, excluded []ExcludedRange) bool {
	for _, r := range excluded {
		if (start >= r.Start && start < r.End) || (end > r.Start && end <= r.End) || (r.Start <= start && end <= r.End) {
			return true
		}
	}
	return false
}

// DetermineIsInline checks if there is non-whitespace text before or after the slot on the same line.
func DetermineIsInline(content string, startOffset, endOffset int) bool {
	// Find line start (backward from startOffset)
	lineStart := strings.LastIndex(content[:startOffset], "\n")
	if lineStart == -1 {
		lineStart = 0
	} else {
		lineStart++ // move past '\n'
	}

	// Find line end (forward from endOffset)
	lineEnd := strings.Index(content[endOffset:], "\n")
	if lineEnd == -1 {
		lineEnd = len(content)
	} else {
		lineEnd = endOffset + lineEnd
	}

	before := strings.TrimSpace(content[lineStart:startOffset])
	after := strings.TrimSpace(content[endOffset:lineEnd])

	return before != "" || after != ""
}

// ParseSlots finds all valid slots and recipe invocations in content according to cfg.
func ParseSlots(content string, cfg SlotConfig) []SlotMatch {
	var matches []SlotMatch
	excluded := FindExcludedRanges(content)

	// Collect delimiters to search
	type delimiterInfo struct {
		open    string
		close   string
		isRec   bool
		profile *SlotProfile
		recipe  *Recipe
	}
	var delims []delimiterInfo

	// Recipes take precedence
	for i := range cfg.Recipes {
		r := &cfg.Recipes[i]
		delims = append(delims, delimiterInfo{
			open:   r.TriggerOpen,
			close:  r.TriggerClose,
			isRec:  true,
			recipe: r,
		})
	}

	// Slot profiles
	for i := range cfg.SlotProfiles {
		p := &cfg.SlotProfiles[i]
		delims = append(delims, delimiterInfo{
			open:    p.TriggerOpen,
			close:   p.TriggerClose,
			isRec:   false,
			profile: p,
		})
	}

	// Search text for matches
	contentLen := len(content)
	idx := 0

	for idx < contentLen {
		foundOpen := false
		var matchedDelim delimiterInfo
		earliestStart := -1

		// Find earliest delimiter at current or future offset
		for _, d := range delims {
			pos := strings.Index(content[idx:], d.open)
			if pos != -1 {
				absPos := idx + pos
				if earliestStart == -1 || absPos < earliestStart {
					earliestStart = absPos
					matchedDelim = d
					foundOpen = true
				}
			}
		}

		if !foundOpen {
			break
		}

		openStart := earliestStart
		openEnd := openStart + len(matchedDelim.open)

		// Find matching closing delimiter after openEnd
		closePos := strings.Index(content[openEnd:], matchedDelim.close)
		if closePos == -1 {
			// No matching close delimiter found, skip past open delimiter
			idx = openEnd
			continue
		}

		closeStart := openEnd + closePos
		closeEnd := closeStart + len(matchedDelim.close)

		// Check if inside excluded range (code block, inline code, link)
		if isOffsetExcluded(openStart, closeEnd, excluded) {
			idx = openEnd
			continue
		}

		rawInside := content[openEnd:closeStart]
		trimmed := strings.TrimSpace(rawInside)

		// Skip in-progress placeholders (e.g., "⟳ 実行中...", "(実行中...)") so they are never parsed as new actionable slots
		if strings.HasPrefix(trimmed, "⟳") || strings.HasPrefix(trimmed, "実行中...") || strings.HasPrefix(trimmed, "(実行中...)") {
			idx = closeEnd
			continue
		}

		// Check skill prefix (@skill-name) or role prefix (code: ...)
		skillName := ""
		agentName := ""
		outputMode := OutputModeReplace
		role := ""
		instruction := trimmed

		if strings.HasPrefix(trimmed, "@") {
			afterAt := trimmed[1:]
			sepIdx := strings.IndexAny(afterAt, ": \t\r\n")
			if sepIdx == -1 {
				skillName = strings.TrimSpace(afterAt)
				instruction = ""
			} else {
				skillName = strings.TrimSpace(afterAt[:sepIdx])
				rest := afterAt[sepIdx:]
				if strings.HasPrefix(rest, ":") {
					rest = strings.TrimPrefix(rest, ":")
				}
				instruction = strings.TrimSpace(rest)
			}
			role = "@" + skillName
			// An agent key or alias wins over a skill of the same name; recipes keep their
			// own pipeline semantics and never take the mention form.
			if !matchedDelim.isRec {
				if key, ok := ResolveAgentName(cfg, skillName); ok {
					agentName = key
					skillName = ""
					outputMode = OutputModeBelow
				}
			}
		} else if colonIdx := strings.Index(trimmed, ":"); colonIdx != -1 {
			candidateRole := strings.TrimSpace(trimmed[:colonIdx])
			// If role matches one of known profiles or a word without spaces
			if !strings.ContainsAny(candidateRole, " \t\n\r") && utf8.RuneCountInString(candidateRole) <= 20 {
				role = candidateRole
				instruction = strings.TrimSpace(trimmed[colonIdx+1:])
			}
		}

		if role == "" && matchedDelim.profile != nil {
			role = matchedDelim.profile.Name
		} else if role == "" && matchedDelim.recipe != nil {
			role = matchedDelim.recipe.Name
		}

		isInline := DetermineIsInline(content, openStart, closeEnd)

		matchType := "slot"
		if matchedDelim.isRec {
			matchType = "recipe"
		}

		matches = append(matches, SlotMatch{
			Type:          matchType,
			OpenDelimiter: matchedDelim.open,
			CloseDelim:    matchedDelim.close,
			StartOffset:   openStart,
			EndOffset:     closeEnd,
			RawContent:    trimmed,
			Role:          role,
			SkillName:     skillName,
			AgentName:     agentName,
			OutputMode:    outputMode,
			Instruction:   instruction,
			IsInline:      isInline,
			Profile:       matchedDelim.profile,
			Recipe:        matchedDelim.recipe,
		})

		idx = closeEnd
	}

	return matches
}

// FindApprovalGates scans document for Human-in-the-Loop approval gate lines.
//
// A gate inside an HTML comment is switched off, like a commented-out slot (isOffsetExcluded against the comment
// ranges). Only that rule applies here, not the rest of FindExcludedRanges: a gate line may carry a link or a bare
// URL in its description, and the frontend's own gate lookup (runSlotTrigger in slot_agent.js) applies exactly the
// comment rule, so both sides pick the same gate. A gate written inside a code fence still counts, as it always has.
func FindApprovalGates(content string) []ApprovalGate {
	var gates []ApprovalGate
	matches := getParserRegexes().approvalGate.FindAllStringSubmatchIndex(content, -1)
	var comments []ExcludedRange
	if len(matches) > 0 {
		comments = findHTMLComments(content)
	}

	for _, m := range matches {
		lineStart := m[0]
		lineEnd := m[1]
		if isOffsetExcluded(lineStart, lineEnd, comments) {
			continue
		}
		checkChar := content[m[2]:m[3]]
		desc := strings.TrimSpace(content[m[4]:m[5]])
		isApproved := strings.ToLower(checkChar) == "x"

		gates = append(gates, ApprovalGate{
			StartOffset: lineStart,
			EndOffset:   lineEnd,
			StepDesc:    desc,
			IsApproved:  isApproved,
			RawLine:     content[lineStart:lineEnd],
		})
	}

	return gates
}
