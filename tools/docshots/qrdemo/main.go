// qrdemo prints a QR code (PNG data URI) for the fake Mobile Drop pairing URL used by the
// documentation screenshots. It only renders an image: no server is started, nothing is sent.
package main

import (
	"fmt"
	"os"

	"md-memo/pkg/qrgen"
)

func main() {
	url := "http://192.168.0.24:52814/?token=demo0000demo0000demo0000demo0000"
	if len(os.Args) > 1 {
		url = os.Args[1]
	}
	uri, err := qrgen.DataURI(url)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	fmt.Print(uri)
}
