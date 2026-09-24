package main

// This file exercises build_mac.sh and the AppVersion constant in app.go purely as text: it
// never invokes bash, sips, iconutil, codesign or go build, so it runs fine on the Windows
// development machine as well as on CI. It is intentionally self-contained - no helpers from
// any other _test.go file in this package - because other agents may be mid-edit on the rest
// of the root package while this runs.
//
// What it proves:
//   - the Info.plist heredoc build_mac.sh writes is well-formed plist XML;
//   - CFBundleExecutable/CFBundleName inside it resolve to the same app name the script itself
//     builds and ad-hoc signs (APP_NAME);
//   - CFBundleDocumentTypes still covers .md/.markdown/.txt, so macOS keeps offering MD-Memo
//     for "Open With" on those extensions (see bd90136 in this repo's history, which fixed
//     exactly that being broken);
//   - NSMicrophoneUsageDescription is present, which is required for the voice input feature
//     to be allowed to prompt for microphone access at all on macOS;
//   - the APP_VERSION grep the script runs against app.go actually matches today's AppVersion
//     line, reimplemented here as a Go regexp rather than shelling out to grep.

import (
	"encoding/xml"
	"fmt"
	"os"
	"regexp"
	"strings"
	"testing"
)

func readRepoFile(t *testing.T, name string) string {
	t.Helper()
	data, err := os.ReadFile(name)
	if err != nil {
		t.Fatalf("reading %s: %v", name, err)
	}
	return string(data)
}

// extractInfoPlistHeredoc pulls the literal text between the
// `cat <<EOF > "$CONTENTS_DIR/Info.plist"` line and the closing `EOF` line out of build_mac.sh.
func extractInfoPlistHeredoc(t *testing.T, script string) string {
	t.Helper()
	const startMarker = `cat <<EOF > "$CONTENTS_DIR/Info.plist"`
	startIdx := strings.Index(script, startMarker)
	if startIdx < 0 {
		t.Fatalf("build_mac.sh: could not find heredoc start marker %q; script layout changed - update this test", startMarker)
	}
	rest := script[startIdx+len(startMarker):]

	lines := strings.Split(rest, "\n")
	var body []string
	closed := false
	for _, line := range lines[1:] { // skip the empty remainder of the marker's own line
		if strings.TrimRight(line, "\r") == "EOF" {
			closed = true
			break
		}
		body = append(body, line)
	}
	if !closed {
		t.Fatalf("build_mac.sh: heredoc starting at %q was never closed with a bare EOF line", startMarker)
	}
	return strings.Join(body, "\n")
}

// shellVar extracts the value of a `NAME="value"` assignment from a shell script.
func shellVar(t *testing.T, script, name string) string {
	t.Helper()
	re := regexp.MustCompile(regexp.QuoteMeta(name) + `="([^"]*)"`)
	m := re.FindStringSubmatch(script)
	if m == nil {
		t.Fatalf("build_mac.sh: could not find %s=\"...\" assignment", name)
	}
	return m[1]
}

// plistValue is a generic parsed Apple plist value: a string, a bool (<true/>/<false/>), an
// array of plistValue, or a dict of string -> plistValue. Only the node kinds build_mac.sh's
// Info.plist actually uses are handled; anything else is skipped rather than failing the test,
// since this parser only needs to be as capable as the one real document it reads.
type plistValue struct {
	kind  string // "string", "bool", "array", "dict"
	str   string
	bool_ bool
	array []plistValue
	dict  map[string]plistValue
}

func parsePlistDict(root string) (map[string]plistValue, error) {
	dec := xml.NewDecoder(strings.NewReader(root))
	dec.Strict = false // plist's DOCTYPE/internal subset is not something encoding/xml needs to validate

	for {
		tok, err := dec.Token()
		if err != nil {
			return nil, fmt.Errorf("looking for top-level <dict>: %w", err)
		}
		if se, ok := tok.(xml.StartElement); ok && se.Name.Local == "dict" {
			return parseDict(dec)
		}
	}
}

