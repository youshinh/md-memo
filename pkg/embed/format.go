package embed

import "strings"

// textFormat is the wording a model was trained with for the two sides of a search: the words that go in front of a question and in
// front of a passage. An e5 model, say, was trained on "query: ..." and "passage: ..." and finds less without them. The caller only
// says Query or Document (see Kind); the Embedder puts the words in.
type textFormat struct {
	query string
	doc   string
}

func (f textFormat) apply(k Kind, text string) string {
	if k == Query {
		return f.query + text
	}
	return f.doc + text
}

// textFormats are the models, by a fragment of their lower-cased name, that expect such wording; checked in order, the first hit
// wins. A model that is not listed (bge-m3, text-embedding-3-*, all-minilm...) gets the text as it is. The wording is from each
// model's own card (Qwen3-Embedding and EmbeddingGemma were checked against their Hugging Face cards; the e5, nomic, mxbai and
// snowflake wording is from memory of theirs: UNVERIFIED here, and wrong wording only lowers the quality of the matches, it does not
// break anything). A fragment is matched anywhere in the name, because Ollama and registries add a namespace and a tag
// ("hf.co/x/multilingual-e5-large-GGUF:Q8_0").
var textFormats = []struct {
	contains []string
	format   textFormat
}{
	{[]string{"multilingual-e5", "e5-small", "e5-base", "e5-large"}, textFormat{"query: ", "passage: "}},
	{[]string{"nomic-embed-text"}, textFormat{"search_query: ", "search_document: "}},
	{[]string{"embeddinggemma"}, textFormat{"task: search result | query: ", "title: none | text: "}},
	{[]string{"qwen3-embedding"}, textFormat{"Instruct: Given a web search query, retrieve relevant passages that answer the query\nQuery:", ""}}, // no space after "Query:", as its card has it
	{[]string{"mxbai-embed", "snowflake-arctic-embed"}, textFormat{"Represent this sentence for searching relevant passages: ", ""}},
}

func textFormatFor(model string) textFormat {
	m := strings.ToLower(model)
	for _, e := range textFormats {
		for _, frag := range e.contains {
			if strings.Contains(m, frag) {
				return e.format
			}
		}
	}
	return textFormat{}
}
