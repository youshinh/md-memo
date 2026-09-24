package main

import (
	"sync"
	"sync/atomic"
	"testing"
)

// deferredDispatchWebView is a WebViewInstance whose Dispatch stores the callback instead of
// running it inline, so a test can flip App.isDestroyed between "dispatched" and "actually ran"
// to prove dispatchEval re-checks isDestroyed on the UI thread at run time, not at enqueue time.
type deferredDispatchWebView struct {
	mu      sync.Mutex
	pending []func()
	eval    []string
}

func (m *deferredDispatchWebView) Dispatch(f func()) {
	m.mu.Lock()
	m.pending = append(m.pending, f)
	m.mu.Unlock()
}

func (m *deferredDispatchWebView) Eval(js string) {
	m.mu.Lock()
	m.eval = append(m.eval, js)
	m.mu.Unlock()
}

// runPending executes every callback queued by Dispatch so far, simulating the UI thread later
// picking up the work.
func (m *deferredDispatchWebView) runPending() {
	m.mu.Lock()
	pending := m.pending
	m.pending = nil
	m.mu.Unlock()
	for _, f := range pending {
		f()
	}
}

func (m *deferredDispatchWebView) calls() []string {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]string, len(m.eval))
	copy(out, m.eval)
	return out
}

func TestDispatchEvalRunsWhenAlive(t *testing.T) {
	fake := &evalCaptureWebView{}
	a := &App{w: fake}

	a.dispatchEval("window.foo()")

	got := fake.calls()
	if len(got) != 1 || got[0] != "window.foo()" {
		t.Fatalf("calls() = %v, want [\"window.foo()\"]", got)
	}
}

func TestDispatchEvalSkipsWhenDestroyedBeforeRun(t *testing.T) {
	fake := &deferredDispatchWebView{}
	a := &App{w: fake}

	// Dispatch is enqueued while the app is still alive...
	a.dispatchEval("window.foo()")

	// ...but isDestroyed flips before the UI thread gets around to running it. The isDestroyed
	// check must happen inside the dispatched closure at run time to catch this, not once at
	// enqueue time.
	atomic.StoreInt32(&a.isDestroyed, 1)
	fake.runPending()

	if got := fake.calls(); len(got) != 0 {
		t.Fatalf("calls() = %v, want no Eval calls after isDestroyed was set", got)
	}
}

func TestDispatchEvalRunsWhenNotYetDestroyedAtRunTime(t *testing.T) {
	fake := &deferredDispatchWebView{}
	a := &App{w: fake}

	a.dispatchEval("window.foo()")
	fake.runPending()

	got := fake.calls()
	if len(got) != 1 || got[0] != "window.foo()" {
		t.Fatalf("calls() = %v, want [\"window.foo()\"]", got)
	}
}

func TestDispatchEvalNilWindowDoesNotPanic(t *testing.T) {
	a := &App{}

	defer func() {
		if r := recover(); r != nil {
			t.Fatalf("dispatchEval panicked with nil a.w: %v", r)
		}
	}()

	a.dispatchEval("window.foo()")
}
