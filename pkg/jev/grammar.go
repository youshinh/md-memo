package jev

import (
	"bufio"
	"fmt"
	"regexp"
	"strings"
	"sync"
)

// TaskActionEBNF contains the formal EBNF grammar used for constrained decoding.
const TaskActionEBNF = `task_list    ::= task_item+
task_item    ::= action_prefix action_type " " command_body "\n"
action_prefix ::= "- [ ] "
action_type  ::= "sh" | "ai" | "doc"
command_body ::= [^\n]+
arguments    ::= [^\n]*
`

// Compiled on first use, not at start-up.
var taskItemRegex = sync.OnceValue(func() *regexp.Regexp {
	return regexp.MustCompile(`^-\s*\[\s*\]\s+(sh|ai|doc)\s+(.+)$`)
})

// ParseTaskActionItems decodes raw text output according to EBNF TaskAction rules,
// mathematically filtering out conversational preambles and epilogues.
func ParseTaskActionItems(text string) []Candidate {
	var results []Candidate
	scanner := bufio.NewScanner(strings.NewReader(text))
	itemRe := taskItemRegex()

	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		matches := itemRe.FindStringSubmatch(line)
		if len(matches) == 3 {
			actType := strings.ToLower(matches[1])
			cmdBody := strings.TrimSpace(matches[2])

			scope := "local"
			if actType == "doc" || strings.Contains(cmdBody, "repo") || strings.Contains(cmdBody, "issue") || strings.Contains(cmdBody, "docs/") {
				scope = "global"
			}

			results = append(results, Candidate{
				ActionType:  actType,
				Command:     cmdBody,
				Description: buildDefaultDescription(actType, cmdBody),
				Scope:       scope,
			})
		}
	}
	return results
}

// FormatTaskItem serializes a Candidate to strict EBNF markdown task line.
func FormatTaskItem(c Candidate) string {
	actType := c.ActionType
	if actType == "" {
		actType = "sh"
	}
	return fmt.Sprintf("- [ ] %s %s\n", actType, strings.TrimSpace(c.Command))
}

func buildDefaultDescription(actType, cmd string) string {
	switch actType {
	case "sh":
		return fmt.Sprintf("Unix CLI実行: %s", cmd)
	case "ai":
		return fmt.Sprintf("AIコード支援: %s", cmd)
	case "doc":
		return fmt.Sprintf("ドキュメント更新: %s", cmd)
	default:
		return cmd
	}
}
