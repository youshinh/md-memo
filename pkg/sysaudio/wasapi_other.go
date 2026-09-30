//go:build !windows

package sysaudio

import "errors"

// Capturing the PC's own sound needs the Windows Audio Session API; other systems have no equivalent without an extra
// driver, so the feature is reported as unsupported there.
var errUnsupported = errors.New("recording the PC's sound is only available on Windows")

// Supported is false away from Windows.
func Supported() bool { return false }

type unsupportedSource struct{ name string }

func (u unsupportedSource) Name() string              { return u.name }
func (u unsupportedSource) ExpectAudio() bool         { return false }
func (u unsupportedSource) Start(func([]int16)) error { return errUnsupported }
func (u unsupportedSource) Stop()                     {}

// NewMicrophone is not available here.
func NewMicrophone() Source { return unsupportedSource{"microphone"} }

// NewSystemAudio is not available here.
func NewSystemAudio() Source { return unsupportedSource{"PC audio"} }
