// Deterministic bilingual (English + Somali) text normalization, chunking, and sentence splitting.
// Zero AI / zero external APIs.

const STOPWORDS = new Set([
  // English stopwords
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'been', 'being', 'by', 'for',
  'from', 'had', 'has', 'have', 'he', 'her', 'here', 'him', 'his', 'how',
  'i', 'if', 'in', 'into', 'is', 'it', 'its', 'just', 'me', 'more', 'most',
  'my', 'no', 'not', 'of', 'on', 'or', 'our', 'out', 'she', 'so', 'some',
  'such', 'than', 'that', 'the', 'their', 'them', 'then', 'there', 'these',
  'they', 'this', 'those', 'to', 'too', 'up', 'us', 'very', 'was', 'we',
  'were', 'what', 'when', 'where', 'which', 'who', 'why', 'will', 'with',
  'would', 'you', 'your',
  // Somali stopwords
  'iyo', 'oo', 'ee', 'ah', 'in', 'uu', 'ay', 'ayaa', 'waxaa', 'ku', 'ka',
  'la', 'u', 'si', 'marka', 'haddii', 'ama', 'balse', 'laakiin', 'waa',
  'yahay', 'tahay', 'yihiin', 'ahaan', 'kuwa', 'kaas', 'tan', 'kan', 'mid',
  'maxaa', 'sidee', 'goorma', 'xaggee', 'yaa', 'waxay', 'wuxuu', 'iska',
  'dhex', 'kale', 'iyo', 'oo', 'soo',
]);

export function normalizeText(raw: string): string {
  return raw
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    // Normalize curly quotes/apostrophes and Somali glottal markers
    .replace(/[\u2018\u2019\u02BC`']/g, '')
    // Replace punctuation and symbols with spaces, keeping Unicode letters/digits
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function tokenizeAll(raw: string): string[] {
  const norm = normalizeText(raw);
  if (!norm) return [];
  return norm.split(' ').filter((t) => t.length >= 2);
}

export function tokenizeKeywords(raw: string): string[] {
  const all = tokenizeAll(raw);
  const keywords = all.filter((t) => !STOPWORDS.has(t));
  // If every word was a stopword (e.g., short query), fall back to all tokens
  return keywords.length > 0 ? keywords : all;
}

export function countTermFrequencies(tokens: string[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const token of tokens) {
    map.set(token, (map.get(token) ?? 0) + 1);
  }
  return map;
}

export interface ChunkResult {
  page_number: number;
  chunk_index: number;
  word_count: number;
  chunk_text: string;
  normalized_text: string;
}

/**
 * Splits a page's original text into 300-500 word chunks (preserving exact page numbers).
 * If a page has fewer than 300 words, keeps it as a single chunk so short pages remain searchable.
 */
export function chunkPageText(
  pageNumber: number,
  originalText: string,
  targetWords = 380,
  maxWords = 480,
  overlapWords = 45,
): ChunkResult[] {
  const cleaned = originalText.replace(/\r\n/g, '\n').trim();
  if (!cleaned) return [];

  const words = cleaned.split(/\s+/);
  if (words.length <= maxWords) {
    return [
      {
        page_number: pageNumber,
        chunk_index: 0,
        word_count: words.length,
        chunk_text: cleaned,
        normalized_text: normalizeText(cleaned),
      },
    ];
  }

  const chunks: ChunkResult[] = [];
  let start = 0;
  let chunkIndex = 0;

  while (start < words.length) {
    let end = Math.min(start + targetWords, words.length);

    // Try to extend up to maxWords to snap onto a sentence boundary
    if (end < words.length) {
      const searchLimit = Math.min(start + maxWords, words.length);
      for (let i = end; i < searchLimit; i++) {
        if (/[.!?]$/.test(words[i])) {
          end = i + 1;
          break;
        }
      }
    }

    const slice = words.slice(start, end);
    const remaining = words.length - end;
    // Merge short tail into current chunk if <= 120 words and within maxWords ceiling
    if (remaining > 0 && remaining <= 120 && slice.length + remaining <= maxWords + 40) {
      const merged = words.slice(start, words.length).join(' ');
      chunks.push({
        page_number: pageNumber,
        chunk_index: chunkIndex,
        word_count: words.length - start,
        chunk_text: merged,
        normalized_text: normalizeText(merged),
      });
      break;
    }

    const chunkText = slice.join(' ');
    chunks.push({
      page_number: pageNumber,
      chunk_index: chunkIndex++,
      word_count: slice.length,
      chunk_text: chunkText,
      normalized_text: normalizeText(chunkText),
    });

    if (end >= words.length) break;
    start = Math.max(start + 1, end - overlapWords);
  }

  return chunks;
}

/**
 * Splits original PDF page text into verbatim sentences without rewriting or altering wording.
 */
export function splitIntoSentences(originalText: string): string[] {
  const normalizedLineBreaks = originalText
    .replace(/\r\n/g, '\n')
    // Join hyphenated line-wraps common in PDFs while preserving normal spacing
    .replace(/-\n(?=\p{L})/gu, '')
    .replace(/[ \t]+/g, ' ');

  const paragraphs = normalizedLineBreaks
    .split(/\n{2,}/)
    .map((p) => p.replace(/\n+/g, ' ').trim())
    .filter((p) => p.length > 0);

  const sentences: string[] = [];
  for (const paragraph of paragraphs) {
    // Split on sentence-ending punctuation followed by whitespace and uppercase/digit/quote
    const parts = paragraph.split(/(?<=[.!?])\s+(?=[A-Z0-9"“‘(\[\u00C0-\u024F])/);
    for (const part of parts) {
      const trimmed = part.trim();
      if (trimmed.length >= 12) {
        sentences.push(trimmed);
      }
    }
  }
  return sentences;
}
