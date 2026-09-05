import fs from 'fs/promises';
import path from 'path';
import Database from 'better-sqlite3';
import { lookupEntity } from '../retrieval/entityLookup';

// ---------------------------------------------------------------------------
// Lifecycle layer — the piece that turns OSM from an index into a memory.
//
// Design: every memory event is appended to a durable Markdown ledger in the
// vault FIRST (git-tracked, survives `rm index.db`), then applied to SQLite.
// On index/rebuild, the ledger is REPLAYED (idempotently, by event id) so the
// facts table is fully reconstructible. SQLite is a derived cache, never the
// source of truth.
//
// Temporal truth: facts carry valid_from/valid_to. supersede() closes the
// current fact (valid_to=now) and opens the new one. Current-only reads are
// the default; history remains answerable via asOf / includeHistory.
// ---------------------------------------------------------------------------

export interface MemoryReceipt {
  ok: boolean;
  eventId: string;
  action: 'supersede' | 'store' | 'nochange';
  subject: string;
  predicate: string;
  closed: { factId: number; object: string; validTo: string } | null;
  created: { factId: number; object: string; validFrom: string } | null;
  ledger: string;
}

const ledgerBlock =
  /^## (mem_[A-Za-z0-9]+) · (.+?)\n((?:- [\w-]+: .*\n?)+)/gim;

function newEventId(): string {
  const t = Date.now().toString(36);
  const r = Math.random().toString(36).slice(2, 8);
  return `mem_${t}${r}`.toUpperCase();
}

export async function appendLedgerEvent(
  vaultPath: string, ledgerRelPath: string,
  ev: { id: string; at: string; kind: string; subject: string; predicate: string; object: string; closedEvent?: string | null; source: string },
): Promise<string> {
  let filePath = path.join(vaultPath, ledgerRelPath);
  if (!filePath.endsWith('.md')) filePath += '.md';
  const resolved = path.resolve(filePath);
  const base = path.resolve(path.join(vaultPath, path.dirname(ledgerRelPath)));
  if (!resolved.startsWith(base)) throw new Error('ledger path escapes vault');
  await fs.mkdir(path.dirname(resolved), { recursive: true });
  try {
    await fs.access(resolved);
  } catch {
    await fs.writeFile(resolved,
      `---\ntype: memory-ledger\ntitle: Memory Events Ledger\n---\n\n# Memory Events Ledger\n\nAppend-only durable record of memory events. Replayed on rebuild.\n`);
  }
  const lines = [
    `\n## ${ev.id} · ${ev.at}`,
    `- kind: ${ev.kind}`,
    `- subject: ${ev.subject}`,
    `- predicate: ${ev.predicate}`,
    `- object: ${ev.object.replace(/\n/g, ' ')}`,
  ];
  if (ev.closedEvent) lines.push(`- closed_event: ${ev.closedEvent}`);
  lines.push(`- source: ${ev.source.replace(/\n/g, ' ')}`, ``);
  await fs.appendFile(resolved, lines.join('\n'));
  return resolved;
}

/** Replay the ledger into facts (idempotent via event_id). Safe to run on every index/rebuild. */
export async function replayLedger(db: Database.Database, vaultPath: string, ledgerRelPath: string): Promise<number> {
  let filePath = path.join(vaultPath, ledgerRelPath);
  if (!filePath.endsWith('.md')) filePath += '.md';
  let content: string;
  try { content = await fs.readFile(filePath, 'utf-8'); } catch { return 0; }
  let applied = 0;
  for (const m of content.matchAll(ledgerBlock)) {
    const [, id, at, kv] = m;
    const fields: Record<string, string> = {};
    for (const l of kv.split('\n')) {
      const lm = /^- ([\w-]+): (.*)$/.exec(l);
      if (lm) fields[lm[1]] = lm[2];
    }
    if (!fields.subject || !fields.predicate || !fields.object) continue;
    applied += applyEvent(db, {
      id, at: at.trim(), kind: fields.kind ?? 'store',
      subject: fields.subject, predicate: fields.predicate, object: fields.object,
      closedEvent: fields.closed_event ?? null, source: fields.source ?? 'ledger',
    });
  }
  return applied;
}

