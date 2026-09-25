package cli

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"sync/atomic"
	"testing"

	"md-memo/pkg/ipc"
)

const japaneseNote = "日本語のメモ\n- [ ] タスク：牛乳を買う\n😀 絵文字と結合文字 é\n"

func TestWriteFileAtomic(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "note.md")

	if err := writeFileAtomic(path, []byte("first")); err != nil {
		t.Fatal(err)
	}
	if got, _ := os.ReadFile(path); string(got) != "first" {
		t.Errorf("new file = %q", got)
	}

	if err := writeFileAtomic(path, []byte(japaneseNote)); err != nil {
		t.Fatal(err)
	}
	if got, _ := os.ReadFile(path); string(got) != japaneseNote {
		t.Errorf("replaced file = %q", got)
	}

	if err := writeFileAtomic(path, nil); err != nil {
		t.Fatal(err)
	}
	if fi, err := os.Stat(path); err != nil || fi.Size() != 0 {
		t.Errorf("an empty note must give an empty file (stat %v, err %v)", fi, err)
	}

	// Only the target is left: the temp file was renamed away.
	entries, _ := os.ReadDir(dir)
	if len(entries) != 1 || entries[0].Name() != "note.md" {
		t.Errorf("folder holds %v, want just note.md", entries)
	}
}

func TestWriteFileAtomicFailureLeavesNothingBehind(t *testing.T) {
	dir := t.TempDir()
	// The target is a folder, so the rename must fail; the temp file must not stay.
	target := filepath.Join(dir, "taken")
	if err := os.Mkdir(target, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := writeFileAtomic(target, []byte("x")); err == nil {
		t.Fatal("renaming a file over a folder should fail")
	}
	entries, _ := os.ReadDir(dir)
	if len(entries) != 1 || entries[0].Name() != "taken" {
		t.Errorf("folder holds %v, want just the folder", entries)
	}
}

func TestWriteFileAtomicKeepsThePermissionsOfAnExistingFile(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("permission bits are not meaningful on Windows")
	}
	path := filepath.Join(t.TempDir(), "note.md")
	if err := os.WriteFile(path, []byte("old"), 0o640); err != nil {
		t.Fatal(err)
	}
	if err := writeFileAtomic(path, []byte("new")); err != nil {
		t.Fatal(err)
	}
	if fi, _ := os.Stat(path); fi.Mode().Perm() != 0o640 {
		t.Errorf("mode = %v, want 0640", fi.Mode().Perm())
	}
	fresh := filepath.Join(t.TempDir(), "fresh.md")
	if err := writeFileAtomic(fresh, []byte("x")); err != nil {
		t.Fatal(err)
	}
	if fi, _ := os.Stat(fresh); fi.Mode().Perm() != 0o644 {
		t.Errorf("new file mode = %v, want 0644", fi.Mode().Perm())
	}
}

func TestResolveOutPath(t *testing.T) {
	dir := t.TempDir()
	t.Chdir(dir)

	got, err := resolveOutPath("out.md")
	if err != nil {
		t.Fatal(err)
	}
	if want := filepath.Join(evalSymlinks(t, dir), "out.md"); evalSymlinks(t, filepath.Dir(got)) != filepath.Dir(want) || filepath.Base(got) != "out.md" {
		t.Errorf("relative path resolved to %q, want it inside the working directory %q", got, dir)
	}
	if !filepath.IsAbs(got) {
		t.Errorf("%q is not absolute", got)
	}

	sub := filepath.Join(dir, "sub")
	if err := os.Mkdir(sub, 0o755); err != nil {
		t.Fatal(err)
	}
	if _, err := resolveOutPath(filepath.Join("sub", "x.md")); err != nil {
		t.Errorf("a file in an existing sub-folder is fine: %v", err)
	}

	if _, err := resolveOutPath(""); err == nil {
		t.Error("an empty path must be refused")
	}
	if _, err := resolveOutPath("sub"); err == nil || !strings.Contains(err.Error(), "folder") {
		t.Errorf("a directory must be refused, got %v", err)
	}
	if _, err := resolveOutPath("."); err == nil {
		t.Error(". is a directory and must be refused")
	}
	if _, err := resolveOutPath(filepath.Join("missing", "x.md")); err == nil || !strings.Contains(err.Error(), "does not exist") {
		t.Errorf("a missing parent folder must be refused, got %v", err)
	}
	if exists(filepath.Join(dir, "missing")) {
		t.Error("no folder may be created for the user")
	}
}