func parseDict(dec *xml.Decoder) (map[string]plistValue, error) {
	result := map[string]plistValue{}
	var pendingKey string
	haveKey := false
	for {
		tok, err := dec.Token()
		if err != nil {
			return nil, err
		}
		switch t := tok.(type) {
		case xml.StartElement:
			if t.Name.Local == "key" {
				var k string
				if err := dec.DecodeElement(&k, &t); err != nil {
					return nil, fmt.Errorf("decoding <key>: %w", err)
				}
				pendingKey = k
				haveKey = true
				continue
			}
			if !haveKey {
				return nil, fmt.Errorf("plist value <%s> with no preceding <key>", t.Name.Local)
			}
			v, err := parsePlistValue(dec, t)
			if err != nil {
				return nil, err
			}
			result[pendingKey] = v
			haveKey = false
		case xml.EndElement:
			if t.Name.Local == "dict" {
				return result, nil
			}
		}
	}
}

func parsePlistValue(dec *xml.Decoder, start xml.StartElement) (plistValue, error) {
	switch start.Name.Local {
	case "string":
		var s string
		if err := dec.DecodeElement(&s, &start); err != nil {
			return plistValue{}, fmt.Errorf("decoding <string>: %w", err)
		}
		return plistValue{kind: "string", str: s}, nil
	case "true", "false":
		if err := skipToMatchingEnd(dec); err != nil {
			return plistValue{}, err
		}
		return plistValue{kind: "bool", bool_: start.Name.Local == "true"}, nil
	case "array":
		var items []plistValue
		for {
			tok, err := dec.Token()
			if err != nil {
				return plistValue{}, fmt.Errorf("reading <array> contents: %w", err)
			}
			switch t := tok.(type) {
			case xml.StartElement:
				v, err := parsePlistValue(dec, t)
				if err != nil {
					return plistValue{}, err
				}
				items = append(items, v)
			case xml.EndElement:
				if t.Name.Local == "array" {
					return plistValue{kind: "array", array: items}, nil
				}
			}
		}
	case "dict":
		d, err := parseDict(dec)
		if err != nil {
			return plistValue{}, err
		}
		return plistValue{kind: "dict", dict: d}, nil
	default:
		// integer / real / data / date etc: not used by this Info.plist, skip over it.
		if err := skipToMatchingEnd(dec); err != nil {
			return plistValue{}, err
		}
		return plistValue{}, nil
	}
}

// skipToMatchingEnd consumes tokens until the EndElement that balances the StartElement the
// caller already consumed (works for both "<foo>...</foo>" and self-closing "<foo/>", since
// encoding/xml turns the latter into an immediately-following EndElement of its own).
func skipToMatchingEnd(dec *xml.Decoder) error {
	depth := 1
	for depth > 0 {
		tok, err := dec.Token()
		if err != nil {
			return err
		}
		switch tok.(type) {
		case xml.StartElement:
			depth++
		case xml.EndElement:
			depth--
		}
	}
	return nil
}

