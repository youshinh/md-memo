//go:build !darwin && !linux

package singleinstance

// Acquire is a stub on platforms that guard against a second instance some other way -
// Windows uses a named mutex created in window_windows.go, which also has to broadcast an
// "activate" window message, so routing it through this package would buy nothing. It always
// reports the lock as acquired so no caller accidentally refuses to start.
func Acquire() (bool, error) {
	return true, nil
}

// Release is a stub counterpart of Acquire and never fails.
func Release() error {
	return nil
}
