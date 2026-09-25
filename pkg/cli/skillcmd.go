package cli

import (
	"errors"
	"flag"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"

	"md-memo/pkg/appdir"
	"md-memo/pkg/skillinstall"
	"md-memo/skills"
)

// `md-memo agent install-skill` puts the agent skill that is built into this program into an agent's
// skills folder, so a Homebrew install (which has neither the repository nor the release zip) can
// have it too. The copying, the version marker and the refusal to overwrite somebody's edits are in
// pkg/skillinstall; this file decides where, and prints what happened.

// skillSource is the skill folder to install, and skillFinder looks for a skills/md-memo folder on
// disk for --link. Variables so that a test can hand in its own.
var (
	skillSource = func() fs.FS { return skills.Skill() }
	skillFinder = findSkillSource
)

// The three kinds of target.
const (
	targetClaude = "claude"
	targetCodex  = "codex"
	targetDir    = "dir"
)

func (r *HeadlessRunner) runInstallSkill(args []string) (int, error) {
	flags := flag.NewFlagSet("agent install-skill", flag.ContinueOnError)
	flags.SetOutput(r.stderr)
	claude := flags.Bool("claude", false, "Install for Claude Code (~/.claude/skills; CLAUDE_CONFIG_DIR is honoured). The default")
	codex := flags.Bool("codex", false, "Install for Codex ($CODEX_HOME/skills, else ~/.codex/skills; path unverified)")
	dir := flags.String("dir", "", "Install into <path>/md-memo")
	force := flags.Bool("force", false, "Replace a folder that was edited, has no marker, is newer, or is a link")
	link := flags.Bool("link", false, "Link to the skills/md-memo folder on disk instead of copying (not on Windows)")
	forceJSON := flags.Bool("json", false, "Force JSON output")
	forceText := flags.Bool("text", false, "Force plain text output")
	if err := flags.Parse(args); err != nil {
		return 1, err
	}
	if flags.NArg() > 0 {
		return 1, fmt.Errorf("unexpected argument %q: agent install-skill takes only flags", flags.Arg(0))
	}
	dirSet := false
	flags.Visit(func(f *flag.Flag) { dirSet = dirSet || f.Name == "dir" })
	if dirSet && *dir == "" {
		return 1, errors.New("--dir needs a folder")
	}
	chosen := 0
	for _, b := range []bool{*claude, *codex, dirSet} {
		if b {
			chosen++
		}
	}
	if chosen > 1 {
		return 1, errors.New("choose one of --claude, --codex and --dir")
	}
	kind := targetClaude
	switch {
	case *codex:
		kind = targetCodex
	case dirSet:
		kind = targetDir
	}

	base, err := skillBase(kind, *dir)
	if err != nil {
		return 1, err
	}
	version := r.version
	if version == "" {
		version = "dev"
	}
	opt := skillinstall.Options{Base: base, Version: version, Force: *force}

	var res *skillinstall.Result
	if *link {
		if !skillinstall.LinksSupported() {
			return 1, skillinstall.ErrLinkUnsupported
		}
		source := skillFinder()
		if source == "" {
			return 1, errors.New("--link needs the skills/md-memo folder on disk (next to the program, or in the current folder or one above it: a checkout or the unpacked release), and there is none here. Run it without --link to install a copy")
		}
		res, err = skillinstall.Link(source, opt)
	} else {
		res, err = skillinstall.Install(skillSource(), opt)
	}
	if err != nil {
		return 1, err
	}

	if ResolveFormatCustom(*forceJSON, *forceText, IsTerminal(os.Stdout)) == FormatJSON {
		PrintFormatted(r.stdout, FormatJSON, "", struct {
			*skillinstall.Result
			Target string `json:"target"`
			Base   string `json:"base"`
		}{res, kind, base})
		return 0, nil
	}
	printSkillResult(r.stdout, res, kind)
	return 0, nil
}

