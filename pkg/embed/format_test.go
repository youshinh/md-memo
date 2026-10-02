package embed

import "testing"

func TestTextFormatTable(t *testing.T) {
	cases := []struct {
		model      string
		query, doc string // what the text "x" becomes
	}{
		{"bge-m3", "x", "x"},
		{"text-embedding-3-small", "x", "x"},
		{"all-minilm", "x", "x"},
		{"multilingual-e5-large", "query: x", "passage: x"},
		{"intfloat/multilingual-e5-small", "query: x", "passage: x"},
		{"hf.co/someone/e5-base-v2-GGUF:Q8_0", "query: x", "passage: x"},
		{"e5-mistral-7b-instruct", "x", "x"}, // another wording entirely: left alone rather than given the wrong one
		{"nomic-embed-text:latest", "search_query: x", "search_document: x"},
		{"embeddinggemma", "task: search result | query: x", "title: none | text: x"},
		{"qwen3-embedding:0.6b", "Instruct: Given a web search query, retrieve relevant passages that answer the query\nQuery:x", "x"},
		{"mxbai-embed-large", "Represent this sentence for searching relevant passages: x", "x"},
		{"MXBAI-Embed-Large", "Represent this sentence for searching relevant passages: x", "x"},
	}
	for _, c := range cases {
		f := textFormatFor(c.model)
		if got := f.apply(Query, "x"); got != c.query {
			t.Errorf("%s: query = %q, want %q", c.model, got, c.query)
		}
		if got := f.apply(Document, "x"); got != c.doc {
			t.Errorf("%s: document = %q, want %q", c.model, got, c.doc)
		}
	}
}
