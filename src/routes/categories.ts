import { Env } from '../types';
import {
  errorResponse,
  generateId,
  jsonResponse,
  parseJsonBody,
} from '../utils/http';

export async function handleListCategories(env: Env): Promise<Response> {
  const rows = await env.DB.prepare(
    `SELECT c.id, c.name, c.description,
            COUNT(d.id) AS document_count
     FROM categories c
     LEFT JOIN documents d ON d.category_id = c.id AND d.processing_status = 'Completed'
     GROUP BY c.id, c.name, c.description
     ORDER BY c.name ASC`,
  ).all();

  return jsonResponse({
    success: true,
    categories: rows.results || [],
  });
}

export async function handleCreateCategory(
  request: Request,
  env: Env,
): Promise<Response> {
  const body = await parseJsonBody<{ name?: string; description?: string }>(
    request,
  );
  if (!body) return errorResponse('Invalid JSON request body', 400);

  const name = (body.name || '').trim();
  const description = (body.description || '').trim();
  if (name.length < 2 || name.length > 60) {
    return errorResponse('Category name must be 2 to 60 characters', 400);
  }

  const existing = await env.DB.prepare(
    'SELECT id FROM categories WHERE LOWER(name) = LOWER(?)',
  )
    .bind(name)
    .first();
  if (existing) {
    return errorResponse('Category already exists', 409);
  }

  const id = generateId('cat');
  await env.DB.prepare(
    'INSERT INTO categories (id, name, description) VALUES (?, ?, ?)',
  )
    .bind(id, name, description)
    .run();

  return jsonResponse(
    {
      success: true,
      category: { id, name, description, document_count: 0 },
    },
    201,
  );
}

export async function handleUpdateCategory(
  id: string,
  request: Request,
  env: Env,
): Promise<Response> {
  const body = await parseJsonBody<{ name?: string; description?: string }>(
    request,
  );
  if (!body) return errorResponse('Invalid JSON request body', 400);

  const existing = await env.DB.prepare(
    'SELECT id, name, description FROM categories WHERE id = ?',
  )
    .bind(id)
    .first<{ id: string; name: string; description: string }>();
  if (!existing) {
    return errorResponse('Category not found', 404);
  }

  const nextName =
    body.name !== undefined ? body.name.trim() : existing.name;
  const nextDesc =
    body.description !== undefined
      ? body.description.trim()
      : existing.description;

  if (nextName.length < 2 || nextName.length > 60) {
    return errorResponse('Category name must be 2 to 60 characters', 400);
  }

  await env.DB.prepare(
    'UPDATE categories SET name = ?, description = ? WHERE id = ?',
  )
    .bind(nextName, nextDesc, id)
    .run();

  return jsonResponse({
    success: true,
    category: { id, name: nextName, description: nextDesc },
  });
}

export async function handleDeleteCategory(
  id: string,
  env: Env,
): Promise<Response> {
  const existing = await env.DB.prepare(
    'SELECT id FROM categories WHERE id = ?',
  )
    .bind(id)
    .first();
  if (!existing) {
    return errorResponse('Category not found', 404);
  }

  await env.DB.prepare(
    'UPDATE documents SET category_id = NULL WHERE category_id = ?',
  )
    .bind(id)
    .run();
  await env.DB.prepare('DELETE FROM categories WHERE id = ?').bind(id).run();

  return jsonResponse({ success: true, deleted_id: id });
}
