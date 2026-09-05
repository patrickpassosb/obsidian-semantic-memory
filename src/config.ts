export interface Config {
  vaultPath: string;
  dbPath: string;
  embeddingProvider: 'openai' | 'local';
  openaiApiKey?: string;
  embeddingModel?: string;
  embeddingBaseURL?: string;
  embeddingDims?: number;
  chunkMaxTokens: number;
  chunkOverlapTokens: number;
  priorityPaths: string[];
  memoryDir: string;
  llmExtraction: boolean;
  indexConcurrency: number;
}

export function loadConfig(): Config {
  const vaultPath = process.env.VAULT_PATH;
  if (!vaultPath) throw new Error('VAULT_PATH environment variable is required');

  const rawProvider = process.env.EMBEDDING_PROVIDER ?? 'openai';
  if (rawProvider !== 'openai' && rawProvider !== 'local') {
    throw new Error(`Invalid EMBEDDING_PROVIDER "${rawProvider}": must be "openai" or "local"`);
  }
  const embeddingProvider = rawProvider as 'openai' | 'local';

  if (embeddingProvider === 'openai') {
    const key = process.env.OPENAI_API_KEY;
    if (!key || key.trim() === '') {
      throw new Error('OPENAI_API_KEY is required when EMBEDDING_PROVIDER is "openai"');
    }
  }

  const chunkMaxTokens = Number(process.env.CHUNK_MAX_TOKENS ?? 400);
  if (!Number.isFinite(chunkMaxTokens) || chunkMaxTokens <= 0) {
    throw new Error('CHUNK_MAX_TOKENS must be a positive number');
  }

  const chunkOverlapTokens = Number(process.env.CHUNK_OVERLAP_TOKENS ?? 50);
  if (!Number.isFinite(chunkOverlapTokens) || chunkOverlapTokens < 0) {
    throw new Error('CHUNK_OVERLAP_TOKENS must be a non-negative number');
  }

  if (chunkOverlapTokens >= chunkMaxTokens) {
    throw new Error('CHUNK_OVERLAP_TOKENS must be less than CHUNK_MAX_TOKENS');
  }

  const indexConcurrency = Number(process.env.INDEX_CONCURRENCY ?? 5);

  const rawPriorityPaths = process.env.PRIORITY_PATHS ?? '';
  const priorityPaths = rawPriorityPaths ? rawPriorityPaths.split(',').map(p => p.trim()).filter(Boolean) : [];

  return {
    vaultPath,
    dbPath: process.env.DB_PATH ?? `${vaultPath}/.semantic-memory/index.db`,
    embeddingProvider,
    openaiApiKey: process.env.OPENAI_API_KEY,
    embeddingModel: process.env.EMBEDDING_MODEL,
    embeddingBaseURL: process.env.EMBEDDING_BASE_URL,
    embeddingDims: process.env.EMBEDDING_DIMS ? parseInt(process.env.EMBEDDING_DIMS, 10) : undefined,
    chunkMaxTokens,
    chunkOverlapTokens,
    priorityPaths,
    memoryDir: process.env.MEMORY_DIR ?? 'Memory/Daily',
    llmExtraction: process.env.LLM_EXTRACTION === 'true',
    indexConcurrency: Math.max(1, Math.min(20, indexConcurrency)),
  };
}
