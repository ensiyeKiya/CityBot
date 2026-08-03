/**
 * Knowledge Thing — answers building-level questions through the Wikipedia
 * RAG pipeline (offline Qdrant index + query-time semantic retrieval).
 */

import { searchWikiChunks, WIKI_LANG } from '../wikiRag';
import { tracer, THING_IDS, SECURITY_SCHEME, httpForm } from './shared';

const TITLE = 'knowledge';

export async function exposeKnowledgeThing(WoT: any): Promise<any> {
  const thing = await WoT.produce({
    id: THING_IDS.knowledge,
    title: TITLE,
    description: 'Knowledge Thing: building-level knowledge through the Wikipedia RAG pipeline with semantic retrieval',
    ...SECURITY_SCHEME,
    properties: {},
    events: {},
    actions: {
      getWikipediaSummary: {
        description: 'Retrieves relevant Wikipedia article sections for the selected building using semantic search. Call this when the user asks a question about the building and the answer is NOT found in the building metadata. Always pass the user\'s question as the query parameter to enable smart section retrieval. Requires wiki_pageid from selectedBuilding. Returns condensed article content focused on the query.',
        input: {
          type: 'object',
          properties: {
            pageid: { type: 'number', description: 'Wikipedia page ID (BG)' },
            query: { type: 'string', description: 'used to find relevant sections' }
          },
          required: ['pageid', 'query']
        },
        output: { type: 'object' },
        forms: httpForm(TITLE, 'actions', 'getWikipediaSummary', ['invokeaction'])
      }
    }
  });

  thing.setActionHandler('getWikipediaSummary', async (params: any) => {
    const span = tracer.startSpan('getWikipediaSummary');
    try {
      let input = params && typeof params.value === 'function' ? await params.value() : params || {};
      const pageid = Number(input?.pageid);
      const query = input?.query ? String(input.query).trim() : '';

      if (!Number.isFinite(pageid)) return { error: true, message: 'pageid is required' };
      if (!query) return { error: true, message: 'query is required for semantic search' };

      console.log(`🔍 Wiki RAG search: pageid=${pageid}, query="${query}"`);

      // Embed ONLY the query and retrieve pre-indexed chunks from Qdrant
      const hits = await searchWikiChunks(pageid, query, 5);

      if (hits.length === 0) {
        return {
          error: true,
          message: `No indexed Wikipedia content for pageid ${pageid}. The offline index may be out of date (run: npm run index:wiki -- --pageid ${pageid}).`
        };
      }

      const condensedArticle = hits
        .map((hit, idx) => {
          console.log(`  ${idx + 1}. Relevance: ${Math.round(hit.score * 100)}% - "${hit.text.substring(0, 80)}..."`);
          return hit.text;
        })
        .join('\n\n');

      const articleChars = hits[0].articleChars || condensedArticle.length;
      console.log(`✅ Retrieved ${hits.length}/${hits[0].totalChunks} chunks (${condensedArticle.length}/${articleChars} chars)`);

      return {
        success: true,
        pageid,
        title: hits[0].title,
        article: condensedArticle, // ONLY relevant sections found by semantic search
        relevantSections: hits.length,
        totalSections: hits[0].totalChunks,
        compressionRatio: Math.round(condensedArticle.length / articleChars * 100),
        lang: WIKI_LANG
      };
    } catch (error) {
      console.error('Error in getWikipediaSummary handler:', error);
      const msg = error instanceof Error ? error.message : String(error);
      return { error: true, message: `Failed to fetch Wikipedia summary: ${msg}` };
    } finally {
      span.end();
    }
  });

  await thing.expose();
  console.log(`✅ Knowledge Thing exposed as "${TITLE}"`);
  return thing;
}
