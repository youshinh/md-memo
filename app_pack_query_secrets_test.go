package main

import (
	"strings"
	"testing"

	"md-memo/pkg/configpack"
)

// B24: "Include API keys" off must also remove a key that sits in the QUERY of an address (https://host/v1?key=...), in both
// formats, exactly as `md-memo config get` hides it. With "Include API keys" on, the file is written as it is.
const queryKeyConfig = `{"text":{"apiKey":"sk-secret","baseUrl":"https://h.example/v1?key=K2&alt=json","model":"m"},"scraps":{"gitRemoteUrl":"https://github.com/a/b.git?token=Q1"}}`

func exportedConfig(t *testing.T, e *packEnv, format string, includeSecrets bool) (string, map[string]any) {
	t.Helper()
	sel := e.exportSel(map[string]any{
		"format": format, "includeConfig": true, "includeSecrets": includeSecrets,
		"configSections": []string{"models", "sync"}, "agents": []string{}, "skills": []string{},
	})
	out, err := e.app.PackExport(sel, queryKeyConfig)
	if err != nil {
		t.Fatalf("%s: %v", format, err)
	}
	res := decodeMap(t, out)
	path, _ := res["path"].(string)
	if format == "json" {
		return readFile(t, path), res
	}
	pk, err := configpack.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer pk.Close()
	b, err := pk.ReadConfig()
	if err != nil {
		t.Fatal(err)
	}
	return string(b), res
}

func TestPackExportRemovesKeysInUrlQueries(t *testing.T) {
	for _, format := range []string{"pack", "json"} {
		e := newPackEnv(t)
		cfg, res := exportedConfig(t, e, format, false)
		for _, leak := range []string{"sk-secret", "K2", "Q1"} {
			if strings.Contains(cfg, leak) {
				t.Errorf("[%s] %q is still in the exported file: %s", format, leak, cfg)
			}
		}
		for _, keep := range []string{`"baseUrl":"https://h.example/v1?key=&alt=json"`, `"gitRemoteUrl":"https://github.com/a/b.git?token="`, `"model":"m"`} {
			if !strings.Contains(cfg, keep) {
				t.Errorf("[%s] expected %s in %s", format, keep, cfg)
			}
		}
		if n, _ := res["secretsStripped"].(float64); n != 3 {
			t.Errorf("[%s] secretsStripped = %v, want 3 (apiKey and the two query keys)", format, res["secretsStripped"])
		}
	}
}

func TestPackExportWithKeysLeavesAddressesAsTheyAre(t *testing.T) {
	e := newPackEnv(t)
	cfg, _ := exportedConfig(t, e, "json", true)
	for _, want := range []string{"sk-secret", "key=K2&alt=json", "token=Q1"} {
		if !strings.Contains(cfg, want) {
			t.Errorf("with keys included, %q must stay: %s", want, cfg)
		}
	}
}
