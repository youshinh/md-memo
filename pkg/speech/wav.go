package speech

import (
	"bufio"
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"math"
	"os"
)

const (
	targetRate      = 16000
	convertBlock    = 1 << 15
	wavHeaderSize   = 44
	wavUnknownSize  = 0xFFFFFFFF
	maxFmtChunkSize = 4096
	maxChannels     = 64
)

var (
	errNotWAV         = errors.New("not a RIFF/WAVE stream")
	errUnsupportedWAV = errors.New("unsupported WAV encoding")
)

type wavFormat struct {
	tag      uint16 // 1 = integer PCM, 3 = IEEE float
	channels int
	rate     int
	bits     int
}

type wavDecoder struct {
	r         io.Reader
	format    wavFormat
	frameSize int
	raw       []byte
}

func newWAVDecoder(src io.Reader) (*wavDecoder, error) {
	r := bufio.NewReaderSize(src, 1<<16)
	var hdr [12]byte
	if _, err := io.ReadFull(r, hdr[:]); err != nil {
		return nil, errNotWAV
	}
	if (string(hdr[:4]) != "RIFF" && string(hdr[:4]) != "RF64") || string(hdr[8:12]) != "WAVE" {
		return nil, errNotWAV
	}

	var format wavFormat
	haveFmt := false
	for {
		var ch [8]byte
		if _, err := io.ReadFull(r, ch[:]); err != nil {
			return nil, errors.New("WAV に音声データ(data チャンク)がありません")
		}
		id, size := string(ch[:4]), int64(binary.LittleEndian.Uint32(ch[4:]))
		switch id {
		case "fmt ":
			if size < 16 || size > maxFmtChunkSize {
				return nil, fmt.Errorf("WAV の fmt チャンクが不正です(サイズ %d)", size)
			}
			buf := make([]byte, size)
			if _, err := io.ReadFull(r, buf); err != nil {
				return nil, errors.New("WAV の fmt チャンクが途中で切れています")
			}
			var err error
			if format, err = parseWAVFormat(buf); err != nil {
				return nil, err
			}
			haveFmt = true
		case "data":
			if !haveFmt {
				return nil, errors.New("WAV の fmt チャンクが data チャンクより後ろにあります")
			}
			var body io.Reader = r
			// 0 and 0xFFFFFFFF are what streaming writers leave behind; read to EOF then.
			if size != 0 && size != wavUnknownSize {
				body = io.LimitReader(r, size)
			}
			frame := format.channels * format.bits / 8
			return &wavDecoder{r: body, format: format, frameSize: frame, raw: make([]byte, convertBlock*frame)}, nil
		default: // JUNK, LIST, fact, bext, ...
			if _, err := io.CopyN(io.Discard, r, size); err != nil {
				return nil, errors.New("WAV のチャンクが途中で切れています")
			}
		}
		if size&1 == 1 {
			r.ReadByte() // chunks are padded to an even size
		}
	}
}

func parseWAVFormat(b []byte) (wavFormat, error) {
	f := wavFormat{
		tag:      binary.LittleEndian.Uint16(b[0:]),
		channels: int(binary.LittleEndian.Uint16(b[2:])),
		rate:     int(binary.LittleEndian.Uint32(b[4:])),
		bits:     int(binary.LittleEndian.Uint16(b[14:])),
	}
	if f.tag == 0xFFFE {
		if len(b) < 40 {
			return f, errors.New("WAV の WAVE_FORMAT_EXTENSIBLE ヘッダが短すぎます")
		}
		f.tag = binary.LittleEndian.Uint16(b[24:])
	}
	if f.channels < 1 || f.channels > maxChannels || f.rate < 1 {
		return f, fmt.Errorf("WAV のヘッダが不正です(チャンネル数 %d / サンプリング周波数 %d)", f.channels, f.rate)
	}
	switch {
	case f.tag == 1 && (f.bits == 8 || f.bits == 16 || f.bits == 24 || f.bits == 32):
	case f.tag == 3 && (f.bits == 32 || f.bits == 64):
	default:
		return f, fmt.Errorf("%w (形式タグ %d / %dビット)", errUnsupportedWAV, f.tag, f.bits)
	}
	return f, nil
}

