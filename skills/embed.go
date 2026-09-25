// Package skills embeds the agent skill (the md-memo folder next to this file) into the program,
// so `md-memo agent install-skill` can put it into an agent's skills folder without the
// repository or the release zip: a Homebrew install, for one, has neither.
//
// The files cost about 320 KB in the binary and nothing at start-up: the data sits in the
// read-only part of the program and is only read when the command runs.
package skills

import (
	"embed"
	"io/fs"
)

//go:embed md-memo
var content embed.FS

// Skill returns the skill folder: SKILL.md at its root, the references/ folder below it.
func Skill() fs.FS {
	sub, err := fs.Sub(content, "md-memo")
	if err != nil { // cannot happen: the directory is embedded above
		panic(err)
	}
	return sub
}
