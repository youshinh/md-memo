package inbox

import (
	"path/filepath"
	"testing"

	"md-memo/pkg/scrap"
)

func TestResolveDir(t *testing.T) {
	t.Run("empty means the default folder beside the default scraps", func(t *testing.T) {
		got := ResolveDir("")
		if want := scrap.ResolveScrapDir(DefaultDir); got != want {
			t.Errorf("ResolveDir(\"\") = %q, want %q", got, want)
		}
		if filepath.Base(got) != "inbox" {
			t.Errorf("default folder should be called inbox, got %q", got)
		}
	})
	t.Run("an explicit folder is expanded like the scrap folder", func(t *testing.T) {
		if got, want := ResolveDir("/custom/inbox"), filepath.Clean("/custom/inbox"); got != want {
			t.Errorf("got %q, want %q", got, want)
		}
		if got, want := ResolveDir("~/hot"), scrap.ResolveScrapDir("~/hot"); got != want {
			t.Errorf("got %q, want %q", got, want)
		}
	})
}
