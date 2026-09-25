package cli

import (
	"bytes"
	"encoding/json"
	"errors"
	"os"

	"md-memo/pkg/appdir"
	"md-memo/pkg/inbox"
	"md-memo/pkg/scrap"
)

// Config is the read-only, standalone view of config.json that the commands that run without the
// GUI share (info, ocr, scrap, config get). It never writes, never creates a folder, and never
// needs the running app.
//
// A missing or unreadable file, or one that is not valid JSON, is not an error here: the accessors
// then answer with the defaults (as `ocr` always did), and Err says why for the one command that
// wants to tell the user (config get). Only a JSON object counts as content.
type Config struct {
	// Path is where config.json is (or would be); Exists tells whether a file is there.
	Path   string
	Exists bool
	// Data is the file as read (nil when there is none) and Values its top-level object, parsed with
	// json.Number so a number is shown exactly as written. Values is never nil.
	Data   []byte
	Values map[string]interface{}
	// Err is set when the file exists but could not be read or is not a JSON object.
	Err error
}

// LoadConfig reads config.json from the per-user settings folder (appdir, so tests can redirect it).
func LoadConfig() *Config {
	c := ParseConfig(nil)
	c.Path = appdir.ConfigFilePath()
	if _, err := appdir.ConfigDir(); err != nil {
		// No per-user settings folder on this system: there is nothing to read (the defaults apply),
		// and a relative "./md-memo" must not be mistaken for one.
		return c
	}
	data, err := os.ReadFile(c.Path)
	if err != nil {
		if !errors.Is(err, os.ErrNotExist) {
			c.Err = err
		}
		return c
	}
	parsed := ParseConfig(data)
	parsed.Path = c.Path
	parsed.Exists = true
	return parsed
}

// ParseConfig has no I/O: it is all the parsing, so it can be tested directly. nil or empty data
// is "no file". A UTF-8 byte order mark is skipped.
func ParseConfig(data []byte) *Config {
	c := &Config{Data: data, Values: map[string]interface{}{}}
	body := bytes.TrimPrefix(data, []byte{0xEF, 0xBB, 0xBF})
	if len(bytes.TrimSpace(body)) == 0 {
		return c
	}
	dec := json.NewDecoder(bytes.NewReader(body))
	dec.UseNumber()
	var v interface{}
	if err := dec.Decode(&v); err != nil {
		c.Err = err
		return c
	}
	obj, ok := v.(map[string]interface{})
	if !ok {
		c.Err = errors.New("the top level is not a JSON object")
		return c
	}
	c.Values = obj
	return c
}

// Section decodes the top-level key into out (a struct pointer), the way a typed json.Unmarshal of
// the whole file would. A missing key or a value of the wrong shape leaves out as it was.
func (c *Config) Section(key string, out interface{}) {
	raw, ok := c.Values[key]
	if !ok {
		return
	}
	b, err := json.Marshal(raw)
	if err != nil {
		return
	}
	_ = json.Unmarshal(b, out)
}

// DefaultScrapDir is the scrap folder when config.json names none (~ is expanded later).
const DefaultScrapDir = "~/Documents/md-memo/scraps"

// ScrapDir is the configured scrap folder as written (~ not yet expanded), looked up the way the
// app does (parseScrapConfig in app_scrap.go): the legacy top-level "scrap_dir", overridden by
// "scraps.scrapDir" - the key the Settings screen actually writes. An empty value keeps the default.
func (c *Config) ScrapDir() string {
	dir := DefaultScrapDir
	if v, ok := c.Values["scrap_dir"].(string); ok && v != "" {
		dir = v
	}
	if m, ok := c.Values["scraps"].(map[string]interface{}); ok {
		if v, ok := m["scrapDir"].(string); ok && v != "" {
			dir = v
		}
	}
	return dir
}

// ScrapDirResolved is ScrapDir with ~ expanded: the folder the scraps really live in.
func (c *Config) ScrapDirResolved() string { return scrap.ResolveScrapDir(c.ScrapDir()) }

// InboxEnabled is config.json's inbox.enabled (off by default).
func (c *Config) InboxEnabled() bool {
	m, _ := c.Values["inbox"].(map[string]interface{})
	v, _ := m["enabled"].(bool)
	return v
}

// InboxDir is the hot folder, resolved (the default one when inbox.dir is empty). It is the folder
// whether or not InboxEnabled is true.
func (c *Config) InboxDir() string {
	m, _ := c.Values["inbox"].(map[string]interface{})
	dir, _ := m["dir"].(string)
	return inbox.ResolveDir(dir)
}

// AutoSave is general.autoSave; on unless the file says false (the app's own default).
func (c *Config) AutoSave() bool {
	m, _ := c.Values["general"].(map[string]interface{})
	if v, ok := m["autoSave"].(bool); ok {
		return v
	}
	return true
}

// Dir is the md-memo settings folder (the parent of config.json).
func (c *Config) Dir() string { return appdir.AppConfigDir() }
