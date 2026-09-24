package dialog

import (
	"strings"
	"testing"
)

// nastyInputs are values that would be dangerous if they ever ended up interpolated into the
// AppleScript source text handed to `osascript -e`, rather than passed as a separate argv
// element that the script reads back with "item N of argv".
var nastyInputs = []string{
	`with "quotes"`,
	`back\slash`,
	"embedded\nnewline",
	"日本語のタイトル",
	`" & do shell script "rm -rf ~" & "`,
}

func TestOsascriptArgsNeverInlinesInputIntoTheScript(t *testing.T) {
	kinds := []string{kindOpenFile, kindSaveFile, kindOpenFolder}

	for _, kind := range kinds {
		for _, nasty := range nastyInputs {
			t.Run(kind+"/"+nasty, func(t *testing.T) {
				args := osascriptArgs(kind, nasty, nasty)
				if len(args) < 2 {
					t.Fatalf("osascriptArgs(%q, ...) returned too few args: %v", kind, args)
				}
				script := args[1]
				if strings.Contains(script, nasty) {
					t.Fatalf("osascript script for kind %q contains the raw input %q; it must only "+
						"appear as a separate argv element, not inside the -e script text:\n%s", kind, nasty, script)
				}
				// The value must still show up verbatim as its own argv element, otherwise the
				// dialog would silently lose the caller's title/default name.
				found := false
				for _, a := range args[2:] {
					if a == nasty {
						found = true
						break
					}
				}
				if !found {
					t.Fatalf("osascriptArgs(%q, %q, %q) = %v; nasty value not present as a distinct argv element", kind, nasty, nasty, args)
				}
			})
		}
	}
}

func TestOsascriptArgsShape(t *testing.T) {
	if args := osascriptArgs(kindOpenFile, "T", "ignored"); len(args) != 3 || args[0] != "-e" || args[2] != "T" {
		t.Fatalf("osascriptArgs(file) = %v, want [-e <script> T]", args)
	}
	if args := osascriptArgs(kindSaveFile, "T", "D"); len(args) != 4 || args[0] != "-e" || args[2] != "T" || args[3] != "D" {
		t.Fatalf("osascriptArgs(save) = %v, want [-e <script> T D]", args)
	}
	if args := osascriptArgs(kindOpenFolder, "T", "ignored"); len(args) != 3 || args[0] != "-e" || args[2] != "T" {
		t.Fatalf("osascriptArgs(folder) = %v, want [-e <script> T]", args)
	}
	if args := osascriptArgs("bogus-kind", "T", "D"); args != nil {
		t.Fatalf("osascriptArgs(bogus) = %v, want nil", args)
	}
}

func TestOsascriptArgsScriptReferencesArgv(t *testing.T) {
	// Pin that the script text itself reads the title/default name back out of argv (rather
	// than, say, some future edit accidentally hard-coding a literal) - this is what makes the
	// injection-safety test above meaningful.
	for _, kind := range []string{kindOpenFile, kindSaveFile, kindOpenFolder} {
		args := osascriptArgs(kind, "T", "D")
		script := args[1]
		if !strings.Contains(script, "item 1 of argv") {
			t.Errorf("osascript script for kind %q does not read item 1 of argv:\n%s", kind, script)
		}
		if kind == kindSaveFile && !strings.Contains(script, "item 2 of argv") {
			t.Errorf("osascript script for kind %q does not read item 2 of argv:\n%s", kind, script)
		}
	}
}

func TestParseChooseResult(t *testing.T) {
	cases := []struct {
		name     string
		out      string
		isFolder bool
		want     string
	}{
		{
			name: "trailing LF is stripped",
			out:  "/Users/me/notes.md\n",
			want: "/Users/me/notes.md",
		},
		{
			name: "trailing CRLF is stripped",
			out:  "/Users/me/notes.md\r\n",
			want: "/Users/me/notes.md",
		},
		{
			name: "a filename that genuinely ends in a space survives",
			out:  "/Users/me/trailing space .md\n",
			want: "/Users/me/trailing space .md",
		},
		{
			name: "leading whitespace is preserved",
			out:  "  /Users/me/notes.md\n",
			want: "  /Users/me/notes.md",
		},
		{
			name: "empty output means cancel",
			out:  "",
			want: "",
		},
		{
			name: "only a newline still means cancel",
			out:  "\n",
			want: "",
		},
		{
			name:     "folder: one trailing slash is stripped",
			out:      "/Users/me/Notes/\n",
			isFolder: true,
			want:     "/Users/me/Notes",
		},
		{
			name:     "folder: the filesystem root is kept as /",
			out:      "/\n",
			isFolder: true,
			want:     "/",
		},
		{
			name:     "folder: empty output means cancel",
			out:      "",
			isFolder: true,
			want:     "",
		},
		{
			name:     "file result is never slash-trimmed even if it happens to end in /",
			out:      "/Users/me/weird-dir-name-for-a-file/\n",
			isFolder: false,
			want:     "/Users/me/weird-dir-name-for-a-file/",
		},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := parseChooseResult(c.out, c.isFolder); got != c.want {
				t.Fatalf("parseChooseResult(%q, %v) = %q, want %q", c.out, c.isFolder, got, c.want)
			}
		})
	}
}
