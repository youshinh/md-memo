//go:build windows

package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"sync"
	"sync/atomic"
	"syscall"
	"time"
	"unsafe"

	"github.com/jchv/go-webview2/pkg/edge"
	"golang.org/x/sys/windows"
)

// Page.printToPDF of the window's page, asked of WebView2 through ICoreWebView2::CallDevToolsProtocolMethod. The webview library does not
// wrap that method, so it is called here through the interface's table of functions (the order of which is WebView2's own and fixed:
// CallDevToolsProtocolMethod is the 37th entry, GetCoreWebView2 the 26th of the controller's). Nothing here runs until a PDF is asked for.

const (
	comRelease                  = 2  // IUnknown::Release
	controllerGetCoreWebView2   = 25 // ICoreWebView2Controller::get_CoreWebView2
	coreCallDevToolsProtocolFun = 36 // ICoreWebView2::CallDevToolsProtocolMethod
)

// comRaw is a COM object seen as what it is: a pointer to a table of function addresses.
type comRaw struct{ vtbl *[96]uintptr }

// ptr is the address in p as a pointer, without the vet check that uintptr -> unsafe.Pointer is unsafe (these are addresses COM gave us
// in the middle of a call).
func ptr(p uintptr) unsafe.Pointer { return *(*unsafe.Pointer)(unsafe.Pointer(&p)) }

func utf16At(p uintptr) string {
	if p == 0 {
		return ""
	}
	return windows.UTF16PtrToString((*uint16)(ptr(p)))
}

// coreWebView2Of is the window's ICoreWebView2 (the caller releases it).
func coreWebView2Of(w interface{}) (uintptr, error) {
	type ifaceHeader struct {
		itab uintptr
		data unsafe.Pointer
	}
	type webviewHeader struct {
		hwnd       uintptr
		mainthread uintptr
		browser    ifaceHeader
	}
	wh := (*webviewHeader)(reflectValPointer(w))
	if wh == nil || wh.browser.data == nil {
		return 0, errors.New("the window has no web view yet")
	}
	chromium := (*edge.Chromium)(wh.browser.data)
	ctrl := chromium.GetController()
	if ctrl == nil {
		return 0, errors.New("the web view has no controller")
	}
	vt := (*comRaw)(unsafe.Pointer(ctrl)).vtbl
	if vt == nil {
		return 0, errors.New("the web view controller is not usable")
	}
	var core uintptr
	hr, _, _ := syscall.SyscallN(vt[controllerGetCoreWebView2], uintptr(unsafe.Pointer(ctrl)), uintptr(unsafe.Pointer(&core)))
	if int32(hr) < 0 || core == 0 {
		return 0, fmt.Errorf("the web view could not be reached (%08x)", uint32(hr))
	}
	return core, nil
}

func releaseCOM(p uintptr) {
	if p == 0 {
		return
	}
	if vt := (*comRaw)(ptr(p)).vtbl; vt != nil {
		_, _, _ = syscall.SyscallN(vt[comRelease], p)
	}
}

// ---- ICoreWebView2CallDevToolsProtocolMethodCompletedHandler: a COM object that WebView2 calls back (Invoke) ------------------------

type devToolsVtbl struct{ queryInterface, addRef, release, invoke uintptr }

type devToolsHandler struct {
	vtbl *devToolsVtbl // must stay the first field: this is the object's address as COM sees it
	refs int32
	done func(hr int32, resultJSON string)
}

var (
	devToolsOnce sync.Once
	devToolsTbl  *devToolsVtbl
	devToolsLive sync.Map // address of the handler -> the handler: WebView2 holds an address, which does not keep a Go object alive
)

func devToolsTable() *devToolsVtbl {
	devToolsOnce.Do(func() {
		forget := func(this uintptr) { devToolsLive.Delete(this) }
		devToolsTbl = &devToolsVtbl{
			queryInterface: syscall.NewCallback(func(this, riid, out uintptr) uintptr {
				if out != 0 {
					*(*uintptr)(ptr(out)) = this
				}
				if v, ok := devToolsLive.Load(this); ok {
					atomic.AddInt32(&v.(*devToolsHandler).refs, 1)
				}
				return 0
			}),
			addRef: syscall.NewCallback(func(this uintptr) uintptr {
				if v, ok := devToolsLive.Load(this); ok {
					return uintptr(atomic.AddInt32(&v.(*devToolsHandler).refs, 1))
				}
				return 1
			}),
			release: syscall.NewCallback(func(this uintptr) uintptr {
				if v, ok := devToolsLive.Load(this); ok {
					n := atomic.AddInt32(&v.(*devToolsHandler).refs, -1)
					if n <= 0 {
						forget(this)
					}
					return uintptr(n)
				}
				return 0
			}),
			invoke: syscall.NewCallback(func(this, hr, result uintptr) uintptr {
				v, ok := devToolsLive.Load(this)
				if !ok {
					return 0
				}
				h := v.(*devToolsHandler)
				h.done(int32(hr), utf16At(result))
				// WebView2 releases the handler after Invoke; if it never does, the handler goes after a while all the same
				time.AfterFunc(30*time.Second, func() { forget(this) })
				return 0
			}),
		}
	})
	return devToolsTbl
}

// callDevTools starts a DevTools protocol method on the page; done is called later, on the window's thread, with its answer.
func callDevTools(core uintptr, method, params string, done func(hr int32, resultJSON string)) error {
	m, err := windows.UTF16PtrFromString(method)
	if err != nil {
		return err
	}
	p, err := windows.UTF16PtrFromString(params)
	if err != nil {
		return err
	}
	h := &devToolsHandler{vtbl: devToolsTable(), done: done}
	addr := uintptr(unsafe.Pointer(h))
	devToolsLive.Store(addr, h)
	vt := (*comRaw)(ptr(core)).vtbl
	if vt == nil {
		devToolsLive.Delete(addr)
		return errors.New("the web view is not usable")
	}
	hr, _, _ := syscall.SyscallN(vt[coreCallDevToolsProtocolFun], core, uintptr(unsafe.Pointer(m)), uintptr(unsafe.Pointer(p)), addr)
	if int32(hr) < 0 {
		devToolsLive.Delete(addr)
		return fmt.Errorf("the engine refused to print (%08x)", uint32(hr))
	}
	return nil
}

// cdpPrintToPDF prints the window's page to a PDF (Page.printToPDF with params) and returns it.
func (a *App) cdpPrintToPDF(params map[string]interface{}) ([]byte, error) {
	if a.w == nil {
		return nil, errors.New("there is no window")
	}
	body, err := json.Marshal(params)
	if err != nil {
		return nil, err
	}
	type outcome struct {
		pdf []byte
		err error
	}
	done := make(chan outcome, 1)
	a.w.Dispatch(func() { // COM is called on the window's own thread
		core, err := coreWebView2Of(a.w)
		if err != nil {
			done <- outcome{nil, err}
			return
		}
		defer releaseCOM(core)
		err = callDevTools(core, "Page.printToPDF", string(body), func(hr int32, res string) {
			if hr < 0 {
				if len(res) > 200 {
					res = res[:200]
				}
				done <- outcome{nil, fmt.Errorf("the engine could not make the PDF (%08x) %s", uint32(hr), res)}
				return
			}
			pdf, derr := decodePrintPDF(res)
			done <- outcome{pdf, derr}
		})
		if err != nil {
			done <- outcome{nil, err}
		}
	})
	select {
	case o := <-done:
		return o.pdf, o.err
	case <-time.After(printPDFTimeout):
		return nil, errors.New("making the PDF took too long")
	}
}
