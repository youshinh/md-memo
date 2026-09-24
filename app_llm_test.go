package main

import "testing"

func TestMarkdownLinkTarget(t *testing.T) {
	cases := []struct{ in, want string }{
		{"assets/diagram_1.png", "assets/diagram_1.png"},
		{"/Users/you/Library/Application Support/md-memo/assets/diagram_1.jpg", "/Users/you/Library/Application%20Support/md-memo/assets/diagram_1.jpg"},
		{"C:/Users/a b/AppData/Roaming/md-memo/assets/d.png", "C:/Users/a%20b/AppData/Roaming/md-memo/assets/d.png"},
		{"/tmp/my photo (1).png", "/tmp/my%20photo%20%281%29.png"},
		{"/tmp/100%.png", "/tmp/100%25.png"},
		{"/notes/写真.png", "/notes/写真.png"}, // non-ASCII is left readable: the preview decodes and encodes it as needed
	}
	for _, c := range cases {
		if got := markdownLinkTarget(c.in); got != c.want {
			t.Errorf("markdownLinkTarget(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}