// skillBase is the skills folder of the chosen agent, or Dir given with --dir.
func skillBase(kind, dir string) (string, error) {
	home := func() (string, error) {
		h, err := appdir.HomeDir()
		if err != nil || h == "" {
			return "", errors.New("cannot find your home folder; give the folder with --dir <path>")
		}
		return h, nil
	}
	switch kind {
	case targetClaude:
		if v := os.Getenv("CLAUDE_CONFIG_DIR"); v != "" {
			return filepath.Join(v, "skills"), nil
		}
		h, err := home()
		if err != nil {
			return "", err
		}
		return filepath.Join(h, ".claude", "skills"), nil
	case targetCodex:
		if v := os.Getenv("CODEX_HOME"); v != "" {
			return filepath.Join(v, "skills"), nil
		}
		h, err := home()
		if err != nil {
			return "", err
		}
		return filepath.Join(h, ".codex", "skills"), nil
	}
	// --dir: a leading ~ is the home folder (PowerShell hands it over unexpanded), the rest is
	// taken relative to the current folder.
	if dir == "~" || strings.HasPrefix(dir, "~/") || strings.HasPrefix(dir, `~\`) {
		h, err := home()
		if err != nil {
			return "", err
		}
		dir = filepath.Join(h, dir[1:])
	}
	abs, err := filepath.Abs(dir)
	if err != nil {
		return "", err
	}
	return abs, nil
}

// findSkillSource looks for a real skills/md-memo folder beside the program, then around the
// current folder (a checkout).
func findSkillSource() string {
	var starts []string
	if exe, err := os.Executable(); err == nil {
		if resolved, err := filepath.EvalSymlinks(exe); err == nil {
			exe = resolved
		}
		starts = append(starts, filepath.Dir(exe))
	}
	if cwd, err := os.Getwd(); err == nil {
		starts = append(starts, cwd)
	}
	return skillinstall.FindSource(starts...)
}

func printSkillResult(w io.Writer, res *skillinstall.Result, kind string) {
	switch res.Action {
	case skillinstall.Installed:
		fmt.Fprintf(w, "Installed the md-memo skill: %s\n", res.Path)
	case skillinstall.Updated:
		fmt.Fprintf(w, "Updated the md-memo skill (it was installed by md-memo %s): %s\n", orUnknown(res.PreviousVersion), res.Path)
	case skillinstall.Replaced:
		fmt.Fprintf(w, "Replaced the existing md-memo skill: %s\n", res.Path)
		for _, d := range res.Discarded {
			fmt.Fprintf(w, "  discarded: %s\n", d)
		}
	case skillinstall.UpToDate:
		fmt.Fprintf(w, "The md-memo skill is already up to date: %s\n", res.Path)
	case skillinstall.Linked:
		fmt.Fprintf(w, "Linked the md-memo skill: %s -> %s\n", res.Path, res.LinkTarget)
		for _, d := range res.Discarded {
			fmt.Fprintf(w, "  replaced: %s\n", d)
		}
	}
	if res.Action != skillinstall.Linked {
		fmt.Fprintf(w, "  %d files, %.0f KB, from md-memo %s, content hash %s\n", res.Files, float64(res.Bytes)/1024, res.Version, shortHash(res.Hash))
		fmt.Fprintf(w, "  %s, and the marker %s\n", strings.Join(res.Names, ", "), skillinstall.MarkerFile)
	}
	switch kind {
	case targetCodex:
		fmt.Fprintln(w, "  For Codex. The folder Codex reads skills from is UNVERIFIED (this used $CODEX_HOME/skills, else ~/.codex/skills): if your Codex does not find it, install with --dir <folder> instead.")
	case targetDir:
		fmt.Fprintln(w, "  Point your agent at that folder, or start with SKILL.md in it.")
	default:
		fmt.Fprintln(w, "  For Claude Code. Start a new session to make sure it is picked up.")
	}
}

func orUnknown(v string) string {
	if v == "" {
		return "(version unknown)"
	}
	return v
}

// shortHash is the first 12 hex digits of a "sha256:..." value.
func shortHash(h string) string {
	h = strings.TrimPrefix(h, "sha256:")
	if len(h) > 12 {
		h = h[:12]
	}
	return h
}
