# Analysis Documents

Drop **ICP**, **sentiment**, and **lead-scoring** guidelines here. The AI insights analyzer loads every `.md` and `.txt` file in this folder (sorted by filename) and uses them **only** for session analysis — separate from the main RAG knowledge base.

## Adding documents

1. Add a new `.md` or `.txt` file to this folder.
2. Use numeric prefixes to control order, e.g. `01-icp.md`, `02-sentiment-rubric.md`.
3. Re-run analysis on a session (or send a new chat message) to pick up changes.

## Examples of what to add

- Ideal customer profile (ICP) criteria
- Sentiment classification rules
- Lead type definitions (hot / warm / cold)
- Industry-specific scoring notes
- Disqualifier lists

Do **not** put general company/product PDFs here — those belong in `knowledge/` for the chatbot RAG pipeline.
