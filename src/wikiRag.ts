/**
 * Wikipedia RAG for building knowledge.
 *
 * Offline: articles for buildings with a Wikipedia page are fetched, chunked,
 * embedded with BAAI/bge-m3 (DeepInfra) and stored in Qdrant
 * (see src/scripts/build_wiki_index.ts).
 *
 * Online: only the user query is embedded; relevant chunks are retrieved from
 * Qdrant filtered by wiki_pageid.
 */

import OpenAI from 'openai';
import fetch from 'node-fetch';
import { QdrantClient } from '@qdrant/js-client-rest';

export const WIKI_COLLECTION = 'wiki_buildings';
export const EMBEDDING_MODEL = 'BAAI/bge-m3';
export const EMBEDDING_DIM = 1024;
export const WIKI_LANG = 'bg';

// ---------------------------------------------------------------------------
// Clients
// ---------------------------------------------------------------------------

let embeddingClient: OpenAI | null = null;

export function getEmbeddingClient(): OpenAI {
  if (!embeddingClient) {
    embeddingClient = new OpenAI({
      apiKey: process.env.DEEPINFRA_API_KEY || process.env.OPENAI_API_KEY,
      baseURL: 'https://api.deepinfra.com/v1/openai'
    });
  }
  return embeddingClient;
}

let qdrantClient: QdrantClient | null = null;

export function getQdrantClient(): QdrantClient {
  if (!qdrantClient) {
    qdrantClient = new QdrantClient({
      url: process.env.QDRANT_URL || 'http://127.0.0.1:6333'
    });
  }
  return qdrantClient;
}

/** Create the wiki collection with payload indexes if it does not exist yet. */
export async function ensureWikiCollection(): Promise<void> {
  const client = getQdrantClient();
  const collections = await client.getCollections();
  if (collections.collections.some((c) => c.name === WIKI_COLLECTION)) return;

  await client.createCollection(WIKI_COLLECTION, {
    vectors: { size: EMBEDDING_DIM, distance: 'Cosine' }
  });
  await client.createPayloadIndex(WIKI_COLLECTION, {
    field_name: 'wiki_pageid',
    field_schema: 'integer'
  });
  await client.createPayloadIndex(WIKI_COLLECTION, {
    field_name: 'gml_ids',
    field_schema: 'keyword'
  });
  console.log(`✅ Created Qdrant collection "${WIKI_COLLECTION}" (dim=${EMBEDDING_DIM}, cosine)`);
}

// ---------------------------------------------------------------------------
// Wikipedia fetching and text processing
// ---------------------------------------------------------------------------

const WIKI_RETRY_DELAYS_MS = [2000, 5000, 15000];

/** Fetch the complete article for a pageid from the MediaWiki parse API.
 *  Retries up to 3 times on HTTP 429 with exponential back-off. */
export async function fetchWikipediaArticle(
  pageid: number,
  lang: string = WIKI_LANG
): Promise<{ title: string; text: string }> {
  const api = `https://${lang}.wikipedia.org/w/api.php?action=parse&prop=text&pageid=${encodeURIComponent(
    String(pageid)
  )}&format=json&origin=*`;

  for (let attempt = 0; attempt <= WIKI_RETRY_DELAYS_MS.length; attempt++) {
    const res = await fetch(api, { headers: { Accept: 'application/json' } as any });
    if (res.status === 429 && attempt < WIKI_RETRY_DELAYS_MS.length) {
      const waitMs = WIKI_RETRY_DELAYS_MS[attempt];
      console.warn(`  ⏳ Wikipedia 429 for pageid ${pageid}, retrying in ${waitMs}ms (attempt ${attempt + 1}/${WIKI_RETRY_DELAYS_MS.length})...`);
      await new Promise((r) => setTimeout(r, waitMs));
      continue;
    }
    if (!res.ok) {
      throw new Error(`Wikipedia API error for pageid ${pageid}: HTTP ${res.status}`);
    }
    const data: any = await res.json();
    if (!data.parse || !data.parse.text) {
      throw new Error(`Wikipedia article for pageid ${pageid} not found or empty`);
    }
    const html = data.parse.text['*'] || '';
    return { title: data.parse.title || '', text: htmlToPlainText(html) };
  }
  throw new Error(`Wikipedia API error for pageid ${pageid}: HTTP 429 after all retries`);
}

