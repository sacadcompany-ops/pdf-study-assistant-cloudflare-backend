import {
  AnswerMode,
  Env,
  SearchMatchItem,
  SearchResponsePayload,
} from '../types';
import {
  normalizeText,
  splitIntoSentences,
  tokenizeAll,
  tokenizeKeywords,
} from './normalizer';

export const NO_ANSWER_SOMALI =
  "Ma helin jawaab ku filan oo ku jirta PDF-yada la kaydiyey. Fadlan su'aasha si kale u qor.";

interface CandidateChunkRow {
  chunk_id: string;
  document_id: string;
  document_title: string;
  page_number: number;
  word_count: number;
  chunk_text: string;
  normalized_text: string;
  matched_term: string;
  term_frequency: number;
}

/**
 * Mode A: Smart Search (BM25 + TF-IDF + Phrase & Multi-Word Coverage Ranking).
 * Zero AI; strictly deterministic SQL + mathematical scoring.
 */
export async function runSmartSearch(
  env: Env,
  question: string,
  documentId?: string | null,
  limit = 5,
): Promise<SearchResponsePayload> {
  const minThreshold = Number(env.MIN_SMART_THRESHOLD || '0.35') || 0.35;
  const keywords = tokenizeKeywords(question);
  const allTokens = tokenizeAll(question);
  const normalizedQuery = normalizeText(question);

  if (keywords.length === 0) {
    return emptyResult('smart_search');
  }

  const uniqueKeywords = Array.from(new Set(keywords)).slice(0, 16);

  // 1. Corpus stats (total indexed chunks N & average chunk length)
  const statsQuery = documentId
    ? env.DB.prepare(
        `SELECT COUNT(*) AS total_chunks, COALESCE(AVG(tc.word_count), 350) AS avg_len
         FROM text_chunks tc
         JOIN documents d ON d.id = tc.document_id
         WHERE d.processing_status = 'Completed' AND tc.document_id = ?`,
      ).bind(documentId)
    : env.DB.prepare(
        `SELECT COUNT(*) AS total_chunks, COALESCE(AVG(tc.word_count), 350) AS avg_len
         FROM text_chunks tc
         JOIN documents d ON d.id = tc.document_id
         WHERE d.processing_status = 'Completed'`,
      );

  const stats = await statsQuery.first<{ total_chunks: number; avg_len: number }>();
  const totalChunks = stats?.total_chunks ?? 0;
  const avgChunkLen = Math.max(50, stats?.avg_len ?? 350);

  if (totalChunks === 0) {
    return emptyResult('smart_search');
  }

  // 2. Document frequency (DF) per query term using indexed term_index
  const placeholders = uniqueKeywords.map(() => '?').join(',');
  const dfSql = documentId
    ? `SELECT ti.term, COUNT(DISTINCT ti.chunk_id) AS df
       FROM term_index ti
       JOIN documents d ON d.id = ti.document_id
       WHERE d.processing_status = 'Completed' AND ti.document_id = ? AND ti.term IN (${placeholders})
       GROUP BY ti.term`
    : `SELECT ti.term, COUNT(DISTINCT ti.chunk_id) AS df
       FROM term_index ti
       JOIN documents d ON d.id = ti.document_id
       WHERE d.processing_status = 'Completed' AND ti.term IN (${placeholders})
       GROUP BY ti.term`;

  const dfParams = documentId ? [documentId, ...uniqueKeywords] : uniqueKeywords;
  const dfRows = await env.DB.prepare(dfSql)
    .bind(...dfParams)
    .all<{ term: string; df: number }>();

  const dfMap = new Map<string, number>();
  for (const row of dfRows.results || []) {
    dfMap.set(row.term, row.df);
  }

  // 3. Retrieve candidate chunks matching exact terms or prefix partial matches
  const likeClauses = uniqueKeywords
    .filter((t) => t.length >= 4)
    .slice(0, 6)
    .map(() => 'ti.term LIKE ?');

  const exactSql = documentId
    ? `SELECT tc.id AS chunk_id, tc.document_id, d.title AS document_title,
              tc.page_number, tc.word_count, tc.chunk_text, tc.normalized_text,
              ti.term AS matched_term, ti.term_frequency
       FROM term_index ti
       JOIN text_chunks tc ON tc.id = ti.chunk_id
       JOIN documents d ON d.id = tc.document_id
       WHERE d.processing_status = 'Completed' AND tc.document_id = ?
         AND (ti.term IN (${placeholders})${likeClauses.length ? ' OR ' + likeClauses.join(' OR ') : ''})
       LIMIT 600`
    : `SELECT tc.id AS chunk_id, tc.document_id, d.title AS document_title,
              tc.page_number, tc.word_count, tc.chunk_text, tc.normalized_text,
              ti.term AS matched_term, ti.term_frequency
       FROM term_index ti
       JOIN text_chunks tc ON tc.id = ti.chunk_id
       JOIN documents d ON d.id = tc.document_id
       WHERE d.processing_status = 'Completed'
         AND (ti.term IN (${placeholders})${likeClauses.length ? ' OR ' + likeClauses.join(' OR ') : ''})
       LIMIT 600`;

  const prefixParams = uniqueKeywords
    .filter((t) => t.length >= 4)
    .slice(0, 6)
    .map((t) => `${t}%`);
  const candidateParams = documentId
    ? [documentId, ...uniqueKeywords, ...prefixParams]
    : [...uniqueKeywords, ...prefixParams];

  const candidateRows = await env.DB.prepare(exactSql)
    .bind(...candidateParams)
    .all<CandidateChunkRow>();

  // 4. Aggregate BM25 score per chunk
  const k1 = 1.5;
  const b = 0.75;

  interface ChunkAccumulator {
    document_id: string;
    document_title: string;
    page_number: number;
    word_count: number;
    chunk_text: string;
    normalized_text: string;
    bm25: number;
    matchedTerms: Set<string>;
  }

  const chunkMap = new Map<string, ChunkAccumulator>();
  for (const row of candidateRows.results || []) {
    let acc = chunkMap.get(row.chunk_id);
    if (!acc) {
      acc = {
        document_id: row.document_id,
        document_title: row.document_title,
        page_number: row.page_number,
        word_count: Math.max(1, row.word_count),
        chunk_text: row.chunk_text,
        normalized_text: row.normalized_text,
        bm25: 0,
        matchedTerms: new Set<string>(),
      };
      chunkMap.set(row.chunk_id, acc);
    }

    const isExactTerm = uniqueKeywords.includes(row.matched_term);
    const baseTerm = isExactTerm
      ? row.matched_term
      : uniqueKeywords.find((k) => row.matched_term.startsWith(k)) || row.matched_term;

    const df = dfMap.get(baseTerm) ?? 1;
    const idf = Math.log(1 + (totalChunks - df + 0.5) / (df + 0.5));
    const tf = row.term_frequency;
    const lenNorm = 1 - b + b * (acc.word_count / avgChunkLen);
    const termScore = idf * ((tf * (k1 + 1)) / (tf + k1 * lenNorm));

    // Exact match gets full weight, prefix partial match gets 0.65x weight
    acc.bm25 += isExactTerm ? termScore : termScore * 0.65;
    acc.matchedTerms.add(baseTerm);
  }

  // 5. Compute normalized composite score (0.0 - 1.0+) with phrase & coverage boosts
  const scored: SearchMatchItem[] = [];
  const maxPossibleIdf = Math.max(
    1,
    uniqueKeywords.reduce((sum, kw) => {
      const df = dfMap.get(kw) ?? 1;
      return sum + Math.log(1 + (totalChunks - df + 0.5) / (df + 0.5));
    }, 0),
  );

  for (const acc of chunkMap.values()) {
    const coverage = acc.matchedTerms.size / uniqueKeywords.length;
    // Reject single-term noise when the question has 3+ distinct meaningful keywords
    if (uniqueKeywords.length >= 3 && acc.matchedTerms.size < 2 && !acc.normalized_text.includes(normalizedQuery)) {
      continue;
    }

    const phraseMatch =
      normalizedQuery.length >= 6 &&
      allTokens.length >= 2 &&
      acc.normalized_text.includes(normalizedQuery);

    const normalizedBm25 = Math.min(1.0, acc.bm25 / (maxPossibleIdf * 1.15));
    const score =
      normalizedBm25 * 0.55 +
      coverage * 0.35 +
      (phraseMatch ? 0.35 : 0.0);

    if (score >= minThreshold) {
      const excerpt = extractBestPassage(acc.chunk_text, uniqueKeywords, normalizedQuery);
      scored.push({
        document_id: acc.document_id,
        document_title: acc.document_title,
        page_number: acc.page_number,
        relevance_score: Number(Math.min(1.0, score).toFixed(3)),
        matched_text: excerpt,
        matched_terms: Array.from(acc.matchedTerms),
      });
    }
  }

  scored.sort((a, bScore) => bScore.relevance_score - a.relevance_score);

  // Deduplicate by document + page
  const deduped: SearchMatchItem[] = [];
  const seenPage = new Set<string>();
  for (const item of scored) {
    const key = `${item.document_id}:${item.page_number}`;
    if (!seenPage.has(key)) {
      seenPage.add(key);
      deduped.push(item);
    }
    if (deduped.length >= limit) break;
  }

  if (deduped.length === 0) {
    return emptyResult('smart_search');
  }

  const top = deduped[0];
  return {
    found: true,
    answer: top.matched_text,
    answer_mode: 'smart_search',
    document_id: top.document_id,
    document_title: top.document_title,
    page_number: top.page_number,
    relevance_score: top.relevance_score,
    matched_text: top.matched_text,
    results: deduped,
  };
}

