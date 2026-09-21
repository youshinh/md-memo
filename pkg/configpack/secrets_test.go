package configpack

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"
)

func TestIsSecretKey(t *testing.T) {
	for _, k := range []string{"apiKey", "API_KEY", "x-api-key", "OPENAI_APIKEY", "authToken", "tokens", "clientSecret", "Password", "passwd", "DB_PASSWD_FILE", "maxTokens"} {
		if !IsSecretKey(k) {
			t.Errorf("IsSecretKey(%q) = false", k)
		}
	}
	for _, k := range []string{"", "model", "baseUrl", "key", "tok", "scrapDir", "apiUrl"} {
		if IsSecretKey(k) {
			t.Errorf("IsSecretKey(%q) = true", k)
		}
	}
}

func TestStripUserinfo(t *testing.T) {
	cases := []struct {
		in, want string
		changed  bool
	}{
		{"https://user:pw@github.com/a/b.git", "https://github.com/a/b.git", true},
		{"http://user:pw@host:8080/x?q=1#f", "http://host:8080/x?q=1#f", true},
		{"HTTPS://ghp_abc@github.com/a/b", "HTTPS://github.com/a/b", true},
		{"https://a:b:c@host", "https://host", true},
		{"https://user:p@ss@host/path", "https://host/path", true},
		{"https://github.com/a/b.git", "https://github.com/a/b.git", false},
		{"https://github.com/a@b/c.git", "https://github.com/a@b/c.git", false},
		{"https://host/?email=a@b.c", "https://host/?email=a@b.c", false},
		{"git@github.com:a/b.git", "git@github.com:a/b.git", false},
		{"ssh://git@github.com/a/b.git", "ssh://git@github.com/a/b.git", false},
		{"see https://u:p@host", "see https://u:p@host", false},
		{"", "", false},
		{"https://u:p@", "https://", true},
	}
	for _, c := range cases {
		got, changed := StripUserinfo(c.in)
		if got != c.want || changed != c.changed {
			t.Errorf("StripUserinfo(%q) = %q, %v; want %q, %v", c.in, got, changed, c.want, c.changed)
		}
	}
}

func TestStripJSON_NestedKeysArraysAndNumbers(t *testing.T) {
	in := `{
  "text": {"apiKey": "sk-abc", "model": "gpt", "baseUrl": "https://api.example.com"},
  "autocomplete": {"apiKey": "sk-2", "maxTokens": 30},
  "cli": {"token": "t", "tokens": ["a", "b"], "nested": {"MyPassword": "p", "passwd": "q", "secret_x": {"deep": "s", "n": 1, "ok": true}}},
  "vision": {"apiKey": ""},
  "voice": {"api_key": "k1", "api-key": "k2"},
  "scraps": {"gitRemoteUrl": "https://user:pw@github.com/a/b.git", "other": "https://github.com/a/b.git", "ssh": "git@github.com:a/b.git", "tok": "https://ghp_x@github.com/a/b"},
  "flags": {"useToken": true, "tokenLimit": 5, "note": null, "list": [{"secret": "x"}, "plain"]}
}`
	want := `{
  "text": {"apiKey": "", "model": "gpt", "baseUrl": "https://api.example.com"},
  "autocomplete": {"apiKey": "", "maxTokens": 30},
  "cli": {"token": "", "tokens": ["", ""], "nested": {"MyPassword": "", "passwd": "", "secret_x": {"deep": "", "n": 1, "ok": true}}},
  "vision": {"apiKey": ""},
  "voice": {"api_key": "", "api-key": ""},
  "scraps": {"gitRemoteUrl": "https://github.com/a/b.git", "other": "https://github.com/a/b.git", "ssh": "git@github.com:a/b.git", "tok": "https://github.com/a/b"},
  "flags": {"useToken": true, "tokenLimit": 5, "note": null, "list": [{"secret": ""}, "plain"]}
}`
	out, n, err := StripJSON([]byte(in))
	if err != nil {
		t.Fatal(err)
	}
	if string(out) != want {
		t.Errorf("output mismatch\n got: %s\nwant: %s", out, want)
	}
	if n != 13 {
		t.Errorf("count = %d, want 13 (empty values and numbers do not count)", n)
	}
	if !json.Valid(out) {
		t.Error("output is not valid JSON")
	}
	if c, _ := CountSecrets([]byte(in)); c != n {
		t.Errorf("CountSecrets = %d, StripJSON = %d", c, n)
	}
}

