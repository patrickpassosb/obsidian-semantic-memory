import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import Database from 'better-sqlite3';
import { VectorIndex } from '../embeddings/vectorIndex';
import { retrieveContext } from '../retrieval/orchestrator';
import { lookupEntity } from '../retrieval/entityLookup';
import { appendDailyMemory } from '../memory/writer';
import { remember, factsFor } from '../memory/lifecycle';
import type { Config } from '../config';
import type { EmbeddingProvider } from '../embeddings/types';

export function createMcpTools(
  db: Database.Database,
  vectorIndex: VectorIndex,
  provider: EmbeddingProvider,
  config: Pick<Config, 'vaultPath' | 'memoryDir' | 'priorityPaths' | 'memoryLedger'>
) {
  return {
    async vault_search(args: { query: string; topK?: number }) {
      const topK = Math.min(100, Math.max(1, args.topK ?? 5));
      const result = await retrieveContext(db, vectorIndex, provider, args.query, topK, config.priorityPaths ?? []);
      return result.hits;
    },

    async vault_fts(args: { query: string; topK?: number }) {
      const topK = Math.min(50, Math.max(1, args.topK ?? 5));
      const rows = db.prepare(
        `SELECT c.id as chunkId, c.note_path as notePath, c.heading_path as headingPath, c.text,
                bm25(chunks_fts) as score
         FROM chunks_fts
         JOIN chunks c ON c.id = chunks_fts.rowid
         WHERE chunks_fts MATCH ?
         ORDER BY score
         LIMIT ?`
      ).all(args.query, topK) as any[];
      return rows.map(r => ({ ...r, score: Math.abs(r.score), reason: 'fts' }));
    },

    async vault_entity(args: { name: string }) {
      return lookupEntity(db, args.name);
    },

    async vault_facts(args: { entityName: string; asOf?: string; includeHistory?: boolean }) {
      return factsFor(db, args.entityName, { asOf: args.asOf, includeHistory: args.includeHistory }) as any[];
    },

    /** The principal durable-memory verb: ledger-first, supersedes the current fact for the same subject+predicate. Returns a receipt. */
    async vault_remember_fact(args: { subject: string; predicate: string; object: string; source?: string }) {
      return remember(db, config.vaultPath, config.memoryLedger, args);
    },

    async vault_status(_args: {}) {
      const counts = {
        notes: (db.prepare('SELECT COUNT(*) as c FROM notes').get() as any).c,
        chunks: (db.prepare('SELECT COUNT(*) as c FROM chunks').get() as any).c,
        entities: (db.prepare('SELECT COUNT(*) as c FROM entities').get() as any).c,
        facts: (db.prepare('SELECT COUNT(*) as c FROM facts').get() as any).c,
        relations: (db.prepare('SELECT COUNT(*) as c FROM relations').get() as any).c,
      };
      return counts;
    },

    async vault_remember(args: { text: string; date?: string; source?: string }) {
      const date = args.date ?? new Date().toISOString().substring(0, 10);
      const source = args.source ?? 'mcp';
      const filePath = await appendDailyMemory(config.vaultPath, date, { text: args.text, source }, config.memoryDir);
      return { ok: true, path: filePath };
    },

    async vault_store_fact(args: { subject: string; predicate: string; object: string; confidence?: number }) {
      const now = new Date().toISOString();
      const confidence = args.confidence ?? 0.8;

      let entity = lookupEntity(db, args.subject);
      let entityId: number;
      if (entity) {
        entityId = entity.id;
      } else {
        db.prepare(
          `INSERT OR IGNORE INTO notes (path, title, kind, note_hash, modified_at, frontmatter_json) VALUES ('_mcp_', 'MCP', 'system', '_mcp_', ?, '{}')`
        ).run(now);
        const row = db.prepare(
          `INSERT INTO entities (type, canonical_name, aliases_json, source_note, confidence, updated_at) VALUES (?, ?, ?, ?, ?, ?) RETURNING id`
        ).get('concept', args.subject, '[]', '_mcp_', 1.0, now) as { id: number };
        entityId = row.id;
      }

      const row = db.prepare(
        `INSERT INTO facts (subject_entity_id, predicate, object_text, source_path, confidence, valid_from, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`
      ).get(entityId, args.predicate, args.object, '_mcp_', confidence, now, now) as { id: number };

      return { ok: true, factId: row.id };
    },
  };
}

