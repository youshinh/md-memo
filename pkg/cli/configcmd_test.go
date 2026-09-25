package cli

import (
	"encoding/json"
	"os"
	"reflect"
	"strings"
	"testing"
)

// hostileConfig has a secret of every kind config.json can hold: each apiKey the Settings screen
// writes, the Discord bot token, credentials inside URLs (git remote, a database URL in an agent's
// env, a key in a query string), and secrets under keys that only sound secret by an ancestor.
const hostileConfig = `{
  "general": {"autoSave": true, "theme": "dark"},
  "text":          {"baseUrl": "https://api.example.com/v1", "model": "m", "apiKey": "sk-TEXT-AAAA1111"},
  "autocomplete":  {"apiKey": "sk-AUTO-BBBB2222", "maxTokens": 256},
  "vision":        {"apiKey": "sk-VISION-CCCC3333", "baseUrl": "https://v.example.com/x?key=QUERYKEY-DDDD4444&alt=json", "model": "vm"},
  "voice":         {"apiKey": "", "model": "whisper"},
  "cli":           {"apiKey": "sk-CLI-EEEE5555"},
  "action":        {"apiKey": "sk-ACTION-FFFF6666"},
  "image":         {"apiKey": "sk-IMAGE-GGGG7777"},
  "discordBridge": {"enabled": true, "botToken": "MTIzNDU2.DISCORD-TOKEN-HHHH8888", "allowedUserIds": ["1", "2"]},
  "scraps": {
    "scrapDir": "~/scraps",
    "gitRemoteUrl": "https://gituser:GITPASS-IIII9999@github.com/me/notes.git",
    "gitRemote": "https://ghp_GHTOKEN-JJJJ0000@github.com/me/notes.git"
  },
  "agents": [{"name": "a", "env": {"OPENAI_API_KEY": "sk-ENV-KKKK1111", "DB_URL": "postgres://user:DBPASS-LLLL2222@db.example.com/x", "MODE": "fast"}}],
  "secrets": {"anything": "NESTED-MMMM3333", "list": ["ARR-NNNN4444", ""], "count": 3, "on": true},
  "nested": {"password": {"deep": {"deeper": "DEEP-OOOO5555"}}},
  "note": "the word token inside a value is fine",
  "sshRemote": "ssh://git@github.com/me/notes.git",
  "scpRemote": "git@github.com:me/notes.git",
  "a.b": {"c": 1}, "a": {"b": 2}
}`

// Every one of these is (a fragment of) a secret in hostileConfig; none may reach the output.
var hostileFragments = []string{
	"TEXT-AAAA", "AAAA1111", "AUTO-BBBB", "BBBB2222", "VISION-CCCC", "CCCC3333", "QUERYKEY", "DDDD4444",
	"CLI-EEEE", "EEEE5555", "ACTION-FFFF", "FFFF6666", "IMAGE-GGGG", "GGGG7777", "DISCORD-TOKEN", "HHHH8888",
	"MTIzNDU2", "GITPASS", "IIII9999", "GHTOKEN", "JJJJ0000", "ghp_", "ENV-KKKK", "KKKK1111",
	"DBPASS", "LLLL2222", "NESTED-MMMM", "MMMM3333", "ARR-NNNN", "NNNN4444", "DEEP-OOOO", "OOOO5555", "sk-",
}

func configGet(t *testing.T, args ...string) (stdout string, code int, err error) {
	t.Helper()
	out, _, code, err := runHeadless(t, append([]string{"config", "get"}, args...)...)
	return out, code, err
}

