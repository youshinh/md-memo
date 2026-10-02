package lazyre

import (
	"regexp"
	"testing"
)

func TestRegexpCompilesOnFirstUseAndBehavesLikeTheRealOne(t *testing.T) {
	r := New(`(\d+)-(\w+)`)
	if r.re != nil {
		t.Fatalf("compiled before it was used")
	}
	ref := regexp.MustCompile(`(\d+)-(\w+)`)
	s := "a 12-ab, 7-cd and 9-ef"
	if r.MatchString("x") != ref.MatchString("x") || r.MatchString(s) != ref.MatchString(s) {
		t.Errorf("MatchString")
	}
	if got, want := r.FindStringIndex(s), ref.FindStringIndex(s); len(got) != 2 || got[0] != want[0] || got[1] != want[1] {
		t.Errorf("FindStringIndex = %v", got)
	}
	if got := r.FindStringSubmatch(s); len(got) != 3 || got[1] != "12" || got[2] != "ab" {
		t.Errorf("FindStringSubmatch = %v", got)
	}
	if got := r.FindAllString(s, -1); len(got) != 3 || got[2] != "9-ef" {
		t.Errorf("FindAllString = %v", got)
	}
	if got := r.FindAllStringIndex(s, 2); len(got) != 2 {
		t.Errorf("FindAllStringIndex = %v", got)
	}
	if got := r.ReplaceAllString(s, "<$2>"); got != "a <ab>, <cd> and <ef>" {
		t.Errorf("ReplaceAllString = %q", got)
	}
	if got := r.ReplaceAllStringFunc(s, func(m string) string { return "#" }); got != "a #, # and #" {
		t.Errorf("ReplaceAllStringFunc = %q", got)
	}
	if r.re == nil {
		t.Errorf("not compiled after use")
	}
}

func TestABadPatternPanicsAtFirstUse(t *testing.T) {
	r := New(`(`)
	defer func() {
		if recover() == nil {
			t.Errorf("a pattern that does not compile must panic when used")
		}
	}()
	r.MatchString("x")
}
