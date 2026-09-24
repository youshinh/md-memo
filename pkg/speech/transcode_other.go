//go:build !windows

package speech

import "context"

func mediaTranscode(ctx context.Context, in, out string) error { return errNoTranscoder }
