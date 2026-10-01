package main

import (
	"encoding/json"
	"fmt"
)

// imeRetypeMaxKeys bounds one retype: the IME Guardian only offers words of a few letters.
const imeRetypeMaxKeys = 32

// imeRetypeKeys maps romaji ("iro") to the virtual-key codes of the keys that type it. Only plain lowercase letters
// are accepted: a letter's virtual key does not depend on the keyboard layout, whereas an apostrophe or a hyphen
// sits on different keys on a US and a JIS keyboard, so those make the caller fall back to committing the hiragana.
func imeRetypeKeys(romaji string) ([]byte, bool) {
	if len(romaji) == 0 || len(romaji) > imeRetypeMaxKeys {
		return nil, false
	}
	keys := make([]byte, 0, len(romaji))
	for i := 0; i < len(romaji); i++ {
		c := romaji[i]
		if c < 'a' || c > 'z' {
			return nil, false
		}
		keys = append(keys, c-'a'+0x41) // VK_A..VK_Z
	}
	return keys, true
}

// RetypeWithImeAsync makes the OS input method type `romaji` again, so the word arrives as an unconfirmed composition
// (kana with kanji candidates) instead of as finished text. The page has already removed the romaji it typed itself.
// It runs in the background (the keys are spaced out, and a bound call would hold the window still) and answers through
// window.__onImeRetypeResult(reqID, errMsg); an empty errMsg means the keys were sent, not that the IME reacted.
func (a *App) RetypeWithImeAsync(reqID, romaji string) {
	go func() {
		defer func() { _ = recover() }()
		errMsg := ""
		if err := platformImeRetype(romaji); err != nil {
			errMsg = err.Error()
		}
		reqJSON, _ := json.Marshal(reqID)
		errJSON, _ := json.Marshal(errMsg)
		a.dispatchEval(fmt.Sprintf("if (window.__onImeRetypeResult) { window.__onImeRetypeResult(%s, %s); }", reqJSON, errJSON))
	}()
}
