//go:build windows

package sysaudio

import (
	"errors"
	"fmt"
	"runtime"
	"sync"
	"syscall"
	"time"
	"unsafe"
)

// The Windows Audio Session API, called through its COM vtables the same way pkg/dialog calls the file dialogs (no cgo, no
// new dependency). Two kinds of source share one implementation:
//   - the microphone: the default capture endpoint;
//   - the PC's own sound: the default RENDER endpoint opened with AUDCLNT_STREAMFLAGS_LOOPBACK, which hands back exactly what
//     is being played (Zoom's other participants, a video). Nothing is played or changed; the person keeps hearing it.

var (
	ole32w            = syscall.NewLazyDLL("ole32.dll")
	procCoInitEx      = ole32w.NewProc("CoInitializeEx")
	procCoUninit      = ole32w.NewProc("CoUninitialize")
	procCoCreateInst  = ole32w.NewProc("CoCreateInstance")
	procCoTaskMemFree = ole32w.NewProc("CoTaskMemFree")
)

type guid struct {
	d1 uint32
	d2 uint16
	d3 uint16
	d4 [8]byte
}

var (
	clsidMMDeviceEnumerator = guid{0xBCDE0395, 0xE52F, 0x467C, [8]byte{0x8E, 0x3D, 0xC4, 0x57, 0x92, 0x91, 0x69, 0x2E}}
	iidIMMDeviceEnumerator  = guid{0xA95664D2, 0x9614, 0x4F35, [8]byte{0xA7, 0x46, 0xDE, 0x8D, 0xB6, 0x36, 0x17, 0xE6}}
	iidIAudioClient         = guid{0x1CB9AD4C, 0xDBFA, 0x4C32, [8]byte{0xB1, 0x78, 0xC2, 0xF5, 0x68, 0xA7, 0x03, 0xB2}}
	iidIAudioCaptureClient  = guid{0xC8ADBD64, 0xE71E, 0x48A0, [8]byte{0xA4, 0xDE, 0x18, 0x5C, 0x39, 0x5C, 0xD3, 0x17}}
)

const (
	coinitMultithreaded = 0x0
	clsctxAll           = 0x17

	eRender  = 0
	eCapture = 1
	eConsole = 0

	audclntShareModeShared      = 0
	audclntStreamflagsLoopback  = 0x00020000
	audclntBufferflagsSilent    = 0x2
	audclntBufferflagsDiscont   = 0x1
	waveFormatPCM               = 0x0001
	waveFormatIEEEFloat         = 0x0003
	waveFormatExtensible        = 0xFFFE
	requestedBufferDuration100n = 10000000 // one second
)

// vtable slots
const (
	vtRelease = 2

	vtEnumGetDefaultAudioEndpoint = 4
	vtDeviceActivate              = 3

	vtClientInitialize   = 3
	vtClientGetMixFormat = 8
	vtClientStart        = 10
	vtClientStop         = 11
	vtClientGetService   = 14

	vtCaptureGetBuffer         = 3
	vtCaptureReleaseBuffer     = 4
	vtCaptureGetNextPacketSize = 5
)

func vtbl(obj unsafe.Pointer, slot int) uintptr {
	table := *(*unsafe.Pointer)(obj)
	return *(*uintptr)(unsafe.Add(table, slot*int(unsafe.Sizeof(uintptr(0)))))
}

func comCall(obj unsafe.Pointer, slot int, args ...uintptr) uintptr {
	r, _, _ := syscall.SyscallN(vtbl(obj, slot), append([]uintptr{uintptr(obj)}, args...)...)
	return r
}

func comRelease(obj unsafe.Pointer) {
	if obj != nil {
		comCall(obj, vtRelease)
	}
}

func hresult(what string, hr uintptr) error {
	return fmt.Errorf("%s failed (HRESULT 0x%08X)", what, uint32(hr))
}

// Supported is true on Windows: the loopback and capture endpoints exist on every supported version.
func Supported() bool { return true }