const TOOLS = [
  {
    name: 'vault_search',
    description: 'Semantic search over the Obsidian vault. Returns relevant text chunks ranked by semantic similarity, entity matching, graph relations, and fact overlap.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Natural language search query' },
        topK: { type: 'number', description: 'Number of results (1-100, default 5)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'vault_fts',
    description: 'Full-text keyword search over vault chunks (BM25). Fast and exact. Use vault_search for semantic/conceptual queries.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Keyword or phrase to search (SQLite FTS5 syntax supported)' },
        topK: { type: 'number', description: 'Number of results (1-50, default 5)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'vault_entity',
    description: 'Look up an entity (person, project, concept) by name or alias. Returns entity details or null.',
    inputSchema: {
      type: 'object' as const,
      properties: { name: { type: 'string', description: 'Entity name or alias to look up' } },
      required: ['name'],
    },
  },
  {
    name: 'vault_remember_fact',
    description: 'Durable memory write: stores (or supersedes) a fact about a subject. Ledger-first (survives index rebuild), temporal (closes the previous current fact for that subject+predicate). Returns a receipt. Use for "remember that…" statements.',
    inputSchema: {
      type: 'object',
      properties: {
        subject: { type: 'string' }, predicate: { type: 'string' }, object: { type: 'string' }, source: { type: 'string' },
      },
      required: ['subject', 'predicate', 'object'],
    },
  },
  {
    name: 'vault_facts',
    description: 'Get facts for an entity. Default = facts currently valid (valid_to null). asOf = point-in-time, includeHistory = full temporal history.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        entityName: { type: 'string', description: 'Entity name to look up facts for' },
        asOf: { type: 'string', description: 'ISO timestamp — facts valid at that time' },
        includeHistory: { type: 'boolean', description: 'include superseded facts' },
      },
      required: ['entityName'],
    },
  },
  {
    name: 'vault_status',
    description: 'Get vault index statistics: count of notes, chunks, entities, facts, and relations.',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'vault_remember',
    description: 'Store a memory entry in the daily notes. Appends text to the daily note for the given date.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        text: { type: 'string', description: 'Text to remember' },
        date: { type: 'string', description: 'Date in YYYY-MM-DD format (defaults to today)' },
        source: { type: 'string', description: 'Source identifier (defaults to "mcp")' },
      },
      required: ['text'],
    },
  },
  {
    name: 'vault_store_fact',
    description: 'Store a structured fact. Creates entity if it does not exist. Format: subject-predicate-object (e.g. "Alice works_at Globex").',
    inputSchema: {
      type: 'object' as const,
      properties: {
        subject: { type: 'string', description: 'Subject entity name' },
        predicate: { type: 'string', description: 'Predicate (e.g. works_at, is_a, uses, located_in)' },
        object: { type: 'string', description: 'Object value' },
        confidence: { type: 'number', description: 'Confidence score 0-1 (default 0.8)' },
      },
      required: ['subject', 'predicate', 'object'],
    },
  },
];

export async function startMcpServer(
  db: Database.Database,
  vectorIndex: VectorIndex,
  provider: EmbeddingProvider,
  config: Config
) {
  const server = new Server({ name: 'osm-memory', version: '1.0.0' }, { capabilities: { tools: {} } });
  const tools = createMcpTools(db, vectorIndex, provider, config);

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const handler = (tools as any)[name];
    if (!handler) {
      return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
    }
    try {
      const result = await handler(args ?? {});
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (err: any) {
      return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
