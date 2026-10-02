//go:build !windows

package encoding

// pipedCodePage: terminals outside Windows write UTF-8; a text that is not UTF-8 is tried as Shift_JIS (see DecodePipedAs).
func pipedCodePage() int { return 0 }
