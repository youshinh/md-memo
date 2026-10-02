// Package textsig gives a note's text a short fingerprint, so MD-Memo can tell whether the file a tab was read from or last saved to
// still holds that text, without keeping a second copy of the text.
//
// frontend/js/disk_sync.js computes the SAME fingerprint (the shared vectors in both test files pin it): the page stores the
// fingerprint of the text a tab came from or was last saved as, and sends it with the next save; Go reads the file, fingerprints
// what is there now and compares. A mismatch means the file was changed by something else (another editor, a Git pull, a sync
// client, an agent) since this tab last knew it.
//
// Line endings do not count (a CRLF file and the same text as LF have one fingerprint: the page's editor works on LF), and the
// hash runs over UTF-16 code units, which is what the page's strings are made of. It is not a cryptographic hash: it only has to
// notice change, and 53 bits plus the length make an accidental match practically impossible.
package textsig

import (
	"strconv"
	"strings"
)

var lfReplacer = strings.NewReplacer("\r\n", "\n", "\r", "\n")

// NormalizeLF turns CRLF and lone CR into LF, like the page's textarea does.
func NormalizeLF(s string) string {
	if !strings.Contains(s, "\r") {
		return s
	}
	return lfReplacer.Replace(s)
}

// ToCRLF returns the text with every line break written as CRLF.
func ToCRLF(s string) string {
	s = NormalizeLF(s)
	if !strings.Contains(s, "\n") {
		return s
	}
	return strings.ReplaceAll(s, "\n", "\r\n")
}

// Sum is the fingerprint of text, "<length in UTF-16 units>-<53-bit hash>" in hex.
func Sum(text string) string {
	text = NormalizeLF(text)
	var h1, h2 uint32 = 0xdeadbeef, 0x41c6ce57
	n := 0
	mix := func(ch uint32) {
		h1 = (h1 ^ ch) * 2654435761
		h2 = (h2 ^ ch) * 1597334677
		n++
	}
	for _, r := range text {
		if r >= 0x10000 {
			r -= 0x10000
			mix(0xD800 + uint32(r>>10))
			mix(0xDC00 + uint32(r&0x3FF))
		} else {
			mix(uint32(r))
		}
	}
	h1 = (h1 ^ h1>>16) * 2246822507
	h1 ^= (h2 ^ h2>>13) * 3266489909
	h2 = (h2 ^ h2>>16) * 2246822507
	h2 ^= (h1 ^ h1>>13) * 3266489909
	value := uint64(h2&2097151)<<32 | uint64(h1)
	return strconv.FormatInt(int64(n), 16) + "-" + strconv.FormatUint(value, 16)
}
