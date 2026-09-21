package configpack

import (
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"time"
)

type Skill struct {
	ID    string `json:"id"`
	Root  string `json:"root"`
	Name  string `json:"name"`
	Entry string `json:"entry"`
	Files int    `json:"files"`
	Bytes int64  `json:"bytes"`
	Path  string `json:"-"`
}

type skillFile struct {
	rel  string // slash-separated, relative to the skill folder ("" for a file skill)
	abs  string
	size int64
	mode fs.FileMode
	mod  time.Time
}

func isLinkLike(m fs.FileMode) bool { return m&(fs.ModeSymlink|fs.ModeIrregular) != 0 }

// DiscoverSkills never follows links, and leaves an over-limit skill out with a warning rather
// than truncating it.
func DiscoverSkills(projectRoot string) (skills []Skill, warnings []string) {
	if projectRoot == "" {
		return nil, nil
	}
	for _, root := range SkillRoots {
		rootDir := filepath.Join(projectRoot, filepath.FromSlash(root))
		fi, err := os.Lstat(rootDir)
		if err != nil {
			continue
		}
		if isLinkLike(fi.Mode()) || !fi.IsDir() {
			if isLinkLike(fi.Mode()) {
				warnings = append(warnings, fmt.Sprintf("%s はシンボリックリンクのため対象外です / %s is a symbolic link and was skipped", root, root))
			}
			continue
		}
		entries, err := os.ReadDir(rootDir)
		if err != nil {
			continue
		}
		for _, e := range entries {
			name := e.Name()
			if strings.HasPrefix(name, ".") || skipTreeDir(name) {
				continue
			}
			abs := filepath.Join(rootDir, name)
			if isLinkLike(e.Type()) {
				warnings = append(warnings, fmt.Sprintf("%s/%s はシンボリックリンクのため対象外です / %s/%s is a symbolic link and was skipped", root, name, root, name))
				continue
			}
			var sk Skill
			var werr error
			switch {
			case e.IsDir():
				sk, werr = describeDirSkill(root, name, abs)
			case e.Type().IsRegular() && strings.EqualFold(pathExt(name), ".md"):
				sk, werr = describeFileSkill(root, name, abs)
			default:
				continue
			}
			if werr != nil {
				warnings = append(warnings, fmt.Sprintf("%s/%s を除外しました / skipped %s/%s: %v", root, name, root, name, werr))
				continue
			}
			skills = append(skills, sk)
		}
	}
	return skills, warnings
}

func describeDirSkill(root, name, abs string) (Skill, error) {
	if err := ValidateSkillIdent(root, name, EntryDir); err != nil {
		return Skill{}, err
	}
	files, err := walkSkill(abs)
	if err != nil {
		return Skill{}, err
	}
	var total int64
	for _, f := range files {
		total += f.size
	}
	return Skill{ID: SkillID(root, name), Root: root, Name: name, Entry: EntryDir, Files: len(files), Bytes: total, Path: abs}, nil
}

func describeFileSkill(root, name, abs string) (Skill, error) {
	if err := ValidateSkillIdent(root, name, EntryFile); err != nil {
		return Skill{}, err
	}
	fi, err := os.Lstat(abs)
	if err != nil {
		return Skill{}, err
	}
	if fi.Size() > MaxEntryBytes {
		return Skill{}, ErrTooLarge
	}
	return Skill{ID: SkillID(root, name), Root: root, Name: name, Entry: EntryFile, Files: 1, Bytes: fi.Size(), Path: abs}, nil
}

var errNoFiles = biErr("パッケージ化できるファイルがありません", "no files to package")

func errSkillLimit() error {
	return fmt.Errorf("%w (%d files, %d MB per file, %d MB total)", ErrTooLarge, MaxEntries-3, MaxEntryBytes>>20, MaxTotalBytes>>20)
}

// walkSkill applies the importer's skip rules and stops at the first limit crossed, so a huge
// tree is never fully walked.
func walkSkill(dir string) ([]skillFile, error) {
	var files []skillFile
	var total int64
	err := filepath.WalkDir(dir, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if p == dir {
			return nil
		}
		if isLinkLike(d.Type()) {
			if d.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		if d.IsDir() {
			if skipTreeDir(d.Name()) {
				return filepath.SkipDir
			}
			return nil
		}
		if !d.Type().IsRegular() || isEnvFileName(d.Name()) || isJunkFileName(d.Name()) {
			return nil
		}
		rel, err := filepath.Rel(dir, p)
		if err != nil {
			return err
		}
		rel = filepath.ToSlash(rel)
		if err := ValidateEntryName(rel); err != nil {
			return err
		}
		info, err := d.Info()
		if err != nil {
			return err
		}
		if info.Size() > MaxEntryBytes {
			return errSkillLimit()
		}
		total += info.Size()
		// Three slots are kept for the manifest, config and agents files.
		if len(files) >= MaxEntries-3 || total > MaxTotalBytes {
			return errSkillLimit()
		}
		files = append(files, skillFile{rel: rel, abs: p, size: info.Size(), mode: info.Mode(), mod: info.ModTime()})
		return nil
	})
	if err != nil {
		return nil, err
	}
	if len(files) == 0 {
		return nil, errNoFiles
	}
	return files, nil
}
