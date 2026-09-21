package configpack

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"sort"
	"strings"
	"unicode/utf8"

	"gopkg.in/yaml.v3"
)

var secretWords = [...]string{"apikey", "api_key", "api-key", "token", "secret", "password", "passwd"}

// IsSecretKey: keep in step with isSecretKey in frontend/js/config_pack.js.
func IsSecretKey(name string) bool {
	l := strings.ToLower(name)
	for _, w := range secretWords {
		if strings.Contains(l, w) {
			return true
		}
	}
	return false
}

// StripUserinfo removes user:pass@ or a bare token@ from an http(s) URL and leaves the rest as is.
func StripUserinfo(s string) (string, bool) {
	l := strings.ToLower(s)
	schemeEnd := 0
	switch {
	case strings.HasPrefix(l, "https://"):
		schemeEnd = len("https://")
	case strings.HasPrefix(l, "http://"):
		schemeEnd = len("http://")
	default:
		return s, false
	}
	rest := s[schemeEnd:]
	authEnd := strings.IndexAny(rest, "/?# \t\r\n")
	if authEnd < 0 {
		authEnd = len(rest)
	}
	at := strings.LastIndexByte(rest[:authEnd], '@')
	if at < 0 {
		return s, false
	}
	return s[:schemeEnd] + rest[at+1:], true
}

type textEdit struct {
	start, end int
	repl       string
}

func applyEdits(data []byte, edits []textEdit) []byte {
	if len(edits) == 0 {
		return data
	}
	sort.Slice(edits, func(i, j int) bool { return edits[i].start < edits[j].start })
	var out bytes.Buffer
	out.Grow(len(data))
	pos := 0
	for _, e := range edits {
		out.Write(data[pos:e.start])
		out.WriteString(e.repl)
		pos = e.end
	}
	out.Write(data[pos:])
	return out.Bytes()
}

type jsonMode int

const (
	// modeConfig blanks string values below a secret-named key, at any depth.
	modeConfig jsonMode = iota
	// modeAgentsEnv blanks values of secret-named keys, but only inside an "env" mapping.
	modeAgentsEnv
)

type jsonFrame struct {
	obj, expectKey bool
	key            string
	secret         bool
	env            bool
}

func jsonChildFlags(mode jsonMode, top *jsonFrame) (secret, env bool) {
	if top == nil {
		return false, false
	}
	if mode == modeConfig {
		return top.secret || (top.obj && IsSecretKey(top.key)), false
	}
	env = top.env || (top.obj && top.key == "env")
	return env && (top.secret || (top.obj && IsSecretKey(top.key))), env
}

func isJSONGap(b byte) bool {
	switch b {
	case ' ', '\t', '\r', '\n', ',', ':':
		return true
	}
	return false
}

func jsonQuote(s string) string {
	var b bytes.Buffer
	enc := json.NewEncoder(&b)
	enc.SetEscapeHTML(false)
	_ = enc.Encode(s)
	return strings.TrimRight(b.String(), "\n")
}

// scanJSON records byte spans to overwrite instead of re-encoding, so key order, number
// formatting and indentation survive.
func scanJSON(data []byte, mode jsonMode) ([]textEdit, error) {
	dec := json.NewDecoder(bytes.NewReader(data))
	var stack []jsonFrame
	var edits []textEdit
	prev := 0
	for {
		tok, err := dec.Token()
		if err == io.EOF {
			return edits, nil
		}
		if err != nil {
			return nil, err
		}
		end := int(dec.InputOffset())
		var top *jsonFrame
		if n := len(stack); n > 0 {
			top = &stack[n-1]
		}

		valueDone := func() {
			if top != nil && top.obj {
				top.expectKey = true
			}
		}
		// Only ws, ',' and ':' can sit between the previous token and this one.
		start := prev
		for start < end && isJSONGap(data[start]) {
			start++
		}

		switch t := tok.(type) {
		case json.Delim:
			if t == '{' || t == '[' {
				secret, env := jsonChildFlags(mode, top)
				valueDone()
				stack = append(stack, jsonFrame{obj: t == '{', expectKey: t == '{', secret: secret, env: env})
			} else {
				stack = stack[:len(stack)-1]
			}
		case string:
			if top != nil && top.obj && top.expectKey {
				top.key = t
				top.expectKey = false
				break
			}
			secret, env := jsonChildFlags(mode, top)
			if t != "" {
				if secret {
					edits = append(edits, textEdit{start, end, `""`})
				} else if stripped, ok := StripUserinfo(t); ok {
					if mode == modeConfig {
						edits = append(edits, textEdit{start, end, jsonQuote(stripped)})
					} else if env {
						edits = append(edits, textEdit{start, end, `""`})
					}
				}
			}
			valueDone()
		case float64:
			// Only an env value is always a string; elsewhere a number under a key such as
			// autocomplete.maxTokens is a setting, not a credential.
			if secret, _ := jsonChildFlags(mode, top); secret && mode == modeAgentsEnv {
				edits = append(edits, textEdit{start, end, `""`})
			}
			valueDone()
		default:
			valueDone()
		}
		prev = end
	}
}