/** Apply one memory event to SQLite. Idempotent: event_id is unique. */
function applyEvent(db: Database.Database, ev: {
  id: string; at: string; kind: string;
  subject: string; predicate: string; object: string;
  closedEvent: string | null; source: string;
}): number {
  if (db.prepare('SELECT id FROM facts WHERE event_id = ?').get(ev.id)) return 0;

  // resolve/create subject entity over the `_mcp_` system note
  const now = ev.at;
  let entityId = lookupEntity(db, ev.subject)?.id;
  if (!entityId) {
    db.prepare(`INSERT OR IGNORE INTO notes (path, title, kind, note_hash, modified_at, frontmatter_json) VALUES ('_mcp_', 'MCP', 'system', '_mcp_', ?, '{}')`).run(now);
    entityId = (db.prepare(
      `INSERT INTO entities (type, canonical_name, aliases_json, source_note, confidence, updated_at) VALUES ('concept', ?, '[]', '_mcp_', 1.0, ?) RETURNING id`
    ).get(ev.subject, now) as { id: number }).id;
  }

  let closedFactId: number | null = null;
  if (ev.kind === 'supersede' || ev.closedEvent) {
    const cur = db.prepare(
      `SELECT f.id FROM facts f WHERE f.subject_entity_id = ? AND f.predicate = ? AND f.valid_to IS NULL ORDER BY f.valid_from DESC LIMIT 1`
    ).get(entityId, ev.predicate) as { id: number } | undefined;
    if (cur) {
      db.prepare(`UPDATE facts SET valid_to = ?, updated_at = ? WHERE id = ?`).run(now, now, cur.id);
      closedFactId = cur.id;
    }
  }

  const row = db.prepare(
    `INSERT INTO facts (subject_entity_id, predicate, object_text, source_path, confidence, valid_from, valid_to, updated_at, event_id)
     VALUES (?, ?, ?, '_mcp_', 1.0, ?, NULL, ?, ?) RETURNING id`
  ).get(entityId, ev.predicate, ev.object, ev.at, ev.at, ev.id) as { id: number };

  db.prepare(`INSERT INTO write_events (note_path, action, summary, created_at) VALUES ('_memory_ledger_', ?, ?, ?)`)
    .run(ev.kind, `${ev.subject} ${ev.predicate} → ${ev.object}${closedFactId ? ` (closed fact ${closedFactId})` : ''}`, ev.id === undefined ? now : ev.at);
  return 1;
}

/** The principal write verb. Ledger-first, then SQLite. Idempotent on identical current value. */
export async function remember(db: Database.Database, vaultPath: string, ledgerRelPath: string, args: {
  subject: string; predicate: string; object: string; source?: string;
}): Promise<MemoryReceipt> {
  const entity = lookupEntity(db, args.subject);
  const current = entity && (db.prepare(
    `SELECT id, object_text FROM facts WHERE subject_entity_id = ? AND predicate = ? AND valid_to IS NULL ORDER BY valid_from DESC LIMIT 1`
  ).get(entity.id, args.predicate) as { id: number; object_text: string } | undefined);

  if (current && current.object_text === args.object) {
    return { ok: true, eventId: 'none', action: 'nochange', subject: args.subject, predicate: args.predicate, closed: null,
      created: { factId: current.id, object: args.object, validFrom: 'existing' }, ledger: path.join(vaultPath, ledgerRelPath) };
  }

  const at = new Date().toISOString();
  const id = newEventId();
  const kind = current ? 'supersede' : 'store';
  const ledger = await appendLedgerEvent(vaultPath, ledgerRelPath, {
    id, at, kind, subject: args.subject, predicate: args.predicate, object: args.object, source: args.source ?? 'agent',
  });
  applyEvent(db, { id, at, kind, subject: args.subject, predicate: args.predicate, object: args.object, closedEvent: null, source: args.source ?? 'agent' });
  return {
    ok: true, eventId: id, action: kind, subject: args.subject, predicate: args.predicate,
    closed: current ? { factId: current.id, object: current.object_text, validTo: at } : null,
    created: null, ledger,
  };
}

/** Current facts only by default; asOf gives point-in-time; includeHistory gives everything. */
export function factsFor(db: Database.Database, entityName: string, opts: { asOf?: string; includeHistory?: boolean } = {}) {
  const entity = lookupEntity(db, entityName);
  if (!entity) return [];
  if (opts.includeHistory) {
    return db.prepare('SELECT * FROM facts WHERE subject_entity_id = ? ORDER BY updated_at DESC').all(entity.id);
  }
  const t = opts.asOf ?? new Date().toISOString();
  return db.prepare(
    `SELECT * FROM facts WHERE subject_entity_id = ? AND valid_from <= ? AND (valid_to IS NULL OR valid_to > ?) ORDER BY valid_from DESC`
  ).all(entity.id, t, t);
}