/**
 * Mode B: Exact Answer.
 * Splits original PDF text into verbatim sentences and ranks them purely by keyword/phrase overlap.
 * Never rewrites, summarizes, paraphrases, or invents sentences.
 */
export async function runExactAnswer(
  env: Env,
  question: string,
  documentId?: string | null,
  limit = 5,
): Promise<SearchResponsePayload> {
  const minThreshold = Number(env.MIN_EXACT_THRESHOLD || '0.30') || 0.30;
  const keywords = Array.from(new Set(tokenizeKeywords(question))).slice(0, 16);
  const allTokens = tokenizeAll(question);
  const normalizedQuery = normalizeText(question);

  if (keywords.length === 0) {
    return emptyResult('exact_answer');
  }

  // Pre-filter candidate pages using term_index so we don't scan entire DB on large corpora
  const placeholders = keywords.map(() => '?').join(',');
  const pageSql = documentId
    ? `SELECT DISTINCT dp.document_id, d.title AS document_title, dp.page_number, dp.original_text
       FROM document_pages dp
       JOIN documents d ON d.id = dp.document_id
       JOIN text_chunks tc ON tc.document_id = dp.document_id AND tc.page_number = dp.page_number
       JOIN term_index ti ON ti.chunk_id = tc.id
       WHERE d.processing_status = 'Completed' AND dp.document_id = ? AND ti.term IN (${placeholders})
       LIMIT 80`
    : `SELECT DISTINCT dp.document_id, d.title AS document_title, dp.page_number, dp.original_text
       FROM document_pages dp
       JOIN documents d ON d.id = dp.document_id
       JOIN text_chunks tc ON tc.document_id = dp.document_id AND tc.page_number = dp.page_number
       JOIN term_index ti ON ti.chunk_id = tc.id
       WHERE d.processing_status = 'Completed' AND ti.term IN (${placeholders})
       LIMIT 80`;

  const params = documentId ? [documentId, ...keywords] : keywords;
  const pageRows = await env.DB.prepare(pageSql)
    .bind(...params)
    .all<{
      document_id: string;
      document_title: string;
      page_number: number;
      original_text: string;
    }>();

  const matches: SearchMatchItem[] = [];
  const seenSentence = new Set<string>();

  for (const page of pageRows.results || []) {
    const sentences = splitIntoSentences(page.original_text);
    for (const sentence of sentences) {
      const normSentence = normalizeText(sentence);
      if (!normSentence) continue;

      const sentenceTokens = new Set(tokenizeAll(normSentence));
      const matchedTerms: string[] = [];

      for (const kw of keywords) {
        if (sentenceTokens.has(kw)) {
          matchedTerms.push(kw);
        } else if (kw.length >= 4) {
          for (const st of sentenceTokens) {
            if (st.startsWith(kw) || kw.startsWith(st)) {
              matchedTerms.push(kw);
              break;
            }
          }
        }
      }

      if (matchedTerms.length === 0) continue;
      if (keywords.length >= 3 && matchedTerms.length < 2 && !normSentence.includes(normalizedQuery)) {
        continue;
      }

      const coverage = matchedTerms.length / keywords.length;
      const phraseBonus =
        normalizedQuery.length >= 6 &&
        allTokens.length >= 2 &&
        normSentence.includes(normalizedQuery)
          ? 0.4
          : 0.0;
      // Slight preference for concise, informative sentences over giant fragments
      const lengthFactor = sentence.length > 450 ? 0.85 : 1.0;
      const score = Math.min(1.0, (coverage * 0.78 + phraseBonus) * lengthFactor);

      if (score >= minThreshold) {
        const dedupKey = normSentence.slice(0, 120);
        if (!seenSentence.has(dedupKey)) {
          seenSentence.add(dedupKey);
          matches.push({
            document_id: page.document_id,
            document_title: page.document_title,
            page_number: page.page_number,
            relevance_score: Number(score.toFixed(3)),
            matched_text: sentence, // Strictly verbatim!
            matched_terms: matchedTerms,
          });
        }
      }
    }
  }

  matches.sort((a, b) => b.relevance_score - a.relevance_score);
  const topMatches = matches.slice(0, limit);

  if (topMatches.length === 0) {
    return emptyResult('exact_answer');
  }

  const top = topMatches[0];
  return {
    found: true,
    answer: top.matched_text,
    answer_mode: 'exact_answer',
    document_id: top.document_id,
    document_title: top.document_title,
    page_number: top.page_number,
    relevance_score: top.relevance_score,
    matched_text: top.matched_text,
    results: topMatches,
  };
}

function extractBestPassage(
  chunkText: string,
  keywords: string[],
  normalizedQuery: string,
): string {
  const sentences = splitIntoSentences(chunkText);
  if (sentences.length <= 3) return chunkText.trim();

  let bestIdx = 0;
  let bestScore = -1;

  for (let i = 0; i < sentences.length; i++) {
    const norm = normalizeText(sentences[i]);
    let s = 0;
    if (normalizedQuery.length >= 6 && norm.includes(normalizedQuery)) {
      s += 5;
    }
    for (const kw of keywords) {
      if (norm.includes(kw)) s += 1;
    }
    if (s > bestScore) {
      bestScore = s;
      bestIdx = i;
    }
  }

  const start = Math.max(0, bestIdx - 1);
  const end = Math.min(sentences.length, bestIdx + 2);
  return sentences.slice(start, end).join(' ');
}

function emptyResult(mode: AnswerMode): SearchResponsePayload {
  return {
    found: false,
    answer: NO_ANSWER_SOMALI,
    answer_mode: mode,
    document_id: null,
    document_title: null,
    page_number: null,
    relevance_score: 0,
    matched_text: null,
    results: [],
  };
}