var utf8BOM = []byte{0xEF, 0xBB, 0xBF}

func stripJSON(data []byte, mode jsonMode) ([]byte, int, error) {
	body := bytes.TrimPrefix(data, utf8BOM)
	if !json.Valid(body) {
		return nil, 0, errors.New("invalid JSON")
	}
	edits, err := scanJSON(body, mode)
	if err != nil {
		return nil, 0, err
	}
	if len(edits) == 0 {
		return data, 0, nil
	}
	out := applyEdits(body, edits)
	if len(body) != len(data) {
		out = append(append([]byte{}, utf8BOM...), out...)
	}
	return out, len(edits), nil
}

// StripJSON blanks string values below secret-named keys (numbers and bools are left alone) and
// strips URL userinfo. With nothing to strip it returns data itself.
func StripJSON(data []byte) ([]byte, int, error) { return stripJSON(data, modeConfig) }

func CountSecrets(data []byte) (int, error) {
	_, n, err := stripJSON(data, modeConfig)
	return n, err
}

// StripAgents blanks env credentials in an agents file without re-serialising it (a clean file
// comes back as is, YAML keeps its comments). warned: a likely secret was left unedited.
func StripAgents(data []byte, origName string) (out []byte, n int, warned bool) {
	switch AgentsExt(origName) {
	case ".md":
		return stripAgentsMarkdown(data)
	case ".json":
		if o, c, err := stripJSON(data, modeAgentsEnv); err == nil {
			return o, c, false
		}
		return stripAgentsYAML(data)
	}
	if t := bytes.TrimSpace(data); len(t) > 0 && t[0] == '{' {
		if o, c, err := stripJSON(data, modeAgentsEnv); err == nil {
			return o, c, false
		}
	}
	return stripAgentsYAML(data)
}

func stripAgentsMarkdown(src []byte) ([]byte, int, bool) {
	type block struct{ start, end int }
	var blocks []block
	var langs []string
	pos, open, openLang, contentStart := 0, false, "", 0
	for pos < len(src) {
		nl := bytes.IndexByte(src[pos:], '\n')
		lineEnd := len(src)
		next := len(src)
		if nl >= 0 {
			lineEnd = pos + nl
			next = lineEnd + 1
		}
		trimmed := strings.TrimSpace(string(src[pos:lineEnd]))
		if strings.HasPrefix(trimmed, "```") {
			if !open {
				open, openLang, contentStart = true, strings.ToLower(strings.TrimSpace(trimmed[3:])), next
			} else if strings.Trim(trimmed, "`") == "" {
				blocks = append(blocks, block{contentStart, pos})
				langs = append(langs, openLang)
				open = false
			}
		}
		pos = next
	}

	var out bytes.Buffer
	last, total, warned := 0, 0, false
	for i, b := range blocks {
		if l := langs[i]; l != "" && l != "yaml" && l != "yml" && l != "json" {
			continue
		}
		body := src[b.start:b.end]
		var nb []byte
		var c int
		var w bool
		if langs[i] == "json" {
			if o, cnt, err := stripJSON(body, modeAgentsEnv); err == nil {
				nb, c = o, cnt
			} else {
				nb, c, w = stripAgentsYAML(body)
			}
		} else {
			nb, c, w = stripAgentsYAML(body)
		}
		warned = warned || w
		if c == 0 {
			continue
		}
		out.Write(src[last:b.start])
		out.Write(nb)
		last = b.end
		total += c
	}
	if total == 0 {
		return src, 0, warned
	}
	out.Write(src[last:])
	return out.Bytes(), total, warned
}

func stripAgentsYAML(src []byte) ([]byte, int, bool) {
	var doc yaml.Node
	if err := yaml.Unmarshal(src, &doc); err != nil || doc.Kind == 0 {
		return src, 0, false
	}
	var targets []*yaml.Node
	warned := false
	collectEnvSecrets(&doc, false, false, &targets, &warned)
	if len(targets) == 0 {
		return src, 0, warned
	}
	edits, ok := yamlEdits(src, targets)
	if !ok {
		return src, 0, true
	}
	out := applyEdits(src, edits)
	if !sameYAMLExcept(&doc, out, targets) {
		return src, 0, true
	}
	return out, len(targets), warned
}

