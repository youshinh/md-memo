package embed

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"sync"
	"testing"
)

func dot(a, b []float32) float64 {
	var s float64
	for i := range a {
		s += float64(a[i]) * float64(b[i])
	}
	return s
}

func fakeEmbedOne(t *testing.T, f Embedder, text string) []float32 {
	t.Helper()
	v, err := f.Embed(context.Background(), Document, []Input{{Text: text}})
	if err != nil {
		t.Fatal(err)
	}
	return v[0]
}

func TestFakeIdentity(t *testing.T) {
	f := NewFake(128)
	if f.ID() != "fake|bag|128" || f.Dim() != 128 {
		t.Fatalf("ID=%q Dim=%d", f.ID(), f.Dim())
	}
	if caps := f.Caps(); caps != (Caps{Text: true, Image: false, MaxBatch: 16}) {
		t.Fatalf("Caps = %+v", caps)
	}
	if NewFake(0).Dim() != 64 || NewFake(-3).Dim() != 64 {
		t.Fatal("a dimension below 1 should fall back to 64")
	}
	var _ Embedder = NewFakeEmbedder(8)
}

func TestFakeIsDeterministicNormalizedAndKindBlind(t *testing.T) {
	f := NewFake(64)
	a := fakeEmbedOne(t, f, "The quick brown fox")
	b := fakeEmbedOne(t, f, "The quick brown fox")
	if !reflect.DeepEqual(a, b) {
		t.Fatal("the same text gave two different vectors")
	}
	if len(a) != 64 || !isUnit(a) {
		t.Fatalf("vector has %d values and is not a unit vector", len(a))
	}
	q, err := f.Embed(context.Background(), Query, []Input{{Text: "The quick brown fox"}})
	if err != nil || !reflect.DeepEqual(q[0], a) {
		t.Fatalf("a query and a document of the same text must match exactly (err=%v)", err)
	}
	// Another instance of the same size gives the same vectors: the hash does not depend on the process.
	if !reflect.DeepEqual(fakeEmbedOne(t, NewFake(64), "The quick brown fox"), a) {
		t.Fatal("two Fakes disagree")
	}
}

func TestFakeSimilarTextsAreCloser(t *testing.T) {
	f := NewFake(256)
	base := fakeEmbedOne(t, f, "the cat sat on the mat")
	similar := fakeEmbedOne(t, f, "a cat on a mat")
	other := fakeEmbedOne(t, f, "quarterly tax filing deadline")
	if s, o := dot(base, similar), dot(base, other); s < o+0.2 {
		t.Fatalf("similar=%.3f other=%.3f: texts that share words must be clearly closer", s, o)
	}

	jp := fakeEmbedOne(t, f, "今日は晴れです")
	jpSimilar := fakeEmbedOne(t, f, "今日は雨です")
	jpOther := fakeEmbedOne(t, f, "株価の推移を確認する")
	if s, o := dot(jp, jpSimilar), dot(jp, jpOther); s < o+0.2 {
		t.Fatalf("japanese: similar=%.3f other=%.3f", s, o)
	}
	if !near(float32(dot(base, base)), 1) {
		t.Fatal("a vector is not its own cosine 1")
	}
}

func TestFakeDegenerateTexts(t *testing.T) {
	f := NewFake(16)
	for _, s := range []string{"", " ", "a", "あ", "!!", "x y"} {
		if v := fakeEmbedOne(t, f, s); !isUnit(v) {
			t.Errorf("text %q gave a vector that is not a unit vector: %v", s, v)
		}
	}
}

func TestFakeCountsCallsAndInputs(t *testing.T) {
	f := NewFakeEmbedder(32)
	if f.Calls() != 0 || f.Inputs() != 0 {
		t.Fatal("a new Fake has counts")
	}
	if got, err := f.Embed(context.Background(), Document, nil); err != nil || len(got) != 0 || f.Calls() != 0 {
		t.Fatalf("an Embed of nothing: got=%v err=%v calls=%d, want it not counted", got, err, f.Calls())
	}
	if _, err := f.Embed(context.Background(), Document, []Input{{Text: "a"}, {Text: "b"}, {Text: "c"}}); err != nil {
		t.Fatal(err)
	}
	if _, err := f.Embed(context.Background(), Query, []Input{{Text: "d"}}); err != nil {
		t.Fatal(err)
	}
	if f.Calls() != 2 || f.Inputs() != 4 {
		t.Fatalf("calls=%d inputs=%d, want 2 and 4", f.Calls(), f.Inputs())
	}
	if got := f.Seen(); !reflect.DeepEqual(got, []string{"a", "b", "c", "d"}) {
		t.Fatalf("Seen = %v", got)
	}
	got := f.Seen()
	got[0] = "changed"
	if f.Seen()[0] != "a" {
		t.Fatal("Seen hands out its own slice")
	}
}

func TestFakeFailNextFailsOnceAndFailAlwaysUntilCleared(t *testing.T) {
	f := NewFakeEmbedder(8)
	boom := errors.New("boom")
	f.FailNext(boom)
	if _, err := f.Embed(context.Background(), Document, []Input{{Text: "a"}}); !errors.Is(err, boom) {
		t.Fatalf("error = %v, want the injected one", err)
	}
	if f.Calls() != 1 || f.Inputs() != 0 {
		t.Fatalf("calls=%d inputs=%d: a failed call counts as a call, its inputs are not embedded", f.Calls(), f.Inputs())
	}
	if _, err := f.Embed(context.Background(), Document, []Input{{Text: "a"}}); err != nil {
		t.Fatalf("the call after FailNext failed too: %v", err)
	}

	f.FailAlways(boom)
	for i := 0; i < 3; i++ {
		if _, err := f.Embed(context.Background(), Document, []Input{{Text: "a"}}); !errors.Is(err, boom) {
			t.Fatalf("call %d: error = %v", i, err)
		}
	}
	f.FailAlways(nil)
	if _, err := f.Embed(context.Background(), Document, []Input{{Text: "a"}}); err != nil {
		t.Fatalf("after clearing: %v", err)
	}
	if f.Inputs() != 2 {
		t.Fatalf("inputs = %d, want only the 2 that succeeded", f.Inputs())
	}
}

func TestFakeRefusesImagesAndHonoursContext(t *testing.T) {
	f := NewFakeEmbedder(8)
	_, err := f.Embed(context.Background(), Document, []Input{{Text: "a"}, {Image: &Image{MIME: "image/png", Data: []byte{1}}}})
	if err == nil || !strings.Contains(err.Error(), "image") {
		t.Fatalf("error = %v", err)
	}
	if f.Inputs() != 0 {
		t.Fatal("nothing should have been embedded from a refused call")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := f.Embed(ctx, Document, []Input{{Text: "a"}}); !errors.Is(err, context.Canceled) {
		t.Fatalf("error = %v, want context.Canceled", err)
	}
}

func TestFakeIsSafeForConcurrentUse(t *testing.T) {
	f := NewFakeEmbedder(32)
	var wg sync.WaitGroup
	for g := 0; g < 8; g++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := 0; i < 25; i++ {
				if _, err := f.Embed(context.Background(), Document, []Input{{Text: "x"}, {Text: "y"}}); err != nil {
					t.Error(err)
				}
				_ = f.Calls()
				_ = f.Seen()
			}
		}()
	}
	wg.Wait()
	if f.Calls() != 200 || f.Inputs() != 400 {
		t.Fatalf("calls=%d inputs=%d, want 200 and 400", f.Calls(), f.Inputs())
	}
}