func TestStripJSON_CleanInputComesBackByteForByte(t *testing.T) {
	in := []byte("{\r\n\t\"z\" : 1.0 ,\"a\":{\"n\":1e3,\"s\":\"\\u00e9\\\"\"},\r\n\t\"model\":\"x\",\"maxTokens\":30, \"apiKey\":\"\"}\r\n")
	out, n, err := StripJSON(in)
	if err != nil || n != 0 || !bytes.Equal(out, in) {
		t.Fatalf("clean input changed: n=%d err=%v out=%q", n, err, out)
	}
}

func TestStripJSON_TouchesOnlyTheSecretBytes(t *testing.T) {
	in := "{\r\n\t\"apiKey\" :  \"sk-\\u00e9\\\"x\\\\\" ,\r\n\t\"b\":[1,  2], \"z\":1.50\r\n}"
	want := "{\r\n\t\"apiKey\" :  \"\" ,\r\n\t\"b\":[1,  2], \"z\":1.50\r\n}"
	out, n, err := StripJSON([]byte(in))
	if err != nil || n != 1 || string(out) != want {
		t.Fatalf("got %q (n=%d, err=%v), want %q", out, n, err, want)
	}
}

func TestStripJSON_RootsAndEdges(t *testing.T) {
	for in, want := range map[string]string{
		`"just a string"`:                           `"just a string"`,
		`[{"token":"x"},{"a":"b"}]`:                 `[{"token":""},{"a":"b"}]`,
		`{"a":{"b":{"c":{"apiKey":"deep"}}}}`:       `{"a":{"b":{"c":{"apiKey":""}}}}`,
		`{"secret":{"a":["x",{"b":"y"}]}}`:          `{"secret":{"a":["",{"b":""}]}}`,
		`{"url":"https://u:p@h/x","apiKey":"a\"b"}`: `{"url":"https://h/x","apiKey":""}`,
	} {
		out, _, err := StripJSON([]byte(in))
		if err != nil || string(out) != want {
			t.Errorf("StripJSON(%s) = %s, %v; want %s", in, out, err, want)
		}
	}
	bom := append(append([]byte{}, utf8BOM...), []byte(`{"apiKey":"x"}`)...)
	out, n, err := StripJSON(bom)
	if err != nil || n != 1 || !bytes.HasPrefix(out, utf8BOM) || !strings.HasSuffix(string(out), `{"apiKey":""}`) {
		t.Errorf("BOM handling: %q n=%d err=%v", out, n, err)
	}
	for _, bad := range []string{``, `{`, `{"a":}`, `{"a":1} {"b":2}`, `not json`} {
		if _, _, err := StripJSON([]byte(bad)); err == nil {
			t.Errorf("StripJSON(%q) accepted invalid JSON", bad)
		}
	}
}