// read decodes up to len(dst) frames, averaging the channels into mono. A trailing partial frame
// is dropped; io.EOF is returned only when no frame could be read.
func (d *wavDecoder) read(dst []float32) (int, error) {
	if len(dst) > convertBlock {
		dst = dst[:convertBlock]
	}
	n, err := io.ReadFull(d.r, d.raw[:len(dst)*d.frameSize])
	frames := n / d.frameSize
	if err == io.ErrUnexpectedEOF || err == io.EOF {
		err = nil
	}
	if frames == 0 && err == nil {
		return 0, io.EOF
	}
	d.decode(d.raw[:frames*d.frameSize], dst[:frames])
	return frames, err
}

func (d *wavDecoder) decode(raw []byte, out []float32) {
	ch := d.format.channels
	if d.format.tag == 1 && d.format.bits == 16 && ch <= 2 {
		if ch == 1 {
			for i := range out {
				out[i] = float32(int16(binary.LittleEndian.Uint16(raw[2*i:]))) * (1.0 / 32768)
			}
			return
		}
		for i := range out {
			l := int16(binary.LittleEndian.Uint16(raw[4*i:]))
			r := int16(binary.LittleEndian.Uint16(raw[4*i+2:]))
			out[i] = float32(int32(l)+int32(r)) * (1.0 / 65536)
		}
		return
	}

	sample, width := sampleReader(d.format)
	inv := 1 / float32(ch)
	for i := range out {
		var sum float32
		for c := 0; c < ch; c++ {
			sum += sample(raw[(i*ch+c)*width:])
		}
		out[i] = sum * inv
	}
}

func sampleReader(f wavFormat) (func([]byte) float32, int) {
	le := binary.LittleEndian
	switch {
	case f.tag == 3 && f.bits == 64:
		return func(b []byte) float32 { return finite(float32(math.Float64frombits(le.Uint64(b)))) }, 8
	case f.tag == 3:
		return func(b []byte) float32 { return finite(math.Float32frombits(le.Uint32(b))) }, 4
	case f.bits == 8:
		return func(b []byte) float32 { return float32(int(b[0])-128) * (1.0 / 128) }, 1
	case f.bits == 16:
		return func(b []byte) float32 { return float32(int16(le.Uint16(b))) * (1.0 / 32768) }, 2
	case f.bits == 24:
		return func(b []byte) float32 {
			v := int32(uint32(b[0])<<8|uint32(b[1])<<16|uint32(b[2])<<24) >> 8
			return float32(v) * (1.0 / 8388608)
		}, 3
	}
	return func(b []byte) float32 { return float32(int32(le.Uint32(b))) * (1.0 / 2147483648) }, 4
}

func finite(v float32) float32 {
	if v != v || v > 1e6 || v < -1e6 {
		return 0
	}
	return v
}

// resampler is a polyphase windowed-sinc converter (Kaiser, about 60 dB stop-band) that keeps its
// filter history between calls, so the output does not depend on how the input is chunked.
type resampler struct {
	l, m, taps int
	coef       []float32 // coef[phase*taps+k], already reversed for a forward dot product
	buf        []float32
	base       int64 // stream index of buf[0]
	next       int64 // next output index
	pushed     int64
}

const (
	stopbandDB      = 60.0
	transitionRatio = 0.1 // transition width as a fraction of the lower of the two rates
)

