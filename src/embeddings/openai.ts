import OpenAI from 'openai';
import { EmbeddingProvider } from './types';

/**
 * Generic OpenAI-compatible embeddings provider.
 * Works with OpenAI, Voyage AI (voyageai.com, OpenAI-shaped /v1/embeddings),
 * and any compatible gateway. Configured via EMBEDDING_BASE_URL and
 * EMBEDDING_DIMS (defaults preserve upstream OpenAI behavior).
 */
export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  dimensions: number;
  private clients: OpenAI[] = [];
  private cooldown = new Map<number, number>();
  private rr = 0;
  private model: string;

  constructor(apiKeys: string | string[], model?: string, baseURL?: string, dimensions?: number) {
    const keys = Array.isArray(apiKeys) ? apiKeys.filter(Boolean) : [apiKeys];
    if (keys.length === 0) throw new Error('at least one API key required');
    this.model = model ?? 'text-embedding-3-small';
    this.dimensions = dimensions ?? 1536;
    this.clients = keys.map(apiKey => new OpenAI({ apiKey, baseURL }));
  }

  /** next healthy client index (round-robin over non-cooling keys) */
  private nextClient(): number {
    const now = Date.now();
    for (let t = 0; t < this.clients.length; t++) {
      const i = (this.rr + t) % this.clients.length;
      if ((this.cooldown.get(i) ?? 0) <= now) { this.rr = i + 1; return i; }
    }
    return -1; // all cooling
  }

  async embed(texts: string[]): Promise<number[][]> {
    const results: number[][] = [];
    const batchSize = Number(process.env.EMBEDDING_BATCH_SIZE) || 32;
    for (let i = 0; i < texts.length; i += batchSize) {
      const batch = texts.slice(i, i + batchSize);
      results.push(...(await this.embedWithRetry(batch)));
    }
    return results;
  }

  /** Retries on 429/5xx with exponential backoff; on 429 rotates to the next healthy key first. */
  private async embedWithRetry(batch: string[], attempt = 0): Promise<number[][]> {
    const ci = this.nextClient();
    if (ci === -1) {
      const waitMs = Math.max(2000, 1000 * 2 ** Math.min(attempt, 8));
      await new Promise(r => setTimeout(r, waitMs));
      return this.embedWithRetry(batch, attempt + 1);
    }
    try {
      const res = await this.clients[ci].embeddings.create({ model: this.model, input: batch });
      return res.data.map(d => d.embedding);
    } catch (e: any) {
      const status = e?.status;
      if (status === 429 && attempt < 40) {
        this.cooldown.set(ci, Date.now() + 60_000);
        return this.embedWithRetry(batch, attempt + 1); // immediate retry on another key
      }
      if (status >= 500 && status < 600 && attempt < 10) {
        const waitMs = Math.max(Number(e?.headers?.get?.('retry-after')) * 1000 || 0, 1000 * 2 ** attempt, 2000);
        await new Promise(r => setTimeout(r, waitMs));
        return this.embedWithRetry(batch, attempt + 1);
      }
      throw e;
    }
  }
}
