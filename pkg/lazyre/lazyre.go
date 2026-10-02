// Package lazyre is a regular expression that is compiled the first time it is used, not when the program starts: a package-level
// regexp.MustCompile is paid for at every start-up by a feature that may never be used (a few microseconds and a few kilobytes each).
// Only the methods the callers need are here; they are those of *regexp.Regexp.
package lazyre

import (
	"regexp"
	"sync"
)

// Regexp is compiled on first use. The zero value is not usable: make one with New.
type Regexp struct {
	once    sync.Once
	pattern string
	re      *regexp.Regexp
}

// New remembers the pattern. A pattern that does not compile panics at its first use, as regexp.MustCompile does at start-up, so a
// test that uses it finds out.
func New(pattern string) *Regexp { return &Regexp{pattern: pattern} }

func (r *Regexp) get() *regexp.Regexp {
	r.once.Do(func() { r.re = regexp.MustCompile(r.pattern) })
	return r.re
}

func (r *Regexp) MatchString(s string) bool      { return r.get().MatchString(s) }
func (r *Regexp) FindStringIndex(s string) []int { return r.get().FindStringIndex(s) }
func (r *Regexp) FindStringSubmatch(s string) []string {
	return r.get().FindStringSubmatch(s)
}
func (r *Regexp) FindAllString(s string, n int) []string { return r.get().FindAllString(s, n) }
func (r *Regexp) FindAllStringIndex(s string, n int) [][]int {
	return r.get().FindAllStringIndex(s, n)
}
func (r *Regexp) ReplaceAllString(s, repl string) string { return r.get().ReplaceAllString(s, repl) }
func (r *Regexp) ReplaceAllStringFunc(s string, f func(string) string) string {
	return r.get().ReplaceAllStringFunc(s, f)
}
func (r *Regexp) Split(s string, n int) []string { return r.get().Split(s, n) }
