package speech

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

const (
	fmtWAV  = "wav"
	fmtMP3  = "mp3"
	fmtM4A  = "m4a"
	fmtAAC  = "aac"
	fmtOGG  = "ogg"
	fmtFLAC = "flac"
	fmtWebM = "webm"
	fmtWMA  = "wma"

	sniffLen = 32
)

// Package vars so tests never launch a process.
var (
	lookPath      = exec.LookPath
	runTranscoder = mediaTranscode
	execFFmpeg    = runFFmpeg
)

var errNoTranscoder = errors.New("no system audio transcoder on this OS")

type audioInput struct {
	path string
	data []byte
	b64  string // base64 of the audio, decoded lazily and only by the local engine
	mime string
}

func (a audioInput) open() (io.ReadCloser, error) {
	if a.path != "" {
		return os.Open(a.path)
	}
	return io.NopCloser(bytes.NewReader(a.data)), nil
}

func (a audioInput) head() ([]byte, error) {
	r, err := a.open()
	if err != nil {
		return nil, fmt.Errorf("音声ファイルを開けません: %w", err)
	}
	defer r.Close()
	buf := make([]byte, sniffLen)
	n, err := io.ReadFull(r, buf)
	if n == 0 {
		if err != nil && err != io.EOF {
			return nil, fmt.Errorf("音声ファイルを読み取れません: %w", err)
		}
		return nil, errors.New("音声データが空です")
	}
	return buf[:n], nil
}

func sniffFormat(h []byte) string {
	has := func(off int, s string) bool { return len(h) >= off+len(s) && string(h[off:off+len(s)]) == s }
	switch {
	case (has(0, "RIFF") || has(0, "RF64")) && has(8, "WAVE"):
		return fmtWAV
	case has(0, "ID3"):
		return fmtMP3
	case len(h) >= 2 && h[0] == 0xFF && h[1]&0xE0 == 0xE0:
		switch {
		case h[1]&0xF6 == 0xF0:
			return fmtAAC
		case (h[1]>>1)&3 != 0 && (h[1]>>3)&3 != 1:
			return fmtMP3
		}
	case has(4, "ftyp"):
		return fmtM4A
	case has(0, "OggS"):
		return fmtOGG
	case has(0, "fLaC"):
		return fmtFLAC
	case has(0, "\x1a\x45\xdf\xa3"):
		return fmtWebM
	case has(0, "\x30\x26\xb2\x75\x8e\x66\xcf\x11"):
		return fmtWMA
	}
	return ""
}

func formatFromMIME(mime string) string {
	if i := strings.Index(mime, ";"); i >= 0 {
		mime = mime[:i]
	}
	switch strings.ToLower(strings.TrimSpace(mime)) {
	case "audio/wav", "audio/x-wav", "audio/wave", "audio/vnd.wave":
		return fmtWAV
	case "audio/mpeg", "audio/mp3":
		return fmtMP3
	case "audio/mp4", "audio/m4a", "audio/x-m4a", "video/mp4":
		return fmtM4A
	case "audio/aac", "audio/x-aac", "audio/aacp":
		return fmtAAC
	case "audio/ogg", "application/ogg", "audio/opus":
		return fmtOGG
	case "audio/webm", "video/webm":
		return fmtWebM
	case "audio/flac", "audio/x-flac":
		return fmtFLAC
	case "audio/x-ms-wma":
		return fmtWMA
	}
	return ""
}

func formatExt(format string) string {
	if format == "" {
		return ".bin"
	}
	return "." + format
}

func formatMIME(format string) string {
	switch format {
	case fmtWAV:
		return "audio/wav"
	case fmtMP3:
		return "audio/mpeg"
	case fmtM4A:
		return "audio/mp4"
	case fmtAAC:
		return "audio/aac"
	case fmtOGG:
		return "audio/ogg"
	case fmtWebM:
		return "audio/webm"
	case fmtFLAC:
		return "audio/flac"
	case fmtWMA:
		return "audio/x-ms-wma"
	}
	return ""
}

