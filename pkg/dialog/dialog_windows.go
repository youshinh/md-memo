//go:build windows

package dialog

import (
	"fmt"
	"path/filepath"
	"syscall"
	"unsafe"
)

var (
	comdlg32            = syscall.NewLazyDLL("comdlg32.dll")
	procGetOpenFileName = comdlg32.NewProc("GetOpenFileNameW")
	procGetSaveFileName = comdlg32.NewProc("GetSaveFileNameW")

	ole32                = syscall.NewLazyDLL("ole32.dll")
	procCoInitializeEx   = ole32.NewProc("CoInitializeEx")
	procCoUninitialize   = ole32.NewProc("CoUninitialize")
	procCoCreateInstance = ole32.NewProc("CoCreateInstance")
	procCoTaskMemFree    = ole32.NewProc("CoTaskMemFree")
	procIIDFromString    = ole32.NewProc("IIDFromString")

	user32 = syscall.NewLazyDLL("user32.dll")
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

	filter := "Markdown Files (*.md)\x00*.md\x00HTML Files (*.html;*.htm)\x00*.html;*.htm\x00JSON Files (*.json)\x00*.json\x00Text Files (*.txt)\x00*.txt\x00YAML Files (*.yaml;*.yml)\x00*.yaml;*.yml\x00All Files (*.*)\x00*.*\x00\x00"
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



const (
	COINIT_APARTMENTTHREADED = 0x2
	CLSCTX_INPROC_SERVER     = 0x1
	FOS_PICKFOLDERS          = 0x00000020
	FOS_FORCEFILESYSTEM      = 0x00000040
	SIGDN_FILESYSPATH        = 0x80058000
)

type iFileDialogVtbl struct {
	QueryInterface      uintptr
	AddRef              uintptr
	Release             uintptr
	Show                uintptr
	SetFileTypes        uintptr
	SetFileTypeIndex    uintptr
	GetFileTypeIndex    uintptr
	Advise              uintptr
	Unadvise            uintptr
	SetOptions          uintptr
	GetOptions          uintptr
	SetDefaultFolder    uintptr
	SetFolder           uintptr
	GetFolder           uintptr
	GetCurrentSelection uintptr
	SetFileName         uintptr
	GetFileName         uintptr
	SetTitle            uintptr
	SetOkButtonLabel    uintptr
	SetFileNameLabel    uintptr
	GetResult           uintptr
}

type iShellItemVtbl struct {
	QueryInterface uintptr
	AddRef         uintptr
	Release        uintptr
	BindToHandler  uintptr
	GetParent      uintptr
	GetDisplayName uintptr
}

// OpenFolderDialog opens a high-speed, modern native Windows folder picker dialog using COM IFileDialog.
func OpenFolderDialog(title string) (string, error) {
	procCoInitializeEx.Call(0, COINIT_APARTMENTTHREADED)
	defer procCoUninitialize.Call()

	clsidStr, _ := syscall.UTF16PtrFromString("{DC1C5A9C-E88A-4dde-A5A1-60F82A20AEF7}")
	iidFileDialogStr, _ := syscall.UTF16PtrFromString("{42f85136-db7e-439c-85f1-e4075d135fc8}")

	var clsid, iid [16]byte
	procIIDFromString.Call(uintptr(unsafe.Pointer(clsidStr)), uintptr(unsafe.Pointer(&clsid[0])))
	procIIDFromString.Call(uintptr(unsafe.Pointer(iidFileDialogStr)), uintptr(unsafe.Pointer(&iid[0])))

	var dialog uintptr
	hr, _, _ := procCoCreateInstance.Call(
		uintptr(unsafe.Pointer(&clsid[0])),
		0,
		CLSCTX_INPROC_SERVER,
		uintptr(unsafe.Pointer(&iid[0])),
		uintptr(unsafe.Pointer(&dialog)),
	)
	if hr != 0 || dialog == 0 {
		return "", fmt.Errorf("IFileDialog creation failed: 0x%08x", uint32(hr))
	}
	vtbl := *(**iFileDialogVtbl)(unsafe.Pointer(dialog))
	defer syscall.SyscallN(vtbl.Release, dialog)

	// Enable Pick Folders & File System Path enforcement
	var options uint32
	syscall.SyscallN(vtbl.GetOptions, dialog, uintptr(unsafe.Pointer(&options)))
	options |= FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM | ofnPathMustExist
	syscall.SyscallN(vtbl.SetOptions, dialog, uintptr(options))

	if title != "" {
		titleUTF16, _ := syscall.UTF16PtrFromString(title)
		syscall.SyscallN(vtbl.SetTitle, dialog, uintptr(unsafe.Pointer(titleUTF16)))
	}

	// Show modal dialog with active foreground window as owner
	var ownerHWND uintptr
	if procGetActiveWindow := user32.NewProc("GetActiveWindow"); procGetActiveWindow.Find() == nil {
		ownerHWND, _, _ = procGetActiveWindow.Call()
	}
	if ownerHWND == 0 {
		if procGetForegroundWindow := user32.NewProc("GetForegroundWindow"); procGetForegroundWindow.Find() == nil {
			ownerHWND, _, _ = procGetForegroundWindow.Call()
		}
	}
	hr, _, _ = syscall.SyscallN(vtbl.Show, dialog, ownerHWND)
	if hr != 0 {
		// Cancelled by user
		return "", nil
	}

	// Retrieve selected folder IShellItem
	var shellItem uintptr
	hr, _, _ = syscall.SyscallN(vtbl.GetResult, dialog, uintptr(unsafe.Pointer(&shellItem)))
	if hr != 0 || shellItem == 0 {
		return "", nil
	}
	itemVtbl := *(**iShellItemVtbl)(unsafe.Pointer(shellItem))
	defer syscall.SyscallN(itemVtbl.Release, shellItem)

	// Get file system path
	var pszPath *uint16
	hr, _, _ = syscall.SyscallN(itemVtbl.GetDisplayName, shellItem, uintptr(SIGDN_FILESYSPATH), uintptr(unsafe.Pointer(&pszPath)))
	if hr != 0 || pszPath == nil {
		return "", nil
	}
	defer procCoTaskMemFree.Call(uintptr(unsafe.Pointer(pszPath)))

	var length int
	for ptr := pszPath; *ptr != 0; ptr = (*uint16)(unsafe.Pointer(uintptr(unsafe.Pointer(ptr)) + 2)) {
		length++
	}
	slice := unsafe.Slice(pszPath, length)
	return syscall.UTF16ToString(slice), nil
}