func evalSymlinks(t *testing.T, p string) string {
	t.Helper()
	r, err := filepath.EvalSymlinks(p)
	if err != nil {
		t.Fatal(err)
	}
	return r
}

// bufferPeer starts a fake app that serves one note and one selection and counts the calls.
func bufferPeer(t *testing.T, note ipc.BufferInfo, sel *ipc.SelectionInfo) (*ipc.SessionInfo, *int32, *atomic.Value) {
	t.Helper()
	var calls int32
	var lastTab atomic.Value
	session := startFakeRPCPeer(t, func(method string, params json.RawMessage) (interface{}, *ipc.RPCError) {
		atomic.AddInt32(&calls, 1)
		var p struct {
			TabID string `json:"tab_id"`
		}
		_ = json.Unmarshal(params, &p)
		lastTab.Store(p.TabID)
		switch method {
		case "buffer.get":
			return note, nil
		case "buffer.get_selection":
			if sel == nil {
				return nil, &ipc.RPCError{Code: ipc.ErrCodeNoSelection, Message: "no active selection"}
			}
			return *sel, nil
		}
		return nil, &ipc.RPCError{Code: ipc.ErrCodeMethodNotFound, Message: method}
	})
	return session, &calls, &lastTab
}

func runBufferGet(t *testing.T, session *ipc.SessionInfo, args ...string) (stdout string, code int, err error) {
	t.Helper()
	var out, errOut bytes.Buffer
	code, err = NewClientRunner(session, &out, &errOut).Run(append([]string{"buffer", "get"}, args...))
	return out.String(), code, err
}

func TestBufferGetOutWritesUTF8ExactlyAndPrintsMetadata(t *testing.T) {
	dir := t.TempDir()
	t.Chdir(dir)
	session, _, lastTab := bufferPeer(t, ipc.BufferInfo{Content: japaneseNote, Hash: "0123456789abcdef", Generation: 7}, nil)

	stdout, code, err := runBufferGet(t, session, "--out", "note.md", "--tab", "3", "--json")
	if err != nil || code != 0 {
		t.Fatalf("code %d, err %v", code, err)
	}
	data, err := os.ReadFile("note.md")
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(data, []byte(japaneseNote)) {
		t.Errorf("file = %q, want the note byte for byte", data)
	}
	if bytes.HasPrefix(data, utf8BOM) {
		t.Error("no byte order mark unless --bom is given")
	}
	if got, _ := lastTab.Load().(string); got != "3" {
		t.Errorf("--tab was not forwarded (got %q)", got)
	}

	var res map[string]interface{}
	if err := json.Unmarshal([]byte(stdout), &res); err != nil {
		t.Fatalf("stdout is not JSON: %q", stdout)
	}
	if strings.Contains(stdout, "日本語") {
		t.Errorf("the content must not be printed, only its metadata: %q", stdout)
	}
	if !filepath.IsAbs(res["path"].(string)) || filepath.Base(res["path"].(string)) != "note.md" {
		t.Errorf("path = %v", res["path"])
	}
	if int(res["bytes"].(float64)) != len(japaneseNote) {
		t.Errorf("bytes = %v, want %d", res["bytes"], len(japaneseNote))
	}
	if res["hash"] != "0123456789abcdef" || res["generation"].(float64) != 7 {
		t.Errorf("hash/generation = %v / %v", res["hash"], res["generation"])
	}
}

func TestBufferGetOutBOM(t *testing.T) {
	dir := t.TempDir()
	t.Chdir(dir)
	session, _, _ := bufferPeer(t, ipc.BufferInfo{Content: "あ", Hash: "h"}, nil)

	stdout, _, err := runBufferGet(t, session, "--out", "bom.md", "--bom", "--json")
	if err != nil {
		t.Fatal(err)
	}
	data, _ := os.ReadFile("bom.md")
	if want := append(append([]byte{}, utf8BOM...), []byte("あ")...); !bytes.Equal(data, want) {
		t.Errorf("file = % x, want % x", data, want)
	}
	var res struct{ Bytes int }
	_ = json.Unmarshal([]byte(stdout), &res)
	if res.Bytes != len(data) {
		t.Errorf("bytes = %d, want the size of the file (%d, BOM included)", res.Bytes, len(data))
	}
}