func newResampler(inRate, outRate int) *resampler {
	g := gcd(inRate, outRate)
	l, m := outRate/g, inRate/g
	if l > 1024 { // odd sample rates: a slightly off ratio beats a giant filter bank
		l = 1024
		m = int(math.Round(float64(inRate) * 1024 / float64(outRate)))
	}

	lowRate := float64(min(inRate, outRate))
	taps := int(math.Ceil((stopbandDB - 8) * float64(inRate) / (2.285 * 2 * math.Pi * transitionRatio * lowRate)))
	taps += taps & 1
	taps = max(taps, 8)
	half := taps / 2
	beta := 0.1102 * (stopbandDB - 8.7)

	// prototype low-pass at rate inRate*l, cut at half the lower rate
	proto := make([]float64, taps*l)
	center := float64(half * l)
	fcn := lowRate / 2 / (float64(inRate) * float64(l))
	i0Beta := besselI0(beta)
	for i := range proto {
		d := float64(i) - center
		x := d / center
		proto[i] = 2 * fcn * sinc(2*fcn*d) * besselI0(beta*math.Sqrt(math.Max(0, 1-x*x))) / i0Beta
	}

	coef := make([]float32, l*taps)
	for p := 0; p < l; p++ {
		var sum float64
		for k := 0; k < taps; k++ {
			sum += proto[p+k*l]
		}
		for k := 0; k < taps; k++ {
			coef[p*taps+(taps-1-k)] = float32(proto[p+k*l] / sum)
		}
	}
	return &resampler{l: l, m: m, taps: taps, coef: coef, buf: make([]float32, taps), base: int64(-taps)}
}

func (r *resampler) push(in, dst []float32) []float32 {
	r.buf = append(r.buf, in...)
	r.pushed += int64(len(in))
	return r.drain(dst, -1)
}

func (r *resampler) finish(dst []float32) []float32 {
	r.buf = append(r.buf, make([]float32, r.taps)...)
	total := (r.pushed*int64(r.l) + int64(r.m) - 1) / int64(r.m)
	return r.drain(dst, total)
}

func (r *resampler) drain(dst []float32, limit int64) []float32 {
	half := int64(r.taps / 2)
	l, m := int64(r.l), int64(r.m)
	for limit < 0 || r.next < limit {
		nm := r.next * m
		q, phase := nm/l, int(nm%l)
		start := q - half + 1 - r.base
		if start+int64(r.taps) > int64(len(r.buf)) {
			break
		}
		dst = append(dst, dot(r.coef[phase*r.taps:(phase+1)*r.taps], r.buf[start:start+int64(r.taps)]))
		r.next++
	}
	if drop := (r.next*m)/l - half + 1 - r.base; drop > 0 {
		n := copy(r.buf, r.buf[drop:])
		r.buf = r.buf[:n]
		r.base += drop
	}
	return dst
}

func dot(a, b []float32) float32 {
	b = b[:len(a)]
	var s0, s1, s2, s3 float32
	for len(a) >= 4 {
		s0 += a[0] * b[0]
		s1 += a[1] * b[1]
		s2 += a[2] * b[2]
		s3 += a[3] * b[3]
		a, b = a[4:], b[4:]
	}
	for i := range a {
		s0 += a[i] * b[i]
	}
	return (s0 + s1) + (s2 + s3)
}

func gcd(a, b int) int {
	for b != 0 {
		a, b = b, a%b
	}
	return a
}

func sinc(x float64) float64 {
	if x == 0 {
		return 1
	}
	return math.Sin(math.Pi*x) / (math.Pi * x)
}

func besselI0(x float64) float64 {
	sum, term := 1.0, 1.0
	for k := 1; k < 60; k++ {
		term *= (x / (2 * float64(k))) * (x / (2 * float64(k)))
		sum += term
		if term < sum*1e-12 {
			break
		}
	}
	return sum
}

// wavWriter writes 16 kHz mono 16-bit PCM with a canonical 44-byte header whose sizes are
// patched in on close.
type wavWriter struct {
	f       *os.File
	bw      *bufio.Writer
	rate    int
	bytes   int64
	peak    int // largest absolute sample written
	scratch []byte
}

