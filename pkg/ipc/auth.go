package ipc

import (
	"crypto/subtle"
	"fmt"
)

// The JSON-RPC session token (SessionInfo.Token, written to ipc-session.json with mode 0600) is
// what tells "a program of this user" from "any program that found the port". It is REQUIRED for
// every method except the pure reads listed below: a request without it, or with a wrong one, gets
// ErrCodeUnauthorized and is not run. The reads keep the older rule (the token is optional and only
// a wrong one is refused).
//
// The set is a list of what is safe WITHOUT a token, not of what needs one, so a method added
// later is protected until someone deliberately puts it here.
//
// The legacy one-line messages ({"action":"pipe|open|activate"}, sent by `cmd | md-memo` and
// `md-memo <file>`) are a separate channel: they carry no token and are not affected.
var readOnlyMethods = map[string]bool{
	"buffer.get":           true,
	"buffer.get_selection": true,
	"tab.list":             true,
}

// IsReadOnlyMethod reports whether method may be called without the session token.
func IsReadOnlyMethod(method string) bool {
	return readOnlyMethods[method]
}

// tokenMatches compares two tokens in constant time, so the time a refusal takes says nothing about
// how much of a guess was right.
func tokenMatches(supplied, expected string) bool {
	return subtle.ConstantTimeCompare([]byte(supplied), []byte(expected)) == 1
}

// authorize decides whether a request may run. supplied is the request's "auth" field and expected
// the running instance's token. It returns nil when the request may run, otherwise the error to
// send back. The messages never contain the token.
func authorize(method, supplied, expected string) *RPCError {
	if supplied == "" {
		if IsReadOnlyMethod(method) {
			return nil
		}
		return &RPCError{
			Code: ErrCodeUnauthorized,
			Message: fmt.Sprintf("Unauthorized: auth token required for %s: send it as \"auth\" in the request "+
				"(the \"token\" field of ipc-session.json in the md-memo settings folder)", quoteMethod(method)),
		}
	}
	// An empty expected token can never be matched: nothing is accepted then, not even an empty guess.
	if expected != "" && tokenMatches(supplied, expected) {
		return nil
	}
	return &RPCError{
		Code:    ErrCodeUnauthorized,
		Message: "Unauthorized: invalid session token (read the current one from ipc-session.json: it changes every time MD-Memo starts)",
	}
}

// quoteMethod shows a method name in a message without letting a huge one flood it.
func quoteMethod(method string) string {
	const max = 64
	if len(method) > max {
		method = method[:max] + "..."
	}
	return fmt.Sprintf("%q", method)
}
