package cli

import (
	"bytes"
	"errors"
	"flag"
	"fmt"
	"io"
	iofs "io/fs"
	"os"
	"path/filepath"
	"strings"
	"unicode/utf8"

	"md-memo/pkg/encoding"
	"md-memo/pkg/search"
)

// `md-memo scrap tag add|remove|show`: put a tag into a note, take one out, or list the tags a note has (docs/design/tag-filter-2026-10.md
// section 10). It works on text: a file, or standard input, and it answers with the new text on standard output, the way sed does. A
// file is written only with --write, which is the one thing in `scrap` that writes a note; the rule for where a tag goes is
// search.EditTags, the same one the window and the JSON-RPC method scrap.tag_edit use (tagedit.go).

// tagWriteHook runs after the new file is written beside the old one and before it is checked and renamed over it. Tests change the
// file in it to see that a change made in between is refused.
var tagWriteHook func()

func (r *HeadlessRunner) runScrapTag(args []string) (int, error) {
	if len(args) == 0 {
		return 1, errors.New("scrap tag action required: add, remove or show")
	}
	op, rest := args[0], args[1:]
	switch op {
	case "add", "remove", "show":
	default:
		return 1, fmt.Errorf("unknown scrap tag action: %s (use add, remove or show)", op)
	}
	fs := newQuietFlagSet("scrap tag " + op)
	line := fs.Int("line", 0, "Tag the entry that holds this line (1-based) instead of the whole note")
	write := fs.Bool("write", false, "Replace the file by the new text (without it the new text is printed)")
	forceJSON := fs.Bool("json", false, "Print the edit as JSON")
	forceText := fs.Bool("text", false, "Print plain text (the default for add and remove)")
	words, err := parseInterspersed(fs, rest)
	if err != nil {
		return r.flagErr("scrap", err)
	}
	given := map[string]bool{}
	fs.Visit(func(f *flag.Flag) { given[f.Name] = true })
	if given["line"] && *line < 1 {
		return 1, fmt.Errorf("invalid --line %d (use 1 or more)", *line)
	}

	var tags, file string
	if op == "show" {
		if len(words) > 1 {
			return 1, fmt.Errorf("scrap tag show takes at most a file, got %q", words[1])
		}
		if *write {
			return 1, errors.New("--write has no meaning for scrap tag show")
		}
	} else {
		if len(words) == 0 {
			return 1, fmt.Errorf("tags required: md-memo scrap tag %s <tags> [<file>]", op)
		}
		if len(words) > 2 {
			return 1, fmt.Errorf("scrap tag %s takes the tags as one argument (\"a, b\") and a file, got %q as well", op, words[2])
		}
		tags = words[0]
		words = words[1:]
	}
	if len(words) > 0 {
		file = words[0]
	}
	if *write && file == "" {
		return 1, errors.New("--write needs a <file>: it cannot write to standard input")
	}

	text, path, mode, err := r.readTagInput(file, *write)
	if err != nil {
		return 1, err
	}
	scope := "note"
	if given["line"] {
		scope = "entry"
	}
	res, err := ScrapTagEdit(ScrapTagEditRequest{Text: string(text), Op: op, Scope: scope, Line: *line, Tags: TagList{tags}})
	if err != nil {
		return 1, err
	}
	edit := res.TagEdit
	where := tagRange(edit, *line)

	if op == "show" {
		if ResolveFormatCustom(*forceJSON, *forceText, IsTerminal(os.Stdout)) == FormatJSON {
			PrintFormatted(r.stdout, FormatJSON, "", edit)
			return 0, nil
		}
		fmt.Fprintf(r.stdout, "tags of the whole note: %s\n", tagsOrNone(edit.NoteTags))
		if edit.Scope == "entry" {
			fmt.Fprintf(r.stdout, "tags of %s: %s\n", where, tagsOrNone(edit.EntryTags))
			if len(edit.InheritedTags) > 0 {
				fmt.Fprintf(r.stdout, "tags it gets from the headings above: %s\n", strings.Join(edit.InheritedTags, ", "))
			}
		}
		return 0, nil
	}

	if *forceJSON {
		PrintFormatted(r.stdout, FormatJSON, "", edit)
	}
	if tagEditRefused(edit) {
		return 1, errors.New(tagEditMessage(edit, where))
	}
	if *write {
		if edit.Changed {
			if err := writeTagged(path, text, edit.Apply(text), mode); err != nil {
				return 1, err
			}
		}
		fmt.Fprintln(r.stderr, tagEditSummary(edit, where, file))
		return 0, nil
	}
	if !*forceJSON {
		_, _ = r.stdout.Write(edit.Apply(text)) // exactly the text, so that `> file` and a pipe lose and add nothing
	}
	if !edit.Changed || edit.MessageCode != "" {
		fmt.Fprintln(r.stderr, tagEditMessage(edit, where))
	}
	return 0, nil
}

