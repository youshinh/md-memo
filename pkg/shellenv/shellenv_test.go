package shellenv

import (
	"strings"
	"testing"
)

func TestExtractPath(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want string
		ok   bool
	}{
		{
			name: "clean output",
			in:   markerBegin + "/opt/homebrew/bin:/usr/bin" + markerEnd,
			want: "/opt/homebrew/bin:/usr/bin",
			ok:   true,
		},
		{
			name: "rc noise before and after",
			in: "Welcome to zsh!\ndirenv: loading .envrc\n" +
				markerBegin + "/opt/homebrew/bin:/usr/bin" + markerEnd +
				"\nnvm: using v20\n",
			want: "/opt/homebrew/bin:/usr/bin",
			ok:   true,
		},
		{
			name: "surrounding whitespace is trimmed",
			in:   markerBegin + "  /usr/bin  " + markerEnd,
			want: "/usr/bin",
			ok:   true,
		},
		{
			name: "no markers at all",
			in:   "/opt/homebrew/bin:/usr/bin",
			ok:   false,
		},
		{
			name: "only the opening marker",
			in:   "noise" + markerBegin + "/usr/bin",
			ok:   false,
		},
		{
			name: "only the closing marker",
			in:   "/usr/bin" + markerEnd,
			ok:   false,
		},
		{
			name: "empty value between markers",
			in:   markerBegin + markerEnd,
			ok:   false,
		},
		{
			name: "whitespace-only value between markers",
			in:   markerBegin + "   " + markerEnd,
			ok:   false,
		},
		{
			name: "empty input",
			in:   "",
			ok:   false,
		},
		{
			name: "a line mentioning the marker name still parses the first fenced value",
			in:   "echo " + markerBegin + "/first" + markerEnd + markerBegin + "/second" + markerEnd,
			want: "/first",
			ok:   true,
		},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got, ok := ExtractPath(c.in)
			if ok != c.ok {
				t.Fatalf("ExtractPath ok = %v, want %v", ok, c.ok)
			}
			if ok && got != c.want {
				t.Fatalf("ExtractPath = %q, want %q", got, c.want)
			}
			if !ok && got != "" {
				t.Fatalf("ExtractPath returned %q alongside ok=false, want \"\"", got)
			}
		})
	}
}

func TestProbeScriptContainsBothMarkers(t *testing.T) {
	// A typo in the script would make every probe fall back silently, so pin the contract.
	if !strings.Contains(probeScript, markerBegin) || !strings.Contains(probeScript, markerEnd) {
		t.Fatalf("probeScript %q does not carry both markers", probeScript)
	}
	if !strings.Contains(probeScript, `"$PATH"`) {
		t.Fatalf("probeScript %q must pass $PATH quoted", probeScript)
	}
}

func TestMergePath(t *testing.T) {
	cases := []struct {
		name     string
		resolved string
		current  string
		want     string
	}{
		{
			name:     "resolved entries come first",
			resolved: "/opt/homebrew/bin:/usr/local/bin",
			current:  "/usr/bin:/bin",
			want:     "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin",
		},
		{
			name:     "duplicates are dropped keeping the first occurrence",
			resolved: "/usr/bin:/opt/homebrew/bin:/usr/bin",
			current:  "/usr/bin:/bin:/opt/homebrew/bin",
			want:     "/usr/bin:/opt/homebrew/bin:/bin",
		},
		{
			name:     "empty entries are dropped",
			resolved: "::/opt/homebrew/bin::",
			current:  "/usr/bin::",
			want:     "/opt/homebrew/bin:/usr/bin",
		},
		{
			name:     "relative entries are dropped",
			resolved: ".:relative/bin:/opt/homebrew/bin:~/bin",
			current:  "/usr/bin:..",
			want:     "/opt/homebrew/bin:/usr/bin",
		},
		{
			name:     "trailing slashes do not create duplicates",
			resolved: "/usr/bin/",
			current:  "/usr/bin",
			want:     "/usr/bin",
		},
		{
			name:     "root stays root",
			resolved: "/",
			current:  "",
			want:     "/",
		},
		{
			name:     "empty resolved keeps the current path",
			resolved: "",
			current:  "/usr/bin:/bin",
			want:     "/usr/bin:/bin",
		},
		{
			name:     "empty current keeps the resolved path",
			resolved: "/usr/bin:/bin",
			current:  "",
			want:     "/usr/bin:/bin",
		},
		{
			name:     "both empty yields empty",
			resolved: "",
			current:  "",
			want:     "",
		},
		{
			name:     "surrounding whitespace on an entry is trimmed",
			resolved: " /opt/homebrew/bin : /usr/local/bin ",
			current:  "/usr/bin",
			want:     "/opt/homebrew/bin:/usr/local/bin:/usr/bin",
		},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := MergePath(c.resolved, c.current); got != c.want {
				t.Fatalf("MergePath(%q, %q) = %q, want %q", c.resolved, c.current, got, c.want)
			}
		})
	}
}

func TestMergePathIsIdempotent(t *testing.T) {
	resolved := "/opt/homebrew/bin:/usr/local/bin"
	current := "/usr/bin:/bin"
	once := MergePath(resolved, current)
	twice := MergePath(resolved, once)
	if once != twice {
		t.Fatalf("MergePath is not idempotent: %q then %q", once, twice)
	}
}

func TestFallbackPath(t *testing.T) {
	got := FallbackPath("/Users/someone")
	want := "/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/Users/someone/.local/bin"
	if got != want {
		t.Fatalf("FallbackPath = %q, want %q", got, want)
	}

	got = FallbackPath("")
	want = "/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin"
	if got != want {
		t.Fatalf("FallbackPath(\"\") = %q, want %q", got, want)
	}

	if got := FallbackPath("   "); got != want {
		t.Fatalf("FallbackPath(whitespace) = %q, want %q", got, want)
	}
}

func TestFallbackPathSurvivesTheMerge(t *testing.T) {
	// The fallback must actually add the Homebrew directories to a launchd-style PATH.
	launchdPath := "/usr/bin:/bin:/usr/sbin:/sbin"
	merged := MergePath(FallbackPath("/Users/someone"), launchdPath)
	for _, want := range []string{"/opt/homebrew/bin", "/usr/local/bin", "/Users/someone/.local/bin", "/usr/bin", "/sbin"} {
		if !strings.Contains(merged, want) {
			t.Errorf("merged PATH %q is missing %q", merged, want)
		}
	}
}

func TestLoginShell(t *testing.T) {
	existsAll := func(string) bool { return true }
	existsNone := func(string) bool { return false }

	cases := []struct {
		name   string
		env    string
		exists func(string) bool
		want   string
	}{
		{"absolute existing shell is used", "/bin/bash", existsAll, "/bin/bash"},
		{"whitespace is trimmed", "  /opt/homebrew/bin/fish  ", existsAll, "/opt/homebrew/bin/fish"},
		{"unset falls back", "", existsAll, defaultShell},
		{"whitespace only falls back", "   ", existsAll, defaultShell},
		{"relative path falls back", "zsh", existsAll, defaultShell},
		{"non-existent path falls back", "/bin/nope", existsNone, defaultShell},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := LoginShell(c.env, c.exists); got != c.want {
				t.Fatalf("LoginShell(%q) = %q, want %q", c.env, got, c.want)
			}
		})
	}
}
