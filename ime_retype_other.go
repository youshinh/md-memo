//go:build !windows

package main

import "errors"

// platformImeRetype: only Windows can send keys to the input method (macOS has no equivalent that is safe to drive
// from here), and the page does not offer the setting there.
func platformImeRetype(romaji string) error {
	return errors.New("not supported on this OS")
}
