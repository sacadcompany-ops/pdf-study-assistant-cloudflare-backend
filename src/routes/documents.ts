import {
  extractFallbackPdfPages,
  hasUsableExtractedText,
  isValidPdfBytes,
  SCANNED_PDF_ERROR,
} from '../pdf/extractor';
import {
  chunkPageText,
  countTermFrequencies,
  tokenizeAll,
} from '../search/normalizer';
import { DocumentRow, Env, ExtractedPageInput } from '../types';
import {
  CORS_HEADERS,
  errorResponse,
  generateId,
  jsonResponse,
  parseJsonBody,
  sanitizeFilename,
} from '../utils/http';

const BATCH_SIZE = 75;

async function runBatched(
  db: D1Database,
  statements: D1PreparedStatement[],
): Promise<void> {
  for (let i = 0; i < statements.length; i += BATCH_SIZE) {
    await db.batch(statements.slice(i, i + BATCH_SIZE));
  }
}

async function indexExtractedPages(
  env: Env,
  documentId: string,
  pages: ExtractedPageInput[],
): Promise<{ pageCount: number; chunkCount: number; termCount: number }> {
  await env.DB.prepare(
    "UPDATE documents SET processing_status = 'Processing', status_message = 'Indexing text chunks' WHERE id = ?",
  )
    .bind(documentId)
    .run();

  // Clear previous index data when reprocessing or replacing
  await env.DB.batch([
    env.DB.prepare('DELETE FROM term_index WHERE document_id = ?').bind(documentId),
    env.DB.prepare('DELETE FROM text_chunks WHERE document_id = ?').bind(documentId),
    env.DB.prepare('DELETE FROM document_pages WHERE document_id = ?').bind(documentId),
  ]);

  const sortedPages = [...pages]
    .filter((p) => Number.isInteger(p.page_number) && p.page_number >= 1)
    .sort((a, b) => a.page_number - b.page_number);

  if (sortedPages.length === 0 || !hasUsableExtractedText(sortedPages)) {
    await env.DB.prepare(
      "UPDATE documents SET processing_status = 'Failed', page_count = ?, status_message = ? WHERE id = ?",
    )
      .bind(sortedPages.length, SCANNED_PDF_ERROR, documentId)
      .run();
    throw new Error(SCANNED_PDF_ERROR);
  }

  const pageStatements: D1PreparedStatement[] = [];
  const chunkStatements: D1PreparedStatement[] = [];
  const termStatements: D1PreparedStatement[] = [];
  let totalChunks = 0;
  let totalTerms = 0;

  for (const page of sortedPages) {
    const pageId = generateId('pg');
    pageStatements.push(
      env.DB.prepare(
        'INSERT INTO document_pages (id, document_id, page_number, original_text) VALUES (?, ?, ?, ?)',
      ).bind(pageId, documentId, page.page_number, page.original_text),
    );

    const chunks = chunkPageText(page.page_number, page.original_text);
    for (const chunk of chunks) {
      const chunkId = generateId('chk');
      totalChunks++;
      chunkStatements.push(
        env.DB.prepare(
          `INSERT INTO text_chunks (id, document_id, page_number, chunk_index, word_count, chunk_text, normalized_text)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ).bind(
          chunkId,
          documentId,
          chunk.page_number,
          chunk.chunk_index,
          chunk.word_count,
          chunk.chunk_text,
          chunk.normalized_text,
        ),
      );

      const tokens = tokenizeAll(chunk.normalized_text);
      const freqs = countTermFrequencies(tokens);
      for (const [term, tf] of freqs.entries()) {
        totalTerms++;
        termStatements.push(
          env.DB.prepare(
            'INSERT INTO term_index (id, document_id, chunk_id, term, term_frequency) VALUES (?, ?, ?, ?, ?)',
          ).bind(generateId('trm'), documentId, chunkId, term, tf),
        );
      }
    }
  }

  await runBatched(env.DB, pageStatements);
  await runBatched(env.DB, chunkStatements);
  await runBatched(env.DB, termStatements);

  await env.DB.prepare(
    "UPDATE documents SET processing_status = 'Completed', page_count = ?, status_message = '' WHERE id = ?",
  )
    .bind(sortedPages.length, documentId)
    .run();

  return {
    pageCount: sortedPages.length,
    chunkCount: totalChunks,
    termCount: totalTerms,
  };
}

export async function handleAdminUploadDocument(
  request: Request,
  env: Env,
  adminUserId: string,
): Promise<Response> {
  const contentType = request.headers.get('content-type') || '';
  if (!contentType.toLowerCase().includes('multipart/form-data')) {
    return errorResponse('Expected multipart/form-data upload', 400);
  }

  const formData = await request.formData();
  const fileEntry = formData.get('file');
  if (!fileEntry || typeof fileEntry === 'string') {
    return errorResponse('PDF file field "file" is required', 400);
  }

  const file = fileEntry as File;
  const maxBytes = Number(env.MAX_UPLOAD_BYTES || '52428800') || 52428800;
  if (file.size <= 0 || file.size > maxBytes) {
    return errorResponse(
      `PDF file size must be between 1 byte and ${Math.round(maxBytes / (1024 * 1024))} MB`,
      400,
    );
  }

  const fileBytes = new Uint8Array(await file.arrayBuffer());
  if (!isValidPdfBytes(fileBytes)) {
    return errorResponse('Uploaded file is not a valid PDF document', 400);
  }

  const rawTitle = ((formData.get('title') as string) || '').trim();
  const description = ((formData.get('description') as string) || '').trim();
  const categoryId = ((formData.get('category_id') as string) || '').trim() || null;
  const pagesJsonRaw = (formData.get('pages_json') as string) || '';

  const safeFileName = sanitizeFilename(file.name || 'document.pdf');
  const title = rawTitle || safeFileName.replace(/\.pdf$/i, '');
  const docId = generateId('doc');
  const r2Key = `documents/${docId}/${safeFileName}`;
  const uploadedAt = new Date().toISOString();

  // Store original PDF securely in Cloudflare R2
  await env.R2_BUCKET.put(r2Key, fileBytes, {
    httpMetadata: { contentType: 'application/pdf' },
    customMetadata: {
      documentId: docId,
      originalName: safeFileName,
      uploadedBy: adminUserId,
    },
  });

  await env.DB.prepare(
    `INSERT INTO documents
      (id, title, description, file_name, r2_object_key, file_size, page_count, category_id, uploaded_at, processing_status, status_message, uploaded_by)
     VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, 'Pending', '', ?)`,
  )
    .bind(
      docId,
      title,
      description,
      safeFileName,
      r2Key,
      file.size,
      categoryId,
      uploadedAt,
      adminUserId,
    )
    .run();

  let pages: ExtractedPageInput[] = [];
  if (pagesJsonRaw) {
    try {
      const parsed = JSON.parse(pagesJsonRaw);
      if (Array.isArray(parsed)) {
        pages = parsed;
      }
    } catch {
      return errorResponse('Invalid pages_json payload', 400);
    }
  } else {
    pages = await extractFallbackPdfPages(fileBytes);
  }

  try {
    const stats = await indexExtractedPages(env, docId, pages);
    const updated = await getDocumentById(env, docId);
    return jsonResponse(
      {
        success: true,
        document: updated,
        stats,
      },
      201,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : SCANNED_PDF_ERROR;
    const failedDoc = await getDocumentById(env, docId);
    return jsonResponse(
      {
        success: false,
        error: msg,
        document: failedDoc,
      },
      422,
    );
  }
}

export async function handleAdminListDocuments(
  request: Request,
  env: Env,
): Promise<Response> {
  const url = new URL(request.url);
  const query = (url.searchParams.get('q') || '').trim();
  const categoryId = (url.searchParams.get('category_id') || '').trim();
  const status = (url.searchParams.get('status') || '').trim();

  const conditions: string[] = [];
  const params: unknown[] = [];

  if (query) {
    conditions.push('(LOWER(d.title) LIKE LOWER(?) OR LOWER(d.description) LIKE LOWER(?))');
    params.push(`%${query}%`, `%${query}%`);
  }
  if (categoryId) {
    conditions.push('d.category_id = ?');
    params.push(categoryId);
  }
  if (status) {
    conditions.push('d.processing_status = ?');
    params.push(status);
  }

  const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const sql = `
    SELECT d.*, c.name AS category_name
    FROM documents d
    LEFT JOIN categories c ON c.id = d.category_id
    ${whereClause}
    ORDER BY d.uploaded_at DESC
  `;

  const rows = await env.DB.prepare(sql).bind(...params).all<DocumentRow>();
  return jsonResponse({
    success: true,
    documents: rows.results || [],
  });
}

export async function handleAdminGetDocument(
  id: string,
  env: Env,
): Promise<Response> {
  const doc = await getDocumentById(env, id);
  if (!doc) return errorResponse('Document not found', 404);

  const chunkStats = await env.DB.prepare(
    'SELECT COUNT(*) AS chunk_count FROM text_chunks WHERE document_id = ?',
  )
    .bind(id)
    .first<{ chunk_count: number }>();

  return jsonResponse({
    success: true,
    document: doc,
    chunk_count: chunkStats?.chunk_count ?? 0,
  });
}

export async function handleAdminUpdateDocument(
  id: string,
  request: Request,
  env: Env,
): Promise<Response> {
  const existing = await getDocumentById(env, id);
  if (!existing) return errorResponse('Document not found', 404);

  const contentType = request.headers.get('content-type') || '';

  // Support multipart replacement of the PDF binary + metadata
  if (contentType.toLowerCase().includes('multipart/form-data')) {
    const formData = await request.formData();
    const title = ((formData.get('title') as string) || existing.title).trim();
    const description =
      formData.get('description') !== null
        ? ((formData.get('description') as string) || '').trim()
        : existing.description;
    const categoryId =
      formData.get('category_id') !== null
        ? ((formData.get('category_id') as string) || '').trim() || null
        : existing.category_id;

    const fileEntry = formData.get('file');
    if (fileEntry && typeof fileEntry !== 'string') {
      const file = fileEntry as File;
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (!isValidPdfBytes(bytes)) {
        return errorResponse('Replacement file is not a valid PDF', 400);
      }

      const safeName = sanitizeFilename(file.name || existing.file_name);
      const nextKey = `documents/${id}/${safeName}`;
      await env.R2_BUCKET.delete(existing.r2_object_key);
      await env.R2_BUCKET.put(nextKey, bytes, {
        httpMetadata: { contentType: 'application/pdf' },
      });

      await env.DB.prepare(
        `UPDATE documents
         SET title = ?, description = ?, category_id = ?, file_name = ?, r2_object_key = ?, file_size = ?, processing_status = 'Pending', status_message = ''
         WHERE id = ?`,
      )
        .bind(title, description, categoryId, safeName, nextKey, file.size, id)
        .run();

      const pagesJsonRaw = (formData.get('pages_json') as string) || '';
      const pages: ExtractedPageInput[] = pagesJsonRaw
        ? JSON.parse(pagesJsonRaw)
        : await extractFallbackPdfPages(bytes);

      try {
        await indexExtractedPages(env, id, pages);
      } catch (err) {
        const msg = err instanceof Error ? err.message : SCANNED_PDF_ERROR;
        return jsonResponse(
          { success: false, error: msg, document: await getDocumentById(env, id) },
          422,
        );
      }
    } else {
      await env.DB.prepare(
        'UPDATE documents SET title = ?, description = ?, category_id = ? WHERE id = ?',
      )
        .bind(title, description, categoryId, id)
        .run();
    }

    return jsonResponse({
      success: true,
      document: await getDocumentById(env, id),
    });
  }

  const body = await parseJsonBody<{
    title?: string;
    description?: string;
    category_id?: string | null;
  }>(request);
  if (!body) return errorResponse('Invalid JSON request body', 400);

  const title =
    body.title !== undefined ? body.title.trim() : existing.title;
  if (!title) return errorResponse('Document title cannot be empty', 400);

  const description =
    body.description !== undefined
      ? body.description.trim()
      : existing.description;
  const categoryId =
    body.category_id !== undefined ? body.category_id : existing.category_id;

  await env.DB.prepare(
    'UPDATE documents SET title = ?, description = ?, category_id = ? WHERE id = ?',
  )
    .bind(title, description, categoryId, id)
    .run();

  return jsonResponse({
    success: true,
    document: await getDocumentById(env, id),
  });
}

export async function handleAdminDeleteDocument(
  id: string,
  env: Env,
): Promise<Response> {
  const existing = await getDocumentById(env, id);
  if (!existing) return errorResponse('Document not found', 404);

  // Delete from R2 first, then D1 cascade
  try {
    await env.R2_BUCKET.delete(existing.r2_object_key);
  } catch {
    // Continue DB deletion even if object was missing
  }

  await env.DB.batch([
    env.DB.prepare('DELETE FROM term_index WHERE document_id = ?').bind(id),
    env.DB.prepare('DELETE FROM text_chunks WHERE document_id = ?').bind(id),
    env.DB.prepare('DELETE FROM document_pages WHERE document_id = ?').bind(id),
    env.DB.prepare('DELETE FROM documents WHERE id = ?').bind(id),
  ]);

  return jsonResponse({ success: true, deleted_id: id });
}

export async function handleAdminProcessDocument(
  id: string,
  request: Request,
  env: Env,
): Promise<Response> {
  const existing = await getDocumentById(env, id);
  if (!existing) return errorResponse('Document not found', 404);

  const body = await parseJsonBody<{ pages?: ExtractedPageInput[] }>(request);
  let pages: ExtractedPageInput[] = body?.pages || [];

  if (pages.length === 0) {
    // Reuse already-stored pages if available
    const existingPages = await env.DB.prepare(
      'SELECT page_number, original_text FROM document_pages WHERE document_id = ? ORDER BY page_number ASC',
    )
      .bind(id)
      .all<ExtractedPageInput>();
    pages = existingPages.results || [];
  }

  if (pages.length === 0) {
    // Fallback: fetch PDF from R2 and extract text streams
    const r2Object = await env.R2_BUCKET.get(existing.r2_object_key);
    if (!r2Object) {
      return errorResponse('Original PDF not found in R2 storage', 404);
    }
    const bytes = new Uint8Array(await r2Object.arrayBuffer());
    pages = await extractFallbackPdfPages(bytes);
  }

  try {
    const stats = await indexExtractedPages(env, id, pages);
    return jsonResponse({
      success: true,
      document: await getDocumentById(env, id),
      stats,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : SCANNED_PDF_ERROR;
    return jsonResponse(
      {
        success: false,
        error: msg,
        document: await getDocumentById(env, id),
      },
      422,
    );
  }
}

export async function handleStudentListDocuments(
  request: Request,
  env: Env,
): Promise<Response> {
  const url = new URL(request.url);
  const query = (url.searchParams.get('q') || '').trim();
  const categoryId = (url.searchParams.get('category_id') || '').trim();

  const conditions = ["d.processing_status = 'Completed'"];
  const params: unknown[] = [];

  if (query) {
    conditions.push('(LOWER(d.title) LIKE LOWER(?) OR LOWER(d.description) LIKE LOWER(?))');
    params.push(`%${query}%`, `%${query}%`);
  }
  if (categoryId) {
    conditions.push('d.category_id = ?');
    params.push(categoryId);
  }

  const sql = `
    SELECT d.*, c.name AS category_name
    FROM documents d
    LEFT JOIN categories c ON c.id = d.category_id
    WHERE ${conditions.join(' AND ')}
    ORDER BY d.uploaded_at DESC
  `;

  const rows = await env.DB.prepare(sql).bind(...params).all<DocumentRow>();
  return jsonResponse({
    success: true,
    documents: rows.results || [],
  });
}

export async function handleStudentGetDocument(
  id: string,
  env: Env,
): Promise<Response> {
  const doc = await getDocumentById(env, id);
  if (!doc || doc.processing_status !== 'Completed') {
    return errorResponse('Document not found', 404);
  }
  return jsonResponse({
    success: true,
    document: doc,
    download_url: `/api/v1/documents/${id}/download`,
  });
}

export async function handleStudentDownloadDocument(
  id: string,
  env: Env,
): Promise<Response> {
  const doc = await getDocumentById(env, id);
  if (!doc) return errorResponse('Document not found', 404);

  const object = await env.R2_BUCKET.get(doc.r2_object_key);
  if (!object) return errorResponse('PDF binary not found in R2 storage', 404);

  const headers = new Headers(CORS_HEADERS);
  headers.set('Content-Type', 'application/pdf');
  headers.set(
    'Content-Disposition',
    `inline; filename="${doc.file_name.replace(/"/g, '')}"`,
  );
  headers.set('Cache-Control', 'private, max-age=3600');

  return new Response(object.body, { status: 200, headers });
}

export async function handleStudentGetDocumentPage(
  id: string,
  pageNumber: number,
  env: Env,
): Promise<Response> {
  if (!Number.isInteger(pageNumber) || pageNumber < 1) {
    return errorResponse('Invalid page number', 400);
  }

  const doc = await getDocumentById(env, id);
  if (!doc || doc.processing_status !== 'Completed') {
    return errorResponse('Document not found', 404);
  }

  const page = await env.DB.prepare(
    'SELECT page_number, original_text FROM document_pages WHERE document_id = ? AND page_number = ?',
  )
    .bind(id, pageNumber)
    .first<{ page_number: number; original_text: string }>();

  if (!page) {
    return errorResponse('Page not found', 404);
  }

  return jsonResponse({
    success: true,
    document_id: id,
    document_title: doc.title,
    page_count: doc.page_count,
    page_number: page.page_number,
    original_text: page.original_text,
  });
}

async function getDocumentById(
  env: Env,
  id: string,
): Promise<DocumentRow | null> {
  return env.DB.prepare(
    `SELECT d.*, c.name AS category_name
     FROM documents d
     LEFT JOIN categories c ON c.id = d.category_id
     WHERE d.id = ?`,
  )
    .bind(id)
    .first<DocumentRow>();
}