// readTagInput is the text to edit: the file (read as UTF-8, byte for byte, a byte order mark and CRLF included) or standard input
// (decoded as a pipe is, see encoding.DecodePiped). With write the file is also resolved to the real file a link points to, and its mode
// is returned. A file that is not valid UTF-8 is refused: a note this program cannot read exactly is never rewritten.
func (r *HeadlessRunner) readTagInput(file string, write bool) (text []byte, path string, mode os.FileMode, err error) {
	if file == "" {
		if r.stdin == nil && IsTerminal(os.Stdin) {
			return nil, "", 0, errors.New("give a <file>, or pipe the text in: md-memo scrap tag ... < note.md")
		}
		data, err := io.ReadAll(io.LimitReader(r.input(), search.MaxTagEditBytes+1))
		if err != nil {
			return nil, "", 0, fmt.Errorf("failed to read standard input: %w", err)
		}
		if len(data) > search.MaxTagEditBytes {
			return nil, "", 0, errors.New("the text on standard input is over 16 MB")
		}
		return []byte(encoding.DecodePiped(data)), "", 0, nil
	}
	path = file
	if write {
		if real, err := filepath.EvalSymlinks(file); err == nil {
			path = real // the link stays a link: the file it points to is the one replaced
		}
	}
	info, err := os.Stat(path)
	if err != nil {
		return nil, "", 0, fmt.Errorf("cannot read %s: %v", file, fsReason(err))
	}
	if !info.Mode().IsRegular() {
		return nil, "", 0, fmt.Errorf("%s is not a file", file)
	}
	if info.Size() > search.MaxTagEditBytes {
		return nil, "", 0, fmt.Errorf("%s is over 16 MB", file)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, "", 0, fmt.Errorf("cannot read %s: %v", file, fsReason(err))
	}
	if !utf8.Valid(data) {
		return nil, "", 0, fmt.Errorf("%s is not valid UTF-8; it is not edited, so that no text is lost", file)
	}
	return data, path, info.Mode().Perm(), nil
}

// fsReason is the reason in a file error ("no such file or directory"), without the operation and path that the caller names itself.
func fsReason(err error) error {
	var pe *iofs.PathError
	if errors.As(err, &pe) {
		return pe.Err
	}
	return err
}

