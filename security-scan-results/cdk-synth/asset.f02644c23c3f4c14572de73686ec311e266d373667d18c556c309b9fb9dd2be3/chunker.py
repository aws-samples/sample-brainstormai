"""
Semantic chunking using LangChain's RecursiveCharacterTextSplitter.

Strategy: split on paragraph/sentence boundaries first, falling back to
character boundaries. This preserves semantic units better than fixed-size splits.

Chunk size: ~500 tokens (~2000 chars) with 50-token overlap (~200 chars).
"""

from langchain_text_splitters import RecursiveCharacterTextSplitter

CHUNK_SIZE = 2000       # chars (~500 tokens at ~4 chars/token)
CHUNK_OVERLAP = 200     # chars (~50 tokens)

_splitter = RecursiveCharacterTextSplitter(
    chunk_size=CHUNK_SIZE,
    chunk_overlap=CHUNK_OVERLAP,
    separators=["\n\n", "\n", ". ", "! ", "? ", " ", ""],
    length_function=len,
    is_separator_regex=False,
)


def semantic_chunk(text: str) -> list[str]:
    chunks = _splitter.split_text(text)
    # Filter out trivially short chunks (e.g. lone headers)
    return [c.strip() for c in chunks if len(c.strip()) >= 50]
