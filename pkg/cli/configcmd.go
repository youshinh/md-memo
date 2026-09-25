package cli

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"strconv"
	"strings"

	"md-memo/pkg/configpack"
)

// `md-memo config get [key.path]` shows config.json with every secret hidden. It exists so that an
// AI agent (or anyone) can see the settings without ever being handed the file itself, which holds
// API keys and the Discord bot token. Nothing it prints can carry a secret, because the whole
// document is redacted BEFORE a key path picks a part of it: there is no path that reaches a
// secret through an unredacted copy.

const (
	secretSet   = "<set>"
	secretUnset = "<unset>"
)

func (r *HeadlessRunner) runConfig(args []string) (int, error) {
	if len(args) == 0 {
		return 1, errors.New("config subcommand required: get")
	}
	if args[0] != "get" {
		return 1, fmt.Errorf("unknown config action: %s", args[0])
	}
	return r.runConfigGet(args[1:])
}

func (r *HeadlessRunner) runConfigGet(args []string) (int, error) {
	fs := newQuietFlagSet("config get")
	forceJSON := fs.Bool("json", false, "Force JSON output")
	forceText := fs.Bool("text", false, "Print a single value bare")
	rest, err := parseInterspersed(fs, args)
	if err != nil {
		return r.flagErr("config", err)
	}
	if len(rest) > 1 {
		return 1, fmt.Errorf("config get takes at most one key path, got %d", len(rest))
	}

	cfg := LoadConfig()
	if cfg.Err != nil {
		// Not "{}": an unreadable file would look like an empty one, and an agent would conclude
		// that nothing is configured.
		return 1, fmt.Errorf("cannot use %s: %v", cfg.Path, cfg.Err)
	}

	var doc interface{} = RedactConfig(cfg.Values)
	if len(rest) == 1 && rest[0] != "" {
		var ok bool
		if doc, ok = lookupConfigPath(doc, rest[0]); !ok {
			return 1, fmt.Errorf("no such key: %s", rest[0])
		}
	}

	format := ResolveFormatCustom(*forceJSON, *forceText, IsTerminal(os.Stdout))
	if format == FormatText {
		// A single value bare (what a script wants); an object or array is JSON either way.
		switch v := doc.(type) {
		case string:
			fmt.Fprintln(r.stdout, v)
			return 0, nil
		case json.Number:
			fmt.Fprintln(r.stdout, v.String())
			return 0, nil
		case bool:
			fmt.Fprintln(r.stdout, v)
			return 0, nil
		case nil:
			fmt.Fprintln(r.stdout, "null")
			return 0, nil
		}
	}
	return 0, writeJSONNoEscape(r.stdout, doc)
}

// writeJSONNoEscape pretty-prints v the way PrintFormatted does, except that the angle brackets
// and ampersands are not escaped: the marker for a hidden value is meant to be read as it is.
func writeJSONNoEscape(w io.Writer, v interface{}) error {
	enc := json.NewEncoder(w)
	enc.SetEscapeHTML(false)
	enc.SetIndent("", "  ")
	return enc.Encode(v)
}

// RedactConfig returns a deep copy of a parsed config.json (as Config.Values holds it) with every
// secret hidden; the input is not modified. The rules are those of pkg/configpack, the same ones
// that decide what a settings package export leaves out:
//
//   - a string at, or anywhere below, a key whose name configpack.IsSecretKey accepts (apikey,
//     api_key, api-key, token, secret, password, passwd - case-insensitively) becomes "<set>", or
//     "<unset>" when it is empty; not one character of the value survives;
//   - user:password@ (or a bare token@) in an http(s) URL is removed, as configpack.StripUserinfo does;
//   - beyond configpack: the same for other schemes (postgres://user:pw@host), and the value of a
//     secret-looking query parameter (?key=..., &token=...) is replaced by "<set>".
//
// Numbers, true/false and null are kept: a number below a secret-sounding key such as
// autocomplete.maxTokens is a setting, not a credential (configpack leaves those alone too).
func RedactConfig(values map[string]interface{}) map[string]interface{} {
	out, _ := redactValue(values, false).(map[string]interface{})
	if out == nil {
		out = map[string]interface{}{}
	}
	return out
}

