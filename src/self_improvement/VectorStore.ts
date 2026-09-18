// src/self_improvement/VectorStore.ts

/**
 * A very lightweight in‑memory vector store used by the self‑improvement engine.
 * It stores embeddings (as number[] arrays) together with an identifier and the
 * original content (markdown). For production you would replace this with a
 * proper FAISS / pgvector store, but this implementation is sufficient for
 * testing the pipeline.
 */

interface DocumentEntry {
  id: string;
  embedding: number[];
  content: string;
}

export class VectorStore {
  private entries: DocumentEntry[] = [];

  /** Add a document (or update an existing one) to the store. */
  addDocument(id: string, embedding: number[], content: string): void {
    const existingIdx = this.entries.findIndex((e) => e.id === id);
    if (existingIdx >= 0) {
      this.entries[existingIdx] = { id, embedding, content };
    } else {
      this.entries.push({ id, embedding, content });
    }
  }

  /** Compute the cosine similarity between two vectors. */
  private static cosine(a: number[], b: number[]): number {
    let dot = 0;
    let normA = 0;
    let normB = 0;
    const len = Math.min(a.length, b.length);
    for (let i = 0; i < len; i++) {
      dot += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    if (normA === 0 || normB === 0) return 0;
    return dot / (Math.sqrt(normA) * Math.sqrt(normB));
  }

  /** Return the top K most similar documents for a query embedding. */
  similaritySearch(queryEmbedding: number[], topK = 5): DocumentEntry[] {
    const scored = this.entries.map((entry) => ({
      entry,
      score: VectorStore.cosine(queryEmbedding, entry.embedding),
    }));
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK).map((s) => s.entry);
  }
}
