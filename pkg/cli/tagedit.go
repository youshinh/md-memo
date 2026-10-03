package cli

import (
	"encoding/json"
	"errors"

	"md-memo/pkg/search"
)

// The tag editor's entry point (docs/design/tag-filter-2026-10.md section 10). The rules for where a tag goes are search.EditTags; this
// is what `md-memo scrap tag`, the JSON-RPC method scrap.tag_edit and the window's TagEditAsync bind share: the request in the form all
// three take it, the checks of its arguments, and the answer. It works on the text it is given and touches no file and no window.

// TagList is a list of tags that a request may write as one string ("仕事, 急ぎ") or as a list of strings (["仕事", "急ぎ"]).
type TagList []string

// UnmarshalJSON reads a string or a list of strings; null is no tag.
func (t *TagList) UnmarshalJSON(b []byte) error {
	var list []string
	if json.Unmarshal(b, &list) == nil {
		*t = list
		return nil
	}
	var s string
	if json.Unmarshal(b, &s) == nil {
		*t = TagList{s}
		return nil
	}
	return errors.New("tags must be a string or a list of strings")
}

// ScrapTagEditRequest is the request of scrap.tag_edit, and of the bind the window uses.
type ScrapTagEditRequest struct {
	Text       string  `json:"text"`
	Op         string  `json:"op"`    // add, remove or show
	Scope      string  `json:"scope"` // note (the default) or entry
	Line       int     `json:"line"`  // 1-based; the line that picks the entry (scope entry)
	Tags       TagList `json:"tags"`
	ReturnText bool    `json:"return_text"` // also answer the whole new text
}

// ScrapTagEditResult is the answer: the TagEdit, and with ReturnText the text that results from applying it.
type ScrapTagEditResult struct {
	search.TagEdit
	Text *string `json:"text,omitempty"` // a pointer: an empty new text is still sent when it was asked for
}

// ScrapTagEdit works out the edit. A bad argument (no op, an unknown scope, scope entry without a line, no tag, more than 8 tags, a tag
// that is too long, a line outside the text, a text over 16 MB) is a ParamError. Asking for a tag that is there already is not an
// error: the answer's Changed is false and its MessageCode says why.
func ScrapTagEdit(req ScrapTagEditRequest) (ScrapTagEditResult, error) {
	if req.Op == "" {
		return ScrapTagEditResult{}, paramErr("op required: add, remove or show")
	}
	scope := req.Scope
	if scope == "" {
		scope = "note"
	}
	if scope == "entry" && req.Line < 1 {
		return ScrapTagEditResult{}, paramErr("scope entry needs line (1 or more)")
	}
	edit, err := search.EditTags([]byte(req.Text), req.Op, scope, req.Line, req.Tags)
	if err != nil {
		return ScrapTagEditResult{}, &ParamError{Msg: oneLine(err)}
	}
	res := ScrapTagEditResult{TagEdit: edit}
	if req.ReturnText {
		text := string(edit.Apply([]byte(req.Text)))
		res.Text = &text
	}
	return res, nil
}