func TestStripAgents_YAMLEnvKeepsCommentsAndLayout(t *testing.T) {
	in := `# top comment
version: 2
env:
  OPENAI_API_KEY: sk-1234   # inline comment
  LANG: ja_JP.UTF-8
agents:
  claude:
    command: claude
    # env below
    env:
      ANTHROPIC_API_KEY: "sk-ant-xyz"
      GITHUB_TOKEN: 'ghp_abc'
      DEBUG: "1"
      PIN_PASSWORD: 12345
      EMPTY_SECRET: ""
      NULL_TOKEN:
    args: ["--x", "{instruction}"]   # keep
  other:
    command: x
    args: ["--api-key-file", "k.txt"]
`
	want := strings.NewReplacer(
		"sk-1234", `""`, `"sk-ant-xyz"`, `""`, `'ghp_abc'`, `""`, "12345", `""`,
	).Replace(in)
	out, n, warned := StripAgents([]byte(in), "agents.yaml")
	if string(out) != want || n != 4 || warned {
		t.Fatalf("n=%d warned=%v\n--- got\n%s\n--- want\n%s", n, warned, out, want)
	}
	if !strings.Contains(string(out), "# top comment") || !strings.Contains(string(out), "# inline comment") || !strings.Contains(string(out), "# env below") {
		t.Error("comments were lost")
	}
}

func TestStripAgents_YAMLOddLayouts(t *testing.T) {
	cases := map[string][2]string{
		"flow mapping":        {"env: {A_TOKEN: abc, B: c}\n", "env: {A_TOKEN: \"\", B: c}\n"},
		"crlf":                {"env:\r\n  A_TOKEN: abc\r\n  B: c\r\n", "env:\r\n  A_TOKEN: \"\"\r\n  B: c\r\n"},
		"multibyte before":    {"env:\r\n  API_KEY_日本語: \"值段\"\r\n", "env:\r\n  API_KEY_日本語: \"\"\r\n"},
		"escaped dquote":      {"env:\n  A_TOKEN: \"a\\\"b # not a comment\"\n", "env:\n  A_TOKEN: \"\"\n"},
		"squote with quote":   {"env:\n  A_TOKEN: 'it''s'\n", "env:\n  A_TOKEN: \"\"\n"},
		"url with userinfo":   {"env:\n  REMOTE: https://u:p@host/x\n", "env:\n  REMOTE: \"\"\n"},
		"secret container":    {"env:\n  MY_SECRETS:\n    a: x\n    b: [y, z]\n", "env:\n  MY_SECRETS:\n    a: \"\"\n    b: [\"\", \"\"]\n"},
		"no trailing newline": {"env:\n  A_TOKEN: abc", "env:\n  A_TOKEN: \"\""},
	}
	for name, c := range cases {
		out, n, warned := StripAgents([]byte(c[0]), "agents.yaml")
		if string(out) != c[1] || n == 0 || warned {
			t.Errorf("%s: got %q (n=%d warned=%v), want %q", name, out, n, warned, c[1])
		}
	}
}

func TestStripAgents_NothingToStripIsUntouched(t *testing.T) {
	for name, in := range map[string]string{
		"no env":             "version: 2\nagents:\n  a:\n    command: x\n    args: [\"--token\", \"abc\"]  # args are not env\n",
		"env without keys":   "env:\n  LANG: ja\n  EMPTY_TOKEN: \"\"\n  NULL_TOKEN:\n",
		"secret outside env": "api_key: abc\nagents:\n  a:\n    command: x\n",
		"empty":              "",
		"not yaml":           "just: [unclosed",
	} {
		out, n, warned := StripAgents([]byte(in), "agents.yaml")
		if string(out) != in || n != 0 || warned {
			t.Errorf("%s: changed or warned: %q n=%d warned=%v", name, out, n, warned)
		}
	}
}