func redactValue(v interface{}, underSecret bool) interface{} {
	switch t := v.(type) {
	case map[string]interface{}:
		out := make(map[string]interface{}, len(t))
		for k, child := range t {
			out[k] = redactValue(child, underSecret || configpack.IsSecretKey(k))
		}
		return out
	case []interface{}:
		out := make([]interface{}, len(t))
		for i, child := range t {
			out[i] = redactValue(child, underSecret)
		}
		return out
	case string:
		if underSecret {
			if t == "" {
				return secretUnset
			}
			return secretSet
		}
		return redactURL(t)
	}
	return v
}

// redactURL removes credentials from a URL-shaped string and leaves anything else as it is.
func redactURL(s string) string {
	if stripped, ok := configpack.StripUserinfo(s); ok {
		s = stripped
	}
	return redactURLQuery(stripPasswordUserinfo(s))
}

// stripPasswordUserinfo drops "user:password@" from scheme://user:password@host/... for schemes
// configpack.StripUserinfo does not cover. A bare "user@" (ssh://git@host) is an identity, not a
// secret, and stays.
func stripPasswordUserinfo(s string) string {
	i := strings.Index(s, "://")
	if i < 1 {
		return s
	}
	for _, c := range s[:i] {
		if !(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '+' || c == '-' || c == '.') {
			return s
		}
	}
	rest := s[i+3:]
	authEnd := strings.IndexAny(rest, "/?# \t\r\n")
	if authEnd < 0 {
		authEnd = len(rest)
	}
	at := strings.LastIndexByte(rest[:authEnd], '@')
	if at < 0 || !strings.Contains(rest[:at], ":") {
		return s
	}
	return s[:i+3] + rest[at+1:]
}

// redactURLQuery replaces the value of a secret-looking parameter in an http(s) URL's query string,
// for base URLs written as https://host/path?key=SECRET.
func redactURLQuery(s string) string {
	l := strings.ToLower(s)
	if !strings.HasPrefix(l, "http://") && !strings.HasPrefix(l, "https://") {
		return s
	}
	q := strings.IndexByte(s, '?')
	if q < 0 {
		return s
	}
	end := len(s)
	if h := strings.IndexByte(s[q:], '#'); h >= 0 {
		end = q + h
	}
	params := strings.Split(s[q+1:end], "&")
	changed := false
	for i, p := range params {
		name, _, hasValue := strings.Cut(p, "=")
		if hasValue && isSecretParam(name) {
			params[i] = name + "=" + secretSet
			changed = true
		}
	}
	if !changed {
		return s
	}
	return s[:q+1] + strings.Join(params, "&") + s[end:]
}

func isSecretParam(name string) bool {
	if n, err := url.QueryUnescape(name); err == nil {
		name = n
	}
	name = strings.ToLower(name)
	switch name {
	case "key", "sig", "signature", "auth", "authorization":
		return true
	}
	return configpack.IsSecretKey(name)
}

// lookupConfigPath walks a dotted key path ("scraps.scrapDir", "agents.0.name") through a redacted
// document. A key may itself contain dots: at each level the shortest name that exists is tried
// first, then longer ones. A number picks an item of an array.
func lookupConfigPath(doc interface{}, path string) (interface{}, bool) {
	return lookupSegments(doc, strings.Split(path, "."))
}

func lookupSegments(v interface{}, segs []string) (interface{}, bool) {
	if len(segs) == 0 {
		return v, true
	}
	switch t := v.(type) {
	case map[string]interface{}:
		for n := 1; n <= len(segs); n++ {
			if child, ok := t[strings.Join(segs[:n], ".")]; ok {
				if found, ok := lookupSegments(child, segs[n:]); ok {
					return found, true
				}
			}
		}
	case []interface{}:
		if i, err := strconv.Atoi(segs[0]); err == nil && i >= 0 && i < len(t) {
			return lookupSegments(t[i], segs[1:])
		}
	}
	return nil, false
}
