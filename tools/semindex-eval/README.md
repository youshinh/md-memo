# semindex-eval: measure the semantic search on notes whose answers are known

Makes synthetic daily scraps (in the app's own format) in which a few "gold" sentences are hidden among filler, journal entries,
piped logs and AI result blocks, then asks questions that avoid the gold sentences' key words, the way a person asks from memory.
It builds the index with the real code (`pkg/semindex`) and the real model, and prints how often the right note comes first
(hit@1), within the first five (hit@5), how many of the right notes are in the first ten (recall@10) and the mean reciprocal rank
(MRR), for several chunk sizes, with and without the date-and-heading header, and for several weights of the lexical score.

Only synthetic notes are read or sent; nothing of yours. The numbers in `docs/design/semantic-search-2026-10.md` section 2 come
from this tool (and from `gen.mjs`, whose random numbers are seeded, so the same notes come out every time).

```bash
# 1. the notes and their answers (300 days, about 1,800 entries, 31 queries); data/ is ignored by Git
node tools/semindex-eval/gen.mjs tools/semindex-eval/data/scraps 300

# 2. the model: Ollama with bge-m3 on this machine (ollama pull bge-m3), the default
go run ./tools/semindex-eval -scraps tools/semindex-eval/data/scraps

# English notes, and notes in both languages (a Japanese question must find the English note of the same fact, and the other way
# round; the "cross" tables score only answers written in the other language):
node tools/semindex-eval/gen.mjs tools/semindex-eval/data/en/scraps 300 en
node tools/semindex-eval/gen.mjs tools/semindex-eval/data/mixed/scraps 300 mixed
go run ./tools/semindex-eval -scraps tools/semindex-eval/data/mixed/scraps -chunks 150 -weights -1,0.05,0.1

# another model or server (an OpenAI-compatible server is used for any port but Ollama's 11434; the key is read from
# MD_MEMO_EMBED_API_KEY, never from a flag). The synthetic notes are sent there.
go run ./tools/semindex-eval -scraps tools/semindex-eval/data/scraps -base https://api.openai.com/v1 -model text-embedding-3-small
```

Flags: `-chunks 150,300,600` characters, `-headers on|off|both`, `-weights -1,0.05,0.1,0.2` (-1 = the vector alone),
`-logpenalty`, `-lexnorm idf|max` (what the lexical score is divided by; `idf` is the default, `max` the first design), `-work <dir>` to
keep the indexes (a second run on the same folder embeds nothing), `-v` to list the queries whose answer is not in the first five.
Embedding takes about 35 s per variant with bge-m3 on a GPU, so the default grid (6 variants) takes about 2.5 minutes.

## What it showed (bge-m3 through Ollama, 3,101 chunks of 150 characters, 28 meaning queries, 3 identifier queries)

| | hit@1 | hit@5 | recall@10 | MRR |
|---|---|---|---|---|
| vector alone, with the header | 0.79 | 0.82 | 0.58 | 0.81 |
| vector + 0.05 x lexical (the default) | **0.82** | **0.89** | 0.61 | **0.86** |
| vector + 0.10 x lexical | 0.79 | 0.89 | 0.59 | 0.83 |
| vector alone, no header | 0.64 | 0.75 | 0.49 | 0.69 |
| 300 or 600 characters, with the header, + 0.05 | 0.61 | 0.71 | 0.49 to 0.51 | 0.66 |

The identifier queries (an IP address in a piped log) are 1.00 in every variant. These are trends, not promises: the notes are
made from templates and each right answer is one short sentence. Re-measure on real notes before changing a default (see section
12 of the design note: write 20 to 30 questions whose right note you know, and compare the chunk size, the header, the weight).

A search takes about 19 to 48 ms on average over 3,000 to 6,000 chunks, with the index read from disk for each search (as the
command line does) and the query vector cached.
