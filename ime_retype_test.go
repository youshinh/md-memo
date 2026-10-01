package main

import (
	"strings"
	"testing"
)

func TestImeRetypeKeys(t *testing.T) {
	keys, ok := imeRetypeKeys("iro")
	if !ok || len(keys) != 3 || keys[0] != 0x49 || keys[1] != 0x52 || keys[2] != 0x4F {
		t.Fatalf("iro -> %v %v, want VK_I VK_R VK_O", keys, ok)
	}
	if keys, ok := imeRetypeKeys("a"); !ok || len(keys) != 1 || keys[0] != 0x41 {
		t.Errorf("a -> %v %v, want VK_A", keys, ok)
	}
	for _, bad := range []string{"", "Iro", "i ro", "ir-o", "iro'", "いろ", "ir0", strings.Repeat("a", imeRetypeMaxKeys+1)} {
		if keys, ok := imeRetypeKeys(bad); ok {
			t.Errorf("%q was accepted as %v; only 1..%d lowercase letters may be sent as keys", bad, keys, imeRetypeMaxKeys)
		}
	}
	if _, ok := imeRetypeKeys(strings.Repeat("a", imeRetypeMaxKeys)); !ok {
		t.Errorf("a word of exactly %d letters must be accepted", imeRetypeMaxKeys)
	}
}
