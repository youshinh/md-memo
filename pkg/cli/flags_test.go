package cli

import (
	"errors"
	"flag"
	"reflect"
	"testing"
)

func newTestFlags() (*flag.FlagSet, *string, *string, *bool, *int) {
	fs := newQuietFlagSet("t")
	out := fs.String("out", "", "")
	from := fs.String("from", "", "")
	asJSON := fs.Bool("json", false, "")
	limit := fs.Int("limit", 0, "")
	return fs, out, from, asJSON, limit
}

func TestParseInterspersedAcceptsFlagsOnEitherSide(t *testing.T) {
	cases := []struct {
		name string
		args []string
		pos  []string
		out  string
		from string
		json bool
		lim  int
	}{
		{"flags first", []string{"--json", "--from", "2026-01-01", "word"}, []string{"word"}, "", "2026-01-01", true, 0},
		{"flags after", []string{"word", "--json", "--limit", "5"}, []string{"word"}, "", "", true, 5},
		{"flags between", []string{"a", "--from", "x", "b", "--json"}, []string{"a", "b"}, "", "x", true, 0},
		{"equals form", []string{"a", "--limit=7", "-out=f.md"}, []string{"a"}, "f.md", "", false, 7},
		{"single dash", []string{"-json", "a"}, []string{"a"}, "", "", true, 0},
		{"none", []string{}, nil, "", "", false, 0},
		{"explicit false", []string{"a", "--json=false"}, []string{"a"}, "", "", false, 0},
	}
	for _, c := range cases {
		fs, out, from, asJSON, limit := newTestFlags()
		pos, err := parseInterspersed(fs, c.args)
		if err != nil {
			t.Errorf("%s: %v", c.name, err)
			continue
		}
		if !reflect.DeepEqual(pos, c.pos) || *out != c.out || *from != c.from || *asJSON != c.json || *limit != c.lim {
			t.Errorf("%s: pos=%v out=%q from=%q json=%v limit=%d; want pos=%v out=%q from=%q json=%v limit=%d",
				c.name, pos, *out, *from, *asJSON, *limit, c.pos, c.out, c.from, c.json, c.lim)
		}
	}
}

func TestParseInterspersedTerminatorAndDashes(t *testing.T) {
	fs, _, _, asJSON, _ := newTestFlags()
	pos, err := parseInterspersed(fs, []string{"--json", "--", "-x", "--json", "y"})
	if err != nil {
		t.Fatal(err)
	}
	if !*asJSON || !reflect.DeepEqual(pos, []string{"-x", "--json", "y"}) {
		t.Errorf("after --, everything is positional: json=%v pos=%v", *asJSON, pos)
	}

	// A lone dash is a positional argument (the stdin convention), not a flag.
	fs, _, _, _, _ = newTestFlags()
	if pos, err = parseInterspersed(fs, []string{"-", "a"}); err != nil || !reflect.DeepEqual(pos, []string{"-", "a"}) {
		t.Errorf("lone dash: pos=%v err=%v", pos, err)
	}

	// A value-taking flag takes the next argument whatever it looks like.
	fs, out, _, _, _ := newTestFlags()
	if pos, err = parseInterspersed(fs, []string{"--out", "-weird.md", "a"}); err != nil || *out != "-weird.md" || !reflect.DeepEqual(pos, []string{"a"}) {
		t.Errorf("value that starts with a dash: out=%q pos=%v err=%v", *out, pos, err)
	}
}

func TestParseInterspersedErrors(t *testing.T) {
	fs, _, _, _, _ := newTestFlags()
	if _, err := parseInterspersed(fs, []string{"a", "--nope"}); err == nil {
		t.Error("an unknown flag after a positional argument must be an error")
	}
	fs, _, _, _, _ = newTestFlags()
	if _, err := parseInterspersed(fs, []string{"--limit"}); err == nil {
		t.Error("a value flag without its value must be an error")
	}
	fs, _, _, _, _ = newTestFlags()
	if _, err := parseInterspersed(fs, []string{"a", "--limit", "many"}); err == nil {
		t.Error("a bad number must be an error")
	}
	// -h is undefined, so flag reports ErrHelp: the runners turn that into the usage text.
	fs, _, _, _, _ = newTestFlags()
	if _, err := parseInterspersed(fs, []string{"a", "-h"}); !errors.Is(err, flag.ErrHelp) {
		t.Errorf("-h after a positional argument = %v, want flag.ErrHelp", err)
	}
}
