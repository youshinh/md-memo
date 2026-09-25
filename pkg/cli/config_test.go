package cli

import (
	"path/filepath"
	"testing"

	"md-memo/pkg/appdir"
	"md-memo/pkg/inbox"
	"md-memo/pkg/llm"
	"md-memo/pkg/scrap"
)

func TestParseConfig(t *testing.T) {
	t.Run("empty and missing are defaults without an error", func(t *testing.T) {
		for _, data := range [][]byte{nil, {}, []byte("  \n")} {
			c := ParseConfig(data)
			if c.Err != nil || c.Values == nil || len(c.Values) != 0 {
				t.Errorf("ParseConfig(%q) = %+v", data, c)
			}
		}
	})
	t.Run("invalid JSON and non-objects keep the defaults and say why", func(t *testing.T) {
		for _, data := range []string{"not json", `{"a":`, `[1,2]`, `"text"`, `5`} {
			c := ParseConfig([]byte(data))
			if c.Err == nil {
				t.Errorf("ParseConfig(%q): expected an error", data)
			}
			if len(c.Values) != 0 || c.Values == nil {
				t.Errorf("ParseConfig(%q): Values = %v, want an empty map", data, c.Values)
			}
			if c.ScrapDir() != DefaultScrapDir || !c.AutoSave() || c.InboxEnabled() {
				t.Errorf("ParseConfig(%q): accessors must answer with the defaults", data)
			}
		}
	})
	t.Run("a byte order mark is skipped", func(t *testing.T) {
		c := ParseConfig([]byte("\xEF\xBB\xBF" + `{"general":{"autoSave":false}}`))
		if c.Err != nil || c.AutoSave() {
			t.Errorf("BOM config not read: %+v", c)
		}
	})
	t.Run("numbers are kept exactly as written", func(t *testing.T) {
		c := ParseConfig([]byte(`{"n": 1.50, "big": 12345678901234567890}`))
		if got := c.Values["n"].(interface{ String() string }).String(); got != "1.50" {
			t.Errorf("n = %s", got)
		}
		if got := c.Values["big"].(interface{ String() string }).String(); got != "12345678901234567890" {
			t.Errorf("big = %s", got)
		}
	})
}

func TestConfigScrapDir(t *testing.T) {
	cases := []struct{ name, json, want string }{
		{"default", `{}`, "~/Documents/md-memo/scraps"},
		{"legacy top-level key", `{"scrap_dir":"/legacy"}`, "/legacy"},
		{"the nested key the Settings screen writes", `{"scraps":{"scrapDir":"D:/notes/scraps","gitSyncEnabled":true}}`, "D:/notes/scraps"},
		{"nested wins over legacy", `{"scrap_dir":"/legacy","scraps":{"scrapDir":"/nested"}}`, "/nested"},
		{"empty nested keeps the legacy value", `{"scrap_dir":"/legacy","scraps":{"scrapDir":""}}`, "/legacy"},
		{"empty everywhere keeps the default", `{"scrap_dir":"","scraps":{"scrapDir":""}}`, "~/Documents/md-memo/scraps"},
		{"wrong types are ignored", `{"scrap_dir":5,"scraps":"x"}`, "~/Documents/md-memo/scraps"},
	}
	for _, c := range cases {
		if got := ParseConfig([]byte(c.json)).ScrapDir(); got != c.want {
			t.Errorf("%s: ScrapDir = %q, want %q", c.name, got, c.want)
		}
	}
}

func TestConfigResolvedFolders(t *testing.T) {
	home := withTempHome(t)
	c := ParseConfig([]byte(`{"scraps":{"scrapDir":"~/notes"},"inbox":{"enabled":true,"dir":"~/hot"}}`))
	if got, want := c.ScrapDirResolved(), filepath.Join(home, "notes"); got != want {
		t.Errorf("ScrapDirResolved = %q, want %q", got, want)
	}
	if got, want := c.InboxDir(), filepath.Join(home, "hot"); got != want {
		t.Errorf("InboxDir = %q, want %q", got, want)
	}
	if !c.InboxEnabled() {
		t.Error("inbox.enabled = true was not read")
	}

	d := ParseConfig(nil)
	if got, want := d.ScrapDirResolved(), scrap.ResolveScrapDir(""); got != want {
		t.Errorf("default scrap dir = %q, want %q", got, want)
	}
	if got, want := d.InboxDir(), inbox.ResolveDir(""); got != want {
		t.Errorf("default inbox dir = %q, want %q", got, want)
	}
	if d.InboxEnabled() {
		t.Error("the inbox is off unless config.json says otherwise")
	}
}