// NewMicrophone captures the default microphone.
func NewMicrophone() Source { return &wasapiSource{name: "microphone", loopback: false, expect: true} }

// NewSystemAudio captures whatever the default output device is playing.
func NewSystemAudio() Source { return &wasapiSource{name: "PC audio", loopback: true, expect: false} }

type wasapiSource struct {
	name     string
	loopback bool
	expect   bool

	mu      sync.Mutex
	stop    chan struct{}
	stopped chan struct{}
}

func (s *wasapiSource) Name() string      { return s.name }
func (s *wasapiSource) ExpectAudio() bool { return s.expect }

// Start opens the device on a dedicated OS thread (COM wants the apartment of the thread that created the objects) and
// returns once the first attempt has succeeded or failed. Later failures (the headset was unplugged, the default output
// changed) are retried until Stop.
func (s *wasapiSource) Start(push func([]int16)) error {
	s.mu.Lock()
	if s.stop != nil {
		s.mu.Unlock()
		return errors.New("already started")
	}
	s.stop = make(chan struct{})
	s.stopped = make(chan struct{})
	stop, stopped := s.stop, s.stopped
	s.mu.Unlock()

	first := make(chan error, 1)
	go func() {
		defer close(stopped)
		runtime.LockOSThread()
		defer runtime.UnlockOSThread()
		procCoInitEx.Call(0, coinitMultithreaded)
		defer procCoUninit.Call()
		reported := false
		for {
			err := s.capture(push, stop, func() {
				if !reported {
					reported = true
					first <- nil
				}
			})
			if !reported {
				reported = true
				first <- err
				if err != nil {
					return
				}
			}
			select {
			case <-stop:
				return
			case <-time.After(500 * time.Millisecond):
			}
		}
	}()
	select {
	case err := <-first:
		if err != nil {
			s.Stop()
		}
		return err
	case <-time.After(5 * time.Second):
		s.Stop()
		return errors.New("the audio device did not respond")
	}
}

// Stop ends the capture and waits for the device to be released.
func (s *wasapiSource) Stop() {
	s.mu.Lock()
	stop, stopped := s.stop, s.stopped
	s.stop, s.stopped = nil, nil
	s.mu.Unlock()
	if stop == nil {
		return
	}
	close(stop)
	select {
	case <-stopped:
	case <-time.After(3 * time.Second):
	}
}

