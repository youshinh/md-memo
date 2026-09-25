package skills

import (
	"bytes"
	"io/fs"
	"os"
	"path/filepath"
	"testing"
)

// go:embed silently leaves out files whose names start with "." or "_": one added to the skill
// folder would be in the repository and the release zip but not in the program. This compares the
// embedded copy with the folder on disk, file for file.
func TestEmbeddedSkillIsTheFolderOnDisk(t *testing.T) {
	onDisk := map[string][]byte{}
	err := filepath.WalkDir("md-memo", func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return err
		}
		rel, err := filepath.Rel("md-memo", p)
		if err != nil {
			return err
		}
		data, err := os.ReadFile(p)
		onDisk[filepath.ToSlash(rel)] = data
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(onDisk) < 4 {
		t.Fatalf("found only %d files in skills/md-memo", len(onDisk))
	}

	embedded := map[string][]byte{}
	err = fs.WalkDir(Skill(), ".", func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return err
		}
		data, err := fs.ReadFile(Skill(), p)
		embedded[p] = data
		return err
	})
	if err != nil {
		t.Fatal(err)
	}

	for name, data := range onDisk {
		got, ok := embedded[name]
		if !ok {
			t.Errorf("%s is in skills/md-memo but not in the program (go:embed skips names starting with . or _)", name)
			continue
		}
		if !bytes.Equal(got, data) {
			t.Errorf("%s differs between the folder and the program", name)
		}
	}
	for name := range embedded {
		if _, ok := onDisk[name]; !ok {
			t.Errorf("%s is embedded but not on disk", name)
		}
	}
	if _, ok := embedded["SKILL.md"]; !ok {
		t.Error("SKILL.md must be at the root of the embedded skill")
	}
}
