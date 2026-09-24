//go:build !windows

package ocr

import "context"

// recognizeOnDeviceOS always reports unavailable on non-Windows: Windows.Media.Ocr has no
// equivalent wired up here, so Recognize falls straight through to the cloud vision path.
func recognizeOnDeviceOS(ctx context.Context, imagePath string) (string, error) {
	return "", errOnDeviceUnavailable
}
