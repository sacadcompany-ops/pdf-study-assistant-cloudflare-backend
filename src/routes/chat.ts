import { runExactAnswer, runSmartSearch } from '../search/engine';
import { AnswerMode, Env } from '../types';
import {
  errorResponse,
  generateId,
  jsonResponse,
  parseJsonBody,
} from '../utils/http';

export async function handleChatAsk(
  request: Request,
  env: Env,
  userId: string,
): Promise<Response> {
  const body = await parseJsonBody<{
    question?: string;
    document_id?: string | null;
    mode?: string;
    answer_mode?: string;
    limit?: number;
  }>(request);

  if (!body) return errorResponse('Invalid JSON request body', 400);

  const question = (body.question || '').trim();
  if (question.length < 2 || question.length > 500) {
    return errorResponse('Question must be between 2 and 500 characters', 400);
  }

  const rawMode = (body.answer_mode || body.mode || 'smart_search').toLowerCase();
  const mode: AnswerMode =
    rawMode === 'exact_answer' || rawMode === 'exact'
      ? 'exact_answer'
      : 'smart_search';

  const documentId = body.document_id ? body.document_id.trim() : null;
  const limit = Math.min(10, Math.max(1, Number(body.limit || 5)));

  const result =
    mode === 'exact_answer'
      ? await runExactAnswer(env, question, documentId, limit)
      : await runSmartSearch(env, question, documentId, limit);

  const historyId = generateId('cht');
  const createdAt = new Date().toISOString();

  await env.DB.prepare(
    `INSERT INTO chat_history
      (id, user_id, document_id, question, answer, answer_mode, page_number, relevance_score, document_title, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      historyId,
      userId,
      result.document_id,
      question,
      result.answer,
      result.answer_mode,
      result.page_number,
      result.relevance_score,
      result.document_title,
      createdAt,
    )
    .run();

  return jsonResponse({
    success: true,
    history_id: historyId,
    created_at: createdAt,
    ...result,
  });
}

export async function handleSmartSearchRoute(
  request: Request,
  env: Env,
): Promise<Response> {
  const body = await parseJsonBody<{
    query?: string;
    question?: string;
    document_id?: string | null;
    limit?: number;
  }>(request);
  if (!body) return errorResponse('Invalid JSON request body', 400);

  const query = (body.question || body.query || '').trim();
  if (query.length < 2 || query.length > 500) {
    return errorResponse('Query must be between 2 and 500 characters', 400);
  }

  const documentId = body.document_id ? body.document_id.trim() : null;
  const limit = Math.min(15, Math.max(1, Number(body.limit || 8)));
  const result = await runSmartSearch(env, query, documentId, limit);

  return jsonResponse({ success: true, ...result });
}

export async function handleExactSearchRoute(
  request: Request,
  env: Env,
): Promise<Response> {
  const body = await parseJsonBody<{
    query?: string;
    question?: string;
    document_id?: string | null;
    limit?: number;
  }>(request);
  if (!body) return errorResponse('Invalid JSON request body', 400);

  const query = (body.question || body.query || '').trim();
  if (query.length < 2 || query.length > 500) {
    return errorResponse('Query must be between 2 and 500 characters', 400);
  }

  const documentId = body.document_id ? body.document_id.trim() : null;
  const limit = Math.min(15, Math.max(1, Number(body.limit || 8)));
  const result = await runExactAnswer(env, query, documentId, limit);

  return jsonResponse({ success: true, ...result });
}

export async function handleGetChatHistory(
  request: Request,
  env: Env,
  userId: string,
): Promise<Response> {
  const url = new URL(request.url);
  const documentId = (url.searchParams.get('document_id') || '').trim();

  const rows = documentId
    ? await env.DB.prepare(
        `SELECT id, user_id, document_id, question, answer, answer_mode, page_number, relevance_score, document_title, created_at
         FROM chat_history
         WHERE user_id = ? AND document_id = ?
         ORDER BY created_at DESC
         LIMIT 100`,
      )
        .bind(userId, documentId)
        .all()
    : await env.DB.prepare(
        `SELECT id, user_id, document_id, question, answer, answer_mode, page_number, relevance_score, document_title, created_at
         FROM chat_history
         WHERE user_id = ?
         ORDER BY created_at DESC
         LIMIT 100`,
      )
        .bind(userId)
        .all();

  return jsonResponse({
    success: true,
    history: rows.results || [],
  });
}

export async function handleDeleteChatHistory(
  env: Env,
  userId: string,
): Promise<Response> {
  await env.DB.prepare('DELETE FROM chat_history WHERE user_id = ?')
    .bind(userId)
    .run();

  return jsonResponse({
    success: true,
    message: 'Chat history cleared',
  });
}
