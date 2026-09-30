package sysaudio

import "math"

// Format is what a WASAPI endpoint delivers in shared mode: usually 32-bit float stereo at 48 kHz, but 16/24/32-bit integer and
// any channel count or rate happen.
type Format struct {
	Channels int
	Rate     int
	Bits     int  // bits per sample of one channel as stored (16, 24, 32)
	Float    bool // IEEE float (32 bit) rather than integer PCM
}

// Converter turns interleaved frames of a device Format into 16 kHz mono int16, keeping its position across packets (the
// resampler is a streaming linear interpolator, which is plenty for speech).
type Converter struct {
	f    Format
	pos  float64   // position of the next output sample, in input samples from tail[0]
	step float64   // input samples per output sample
	tail []float32 // mono samples not yet consumed
}

// NewConverter makes a converter for f. It returns nil when the format cannot be read (no channels or rate).
func NewConverter(f Format) *Converter {
	if f.Channels < 1 || f.Rate < 1 {
		return nil
	}
	return &Converter{f: f, step: float64(f.Rate) / SampleRate}
}

// Convert takes the raw bytes of `frames` frames and returns the 16 kHz mono samples that are complete so far.
func (c *Converter) Convert(data []byte, frames int) []int16 {
	mono := c.decodeMono(data, frames)
	if len(mono) == 0 {
		return nil
	}
	// Work on the concatenation of what is left from last time and the new samples.
	in := append(c.tail, mono...)
	var out []int16
	// Sample at input position p (relative to in[0]) interpolates between in[floor(p)] and in[floor(p)+1].
	p := c.pos
	for {
		i := int(p)
		if i+1 >= len(in) {
			break
		}
		frac := float32(p - float64(i))
		v := in[i]*(1-frac) + in[i+1]*frac
		out = append(out, toInt16(v))
		p += c.step
	}
	// Keep the samples from floor(p) on, and p relative to them.
	i := int(p)
	if i > len(in) {
		i = len(in)
	}
	c.tail = append([]float32(nil), in[i:]...)
	c.pos = p - float64(i)
	return out
}

func toInt16(v float32) int16 {
	x := float64(v) * 32767
	if x > 32767 {
		return 32767
	}
	if x < -32768 {
		return -32768
	}
	return int16(math.Round(x))
}

// decodeMono reads the frames and averages the channels (-1..1 floats).
func (c *Converter) decodeMono(data []byte, frames int) []float32 {
	bytesPer := c.f.Bits / 8
	if bytesPer < 2 || bytesPer > 4 {
		return nil
	}
	frameBytes := bytesPer * c.f.Channels
	if frames*frameBytes > len(data) {
		frames = len(data) / frameBytes
	}
	out := make([]float32, frames)
	for i := 0; i < frames; i++ {
		var sum float32
		for ch := 0; ch < c.f.Channels; ch++ {
			o := i*frameBytes + ch*bytesPer
			sum += c.sample(data[o : o+bytesPer])
		}
		out[i] = sum / float32(c.f.Channels)
	}
	return out
}

func (c *Converter) sample(b []byte) float32 {
	switch {
	case c.f.Float && len(b) == 4:
		return math.Float32frombits(uint32(b[0]) | uint32(b[1])<<8 | uint32(b[2])<<16 | uint32(b[3])<<24)
	case len(b) == 2:
		return float32(int16(uint16(b[0])|uint16(b[1])<<8)) / 32768
	case len(b) == 3:
		v := int32(uint32(b[0])<<8|uint32(b[1])<<16|uint32(b[2])<<24) >> 8
		return float32(v) / 8388608
	case len(b) == 4:
		v := int32(uint32(b[0]) | uint32(b[1])<<8 | uint32(b[2])<<16 | uint32(b[3])<<24)
		return float32(v) / 2147483648
	}
	return 0
}

// Level is the RMS of samples on a 0..1 scale (for "is there any sound" checks).
func Level(samples []int16) float64 {
	if len(samples) == 0 {
		return 0
	}
	var sum float64
	for _, s := range samples {
		v := float64(s) / 32768
		sum += v * v
	}
	return math.Sqrt(sum / float64(len(samples)))
}
