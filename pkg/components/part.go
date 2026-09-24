// Package components downloads, verifies and tracks optional local parts (a runtime binary, a
// model file) that md-memo does not ship: nothing is fetched until the user asks, and nothing
// costs anything while unused. A Part describes one downloadable thing; Manager (manager.go)
// installs and removes Parts under a root directory.
package components

// Part describes one downloadable component.
type Part struct {
	ID    string `json:"id"`    // stable, filesystem-safe: letters, digits, '.', '-', '_'
	Kind  string `json:"kind"`  // "runtime" or "model" (informational)
	Title string `json:"title"` // shown in the UI
	Note  string `json:"note"`  // one-line description shown in the UI

	URL    string `json:"url"`    // https (http only for localhost, for tests)
	SHA256 string `json:"sha256"` // lowercase hex of the downloaded file; empty = not verified (user-supplied parts only)
	Size   int64  `json:"size"`   // expected download size in bytes; 0 = unknown

	// Archive is "" when URL is the file itself, or "zip" when URL is a zip to extract.
	Archive string `json:"archive"`
	// Extract lists which zip entries to keep, matched case-insensitively against the entry's base
	// name; an entry may be a glob such as "ggml*.dll". Kept entries are flattened into the part's
	// directory. Empty = keep every file (still flattened).
	Extract []string `json:"extract"`
	// Entry is the main file inside the part's directory: the model file for a single-file part, or
	// the executable for an archive. Path() reports it.
	Entry string `json:"entry"`
	// Platform restricts the part to one "GOOS/GOARCH" (for example "windows/amd64"); "" = any.
	Platform string `json:"platform"`
}

// Status is a Part's install state.
type Status struct {
	ID        string `json:"id"`
	Installed bool   `json:"installed"`
	Path      string `json:"path"` // absolute path of Entry when installed, else ""
	Size      int64  `json:"size"` // bytes on disk when installed
}
