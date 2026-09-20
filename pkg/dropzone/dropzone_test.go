package dropzone

import (
	"net"
	"strings"
	"testing"
	"time"
)

func TestIsBareURL(t *testing.T) {
	cases := []struct {
		in   string
		want bool
	}{
		{"https://example.com", true},
		{"http://example.com/path?x=1", true},
		{"  https://example.com  ", true},
		{"check https://example.com yo", false},
		{"not a url", false},
		{"", false},
		{"ftp://example.com", false},
		{"https://example.com another-word", false},
	}
	for _, c := range cases {
		if got := IsBareURL(c.in); got != c.want {
			t.Errorf("IsBareURL(%q) = %v, want %v", c.in, got, c.want)
		}
	}
}

func TestClassifyFileExtension(t *testing.T) {
	cases := []struct {
		filename  string
		wantPlain bool
		wantLang  string
	}{
		{"notes.md", true, ""},
		{"notes.MD", true, ""},
		{"todo.txt", true, ""},
		{"index.html", false, "html"},
		{"app.js", false, "javascript"},
		{"data.json", false, "json"},
		{"main.py", false, "python"},
		{"weird.xyz123", false, ""},
		{"noext", false, ""},
	}
	for _, c := range cases {
		got := ClassifyFileExtension(c.filename)
		if got.Plain != c.wantPlain || got.Lang != c.wantLang {
			t.Errorf("ClassifyFileExtension(%q) = %+v, want Plain=%v Lang=%q", c.filename, got, c.wantPlain, c.wantLang)
		}
	}
}

func TestFormatTextBody(t *testing.T) {
	if got := FormatTextBody("https://example.com"); got != "[https://example.com](https://example.com)" {
		t.Errorf("bare URL not linkified, got %q", got)
	}
	if got := FormatTextBody("  hello world  "); got != "hello world" {
		t.Errorf("plain text not trimmed correctly, got %q", got)
	}
}

func TestFormatFileBody(t *testing.T) {
	if got := FormatFileBody("notes.md", "# Title\n\n"); got != "# Title" {
		t.Errorf("markdown file body should pass through untrimmed of trailing newlines, got %q", got)
	}
	got := FormatFileBody("app.js", "console.log(1)")
	want := "```javascript\nconsole.log(1)\n```"
	if got != want {
		t.Errorf("FormatFileBody(app.js) = %q, want %q", got, want)
	}
	got = FormatFileBody("weird.xyz123", "raw content")
	want = "```\nraw content\n```"
	if got != want {
		t.Errorf("FormatFileBody(unknown ext) = %q, want %q", got, want)
	}
}

func TestStripMarkdownFence(t *testing.T) {
	cases := []struct {
		in   string
		want string
	}{
		{"```markdown\n# Hi\n\nbody\n```", "# Hi\n\nbody"},
		{"```md\ntext\n```", "text"},
		{"```\nplain\n```", "plain"},
		{"# Hi\n\nno fence here", "# Hi\n\nno fence here"},
		{"```go\ncode.Stay()\n```", "```go\ncode.Stay()\n```"}, // non-markdown fence left alone
		{"```markdown\nunterminated", "```markdown\nunterminated"},
	}
	for _, c := range cases {
		if got := StripMarkdownFence(c.in); got != c.want {
			t.Errorf("StripMarkdownFence(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

func TestFormatSection(t *testing.T) {
	at := time.Date(2026, 9, 20, 9, 5, 3, 0, time.UTC)
	got := FormatSection(KindText, "", "hello", at, nil)
	if !strings.Contains(got, "## Mobile Drop [09:05:03]") {
		t.Errorf("FormatSection missing expected header, got %q", got)
	}
	if !strings.Contains(got, "hello") {
		t.Errorf("FormatSection missing body, got %q", got)
	}

	withName := FormatSection(KindFile, "notes.md", "body", at, nil)
	if !strings.Contains(withName, "— notes.md") {
		t.Errorf("FormatSection should include filename when provided, got %q", withName)
	}

	withGeo := FormatSection(KindText, "", "hello", at, &Geo{Lat: 34.69347, Lon: 135.50218})
	if !strings.Contains(withGeo, "## Mobile Drop [09:05:03] (34.693, 135.502)") {
		t.Errorf("FormatSection should append rounded geo, got %q", withGeo)
	}

	withBoth := FormatSection(KindFile, "notes.md", "body", at, &Geo{Lat: -12.5, Lon: 45})
	if !strings.Contains(withBoth, "— notes.md (-12.500, 45.000)") {
		t.Errorf("filename must come before geo, got %q", withBoth)
	}
}

func TestIsPrivateIPv4(t *testing.T) {
	cases := []struct {
		ip   string
		want bool
	}{
		{"10.0.0.5", true},
		{"172.16.0.1", true},
		{"172.31.255.254", true},
		{"172.32.0.1", false}, // just outside 172.16.0.0/12
		{"172.15.255.255", false},
		{"192.168.1.42", true},
		{"192.169.1.1", false},
		{"127.0.0.1", false},
		{"169.254.1.1", false},
		{"8.8.8.8", false},
	}
	for _, c := range cases {
		ip := net.ParseIP(c.ip)
		if ip == nil {
			t.Fatalf("failed to parse test IP %q", c.ip)
		}
		if got := isPrivateIPv4(ip); got != c.want {
			t.Errorf("isPrivateIPv4(%q) = %v, want %v", c.ip, got, c.want)
		}
	}
}

func TestFormatFileBodyFenceOutgrowsBackticksInContent(t *testing.T) {
	content := "before\n```\ninner block\n```\nafter"
	got := FormatFileBody("snippet.js", content)
	want := "````javascript\n" + content + "\n````"
	if got != want {
		t.Errorf("FormatFileBody must use a fence longer than the content's own:\n got: %q\nwant: %q", got, want)
	}
	// Plain (markdown/text) files are never fenced.
	if got := FormatFileBody("notes.md", content); got != content {
		t.Errorf("plain files pass through unchanged, got %q", got)
	}
}

func TestFormatSectionKeepsTheHeadingOnOneLine(t *testing.T) {
	at := time.Date(2026, 9, 20, 10, 5, 9, 0, time.UTC)
	got := FormatSection(KindFile, "evil\n# injected heading\r\nname.txt", "body", at, nil)
	if strings.Contains(got, "\n# injected heading") {
		t.Errorf("a filename must not be able to start a new markdown line: %q", got)
	}
	long := FormatSection(KindFile, strings.Repeat("あ", 500)+".txt", "body", at, nil)
	if n := len([]rune(strings.SplitN(strings.TrimSpace(long), "\n", 2)[0])); n > 160 {
		t.Errorf("over-long filenames should be capped, heading has %d runes", n)
	}
}