func TestConfigGetPrintsNoSecretAtAll(t *testing.T) {
	withTempHome(t)
	writeConfigFile(t, hostileConfig)

	for _, mode := range [][]string{{"--json"}, {"--text"}, {}} {
		out, code, err := configGet(t, mode...)
		if err != nil || code != 0 {
			t.Fatalf("%v: code %d err %v", mode, code, err)
		}
		for _, frag := range hostileFragments {
			if strings.Contains(out, frag) {
				t.Errorf("%v: the output contains %q:\n%s", mode, frag, out)
			}
		}
		if strings.Contains(out, `\u003c`) {
			t.Errorf("%v: the markers must not be HTML-escaped:\n%s", mode, out)
		}
	}

	out, _, _ := configGet(t, "--json")
	var doc map[string]interface{}
	mustJSON(t, out, &doc)
	get := func(path ...string) interface{} {
		var cur interface{} = doc
		for _, p := range path {
			switch c := cur.(type) {
			case map[string]interface{}:
				cur = c[p]
			case []interface{}:
				cur = c[0]
			}
		}
		return cur
	}

	// A value that is set shows "<set>", an empty one "<unset>", for every key the app writes.
	for _, path := range [][]string{{"text", "apiKey"}, {"autocomplete", "apiKey"}, {"vision", "apiKey"},
		{"cli", "apiKey"}, {"action", "apiKey"}, {"image", "apiKey"}, {"discordBridge", "botToken"},
		{"agents", "0", "env", "OPENAI_API_KEY"}, {"secrets", "anything"}, {"nested", "password", "deep", "deeper"}} {
		if got := get(path...); got != "<set>" {
			t.Errorf("%v = %v, want <set>", path, got)
		}
	}
	if got := get("voice", "apiKey"); got != "<unset>" {
		t.Errorf("an empty api key is <unset>, got %v", got)
	}
	if got := get("secrets", "list"); !reflect.DeepEqual(got, []interface{}{"<set>", "<unset>"}) {
		t.Errorf("every string of a secret list is hidden, got %v", got)
	}

	// Credentials inside URLs are removed; the rest of the URL stays.
	for path, want := range map[string]string{
		"scraps.gitRemoteUrl": "https://github.com/me/notes.git",
		"scraps.gitRemote":    "https://github.com/me/notes.git",
	} {
		if got := lookupOrFail(t, doc, path); got != want {
			t.Errorf("%s = %v, want %s", path, got, want)
		}
	}
	if got := get("vision", "baseUrl"); got != "https://v.example.com/x?key=<set>&alt=json" {
		t.Errorf("query key = %v", got)
	}
	if got := get("agents", "0", "env", "DB_URL"); got != "postgres://db.example.com/x" {
		t.Errorf("db url = %v", got)
	}

	// Everything that is not a secret survives untouched: numbers, booleans, plain strings, and
	// identities that are not credentials (ssh://git@host, git@host:path).
	if got := get("autocomplete", "maxTokens"); got != float64(256) {
		t.Errorf("maxTokens = %v (%T): a number below a secret-sounding key is a setting", got, got)
	}
	if got := get("secrets", "count"); got != float64(3) {
		t.Errorf("secrets.count = %v", got)
	}
	if got := get("secrets", "on"); got != true {
		t.Errorf("secrets.on = %v", got)
	}
	for path, want := range map[string]interface{}{
		"general.autoSave": true, "general.theme": "dark", "text.model": "m", "text.baseUrl": "https://api.example.com/v1",
		"discordBridge.enabled": true, "note": "the word token inside a value is fine",
		"sshRemote": "ssh://git@github.com/me/notes.git", "scpRemote": "git@github.com:me/notes.git",
		"agents.0.env.MODE": "fast", "agents.0.name": "a",
	} {
		if got := lookupOrFail(t, doc, path); got != want {
			t.Errorf("%s = %v, want %v", path, got, want)
		}
	}
	if !reflect.DeepEqual(lookupOrFail(t, doc, "discordBridge.allowedUserIds"), []interface{}{"1", "2"}) {
		t.Error("allowedUserIds is not a secret and must stay")
	}
}

// lookupOrFail walks a parsed document with the command's own path rules.
func lookupOrFail(t *testing.T, doc map[string]interface{}, path string) interface{} {
	t.Helper()
	v, ok := lookupConfigPath(doc, path)
	if !ok {
		t.Fatalf("no such key: %s", path)
	}
	return v
}