// writeTagged replaces the file at path, which was read as old, by data. The new file is written beside it first (same folder, same
// permission bits); then the old one is read again, and if it is not what was read at the start, or is gone, nothing is replaced: the
// person (or the app) saved a note while this ran, and their text must not be overwritten. A file is never created.
func writeTagged(path string, old, data []byte, mode os.FileMode) error {
	tmp, err := os.CreateTemp(filepath.Dir(path), ".md-memo-tag-*.tmp")
	if err != nil {
		return fmt.Errorf("cannot write beside %s: %w", path, err)
	}
	tmpName := tmp.Name()
	fail := func(err error) error {
		_ = tmp.Close()
		_ = os.Remove(tmpName)
		return err
	}
	if _, err := tmp.Write(data); err != nil {
		return fail(fmt.Errorf("cannot write %s: %w", path, err))
	}
	if err := tmp.Sync(); err != nil {
		return fail(fmt.Errorf("cannot write %s: %w", path, err))
	}
	if err := tmp.Close(); err != nil {
		_ = os.Remove(tmpName)
		return fmt.Errorf("cannot write %s: %w", path, err)
	}
	_ = os.Chmod(tmpName, mode)
	if tagWriteHook != nil {
		tagWriteHook()
	}
	if cur, err := os.ReadFile(path); err != nil || !bytes.Equal(cur, old) {
		_ = os.Remove(tmpName)
		return fmt.Errorf("%s changed while the tag was being written; nothing was written, run it again", path)
	}
	if err := os.Rename(tmpName, path); err != nil {
		_ = os.Remove(tmpName)
		return fmt.Errorf("cannot replace %s: %w", path, err)
	}
	return nil
}

// ---- what is said ----------------------------------------------------------------------------------

// tagEditRefused: the request could not be done for a reason the person has to act on (not for "already there" or "no such tag").
func tagEditRefused(e search.TagEdit) bool {
	if e.Changed {
		return false
	}
	switch e.MessageCode {
	case "front_matter", "front_matter_tag", "on_note", "on_entry", "on_parent":
		return true
	}
	return false
}

// tagRange names the range an edit used.
func tagRange(e search.TagEdit, line int) string {
	switch {
	case e.Scope == "entry":
		return fmt.Sprintf("the entry at line %d", line)
	case line > 0:
		return fmt.Sprintf("the whole note (line %d is not inside an entry)", line)
	}
	return "the whole note"
}

func tagsOrNone(tags []string) string {
	if len(tags) == 0 {
		return "(none)"
	}
	return strings.Join(tags, ", ")
}

// tagEditMessage says in one line why an edit did not do everything that was asked.
func tagEditMessage(e search.TagEdit, where string) string {
	tags := strings.Join(e.Unchanged, ", ")
	switch e.MessageCode {
	case "already":
		return fmt.Sprintf("nothing changed: %s already applies to %s", tags, where)
	case "none_found":
		return fmt.Sprintf("nothing changed: %s is not a tag of %s", tags, where)
	case "front_matter":
		return "the note starts with a YAML front matter, and MD-Memo never edits one: a tag for the whole note cannot go above it (tag an entry with --line instead)"
	case "front_matter_tag":
		return fmt.Sprintf("%s is written in the YAML front matter of the note, which MD-Memo never edits", tags)
	case "on_note":
		return fmt.Sprintf("%s is a tag of the whole note, not of %s: run it without --line", tags, where)
	case "on_entry":
		return fmt.Sprintf("%s is a tag of an entry, not of the whole note: give the --line of that entry", tags)
	case "on_parent":
		// the tag is written under a heading above the entry and only reaches it from there: take it from that heading
		return fmt.Sprintf("%s is written under the heading %q (line %d), which reaches %s: give the --line of that heading", tags, e.ParentHeading, e.ParentLine, where)
	}
	return "nothing changed"
}

// tagEditSummary is the one line --write prints: what was done to which file.
func tagEditSummary(e search.TagEdit, where, file string) string {
	if !e.Changed {
		return file + ": " + tagEditMessage(e, where)
	}
	var did []string
	if len(e.Added) > 0 {
		did = append(did, "added "+strings.Join(e.Added, ", "))
	}
	if len(e.Removed) > 0 {
		did = append(did, "removed "+strings.Join(e.Removed, ", "))
	}
	s := fmt.Sprintf("%s: %s (%s)", file, strings.Join(did, "; "), where)
	if e.MessageCode != "" && e.MessageCode != "already" {
		s += "; " + tagEditMessage(e, where)
	}
	return s
}
