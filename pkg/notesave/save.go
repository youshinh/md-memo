package notesave

import (
	"fmt"

	"md-memo/pkg/atomicfile"
	"md-memo/pkg/encoding"
)

// Request is one save.
type Request struct {
	// Path is the file to write, exactly as the caller named it.
	Path string
	// Own is the file the note is already bound to ("" if none); saving to it needs no Overwrite.
	Own string
	// Overwrite lets the save replace another existing file.
	Overwrite bool
	// Text is the note (LF line endings; they are written as they are).
	Text string
	// Encoding is what encoding.ParseName accepts ("" = UTF-8). The text must be representable in it.
	Encoding string
}

// Result says what was written.
type Result struct {
	Path     string // the cleaned path
	Bytes    int    // size of the file
	Encoding string // canonical name, encoding.NameUTF8 or encoding.NameShiftJIS
	Created  bool   // the file did not exist before
}

// Save validates the request, encodes the text without changing a single character, and writes the
// file all at once (a temporary file in the same folder renamed over the target, the permissions of
// an existing file kept). Nothing is written when any step fails: a bad path, a target that may not
// be replaced, an unknown encoding, or a character the encoding cannot hold (an
// *encoding.UnrepresentableError). A refusal by a path rule is a *RefusedError.
func Save(req Request) (*Result, error) {
	clean, err := ValidatePath(req.Path)
	if err != nil {
		return nil, err
	}
	target, err := CheckTarget(clean, req.Own, req.Overwrite)
	if err != nil {
		return nil, err
	}
	name, err := encoding.ParseName(req.Encoding)
	if err != nil {
		return nil, err
	}
	if name == "" {
		name = encoding.NameUTF8
	}
	data, err := encoding.EncodeStrict(req.Text, name)
	if err != nil {
		return nil, err
	}
	if err := atomicfile.Write(target.Real, data, ".md-memo-save-*.tmp"); err != nil {
		return nil, fmt.Errorf("cannot write %s: %w", quote(clean), err)
	}
	return &Result{Path: clean, Bytes: len(data), Encoding: name, Created: !target.Exists}, nil
}
