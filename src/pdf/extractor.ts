import { ExtractedPageInput } from '../types';

export const SCANNED_PDF_ERROR =
  'This PDF appears to be scanned or image-based and cannot be searched without OCR.';

export function isValidPdfBytes(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 5) return false;
  // Verify %PDF- magic header within first 1024 bytes
  const headerSlice = new TextDecoder('latin1').decode(
    bytes.subarray(0, Math.min(1024, bytes.byteLength)),
  );
  return headerSlice.includes('%PDF-');
}

/**
 * Pure TypeScript fallback PDF text extractor for uncompressed or FlateDecode text streams
 * when reprocessing on the server without pre-extracted Android PDFBox pages.
 * Note: Android uploads pre-extract every page accurately using PDFBox-Android.
 */
export async function extractFallbackPdfPages(
  bytes: Uint8Array,
): Promise<ExtractedPageInput[]> {
  const rawLatin1 = new TextDecoder('latin1').decode(bytes);
  const streamRegex = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
  const collectedTexts: string[] = [];

  let match: RegExpExecArray | null;
  while ((match = streamRegex.exec(rawLatin1)) !== null) {
    const streamBody = match[1];
    let decodedStream = streamBody;

    // Attempt zlib/deflate decompression if stream looks compressed
    if (
      streamBody.length > 2 &&
      streamBody.charCodeAt(0) === 0x78
    ) {
      try {
        const streamBytes = new Uint8Array(streamBody.length);
        for (let i = 0; i < streamBody.length; i++) {
          streamBytes[i] = streamBody.charCodeAt(i) & 0xff;
        }
        const ds = new DecompressionStream('deflate');
        const writer = ds.writable.getWriter();
        writer.write(streamBytes);
        writer.close();
        const decompressed = await new Response(ds.readable).arrayBuffer();
        decodedStream = new TextDecoder('latin1').decode(decompressed);
      } catch {
        // Not deflate or malformed stream; skip gracefully
        continue;
      }
    }

    const textOperators = extractTextOperators(decodedStream);
    if (textOperators.trim().length > 0) {
      collectedTexts.push(textOperators.trim());
    }
  }

  if (collectedTexts.length === 0) {
    return [];
  }

  // Group into page-like segments
  return collectedTexts.map((txt, idx) => ({
    page_number: idx + 1,
    original_text: txt,
  }));
}

function extractTextOperators(contentStream: string): string {
  const parts: string[] = [];
  // Match (...) Tj or [(...)] TJ PDF text operators
  const tjRegex = /\(([^()\\]*(?:\\.[^()\\]*)*)\)\s*Tj/g;
  let m: RegExpExecArray | null;
  while ((m = tjRegex.exec(contentStream)) !== null) {
    parts.push(unescapePdfLiteral(m[1]));
  }

  const tjArrayRegex = /\[((?:[^[\]]*?))\]\s*TJ/g;
  while ((m = tjArrayRegex.exec(contentStream)) !== null) {
    const inner = m[1];
    const litRegex = /\(([^()\\]*(?:\\.[^()\\]*)*)\)/g;
    let lit: RegExpExecArray | null;
    const lineParts: string[] = [];
    while ((lit = litRegex.exec(inner)) !== null) {
      lineParts.push(unescapePdfLiteral(lit[1]));
    }
    if (lineParts.length > 0) {
      parts.push(lineParts.join(''));
    }
  }

  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

function unescapePdfLiteral(str: string): string {
  return str
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, ' ')
    .replace(/\\t/g, ' ')
    .replace(/\\\(/g, '(')
    .replace(/\\\)/g, ')')
    .replace(/\\\\/g, '\\');
}

export function hasUsableExtractedText(pages: ExtractedPageInput[]): boolean {
  const combined = pages
    .map((p) => p.original_text.trim())
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  // Require at least 20 alphanumeric/letter characters across the PDF to count as searchable text
  const letterCount = (combined.match(/[\p{L}\p{N}]/gu) || []).length;
  return letterCount >= 20;
}
