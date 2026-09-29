package llm

import (
	"errors"
	"regexp"
	"strings"
)

// A request to the Gemini API carries the API key in its address ("...:generateContent?key=AIza..."). net/http puts that whole
// address into the error it returns, and the error text is shown to the person (the ask bar's details, a toast, a line in the
// note) and ends up in their file. Every exported entry point that talks to a hosted model therefore passes its error through
// scrubKeyErr, and the screen and the note only ever see the redacted text.
var (
	reKeyParam  = regexp.MustCompile(`(?i)([?&;](?:key|api[_-]?key|apikey|access[_-]?token|token)=)[^&\s"'<>)\]]+`)
	reGoogleKey = regexp.MustCompile(`AIza[0-9A-Za-z_\-]{16,}`)
	reBearer    = regexp.MustCompile(`(?i)(\bBearer\s+)[A-Za-z0-9._~+/=\-]{8,}`)
)

// RedactSecrets returns text with anything that is a secret taken out: the given keys wherever they appear, a key or token in a
// query string, a Google API key, a bearer token. Ordinary text is returned as it was.
func RedactSecrets(text string, secrets ...string) string {
	for _, secret := range secrets {
		if len(secret) >= 6 {
			text = strings.ReplaceAll(text, secret, "***")
		}
	}
	text = reKeyParam.ReplaceAllString(text, "${1}***")
	text = reGoogleKey.ReplaceAllString(text, "***")
	text = reBearer.ReplaceAllString(text, "${1}***")
	return text
}

// redactedError is an error whose text has had the secrets taken out. errors.Is / errors.As still see the original chain (so
// errors.Is(err, ErrNotConfigured) keeps working) without the original being handed out by Unwrap.
type redactedError struct {
	msg string
	err error
}

func (e *redactedError) Error() string        { return e.msg }
func (e *redactedError) Is(target error) bool { return errors.Is(e.err, target) }
func (e *redactedError) As(target any) bool   { return errors.As(e.err, target) }

// scrubKeyErr returns err unchanged when its text holds no secret (the usual case), otherwise an error with the redacted text.
func scrubKeyErr(err error, secrets ...string) error {
	if err == nil {
		return nil
	}
	msg := err.Error()
	clean := RedactSecrets(msg, secrets...)
	if clean == msg {
		return err
	}
	return &redactedError{msg: clean, err: err}
}
