//go:build windows

package dialog

import (
	"path/filepath"
	"syscall"
	"unsafe"
)

var (
	comdlg32            = syscall.NewLazyDLL("comdlg32.dll")
	procGetOpenFileName = comdlg32.NewProc("GetOpenFileNameW")
	procGetSaveFileName = comdlg32.NewProc("GetSaveFileNameW")
)

type openFileName struct {
	lStructSize       uint32
	hwndOwner         uintptr
	hInstance         uintptr
	lpstrFilter       *uint16
	lpstrCustomFilter *uint16
	nMaxCustFilter    uint32
	nFilterIndex      uint32
	lpstrFile         *uint16
	nMaxFile          uint32
	lpstrFileTitle    *uint16
	nMaxFileTitle     uint32
	lpstrInitialDir   *uint16
	lpstrTitle        *uint16
	flags             uint32
	nFileOffset       uint16
	nFileExtension    uint16
	lpstrDefExt       *uint16
	lCustData         uintptr
	lpfnHook          uintptr
	lpTemplateName    *uint16
	pvReserved        uintptr
	dwReserved        uint32
	flagsEx           uint32
}

const (
	ofnFileMustExist   = 0x00001000
	ofnPathMustExist   = 0x00000800
	ofnOverwritePrompt = 0x00000002
	ofnExplorer        = 0x00080000
)

// OpenFileDialog shows native Windows Open File dialog supporting all text and code files.
func OpenFileDialog(title string) (string, error) {
	var ofn openFileName
	ofn.lStructSize = uint32(unsafe.Sizeof(ofn))

	filter := "All Supported Text Files (*.md;*.txt;*.json;*.yaml;*.yml;*.toml;*.csv;*.tsv;*.xml;*.html;*.css;*.js;*.ts;*.go;*.py;*.rs;*.sh;*.bat;*.ps1;*.log;*.env;*.ini;*.sql;*.c;*.cpp;*.h)\x00*.md;*.txt;*.json;*.yaml;*.yml;*.toml;*.csv;*.tsv;*.xml;*.html;*.css;*.js;*.ts;*.go;*.py;*.rs;*.sh;*.bat;*.ps1;*.log;*.env;*.ini;*.sql;*.c;*.cpp;*.h\x00Markdown Files (*.md;*.markdown)\x00*.md;*.markdown\x00JSON / Config Files (*.json;*.yaml;*.yml;*.toml;*.ini;*.env)\x00*.json;*.yaml;*.yml;*.toml;*.ini;*.env\x00Text / Source Code (*.txt;*.log;*.go;*.py;*.js;*.ts;*.html;*.css)\x00*.txt;*.log;*.go;*.py;*.js;*.ts;*.html;*.css\x00All Files (*.*)\x00*.*\x00\x00"
	filterUTF16, _ := syscall.UTF16PtrFromString(filter)
	ofn.lpstrFilter = filterUTF16

	fileBuf := make([]uint16, 2048)
	ofn.lpstrFile = &fileBuf[0]
	ofn.nMaxFile = uint32(len(fileBuf))

	titleUTF16, _ := syscall.UTF16PtrFromString(title)
	ofn.lpstrTitle = titleUTF16

	defExt, _ := syscall.UTF16PtrFromString("md")
	ofn.lpstrDefExt = defExt

	ofn.flags = ofnFileMustExist | ofnPathMustExist | ofnExplorer

	ret, _, _ := procGetOpenFileName.Call(uintptr(unsafe.Pointer(&ofn)))
	if ret == 0 {
		return "", nil // Cancelled
	}

	return syscall.UTF16ToString(fileBuf), nil
}

// SaveFileDialog shows native Windows Save File dialog.
func SaveFileDialog(title, defaultName string) (string, error) {
	var ofn openFileName
	ofn.lStructSize = uint32(unsafe.Sizeof(ofn))

	filter := "Markdown Files (*.md)\x00*.md\x00JSON Files (*.json)\x00*.json\x00Text Files (*.txt)\x00*.txt\x00YAML Files (*.yaml;*.yml)\x00*.yaml;*.yml\x00All Files (*.*)\x00*.*\x00\x00"
	filterUTF16, _ := syscall.UTF16PtrFromString(filter)
	ofn.lpstrFilter = filterUTF16

	fileBuf := make([]uint16, 2048)
	if defaultName != "" {
		copy(fileBuf, syscall.StringToUTF16(defaultName))
	}
	ofn.lpstrFile = &fileBuf[0]
	ofn.nMaxFile = uint32(len(fileBuf))

	titleUTF16, _ := syscall.UTF16PtrFromString(title)
	ofn.lpstrTitle = titleUTF16

	defaultExt := "md"
	if ext := filepath.Ext(defaultName); ext != "" {
		defaultExt = ext[1:]
	}
	defExt, _ := syscall.UTF16PtrFromString(defaultExt)
	ofn.lpstrDefExt = defExt

	ofn.flags = ofnOverwritePrompt | ofnPathMustExist | ofnExplorer

	ret, _, _ := procGetSaveFileName.Call(uintptr(unsafe.Pointer(&ofn)))
	if ret == 0 {
		return "", nil // Cancelled
	}

	selected := syscall.UTF16ToString(fileBuf)
	if filepath.Ext(selected) == "" {
		selected += "." + defaultExt
	}
	return selected, nil
}
