package slotagent

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// SkillInfo contains metadata and instructions extracted from a skill definition file.
type SkillInfo struct {
	Name        string
	Path        string
	Instruction string
	RawContent  string
}

// ExtractSkillInstruction extracts markdown instruction content from a SKILL.md file,
// safely removing YAML frontmatter (between first and second ---) if present.
func ExtractSkillInstruction(content string) string {
	trimmed := strings.TrimSpace(content)
	if !strings.HasPrefix(trimmed, "---") {
		return trimmed
	}

	// Find the closing --- of YAML frontmatter
	rest := trimmed[3:]
	closingIdx := strings.Index(rest, "\n---")
	if closingIdx == -1 {
		return trimmed
	}

	body := rest[closingIdx+4:]
	// Strip optional newline following closing delimiter
	body = strings.TrimPrefix(body, "\r\n")
	body = strings.TrimPrefix(body, "\n")
	return strings.TrimSpace(body)
}

// FindSkillInstruction searches for a skill definition file under rootDir and returns its body instructions.
// Search candidates (in order):
// 1. skills/<skillName>/SKILL.md
// 2. skills/<skillName>.md
// 3. skills/<skillName>/README.md
// 4. .gemini/skills/<skillName>/SKILL.md
// 5. .claude/skills/<skillName>/SKILL.md
func FindSkillInstruction(rootDir, skillName string) (*SkillInfo, error) {
	cleanName := strings.TrimPrefix(strings.TrimSpace(skillName), "@")
	if cleanName == "" {
		return nil, fmt.Errorf("skill name is empty")
	}

	candidates := []string{
		filepath.Join(rootDir, "skills", cleanName, "SKILL.md"),
		filepath.Join(rootDir, "skills", cleanName+".md"),
		filepath.Join(rootDir, "skills", cleanName, "README.md"),
		filepath.Join(rootDir, ".gemini", "skills", cleanName, "SKILL.md"),
		filepath.Join(rootDir, ".claude", "skills", cleanName, "SKILL.md"),
	}

	var foundPath string
	for _, cand := range candidates {
		if fi, err := os.Stat(cand); err == nil && !fi.IsDir() {
			foundPath = cand
			break
		}
	}

	if foundPath == "" {
		return nil, fmt.Errorf("skill '%s' not found (searched in skills/%s/SKILL.md)", cleanName, cleanName)
	}

	data, err := os.ReadFile(foundPath)
	if err != nil {
		return nil, fmt.Errorf("failed to read skill file %s: %w", foundPath, err)
	}

	raw := string(data)
	instruction := ExtractSkillInstruction(raw)

	return &SkillInfo{
		Name:        cleanName,
		Path:        foundPath,
		Instruction: instruction,
		RawContent:  raw,
	}, nil
}