// capture opens the default endpoint and reads it until stop (nil) or until the device fails (the error).
func (s *wasapiSource) capture(push func([]int16), stop <-chan struct{}, opened func()) error {
	var enumerator unsafe.Pointer
	hr, _, _ := procCoCreateInst.Call(uintptr(unsafe.Pointer(&clsidMMDeviceEnumerator)), 0, clsctxAll, uintptr(unsafe.Pointer(&iidIMMDeviceEnumerator)), uintptr(unsafe.Pointer(&enumerator)))
	if hr != 0 {
		return hresult("CoCreateInstance(MMDeviceEnumerator)", hr)
	}
	defer comRelease(enumerator)

	flow := uintptr(eCapture)
	if s.loopback {
		flow = eRender
	}
	var device unsafe.Pointer
	if hr := comCall(enumerator, vtEnumGetDefaultAudioEndpoint, flow, eConsole, uintptr(unsafe.Pointer(&device))); hr != 0 {
		if s.loopback {
			return fmt.Errorf("no audio output device: %w", hresult("GetDefaultAudioEndpoint", hr))
		}
		return fmt.Errorf("no microphone: %w", hresult("GetDefaultAudioEndpoint", hr))
	}
	defer comRelease(device)

	var client unsafe.Pointer
	if hr := comCall(device, vtDeviceActivate, uintptr(unsafe.Pointer(&iidIAudioClient)), clsctxAll, 0, uintptr(unsafe.Pointer(&client))); hr != 0 {
		return hresult("Activate(IAudioClient)", hr)
	}
	defer comRelease(client)

	var pf unsafe.Pointer
	if hr := comCall(client, vtClientGetMixFormat, uintptr(unsafe.Pointer(&pf))); hr != 0 {
		return hresult("GetMixFormat", hr)
	}
	format, err := readFormat(pf)
	if err != nil {
		procCoTaskMemFree.Call(uintptr(pf))
		return err
	}
	flags := uintptr(0)
	if s.loopback {
		flags = audclntStreamflagsLoopback
	}
	hr = comCall(client, vtClientInitialize, audclntShareModeShared, flags, requestedBufferDuration100n, 0, uintptr(pf), 0)
	procCoTaskMemFree.Call(uintptr(pf))
	if hr != 0 {
		return hresult("Initialize", hr)
	}
	conv := NewConverter(format)
	if conv == nil {
		return errors.New("unreadable audio format")
	}

	var capt unsafe.Pointer
	if hr := comCall(client, vtClientGetService, uintptr(unsafe.Pointer(&iidIAudioCaptureClient)), uintptr(unsafe.Pointer(&capt))); hr != 0 {
		return hresult("GetService(IAudioCaptureClient)", hr)
	}
	defer comRelease(capt)

	if hr := comCall(client, vtClientStart); hr != 0 {
		return hresult("Start", hr)
	}
	defer comCall(client, vtClientStop)
	opened()

	tick := time.NewTicker(20 * time.Millisecond)
	defer tick.Stop()
	for {
		select {
		case <-stop:
			return nil
		case <-tick.C:
		}
		for {
			var frames uint32
			if hr := comCall(capt, vtCaptureGetNextPacketSize, uintptr(unsafe.Pointer(&frames))); hr != 0 {
				return hresult("GetNextPacketSize", hr) // e.g. the device was removed: the caller reopens the default one
			}
			if frames == 0 {
				break
			}
			var data unsafe.Pointer
			var got, bufFlags uint32
			if hr := comCall(capt, vtCaptureGetBuffer, uintptr(unsafe.Pointer(&data)), uintptr(unsafe.Pointer(&got)), uintptr(unsafe.Pointer(&bufFlags)), 0, 0); hr != 0 {
				return hresult("GetBuffer", hr)
			}
			if bufFlags&audclntBufferflagsSilent != 0 {
				push(make([]int16, int(got)*SampleRate/format.Rate))
			} else if got > 0 {
				raw := unsafe.Slice((*byte)(data), int(got)*format.Channels*(format.Bits/8))
				if out := conv.Convert(raw, int(got)); len(out) > 0 {
					push(out)
				}
			}
			comCall(capt, vtCaptureReleaseBuffer, uintptr(got))
		}
	}
}

// readFormat reads a WAVEFORMATEX / WAVEFORMATEXTENSIBLE.
func readFormat(p unsafe.Pointer) (Format, error) {
	if p == nil {
		return Format{}, errors.New("no audio format")
	}
	head := unsafe.Slice((*byte)(p), 18)
	tag := uint16(head[0]) | uint16(head[1])<<8
	f := Format{
		Channels: int(uint16(head[2]) | uint16(head[3])<<8),
		Rate:     int(uint32(head[4]) | uint32(head[5])<<8 | uint32(head[6])<<16 | uint32(head[7])<<24),
		Bits:     int(uint16(head[14]) | uint16(head[15])<<8),
	}
	switch tag {
	case waveFormatIEEEFloat:
		f.Float = true
	case waveFormatPCM:
	case waveFormatExtensible:
		full := unsafe.Slice((*byte)(p), 40)
		sub := uint16(full[24]) | uint16(full[25])<<8 // the first two bytes of the SubFormat GUID are the format tag
		f.Float = sub == waveFormatIEEEFloat
	default:
		return Format{}, fmt.Errorf("unsupported audio format tag 0x%04X", tag)
	}
	if f.Channels < 1 || f.Rate < 8000 || (f.Bits != 16 && f.Bits != 24 && f.Bits != 32) {
		return Format{}, fmt.Errorf("unsupported audio format: %d ch, %d Hz, %d bit", f.Channels, f.Rate, f.Bits)
	}
	return f, nil
}
