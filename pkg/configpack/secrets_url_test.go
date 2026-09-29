package configpack

import (
	"bytes"
	"strings"
	"testing"
)

// B24: a settings package exported "without keys" used to keep the credential of a base URL that carries it in the query
// (https://host/v1?key=...), although the CLI's `config get` hid the same thing.
func TestStripJSON_QuerySecretsAreBlanked(t *testing.T) {
	in := `{"text":{"baseUrl":"https://h.example/v1?key=K2","apiKey":"sk-x"},"scraps":{"gitRemoteUrl":"https://github.com/a/b.git?token=Q1"},"other":{"u":"https://u:pw@h.example/p?sig=S3&auth=A4&x=1#frag"}}`
	want := `{"text":{"baseUrl":"https://h.example/v1?key=","apiKey":""},"scraps":{"gitRemoteUrl":"https://github.com/a/b.git?token="},"other":{"u":"https://h.example/p?sig=&auth=&x=1#frag"}}`
	out, n, err := StripJSON([]byte(in))
	if err != nil {
		t.Fatal(err)
	}
	if string(out) != want {
		t.Errorf("got  %s\nwant %s", out, want)
	}
	if n != 4 {
		t.Errorf("edits = %d, want 4 (apiKey, key, token, and the one value that had userinfo and two query secrets)", n)
	}
	for _, leak := range []string{"K2", "Q1", "S3", "A4", "sk-x", "pw@"} {
		if strings.Contains(string(out), leak) {
			t.Errorf("%q survived the export", leak)
		}
	}
	// CountSecrets is what the "keys are included" report counts: it must see the same values
	if c, err := CountSecrets([]byte(in)); err != nil || c != 4 {
		t.Errorf("CountSecrets = %d, %v; want 4", c, err)
	}
}

func TestStripJSON_QueryLeavesHarmlessParametersAndBlankOnesAlone(t *testing.T) {
	clean := []byte(`{"a":"https://h.example/v1?alt=json&keyword=fine&monkey=1","b":"https://h.example/v1?key=","c":"https://h.example/v1?empty=&key","d":"not a url ?key=SECRET","e":"ftp://h/x?key=SECRET"}`)
	out, n, err := StripJSON(clean)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(out, clean) || n != 0 {
		t.Errorf("a clean file changed or was counted: n=%d out=%s", n, out)
	}
}

func TestRedactQuerySecrets(t *testing.T) {
	cases := []struct {
		in, repl, want string
		changed        bool
	}{
		{"https://host/x?key=SECRET", "", "https://host/x?key=", true},
		{"https://host/x?key=SECRET", "<set>", "https://host/x?key=<set>", true},
		{"https://host/x?a=1&api_key=SECRET&b=2", "", "https://host/x?a=1&api_key=&b=2", true},
		{"https://host/x?token=S&Access_Token=T", "", "https://host/x?token=&Access_Token=", true},
		{"https://host/x?sig=S#frag", "", "https://host/x?sig=#frag", true},
		{"https://host/x?%6bey=SECRET", "", "https://host/x?%6bey=", true},
		{"HTTPS://host/x?Key=SECRET", "", "HTTPS://host/x?Key=", true},
		{"https://host/x?authorization=Bearer%20abc", "", "https://host/x?authorization=", true},
		{"https://host/x?keyword=fine&monkey=1", "", "https://host/x?keyword=fine&monkey=1", false},
		{"https://host/x?key=", "", "https://host/x?key=", false},
		{"https://host/x?key=<set>", "<set>", "https://host/x?key=<set>", false},
		{"https://host/x?empty=&key", "", "https://host/x?empty=&key", false},
		{"https://host/x#key=SECRET", "", "https://host/x#key=SECRET", false},
		{"https://host/x", "", "https://host/x", false},
		{"file:///C:/x?key=SECRET", "", "file:///C:/x?key=SECRET", false},
		{"plain ?key=SECRET", "", "plain ?key=SECRET", false},
		{"", "", "", false},
	}
	for _, c := range cases {
		got, changed := RedactQuerySecrets(c.in, c.repl)
		if got != c.want || changed != c.changed {
			t.Errorf("RedactQuerySecrets(%q, %q) = %q, %v; want %q, %v", c.in, c.repl, got, changed, c.want, c.changed)
		}
	}
}

func TestStripURLSecrets_UserinfoAndQueryTogether(t *testing.T) {
	got, ok := StripURLSecrets("https://alice:pw@llm.example.com/v1?key=K&alt=json")
	if !ok || got != "https://llm.example.com/v1?key=&alt=json" {
		t.Errorf("got %q, %v", got, ok)
	}
	if got, ok := StripURLSecrets("https://llm.example.com/v1"); ok || got != "https://llm.example.com/v1" {
		t.Errorf("a clean URL changed: %q, %v", got, ok)
	}
}

func TestStripAgents_EnvURLWithQuerySecretIsBlankedWhole(t *testing.T) {
	in := "{\"agents\":{\"a\":{\"env\":{\"BASE\":\"https://h/x?key=abc\",\"OK\":\"https://h/x?alt=json\"}}}}"
	want := "{\"agents\":{\"a\":{\"env\":{\"BASE\":\"\",\"OK\":\"https://h/x?alt=json\"}}}}"
	for _, name := range []string{"agents.json", "agents.yaml"} {
		out, n, warned := StripAgents([]byte(in), name)
		if string(out) != want || n != 1 || warned {
			t.Errorf("%s: got %q (n=%d warned=%v)", name, out, n, warned)
		}
	}
}