func collectEnvSecrets(n *yaml.Node, inEnv, inSecret bool, targets *[]*yaml.Node, warned *bool) {
	switch n.Kind {
	case yaml.DocumentNode:
		for _, c := range n.Content {
			collectEnvSecrets(c, inEnv, inSecret, targets, warned)
		}
	case yaml.MappingNode:
		for i := 0; i+1 < len(n.Content); i += 2 {
			key, v := n.Content[i].Value, n.Content[i+1]
			childEnv := inEnv || key == "env"
			childSecret := childEnv && (inSecret || IsSecretKey(key))
			switch v.Kind {
			case yaml.ScalarNode:
				if childEnv && v.Value != "" && (childSecret && yamlIsTextual(v) || stripsUserinfo(v.Value)) {
					*targets = append(*targets, v)
				}
			case yaml.AliasNode:
				if childEnv {
					*warned = true
				}
			default:
				collectEnvSecrets(v, childEnv, childSecret, targets, warned)
			}
		}
	case yaml.SequenceNode:
		for _, c := range n.Content {
			switch {
			case c.Kind != yaml.ScalarNode:
				collectEnvSecrets(c, inEnv, inSecret, targets, warned)
			case inEnv && inSecret && c.Value != "" && yamlIsTextual(c):
				*targets = append(*targets, c)
			case inEnv:
				// "KEY=value" list form: not edited in place, but not left silent either.
				if k, val, ok := strings.Cut(c.Value, "="); ok && val != "" && IsSecretKey(k) {
					*warned = true
				}
			}
		}
	}
}

func stripsUserinfo(s string) bool {
	_, ok := StripUserinfo(s)
	return ok
}

func yamlIsTextual(n *yaml.Node) bool {
	switch n.Tag {
	case "!!str", "!!int", "!!float":
		return true
	}
	return false
}

// yamlEdits gives up (ok=false) on any scalar whose source extent is uncertain: block scalars,
// tags, anchors, multi-line values.
func yamlEdits(src []byte, targets []*yaml.Node) ([]textEdit, bool) {
	lineStart := []int{0}
	for i, b := range src {
		if b == '\n' {
			lineStart = append(lineStart, i+1)
		}
	}
	var edits []textEdit
	for _, v := range targets {
		if v.Line < 1 || v.Line > len(lineStart) || v.Column < 1 || v.Anchor != "" ||
			v.Style&(yaml.TaggedStyle|yaml.LiteralStyle|yaml.FoldedStyle) != 0 {
			return nil, false
		}
		line := src[lineStart[v.Line-1]:]
		if nl := bytes.IndexByte(line, '\n'); nl >= 0 {
			line = line[:nl]
		}
		off := 0
		for c := 1; c < v.Column; c++ {
			if off >= len(line) {
				return nil, false
			}
			_, size := utf8.DecodeRune(line[off:])
			off += size
		}
		text := line[off:]
		var length int
		switch {
		case v.Style&yaml.DoubleQuotedStyle != 0:
			length = quotedLen(text, '"')
		case v.Style&yaml.SingleQuotedStyle != 0:
			length = quotedLen(text, '\'')
		case !strings.Contains(v.Value, "\n") && bytes.HasPrefix(text, []byte(v.Value)):
			length = len(v.Value)
		}
		if length <= 0 {
			return nil, false
		}
		s := lineStart[v.Line-1] + off
		edits = append(edits, textEdit{s, s + length, `""`})
	}
	return edits, true
}

func quotedLen(text []byte, q byte) int {
	if len(text) == 0 || text[0] != q {
		return 0
	}
	for i := 1; i < len(text); i++ {
		switch {
		case q == '"' && text[i] == '\\':
			i++
		case text[i] == q && q == '\'' && i+1 < len(text) && text[i+1] == '\'':
			i++
		case text[i] == q:
			return i + 1
		}
	}
	return 0
}

// sameYAMLExcept proves an edit touched only the targets: the re-parsed tree must match node for node.
func sameYAMLExcept(orig *yaml.Node, edited []byte, targets []*yaml.Node) bool {
	var doc yaml.Node
	if err := yaml.Unmarshal(edited, &doc); err != nil {
		return false
	}
	isTarget := make(map[*yaml.Node]bool, len(targets))
	for _, t := range targets {
		isTarget[t] = true
	}
	var same func(a, b *yaml.Node) bool
	same = func(a, b *yaml.Node) bool {
		if a.Kind != b.Kind {
			return false
		}
		if isTarget[a] {
			return b.Kind == yaml.ScalarNode && b.Value == ""
		}
		if a.Tag != b.Tag || a.Value != b.Value || len(a.Content) != len(b.Content) {
			return false
		}
		for i := range a.Content {
			if !same(a.Content[i], b.Content[i]) {
				return false
			}
		}
		return true
	}
	return same(orig, &doc)
}