func TestBuildMacInfoPlistHeredoc(t *testing.T) {
	script := readRepoFile(t, "build_mac.sh")

	appName := shellVar(t, script, "APP_NAME")
	minOSVersion := shellVar(t, script, "MIN_OS_VERSION")
	if appName == "" || minOSVersion == "" {
		t.Fatalf("build_mac.sh: APP_NAME=%q MIN_OS_VERSION=%q, expected both non-empty", appName, minOSVersion)
	}

	heredoc := extractInfoPlistHeredoc(t, script)

	const testVersion = "9.9.9"
	filled := heredoc
	filled = strings.ReplaceAll(filled, "$APP_NAME", appName)
	filled = strings.ReplaceAll(filled, "$APP_VERSION", testVersion)
	filled = strings.ReplaceAll(filled, "$MIN_OS_VERSION", minOSVersion)

	if strings.Contains(filled, "$") {
		t.Errorf("Info.plist heredoc still contains an unresolved shell variable after substitution:\n%s", filled)
	}

	dict, err := parsePlistDict(filled)
	if err != nil {
		t.Fatalf("parsing Info.plist heredoc as XML: %v\n---\n%s", err, filled)
	}

	execVal, ok := dict["CFBundleExecutable"]
	if !ok || execVal.kind != "string" {
		t.Fatalf("Info.plist: CFBundleExecutable missing or not a string, got %+v", execVal)
	}
	if execVal.str != appName {
		t.Errorf("CFBundleExecutable = %q, want %q (APP_NAME from build_mac.sh, i.e. the binary build_mac.sh actually moves into the bundle's MacOS dir)", execVal.str, appName)
	}

	nameVal, ok := dict["CFBundleName"]
	if !ok || nameVal.kind != "string" || nameVal.str != appName {
		t.Errorf("CFBundleName = %+v, want string %q", nameVal, appName)
	}

	if v, ok := dict["CFBundleShortVersionString"]; !ok || v.kind != "string" || v.str != testVersion {
		t.Errorf("CFBundleShortVersionString = %+v, want string %q", v, testVersion)
	}
	if v, ok := dict["CFBundleVersion"]; !ok || v.kind != "string" || v.str != testVersion {
		t.Errorf("CFBundleVersion = %+v, want string %q", v, testVersion)
	}

	if _, ok := dict["NSMicrophoneUsageDescription"]; !ok {
		t.Error("Info.plist is missing NSMicrophoneUsageDescription; macOS will refuse to let the app prompt for microphone access for voice input")
	} else if dict["NSMicrophoneUsageDescription"].kind != "string" || strings.TrimSpace(dict["NSMicrophoneUsageDescription"].str) == "" {
		t.Error("NSMicrophoneUsageDescription is present but empty")
	}

	docTypesVal, ok := dict["CFBundleDocumentTypes"]
	if !ok || docTypesVal.kind != "array" {
		t.Fatalf("Info.plist: CFBundleDocumentTypes missing or not an array, got %+v", docTypesVal)
	}

	seenExt := map[string]bool{}
	for _, entry := range docTypesVal.array {
		if entry.kind != "dict" {
			continue
		}
		extsVal, ok := entry.dict["CFBundleTypeExtensions"]
		if !ok || extsVal.kind != "array" {
			continue
		}
		for _, e := range extsVal.array {
			if e.kind == "string" {
				seenExt[e.str] = true
			}
		}
	}
	for _, want := range []string{"md", "markdown", "txt"} {
		if !seenExt[want] {
			t.Errorf("CFBundleDocumentTypes does not declare extension %q; declared: %v", want, seenExt)
		}
	}
}

func TestBuildMacVersionGrepMatchesAppGo(t *testing.T) {
	script := readRepoFile(t, "build_mac.sh")
	appGo := readRepoFile(t, "app.go")

	// This mirrors the two-stage pipeline build_mac.sh actually runs:
	//   grep -oE 'AppVersion[[:space:]]*=[[:space:]]*"[0-9]+\.[0-9]+\.[0-9]+"' app.go | grep -oE '[0-9]+\.[0-9]+\.[0-9]+'
	const scriptSrc = `APP_VERSION="$(grep -oE 'AppVersion[[:space:]]*=[[:space:]]*"[0-9]+\.[0-9]+\.[0-9]+"' app.go | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -n1 || true)"`
	if !strings.Contains(script, scriptSrc) {
		t.Fatalf("build_mac.sh no longer contains the expected APP_VERSION extraction line; this test's regex was pinned to:\n%s\nUpdate both together if the script changed intentionally.", scriptSrc)
	}

	stage1 := regexp.MustCompile(`AppVersion[[:space:]]*=[[:space:]]*"[0-9]+\.[0-9]+\.[0-9]+"`)
	m := stage1.FindString(appGo)
	if m == "" {
		t.Fatalf("app.go does not match the first-stage grep pattern %s; build_mac.sh would fail with 'could not parse the AppVersion constant'", stage1.String())
	}

	stage2 := regexp.MustCompile(`[0-9]+\.[0-9]+\.[0-9]+`)
	version := stage2.FindString(m)
	if version == "" {
		t.Fatalf("second-stage grep found no version number inside %q", m)
	}

	if !regexp.MustCompile(`^\d+\.\d+\.\d+$`).MatchString(version) {
		t.Errorf("extracted APP_VERSION %q is not a plain X.Y.Z version string", version)
	}
}
