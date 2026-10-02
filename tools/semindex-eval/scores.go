package main

import (
	"context"
	"fmt"
	"math"
	"sort"

	"md-memo/pkg/embed"
	"md-memo/pkg/semindex"
)

// scoreReport answers "how many results should a search panel show, and is a score cut-off any use?" for the first index built:
// for each question it takes the ranked notes with their scores and whether each is a right answer, then shows what a fixed number of
// results, an absolute score threshold and a threshold relative to the best score would have kept and shown.

type ranked struct {
	score float64
	rel   bool
}

func scoreReport(ctx context.Context, idx string, emb embed.Embedder, tr truth, weight float64, lexNorm string) error {
	var qs [][]ranked
	var nrel []int
	for _, q := range tr.Queries {
		if q.Type != "semantic" {
			continue
		}
		hits, _, err := semindex.Search(ctx, idx, emb, q.Q, semindex.SearchOptions{Limit: 200, Weight: weight, LexNorm: lexNorm})
		if err != nil {
			return err
		}
		isRel := map[string]bool{}
		for _, r := range q.Rel {
			isRel[r] = true
		}
		var rs []ranked
		for _, h := range hits {
			rs = append(rs, ranked{h.Score, isRel[fmt.Sprintf("%s#%d", h.Rel, h.Entry)]})
		}
		qs = append(qs, rs)
		nrel = append(nrel, len(isRel))
	}
	n := len(qs)
	if n == 0 {
		return nil
	}

	// what a rule shows for one question: the first `cap` results that pass keep(rank, result)
	type outcome struct{ shown, found int }
	run := func(cap int, keep func(top float64, r ranked) bool) (hit, recall, shown, empty float64) {
		for qi, rs := range qs {
			var o outcome
			for _, r := range rs {
				if o.shown == cap {
					break
				}
				if !keep(rs[0].score, r) {
					continue
				}
				o.shown++
				if r.rel {
					o.found++
				}
			}
			if o.found > 0 {
				hit++
			}
			recall += float64(o.found) / float64(max(nrel[qi], 1))
			shown += float64(o.shown)
			if o.shown == 0 {
				empty++
			}
		}
		f := float64(n)
		return hit / f, recall / f, shown / f, empty / f
	}

	fmt.Printf("\n=== how many results to show (%d questions; weight %.2f, %s) ===\n", n, weight, lexNorm)
	fmt.Println("results shown   hit (a right note among them)   recall (share of the right notes)   wrong ones shown")
	for _, cap := range []int{3, 5, 8, 10, 15, 20, 30} {
		h, rc, sh, _ := run(cap, func(float64, ranked) bool { return true })
		fmt.Printf("%-15d %-31.2f %-35.2f %.1f\n", cap, h, rc, sh-rc*avg(nrel))
	}

	fmt.Println("\n=== an absolute score threshold (at most 10 results) ===")
	fmt.Println("threshold   hit    recall  shown on average   questions with nothing shown")
	for _, t := range []float64{0.40, 0.45, 0.50, 0.55, 0.60, 0.65, 0.70} {
		h, rc, sh, em := run(10, func(_ float64, r ranked) bool { return r.score >= t })
		fmt.Printf("%-11.2f %-6.2f %-7.2f %-18.1f %.2f\n", t, h, rc, sh, em)
	}

	fmt.Println("\n=== a threshold relative to the best score (at most 10 results) ===")
	fmt.Println("share of best   hit    recall  shown on average")
	for _, r := range []float64{0.70, 0.80, 0.85, 0.90, 0.95} {
		h, rc, sh, _ := run(10, func(top float64, x ranked) bool { return x.score >= r*top })
		fmt.Printf("%-15.2f %-6.2f %-7.2f %.1f\n", r, h, rc, sh)
	}

	// the scores themselves
	var top1Rel, top1Wrong, firstRelLow []float64
	var gaps []float64
	for _, rs := range qs {
		if len(rs) == 0 {
			continue
		}
		if rs[0].rel {
			top1Rel = append(top1Rel, rs[0].score)
		} else {
			top1Wrong = append(top1Wrong, rs[0].score)
			for _, r := range rs {
				if r.rel {
					firstRelLow = append(firstRelLow, r.score)
					break
				}
			}
		}
		if len(rs) > 1 {
			gaps = append(gaps, rs[0].score-rs[1].score)
		}
	}
	fmt.Println("\n=== the scores (median, 10th and 90th percentile) ===")
	q := func(name string, xs []float64) {
		if len(xs) == 0 {
			fmt.Printf("%-52s none\n", name)
			return
		}
		sort.Float64s(xs)
		pick := func(p float64) float64 { return xs[int(math.Round(p*float64(len(xs)-1)))] }
		fmt.Printf("%-52s %.2f  (%.2f to %.2f)  n=%d\n", name, pick(0.5), pick(0.1), pick(0.9), len(xs))
	}
	q("best result, when it is a right note", top1Rel)
	q("best result, when it is NOT a right note", top1Wrong)
	q("the right note's own score, when it is not first", firstRelLow)
	q("gap between the best and the second result", gaps)
	return nil
}

func avg(xs []int) float64 {
	if len(xs) == 0 {
		return 0
	}
	s := 0
	for _, x := range xs {
		s += x
	}
	return float64(s) / float64(len(xs))
}