func newWAVWriter(path string, rate int) (*wavWriter, error) {
	f, err := os.Create(path)
	if err != nil {
		return nil, err
	}
	w := &wavWriter{f: f, bw: bufio.NewWriterSize(f, 1<<18), rate: rate}
	if _, err := w.bw.Write(make([]byte, wavHeaderSize)); err != nil {
		f.Close()
		return nil, err
	}
	return w, nil
}

func (w *wavWriter) write(samples []float32) error {
	if cap(w.scratch) < len(samples)*2 {
		w.scratch = make([]byte, len(samples)*2)
	}
	b := w.scratch[:len(samples)*2]
	for i, s := range samples {
		v := s * 32768
		var n int32
		if v >= 0 {
			n = int32(min(v+0.5, 32767))
		} else {
			n = int32(max(v-0.5, -32768))
		}
		w.peak = max(w.peak, int(max(n, -n)))
		binary.LittleEndian.PutUint16(b[2*i:], uint16(int16(n)))
	}
	w.bytes += int64(len(b))
	_, err := w.bw.Write(b)
	return err
}

func (w *wavWriter) close() error {
	err := w.bw.Flush()
	if err == nil {
		size := uint32(min(w.bytes, math.MaxUint32-36))
		var h [wavHeaderSize]byte
		copy(h[0:], "RIFF")
		binary.LittleEndian.PutUint32(h[4:], 36+size)
		copy(h[8:], "WAVEfmt ")
		binary.LittleEndian.PutUint32(h[16:], 16)
		binary.LittleEndian.PutUint16(h[20:], 1)
		binary.LittleEndian.PutUint16(h[22:], 1)
		binary.LittleEndian.PutUint32(h[24:], uint32(w.rate))
		binary.LittleEndian.PutUint32(h[28:], uint32(w.rate*2))
		binary.LittleEndian.PutUint16(h[32:], 2)
		binary.LittleEndian.PutUint16(h[34:], 16)
		copy(h[36:], "data")
		binary.LittleEndian.PutUint32(h[40:], size)
		_, err = w.f.WriteAt(h[:], 0)
	}
	if cerr := w.f.Close(); err == nil {
		err = cerr
	}
	return err
}

type wavStats struct {
	samples int64
	peak    int // 0..32768
}

// convertWAV streams a WAV into dstPath as 16 kHz mono 16-bit PCM. Memory use is a few blocks
// regardless of the recording's length.
func convertWAV(ctx context.Context, src io.Reader, dstPath string) (wavStats, error) {
	dec, err := newWAVDecoder(src)
	if err != nil {
		return wavStats{}, err
	}
	w, err := newWAVWriter(dstPath, targetRate)
	if err != nil {
		return wavStats{}, err
	}
	var rs *resampler
	if dec.format.rate != targetRate {
		rs = newResampler(dec.format.rate, targetRate)
	}

	in := make([]float32, convertBlock)
	var out []float32
	fail := func(err error) (wavStats, error) {
		w.close()
		return wavStats{}, err
	}
	for {
		if err := ctx.Err(); err != nil {
			return fail(err)
		}
		n, rerr := dec.read(in)
		if n > 0 {
			if rs == nil {
				err = w.write(in[:n])
			} else {
				out = rs.push(in[:n], out[:0])
				err = w.write(out)
			}
			if err != nil {
				return fail(err)
			}
		}
		if rerr == io.EOF {
			break
		}
		if rerr != nil {
			return fail(fmt.Errorf("WAV の読み取りに失敗しました: %w", rerr))
		}
	}
	if rs != nil {
		out = rs.finish(out[:0])
		if err := w.write(out); err != nil {
			return fail(err)
		}
	}
	if err := w.close(); err != nil {
		return wavStats{}, err
	}
	return wavStats{samples: w.bytes / 2, peak: w.peak}, nil
}
