//go:build !windows

package main

func attachParentConsole() {
	// POSIX terminals automatically attach stdout/stderr
}