/** Convert Wikipedia article HTML to plain text, preserving paragraph breaks. */
export function htmlToPlainText(htmlContent: string): string {
  return (
    htmlContent
      // Remove script, style, and reference tags
      .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
      .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
      .replace(/<sup\b[^>]*>.*?<\/sup>/gi, '')
      // Remove heading "[edit | edit source]" widgets
      .replace(/<span class="mw-editsection"[\s\S]*?<\/span><\/span>/gi, '')
      // IMPORTANT: Convert paragraph/div tags to double newlines BEFORE removing tags
      .replace(/<\/p>/gi, '\n\n')
      .replace(/<p[^>]*>/gi, '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/div>/gi, '\n\n')
      .replace(/<div[^>]*>/gi, '')
      .replace(/<\/li>/gi, '\n')
      .replace(/<\/h[1-6]>/gi, '\n\n')
      // Remove all remaining HTML tags
      .replace(/<[^>]+>/g, ' ')
      // Decode HTML entities
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#039;/g, "'")
      .replace(/&ldquo;/g, '"')
      .replace(/&rdquo;/g, '"')
      .replace(/&#\d+;/g, ' ')
      // Remove any residual edit-section text (bg wiki)
      .replace(/\[\s*редактиране(\s*\|\s*редактиране на кода)?\s*\]/g, '')
      // Clean up whitespace BUT PRESERVE paragraph breaks (double newlines)
      .replace(/ +/g, ' ')
      .replace(/\n /g, '\n')
      .replace(/ \n/g, '\n')
      .replace(/\n\n\n+/g, '\n\n')
      .trim()
  );
}

const MIN_CHUNK_CHARS = 300;
const MAX_CHUNK_CHARS = 1200;

/**
 * Split plain article text into paragraph-level chunks.
 * Consecutive short paragraphs are merged until MIN_CHUNK_CHARS; oversized
 * paragraphs are split at sentence boundaries below MAX_CHUNK_CHARS.
 */
export function chunkArticle(text: string): string[] {
  const paragraphs = text
    .split(/\n\n+/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);

  const chunks: string[] = [];
  let buffer = '';

  const flush = () => {
    const trimmed = buffer.trim();
    if (trimmed.length >= 100) chunks.push(trimmed); // drop residual noise
    buffer = '';
  };

  for (const paragraph of paragraphs) {
    if (paragraph.length > MAX_CHUNK_CHARS) {
      flush();
      // Split long paragraph at sentence boundaries
      const sentences = paragraph.match(/[^.!?]+[.!?]+\s*|[^.!?]+$/g) || [paragraph];
      for (const sentence of sentences) {
        if (buffer.length + sentence.length > MAX_CHUNK_CHARS) flush();
        buffer += sentence;
      }
      flush();
      continue;
    }
    if (buffer.length + paragraph.length + 2 > MAX_CHUNK_CHARS) flush();
    buffer += (buffer ? '\n\n' : '') + paragraph;
    if (buffer.length >= MIN_CHUNK_CHARS) flush();
  }
  flush();

  return chunks;
}

// ---------------------------------------------------------------------------
// Embeddings
// ---------------------------------------------------------------------------

const EMBEDDING_BATCH_SIZE = 64;

/** Embed texts with bge-m3 in batches. Throws on failure (no fallback). */
export async function embedTexts(texts: string[]): Promise<number[][]> {
  const client = getEmbeddingClient();
  const vectors: number[][] = [];
  for (let i = 0; i < texts.length; i += EMBEDDING_BATCH_SIZE) {
    const batch = texts.slice(i, i + EMBEDDING_BATCH_SIZE);
    const response = await client.embeddings.create({
      model: EMBEDDING_MODEL,
      input: batch
    });
    vectors.push(...response.data.map((d) => d.embedding));
  }
  return vectors;
}

// ---------------------------------------------------------------------------
// Retrieval
// ---------------------------------------------------------------------------

export interface WikiSearchHit {
  text: string;
  score: number;
  chunkId: number;
  totalChunks: number;
  articleChars: number;
  title: string;
}

/**
 * Retrieve the topK most relevant chunks of the article `wiki_pageid` for a
 * user query. Embeds ONLY the query; chunk vectors come from the offline index.
 */
export async function searchWikiChunks(
  pageid: number,
  query: string,
  topK: number = 5
): Promise<WikiSearchHit[]> {
  const [queryVector] = await embedTexts([query]);

  const result = await getQdrantClient().search(WIKI_COLLECTION, {
    vector: queryVector,
    limit: topK,
    filter: {
      must: [{ key: 'wiki_pageid', match: { value: pageid } }]
    },
    with_payload: true
  });

  return result.map((hit) => ({
    text: String(hit.payload?.text ?? ''),
    score: hit.score,
    chunkId: Number(hit.payload?.chunk_id ?? -1),
    totalChunks: Number(hit.payload?.total_chunks ?? 0),
    articleChars: Number(hit.payload?.article_chars ?? 0),
    title: String(hit.payload?.wiki_title_bg ?? '')
  }));
}
