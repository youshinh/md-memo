package main

import (
	"bytes"
	"encoding/binary"
	"image"
	"image/color"
	"image/png"
	"os"
)

// Generate a sleek Markdown icon (document + 'M' + arrow)
func createIconImage(size int) image.Image {
	img := image.NewRGBA(image.Rect(0, 0, size, size))
	scale := float64(size) / 256.0

	// Draw rounded background
	bg := color.RGBA{R: 30, G: 30, B: 38, A: 255}
	border := color.RGBA{R: 0, G: 122, B: 204, A: 255}
	accent := color.RGBA{R: 86, G: 156, B: 214, A: 255}
	accentCyan := color.RGBA{R: 78, G: 201, B: 176, A: 255}

	for y := 0; y < size; y++ {
		for x := 0; x < size; x++ {
			fx, fy := float64(x)/scale, float64(y)/scale
			// Rounded rectangle bounds (16 to 240)
			if fx >= 20 && fx <= 236 && fy >= 20 && fy <= 236 {
				// Outer border or bg
				if fx <= 26 || fx >= 230 || fy <= 26 || fy >= 230 {
					img.Set(x, y, border)
				} else {
					img.Set(x, y, bg)
				}
			}
		}
	}

	// Draw 'M' and '↓' in center
	// M lines
	mColor := accentCyan
	drawThickLine := func(x1, y1, x2, y2 float64, c color.Color, thickness float64) {
		dx := x2 - x1
		dy := y2 - y1
		steps := int(max(abs(dx), abs(dy)) * 2)
		if steps == 0 {
			steps = 1
		}
		for i := 0; i <= steps; i++ {
			t := float64(i) / float64(steps)
			cx := (x1 + t*dx) * scale
			cy := (y1 + t*dy) * scale
			r := thickness * scale / 2.0
			for ox := -r; ox <= r; ox++ {
				for oy := -r; oy <= r; oy++ {
					if ox*ox+oy*oy <= r*r {
						ix, iy := int(cx+ox), int(cy+oy)
						if ix >= 0 && ix < size && iy >= 0 && iy < size {
							img.Set(ix, iy, c)
						}
					}
				}
			}
		}
	}

	// M structure (left side 50 to 150)
	drawThickLine(56, 170, 56, 86, mColor, 18)
	drawThickLine(56, 86, 100, 130, mColor, 18)
	drawThickLine(100, 130, 144, 86, mColor, 18)
	drawThickLine(144, 86, 144, 170, mColor, 18)

	// Arrow structure (right side 160 to 200)
	drawThickLine(186, 86, 186, 160, accent, 16)
	drawThickLine(186, 164, 164, 138, accent, 16)
	drawThickLine(186, 164, 208, 138, accent, 16)

	return img
}

func max(a, b float64) float64 {
	if a > b {
		return a
	}
	return b
}
func abs(a float64) float64 {
	if a < 0 {
		return -a
	}
	return a
}

func main() {
	sizes := []int{16, 32, 48, 256}
	var pngBuffers [][]byte

	for _, s := range sizes {
		img := createIconImage(s)
		buf := &bytes.Buffer{}
		_ = png.Encode(buf, img)
		pngBuffers = append(pngBuffers, buf.Bytes())
	}

	// Build ICO file
	icoFile, err := os.Create("app.ico")
	if err != nil {
		panic(err)
	}
	defer icoFile.Close()

	// 6 bytes header: reserved(2), type=1(2), count(2)
	_ = binary.Write(icoFile, binary.LittleEndian, uint16(0))
	_ = binary.Write(icoFile, binary.LittleEndian, uint16(1))
	_ = binary.Write(icoFile, binary.LittleEndian, uint16(len(sizes)))

	offset := uint32(6 + 16*len(sizes))
	for i, s := range sizes {
		w := byte(s)
		if s >= 256 {
			w = 0
		}
		h := w
		// Entry
		_, _ = icoFile.Write([]byte{w, h, 0, 0})
		_ = binary.Write(icoFile, binary.LittleEndian, uint16(1))  // planes
		_ = binary.Write(icoFile, binary.LittleEndian, uint16(32)) // bpp
		_ = binary.Write(icoFile, binary.LittleEndian, uint32(len(pngBuffers[i])))
		_ = binary.Write(icoFile, binary.LittleEndian, offset)
		offset += uint32(len(pngBuffers[i]))
	}

	// Write PNG payloads
	for _, pb := range pngBuffers {
		_, _ = icoFile.Write(pb)
	}
}