func TestStripAgents_UnreliableCasesAreLeftAloneAndFlagged(t *testing.T) {
	for name, in := range map[string]string{
		"block scalar":    "env:\n  A_TOKEN: |\n    abc\n",
		"folded scalar":   "env:\n  A_TOKEN: >\n    abc\n",
		"tagged":          "env:\n  A_TOKEN: !!str abc\n",
		"anchored":        "env:\n  A_TOKEN: &t abc\n",
		"multiline plain": "env:\n  A_TOKEN: abc\n    def\n",
		"alias env":       "base: &b\n  A_TOKEN: abc\nagents:\n  x:\n    env: *b\n",
		"list form":       "env:\n  - GITHUB_TOKEN=abc\n  - LANG=ja\n",
	} {
		out, n, warned := StripAgents([]byte(in), "agents.yaml")
		if string(out) != in {
			t.Errorf("%s: unreliable file was modified: %q", name, out)
		}
		if !warned || n != 0 {
			t.Errorf("%s: warned=%v n=%d, want warned and nothing stripped", name, warned, n)
		}
	}
}

// Half-stripped output would look safe while still leaking, so an unhandled secret refuses the
// whole file rather than editing the neighbours.
func TestStripAgents_OneUnhandledSecretRefusesTheWholeFile(t *testing.T) {
	in := "env:\n  A_TOKEN: abc\n  B_SECRET: |\n    multi\n"
	out, n, warned := StripAgents([]byte(in), "agents.yaml")
	if string(out) != in || n != 0 || !warned {
		t.Fatalf("got %q n=%d warned=%v; want the file untouched and flagged", out, n, warned)
	}
}

func TestStripAgents_JSON(t *testing.T) {
	in := "{\n  \"version\": 2,\n  \"agents\": {\n    \"a\": {\n      \"command\": \"x\",\n      \"env\": {\"API_KEY\": \"k\", \"N\": \"v\", \"PIN_TOKEN\": 123, \"REMOTE\": \"https://u:p@h/x\"}\n    },\n    \"b\": {\"args\": [\"--token\", \"abc\"]}\n  }\n}\n"
	want := "{\n  \"version\": 2,\n  \"agents\": {\n    \"a\": {\n      \"command\": \"x\",\n      \"env\": {\"API_KEY\": \"\", \"N\": \"v\", \"PIN_TOKEN\": \"\", \"REMOTE\": \"\"}\n    },\n    \"b\": {\"args\": [\"--token\", \"abc\"]}\n  }\n}\n"
	for _, name := range []string{"agents.json", "agents.yaml"} {
		out, n, warned := StripAgents([]byte(in), name)
		if string(out) != want || n != 3 || warned {
			t.Errorf("%s: got %q (n=%d warned=%v)", name, out, n, warned)
		}
	}
	clean := []byte(`{"version":2,"agents":{"a":{"env":{"LANG":"ja"}}}}`)
	if out, n, _ := StripAgents(clean, "agents.json"); !bytes.Equal(out, clean) || n != 0 {
		t.Error("clean JSON agents file was modified")
	}
}

func TestStripAgents_MarkdownFencedBlocks(t *testing.T) {
	in := "# Agents\n\nSome prose with `A_TOKEN: abc` inline.\n\n```yaml\nversion: 2\nenv:\n  A_TOKEN: abc\n```\n\n```bash\nexport A_TOKEN=abc\n```\n\n```json\n{\"env\": {\"B_SECRET\": \"s\"}}\n```\n\ntail\n"
	want := "# Agents\n\nSome prose with `A_TOKEN: abc` inline.\n\n```yaml\nversion: 2\nenv:\n  A_TOKEN: \"\"\n```\n\n```bash\nexport A_TOKEN=abc\n```\n\n```json\n{\"env\": {\"B_SECRET\": \"\"}}\n```\n\ntail\n"
	out, n, warned := StripAgents([]byte(in), "agents.md")
	if string(out) != want || n != 2 || warned {
		t.Fatalf("got %q (n=%d warned=%v)\nwant %q", out, n, warned, want)
	}
	for _, plain := range []string{"# Agents\n\nno fences here\n", "# Title\nenv:\n  A_TOKEN: abc\n"} {
		if out, n, _ := StripAgents([]byte(plain), "agents.md"); string(out) != plain || n != 0 {
			t.Errorf("markdown outside a fenced block was modified: %q", out)
		}
	}
}