func TestConfigGetKeyPaths(t *testing.T) {
	withTempHome(t)
	writeConfigFile(t, hostileConfig)

	cases := []struct {
		args []string
		want string // the exact stdout
	}{
		{[]string{"text.apiKey", "--json"}, "\"<set>\"\n"},
		{[]string{"--json", "text.apiKey"}, "\"<set>\"\n"},
		{[]string{"text.apiKey", "--text"}, "<set>\n"},
		{[]string{"voice.apiKey", "--text"}, "<unset>\n"},
		{[]string{"general.autoSave", "--json"}, "true\n"},
		{[]string{"general.autoSave", "--text"}, "true\n"},
		{[]string{"autocomplete.maxTokens", "--text"}, "256\n"},
		{[]string{"autocomplete.maxTokens", "--json"}, "256\n"},
		{[]string{"general.theme", "--text"}, "dark\n"},
		{[]string{"general.theme", "--json"}, "\"dark\"\n"},
		{[]string{"agents.0.name", "--text"}, "a\n"},
		{[]string{"agents.0.env.OPENAI_API_KEY", "--text"}, "<set>\n"},
		{[]string{"secrets.list.1", "--text"}, "<unset>\n"},
		{[]string{"nested.password.deep.deeper", "--text"}, "<set>\n"}, // secret through an ancestor's name
		{[]string{"a.b", "--text"}, "2\n"},                             // a key "a" holding "b" wins ...
		{[]string{"a.b.c", "--text"}, "1\n"},                           // ... until only the key "a.b" fits
	}
	for _, c := range cases {
		out, code, err := configGet(t, c.args...)
		if err != nil || code != 0 || out != c.want {
			t.Errorf("config get %v = %q (code %d err %v), want %q", c.args, out, code, err, c.want)
		}
	}

	// An object is pretty JSON in every mode, with its secrets hidden.
	for _, mode := range []string{"--json", "--text"} {
		out, _, _ := configGet(t, "vision", mode)
		var v map[string]interface{}
		mustJSON(t, out, &v)
		if v["apiKey"] != "<set>" || v["model"] != "vm" {
			t.Errorf("config get vision %s = %v", mode, v)
		}
		if !strings.Contains(out, "\n  \"apiKey\": \"<set>\"") {
			t.Errorf("expected indented JSON, got %q", out)
		}
	}
	out, _, _ := configGet(t, "discordBridge", "--json")
	if strings.Contains(out, "HHHH") || !strings.Contains(out, `"botToken": "<set>"`) {
		t.Errorf("discordBridge = %s", out)
	}

	// Unknown paths, and paths that walk into a scalar.
	for _, p := range []string{"nope", "text.nope", "text.apiKey.x", "agents.5", "agents.x", "general.autoSave.x", ".", "text.", ".text", "a..b"} {
		_, code, err := configGet(t, p)
		if code != 1 || err == nil || !strings.HasPrefix(err.Error(), "no such key") {
			t.Errorf("config get %q: code %d err %v, want exit 1 with \"no such key\"", p, code, err)
		}
	}
}

func TestConfigGetMissingAndBrokenFiles(t *testing.T) {
	withTempHome(t)

	// No config.json: nothing is configured, which is a fact, not an error.
	out, code, err := configGet(t, "--json")
	if err != nil || code != 0 || strings.TrimSpace(out) != "{}" {
		t.Errorf("no file: code %d err %v out %q, want {}", code, err, out)
	}
	if _, code, err := configGet(t, "text.apiKey"); code != 1 || err == nil {
		t.Errorf("a key of a missing file is not found: code %d err %v", code, err)
	}

	// A file that is not valid JSON is an error, never "{}" (an agent would think nothing is set),
	// and the error must not echo the file.
	writeConfigFile(t, `{"text": {"apiKey": "SECRETVALUE-ZZZZ"}, `)
	out, code, err = configGet(t)
	if code != 1 || err == nil || out != "" {
		t.Fatalf("broken file: code %d err %v out %q", code, err, out)
	}
	if strings.Contains(err.Error(), "SECRETVALUE") || !strings.Contains(err.Error(), "config.json") {
		t.Errorf("error = %q", err)
	}
	writeConfigFile(t, `["not", "an", "object"]`)
	if _, code, err := configGet(t); code != 1 || err == nil {
		t.Errorf("a top-level array: code %d err %v", code, err)
	}

	// A byte order mark, as some editors write it, is fine.
	writeConfigFile(t, "\xEF\xBB\xBF"+`{"text": {"apiKey": "BOMSECRET"}, "general": {"autoSave": false}}`)
	out, code, err = configGet(t, "--json")
	if err != nil || code != 0 || strings.Contains(out, "BOMSECRET") || !strings.Contains(out, `"autoSave": false`) {
		t.Errorf("BOM file: code %d err %v out %q", code, err, out)
	}
}

