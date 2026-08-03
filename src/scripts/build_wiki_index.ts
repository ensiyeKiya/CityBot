/**
 * Offline Wikipedia RAG indexer.
 *
 * For every building in the Postgres `buildings` table that has a Wikipedia
 * page (wiki_pageid), fetches the full Bulgarian Wikipedia article, splits it
 * into paragraph-level chunks, embeds each chunk with BAAI/bge-m3 (DeepInfra),
 * and upserts the vectors into the Qdrant collection `wiki_buildings` with
 * payload: wiki_pageid, wiki_title_bg, gml_ids, chunk_id, text, total_chunks,
 * article_chars, indexed_at.
 *
 * Idempotent: existing points of a page are deleted before re-upserting.
 *
 * Usage:
 *   npm run index:wiki                # index all pages
 *   npm run index:wiki -- --pageid 42 # (re)index a single page
 */

import dotenv from 'dotenv';
import { Pool } from 'pg';
import {
  WIKI_COLLECTION,
  ensureWikiCollection,
  fetchWikipediaArticle,
  chunkArticle,
  embedTexts,
  getQdrantClient
} from '../wikiRag';

dotenv.config();

const UPSERT_BATCH_SIZE = 100;
const WIKI_FETCH_DELAY_MS = 600; // polite delay between successful fetches

interface PageEntry {
  pageid: number;
  title: string | null;
  gmlIds: string[];
}

async function loadPagesFromDatabase(): Promise<PageEntry[]> {
  const pool = new Pool({
    host: process.env.DB_HOST || '127.0.0.1',
    port: parseInt(process.env.DB_PORT || '5434'),
    database: process.env.DB_NAME || 'citybot_wot',
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || undefined,
    connectionTimeoutMillis: 10000
  });

  try {
    const result = await pool.query(
      `SELECT gml_id, wiki_pageid, wiki_title_bg
       FROM buildings
       WHERE wiki_pageid IS NOT NULL`
    );

    // Several buildings can link to the same article — group by pageid
    const byPageid = new Map<number, PageEntry>();
    for (const row of result.rows) {
      const pageid = Number(row.wiki_pageid);
      if (!Number.isFinite(pageid)) continue;
      const entry: PageEntry = byPageid.get(pageid) || {
        pageid,
        title: row.wiki_title_bg ?? null,
        gmlIds: []
      };
      if (row.gml_id) entry.gmlIds.push(String(row.gml_id));
      byPageid.set(pageid, entry);
    }
    return [...byPageid.values()];
  } finally {
    await pool.end();
  }
}

async function indexPage(entry: PageEntry): Promise<{ chunks: number; chars: number }> {
  const qdrant = getQdrantClient();

  const article = await fetchWikipediaArticle(entry.pageid);
  const chunks = chunkArticle(article.text);
  if (chunks.length === 0) {
    throw new Error(`article produced 0 chunks (${article.text.length} chars)`);
  }

  const vectors = await embedTexts(chunks);
  const indexedAt = new Date().toISOString();

  // Remove stale points of this page first (article may have shrunk)
  await qdrant.delete(WIKI_COLLECTION, {
    wait: true,
    filter: { must: [{ key: 'wiki_pageid', match: { value: entry.pageid } }] }
  });

  const points = chunks.map((text, chunkId) => ({
    // Deterministic id: pageid * 100000 + chunk index (safe as JS integer)
    id: entry.pageid * 100000 + chunkId,
    vector: vectors[chunkId],
    payload: {
      wiki_pageid: entry.pageid,
      wiki_title_bg: article.title || entry.title,
      gml_ids: entry.gmlIds,
      chunk_id: chunkId,
      text,
      total_chunks: chunks.length,
      article_chars: article.text.length,
      indexed_at: indexedAt
    }
  }));

  for (let i = 0; i < points.length; i += UPSERT_BATCH_SIZE) {
    await qdrant.upsert(WIKI_COLLECTION, {
      wait: true,
      points: points.slice(i, i + UPSERT_BATCH_SIZE)
    });
  }

  return { chunks: chunks.length, chars: article.text.length };
}

async function main(): Promise<void> {
  const pageidArgIdx = process.argv.indexOf('--pageid');
  const onlyPageid = pageidArgIdx !== -1 ? Number(process.argv[pageidArgIdx + 1]) : null;

  console.log('🔌 Connecting to Qdrant at', process.env.QDRANT_URL || 'http://127.0.0.1:6333');
  await ensureWikiCollection();

  console.log('🔌 Loading buildings with Wikipedia pages from Postgres...');
  let pages = await loadPagesFromDatabase();
  if (onlyPageid !== null) {
    pages = pages.filter((p) => p.pageid === onlyPageid);
    if (pages.length === 0) {
      throw new Error(`pageid ${onlyPageid} not found among buildings with wiki_pageid`);
    }
  }
  console.log(`📚 ${pages.length} unique Wikipedia pages to index`);

  let ok = 0;
  let failed = 0;
  let totalChunks = 0;

  for (const [i, entry] of pages.entries()) {
    const label = `[${i + 1}/${pages.length}] pageid=${entry.pageid} "${entry.title ?? ''}"`;
    try {
      const stats = await indexPage(entry);
      totalChunks += stats.chunks;
      ok++;
      console.log(`✅ ${label}: ${stats.chunks} chunks (${stats.chars} chars, ${entry.gmlIds.length} buildings)`);
    } catch (error) {
      failed++;
      console.error(`❌ ${label}: ${error instanceof Error ? error.message : error}`);
    }
    await new Promise((res) => setTimeout(res, WIKI_FETCH_DELAY_MS));
  }

  const collectionInfo = await getQdrantClient().getCollection(WIKI_COLLECTION);
  console.log('\n📊 Indexing complete');
  console.log(`   Pages indexed: ${ok}, failed: ${failed}`);
  console.log(`   Chunks written this run: ${totalChunks}`);
  console.log(`   Points in collection: ${collectionInfo.points_count}`);

  if (failed > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error('❌ Indexer failed:', error);
  process.exit(1);
});