// prepareWAV turns any supported recording into a 16 kHz mono 16-bit WAV inside dir, streaming so a
// long recording never sits in memory, and returns its path and length in samples.
func prepareWAV(ctx context.Context, in audioInput, dir string) (string, wavStats, error) {
	head, err := in.head()
	if err != nil {
		return "", wavStats{}, err
	}
	format := sniffFormat(head)
	if format == "" {
		format = formatFromMIME(in.mime)
	}
	out := filepath.Join(dir, "audio16k.wav")

	if format == fmtWAV {
		n, err := convertInput(ctx, in, out)
		if !errors.Is(err, errNotWAV) && !errors.Is(err, errUnsupportedWAV) {
			return out, n, err
		}
	}
	n, err := decodeExternally(ctx, in, format, dir, out)
	return out, n, err
}

func convertInput(ctx context.Context, in audioInput, out string) (wavStats, error) {
	r, err := in.open()
	if err != nil {
		return wavStats{}, fmt.Errorf("音声ファイルを開けません: %w", err)
	}
	defer r.Close()
	return convertWAV(ctx, r, out)
}

func decodeExternally(ctx context.Context, in audioInput, format, dir, out string) (wavStats, error) {
	src, err := materialize(in, formatExt(format), dir)
	if err != nil {
		return wavStats{}, err
	}
	decoded := filepath.Join(dir, "decoded.wav")
	var causes []string
	finish := func() (wavStats, bool) {
		defer os.Remove(decoded)
		n, err := convertInput(ctx, audioInput{path: decoded}, out)
		if err != nil {
			causes = append(causes, err.Error())
		}
		return n, err == nil
	}

	switch err := runTranscoder(ctx, src, decoded); {
	case err == nil:
		if n, ok := finish(); ok {
			return n, nil
		}
	case !errors.Is(err, errNoTranscoder):
		causes = append(causes, "Windows のデコーダー: "+err.Error())
	}
	if err := ctx.Err(); err != nil {
		return wavStats{}, err
	}

	ffmpeg, lookErr := lookPath("ffmpeg")
	if lookErr == nil {
		err := execFFmpeg(ctx, ffmpeg, src, decoded)
		if err == nil {
			if n, ok := finish(); ok {
				return n, nil
			}
		} else {
			causes = append(causes, "ffmpeg: "+err.Error())
		}
		if err := ctx.Err(); err != nil {
			return wavStats{}, err
		}
	}
	return wavStats{}, unreadableFormatError(format, in.mime, lookErr == nil, causes)
}

func unreadableFormatError(format, mime string, triedFFmpeg bool, causes []string) error {
	name := strings.ToUpper(format)
	if name == "" {
		name = "不明な形式"
		if mime != "" {
			name += ", " + mime
		}
	}
	msg := fmt.Sprintf("この形式(%s)の音声はローカル音声認識では読み取れません。", name)
	if triedFFmpeg {
		msg += "ffmpeg でも変換できませんでした。WAV / MP3 / M4A で保存し直してください。"
	} else {
		msg += "ffmpeg をインストールして PATH に追加するか、WAV / MP3 / M4A で保存し直してください。"
	}
	if len(causes) > 0 {
		msg += " (" + strings.Join(causes, " / ") + ")"
	}
	return errors.New(msg)
}

// materialize returns a file with the given extension holding the input: the original path when it
// already matches, else a copy in dir. The Windows transcoder decides how to read a file by its
// extension.
func materialize(in audioInput, ext, dir string) (string, error) {
	if in.path != "" && strings.EqualFold(filepath.Ext(in.path), ext) {
		return in.path, nil
	}
	dst := filepath.Join(dir, "input"+ext)
	r, err := in.open()
	if err != nil {
		return "", fmt.Errorf("音声ファイルを開けません: %w", err)
	}
	defer r.Close()
	f, err := os.Create(dst)
	if err != nil {
		return "", err
	}
	if _, err := io.Copy(f, r); err != nil {
		f.Close()
		return "", err
	}
	return dst, f.Close()
}