func TestConfigAutoSave(t *testing.T) {
	cases := map[string]bool{
		`{}`:                                   true,
		`{"general":{}}`:                       true,
		`{"general":{"autoSave":true}}`:        true,
		`{"general":{"autoSave":false}}`:       false,
		`{"general":{"autoSave":"no"}}`:        true, // a wrong type is not a setting
		`{"general":"x"}`:                      true,
		`{"general":{"autoSave":false},"a":1}`: false,
	}
	for data, want := range cases {
		if got := ParseConfig([]byte(data)).AutoSave(); got != want {
			t.Errorf("%s: AutoSave = %v, want %v", data, got, want)
		}
	}
}

func TestConfigSection(t *testing.T) {
	c := ParseConfig([]byte(`{"vision":{"baseUrl":"https://v","model":"m","apiKey":"k","prompt":"p"},"text":"not an object"}`))
	var v llm.VisionConfig
	c.Section("vision", &v)
	if want := (llm.VisionConfig{BaseURL: "https://v", Model: "m", APIKey: "k", Prompt: "p"}); v != want {
		t.Errorf("vision = %+v, want %+v", v, want)
	}
	var untouched llm.VisionConfig
	c.Section("text", &untouched)    // wrong shape
	c.Section("missing", &untouched) // absent
	if untouched != (llm.VisionConfig{}) {
		t.Errorf("a wrong shape or a missing key must leave the target alone, got %+v", untouched)
	}
}

func TestLoadConfig(t *testing.T) {
	withTempHome(t)

	t.Run("no file is defaults, and nothing is created", func(t *testing.T) {
		c := LoadConfig()
		if c.Exists || c.Err != nil || c.Path != appdir.ConfigFilePath() {
			t.Errorf("LoadConfig() = %+v", c)
		}
		if exists(appdir.AppConfigDir()) {
			t.Error("reading the config must not create the settings folder")
		}
		if c.Dir() != appdir.AppConfigDir() {
			t.Errorf("Dir = %q", c.Dir())
		}
	})

	t.Run("a file is read", func(t *testing.T) {
		writeConfigFile(t, `{"scrap_dir":"/somewhere","general":{"autoSave":false}}`)
		c := LoadConfig()
		if !c.Exists || c.Err != nil || c.ScrapDir() != "/somewhere" || c.AutoSave() {
			t.Errorf("LoadConfig() = %+v", c)
		}
		if string(c.Data) != `{"scrap_dir":"/somewhere","general":{"autoSave":false}}` {
			t.Errorf("Data = %q", c.Data)
		}
	})

	t.Run("an unparsable file is defaults with the reason", func(t *testing.T) {
		writeConfigFile(t, `{"scrap_dir": `)
		c := LoadConfig()
		if !c.Exists || c.Err == nil || c.ScrapDir() != DefaultScrapDir {
			t.Errorf("LoadConfig() = %+v", c)
		}
	})

	t.Run("a folder where config.json should be is an error, not a crash", func(t *testing.T) {
		withTempHome(t)
		writeFile(t, filepath.Join(appdir.ConfigFilePath(), "x"), "")
		c := LoadConfig()
		if c.Err == nil || c.ScrapDir() != DefaultScrapDir {
			t.Errorf("LoadConfig() = %+v", c)
		}
	})
}

// ocr reads its settings through the shared Config; these are the cases it always handled.
func TestOCRConfigRidesOnSharedConfig(t *testing.T) {
	withTempHome(t)
	writeConfigFile(t, `{"scraps":{"scrapDir":"/nested"},"vision":{"baseUrl":"https://v","model":"m","apiKey":"k"}}`)
	got := loadOCRFileConfig()
	if got.ScrapDir != "/nested" || got.Vision.APIKey != "k" || got.Vision.BaseURL != "https://v" || got.Vision.Model != "m" {
		t.Errorf("loadOCRFileConfig() = %+v", got)
	}
	// No file at all: the defaults, as before.
	withTempHome(t)
	if def := loadOCRFileConfig(); def.ScrapDir != DefaultScrapDir || def.Vision != (llm.VisionConfig{}) {
		t.Errorf("loadOCRFileConfig() without a file = %+v", def)
	}
}