func TestConfigGetArgumentsAndActions(t *testing.T) {
	withTempHome(t)
	writeConfigFile(t, `{"a": 1, "b": 2}`)
	if _, code, err := configGet(t, "a", "b"); code != 1 || err == nil {
		t.Errorf("two key paths: code %d err %v", code, err)
	}
	if _, code, err := configGet(t, "--bogus"); code != 1 || err == nil {
		t.Errorf("unknown flag: code %d err %v", code, err)
	}
	for _, args := range [][]string{{"config"}, {"config", "set", "a", "1"}, {"config", "edit"}} {
		if _, _, code, err := runHeadless(t, args...); code != 1 || err == nil {
			t.Errorf("%v: code %d err %v; only get exists", args, code, err)
		}
	}
	out, _, code, err := runHeadless(t, "config", "get", "a", "-h")
	if err != nil || code != 0 || out != SubcommandUsage("config") {
		t.Errorf("-h: code %d err %v out %q", code, err, firstLine(out))
	}
	// An empty path is the whole document.
	if out, _, _ := configGet(t, "", "--json"); !strings.Contains(out, `"a": 1`) {
		t.Errorf("empty path = %q", out)
	}
	// Numbers come out exactly as written.
	writeConfigFile(t, `{"n": 1.50, "big": 12345678901234567890}`)
	if out, _, _ := configGet(t, "--json"); !strings.Contains(out, `"n": 1.50`) || !strings.Contains(out, `12345678901234567890`) {
		t.Errorf("numbers were rewritten: %s", out)
	}
}

// config get never writes: not the settings folder, not config.json.
func TestConfigGetChangesNothing(t *testing.T) {
	withTempHome(t)
	_, _, _ = configGet(t)
	_, _, _ = configGet(t, "text.apiKey")
	if exists(LoadConfig().Dir()) {
		t.Error("config get created the settings folder")
	}
	path := writeConfigFile(t, hostileConfig)
	before := fileBytes(t, path)
	_, _, _ = configGet(t)
	if got := fileBytes(t, path); got != before {
		t.Error("config get rewrote config.json")
	}
}

func fileBytes(t *testing.T, path string) string {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func TestRedactConfigDoesNotMutateItsInput(t *testing.T) {
	c := ParseConfig([]byte(hostileConfig))
	before, _ := json.Marshal(c.Values)
	red := RedactConfig(c.Values)
	after, _ := json.Marshal(c.Values)
	if string(before) != string(after) {
		t.Error("RedactConfig changed its input")
	}
	if b, _ := json.Marshal(red); strings.Contains(string(b), "AAAA1111") {
		t.Error("the copy still holds a secret")
	}
	if got := RedactConfig(nil); got == nil || len(got) != 0 {
		t.Errorf("RedactConfig(nil) = %v, want an empty map", got)
	}
}

func TestRedactURL(t *testing.T) {
	cases := map[string]string{
		"https://user:pw@host/x":                    "https://host/x",
		"https://tokenonly@host/x":                  "https://host/x", // configpack: a bare token@ too
		"http://u:p@host:8080/x?y=1":                "http://host:8080/x?y=1",
		"postgres://user:pw@db/x":                   "postgres://db/x",
		"ftp://a:b@host":                            "ftp://host",
		"ssh://git@github.com/me/x.git":             "ssh://git@github.com/me/x.git",
		"git@github.com:me/x.git":                   "git@github.com:me/x.git",
		"https://host/x?key=SECRET":                 "https://host/x?key=<set>",
		"https://host/x?a=1&api_key=SECRET&b=2":     "https://host/x?a=1&api_key=<set>&b=2",
		"https://host/x?token=S&Access_Token=T":     "https://host/x?token=<set>&Access_Token=<set>",
		"https://host/x?sig=S#frag":                 "https://host/x?sig=<set>#frag",
		"https://host/x?keyword=fine&monkey=1":      "https://host/x?keyword=fine&monkey=1",
		"https://host/x?%6bey=SECRET":               "https://host/x?%6bey=<set>",
		"https://host/x?q=a@b:c":                    "https://host/x?q=a@b:c",
		"https://host/a@b":                          "https://host/a@b",                     // an @ in the path is not userinfo
		"plain text with https://u:p@x inside":      "plain text with https://u:p@x inside", // not URL-shaped: untouched
		"":                                          "",
		"C:/Users/me/notes":                         "C:/Users/me/notes",
		"file:///C:/Users/me/notes":                 "file:///C:/Users/me/notes",
		"https://host/x?empty=&key":                 "https://host/x?empty=&key",
		"HTTPS://user:pw@HOST/x?Key=SECRET":         "HTTPS://HOST/x?Key=<set>",
		"https://user:p@ss@host/x":                  "https://host/x",
		"https://host/x?authorization=Bearer%20abc": "https://host/x?authorization=<set>",
	}
	for in, want := range cases {
		if got := redactURL(in); got != want {
			t.Errorf("redactURL(%q) = %q, want %q", in, got, want)
		}
	}
}