func TestBufferGetOutSelection(t *testing.T) {
	dir := t.TempDir()
	t.Chdir(dir)
	session, _, _ := bufferPeer(t, ipc.BufferInfo{Content: "whole note", Hash: "wholehash"},
		&ipc.SelectionInfo{Text: "選択した部分", Start: 2, End: 8})

	stdout, _, err := runBufferGet(t, session, "--selection", "--out", "sel.md", "--json")
	if err != nil {
		t.Fatal(err)
	}
	if data, _ := os.ReadFile("sel.md"); string(data) != "選択した部分" {
		t.Errorf("file = %q, want only the selection", data)
	}
	var res map[string]interface{}
	_ = json.Unmarshal([]byte(stdout), &res)
	if !regexp.MustCompile(`^[0-9a-f]{16}$`).MatchString(res["hash"].(string)) || res["hash"] == "wholehash" {
		t.Errorf("hash = %v, want the 16-hex hash of the selected text", res["hash"])
	}
	if res["hash"] != contentHash("選択した部分") {
		t.Errorf("hash = %v, want %s", res["hash"], contentHash("選択した部分"))
	}
	if _, has := res["generation"]; has {
		t.Errorf("a selection has no generation: %v", res)
	}
}

func TestBufferGetOutTextIsOneLine(t *testing.T) {
	dir := t.TempDir()
	t.Chdir(dir)
	session, _, _ := bufferPeer(t, ipc.BufferInfo{Content: "abc", Hash: "feedface"}, nil)
	stdout, _, err := runBufferGet(t, session, "--out", "a.md", "--text")
	if err != nil {
		t.Fatal(err)
	}
	if strings.Count(stdout, "\n") != 1 || !strings.HasPrefix(stdout, "Wrote 3 bytes to ") || !strings.Contains(stdout, "a.md") || !strings.Contains(stdout, "feedface") {
		t.Errorf("text output = %q", stdout)
	}
}

func TestBufferGetOutReplacesAnExistingFile(t *testing.T) {
	dir := t.TempDir()
	t.Chdir(dir)
	if err := os.WriteFile("note.md", []byte("old content that is longer"), 0o644); err != nil {
		t.Fatal(err)
	}
	session, _, _ := bufferPeer(t, ipc.BufferInfo{Content: "new", Hash: "h"}, nil)
	if _, _, err := runBufferGet(t, session, "--out", "note.md", "--json"); err != nil {
		t.Fatal(err)
	}
	if data, _ := os.ReadFile("note.md"); string(data) != "new" {
		t.Errorf("file = %q", data)
	}
	if entries, _ := os.ReadDir(dir); len(entries) != 1 {
		t.Errorf("stray files left in the folder: %v", entries)
	}
}

func TestBufferGetOutRefusesBadPathsBeforeCallingTheApp(t *testing.T) {
	dir := t.TempDir()
	t.Chdir(dir)
	if err := os.Mkdir("adir", 0o755); err != nil {
		t.Fatal(err)
	}
	session, calls, _ := bufferPeer(t, ipc.BufferInfo{Content: "x", Hash: "h"}, nil)

	for _, args := range [][]string{
		{"--out", "adir"},
		{"--out", filepath.Join("nope", "x.md")},
		{"--out", ""},
		{"--bom"}, // --bom without --out
	} {
		if _, code, err := runBufferGet(t, session, args...); err == nil || code != 1 {
			t.Errorf("%v: expected exit 1 and an error, got code %d, err %v", args, code, err)
		}
	}
	if n := atomic.LoadInt32(calls); n != 0 {
		t.Errorf("the app was asked %d time(s); a bad --out must fail before that", n)
	}
	if exists(filepath.Join(dir, "nope")) {
		t.Error("no folder may be created")
	}
}

func TestBufferGetOutNoSelectionWritesNothing(t *testing.T) {
	dir := t.TempDir()
	t.Chdir(dir)
	session, _, _ := bufferPeer(t, ipc.BufferInfo{Content: "x", Hash: "h"}, nil) // no selection
	_, code, err := runBufferGet(t, session, "--selection", "--out", "sel.md")
	if code != 1 || err == nil || err.Error() != "no active selection" {
		t.Errorf("code %d, err %v", code, err)
	}
	if exists("sel.md") {
		t.Error("a failed read must not leave a file behind")
	}
}

// Without --out the command prints the note as before; --bom alone is an error rather than a no-op.
func TestBufferGetWithoutOutIsUnchanged(t *testing.T) {
	session, _, _ := bufferPeer(t, ipc.BufferInfo{Content: "plain text", Hash: "h"}, nil)
	stdout, code, err := runBufferGet(t, session, "--text")
	if err != nil || code != 0 || stdout != "plain text" {
		t.Errorf("stdout %q, code %d, err %v", stdout, code, err)
	}
}
