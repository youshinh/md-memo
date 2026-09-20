// Package qrgen renders a URL as a QR code PNG for the Mobile Drop feature.
//
// NOTE (build): this file requires github.com/skip2/go-qrcode, which is not
// yet a dependency of this module. It could not be added or compiled in the
// sandbox this change was authored in (no network access to the Go module
// proxy). Before building md-memo after pulling this change, run once,
// from the module root:
//
//	go get github.com/skip2/go-qrcode@latest
//	go mod tidy
//
// That fetches the dependency and populates go.sum; go.mod/go.sum are left
// untouched by this change on purpose rather than hand-edited with
// unverifiable hashes. The CI workflow (go test ./...) will surface any
// problem immediately on the next push.
package qrgen

import (
	"encoding/base64"
	"fmt"

	qrcode "github.com/skip2/go-qrcode"
)

// Size is the rendered QR PNG's edge length in pixels, chosen to stay
// crisp but small in the desktop modal.
const Size = 320

// PNG renders content (typically the Mobile Drop pairing URL) as a QR code
// PNG at medium error-correction level, which tolerates the phone camera's
// glare/angle without needing an oversized code.
func PNG(content string) ([]byte, error) {
	png, err := qrcode.Encode(content, qrcode.Medium, Size)
	if err != nil {
		return nil, fmt.Errorf("qrgen: encoding QR code: %w", err)
	}
	return png, nil
}

// DataURI renders content as a QR PNG and returns it as a data: URI ready
// to drop straight into an <img src="..."> — this is what gets sent to the
// frontend over the existing Eval-based async result channel.
func DataURI(content string) (string, error) {
	png, err := PNG(content)
	if err != nil {
		return "", err
	}
	return "data:image/png;base64," + base64.StdEncoding.EncodeToString(png), nil
}
