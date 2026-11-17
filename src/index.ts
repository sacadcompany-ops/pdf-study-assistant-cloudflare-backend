import {
  authenticateRequest,
  handleLogin,
  handleLogout,
  handleMe,
  handleRegister,
} from './routes/auth';
import {
  handleCreateCategory,
  handleDeleteCategory,
  handleListCategories,
  handleUpdateCategory,
} from './routes/categories';
import {
  handleChatAsk,
  handleDeleteChatHistory,
  handleExactSearchRoute,
  handleGetChatHistory,
  handleSmartSearchRoute,
} from './routes/chat';
import {
  handleAdminDeleteDocument,
  handleAdminGetDocument,
  handleAdminListDocuments,
  handleAdminProcessDocument,
  handleAdminUpdateDocument,
  handleAdminUploadDocument,
  handleStudentDownloadDocument,
  handleStudentGetDocument,
  handleStudentGetDocumentPage,
  handleStudentListDocuments,
} from './routes/documents';
import { Env } from './types';
import { CORS_HEADERS, errorResponse, jsonResponse } from './utils/http';
import { checkRateLimit } from './utils/rateLimit';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const method = request.method.toUpperCase();

    // Public health check (preserves existing root contract)
    if (path === '/' && method === 'GET') {
      return jsonResponse({
        success: true,
        name: env.APP_NAME || 'PDF Study Assistant API',
        mode: 'no-ai-deterministic',
        status: 'Online',
        endpoints: [
          '/',
          '/api/v1/auth/register',
          '/api/v1/auth/login',
          '/api/v1/auth/logout',
          '/api/v1/auth/me',
          '/api/v1/categories',
          '/api/v1/documents',
          '/api/v1/chat/ask',
          '/api/v1/search/smart',
          '/api/v1/search/exact',
          '/api/v1/chat/history',
          '/api/v1/admin/documents',
          '/api/v1/admin/categories',
        ],
      });
    }

    // Apply rate limiting on all API requests
    const rate = await checkRateLimit(request, env);
    if (!rate.allowed) {
      return errorResponse(
        'Too many requests. Please wait a moment and try again.',
        429,
        'RATE_LIMITED',
      );
    }

    try {
      // --- Authentication ---
      if (path === '/api/v1/auth/register' && method === 'POST') {
        return handleRegister(request, env);
      }
      if (path === '/api/v1/auth/login' && method === 'POST') {
        return handleLogin(request, env);
      }
      if (path === '/api/v1/auth/logout' && method === 'POST') {
        return handleLogout(request, env);
      }
      if (path === '/api/v1/auth/me' && method === 'GET') {
        return handleMe(request, env);
      }

      // Require valid JWT for all remaining /api/v1/* endpoints
      const auth = await authenticateRequest(request, env);
      if (!auth) {
        return errorResponse('Authentication required', 401, 'UNAUTHORIZED');
      }

      // --- Categories (read for all authenticated users) ---
      if (path === '/api/v1/categories' && method === 'GET') {
        return handleListCategories(env);
      }

      // --- Student Documents ---
      if (path === '/api/v1/documents' && method === 'GET') {
        return handleStudentListDocuments(request, env);
      }

      const docPageMatch = path.match(
        /^\/api\/v1\/documents\/([^/]+)\/pages\/(\d+)$/,
      );
      if (docPageMatch && method === 'GET') {
        return handleStudentGetDocumentPage(
          decodeURIComponent(docPageMatch[1]),
          Number(docPageMatch[2]),
          env,
        );
      }

      const docDownloadMatch = path.match(
        /^\/api\/v1\/documents\/([^/]+)\/download$/,
      );
      if (docDownloadMatch && method === 'GET') {
        return handleStudentDownloadDocument(
          decodeURIComponent(docDownloadMatch[1]),
          env,
        );
      }

      const docDetailMatch = path.match(/^\/api\/v1\/documents\/([^/]+)$/);
      if (docDetailMatch && method === 'GET') {
        return handleStudentGetDocument(
          decodeURIComponent(docDetailMatch[1]),
          env,
        );
      }

      // --- Chat & Search ---
      if (path === '/api/v1/chat/ask' && method === 'POST') {
        return handleChatAsk(request, env, auth.user.id);
      }
      if (path === '/api/v1/search/smart' && method === 'POST') {
        return handleSmartSearchRoute(request, env);
      }
      if (path === '/api/v1/search/exact' && method === 'POST') {
        return handleExactSearchRoute(request, env);
      }
      if (path === '/api/v1/chat/history' && method === 'GET') {
        return handleGetChatHistory(request, env, auth.user.id);
      }
      if (path === '/api/v1/chat/history' && method === 'DELETE') {
        return handleDeleteChatHistory(env, auth.user.id);
      }

      // --- Admin Guard ---
      if (path.startsWith('/api/v1/admin/')) {
        if (auth.user.role !== 'admin') {
          return errorResponse(
            'Administrator permissions are required',
            403,
            'FORBIDDEN',
          );
        }

        if (path === '/api/v1/admin/documents' && method === 'POST') {
          return handleAdminUploadDocument(request, env, auth.user.id);
        }
        if (path === '/api/v1/admin/documents' && method === 'GET') {
          return handleAdminListDocuments(request, env);
        }

        const adminProcessMatch = path.match(
          /^\/api\/v1\/admin\/documents\/([^/]+)\/process$/,
        );
        if (adminProcessMatch && method === 'POST') {
          return handleAdminProcessDocument(
            decodeURIComponent(adminProcessMatch[1]),
            request,
            env,
          );
        }

        const adminDocMatch = path.match(
          /^\/api\/v1\/admin\/documents\/([^/]+)$/,
        );
        if (adminDocMatch) {
          const docId = decodeURIComponent(adminDocMatch[1]);
          if (method === 'GET') return handleAdminGetDocument(docId, env);
          if (method === 'PUT')
            return handleAdminUpdateDocument(docId, request, env);
          if (method === 'DELETE')
            return handleAdminDeleteDocument(docId, env);
        }

        if (path === '/api/v1/admin/categories' && method === 'POST') {
          return handleCreateCategory(request, env);
        }

        const adminCatMatch = path.match(
          /^\/api\/v1\/admin\/categories\/([^/]+)$/,
        );
        if (adminCatMatch) {
          const catId = decodeURIComponent(adminCatMatch[1]);
          if (method === 'PUT')
            return handleUpdateCategory(catId, request, env);
          if (method === 'DELETE') return handleDeleteCategory(catId, env);
        }
      }

      return errorResponse('Endpoint not found', 404, 'NOT_FOUND');
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Internal server error';
      return errorResponse(message, 500, 'INTERNAL_ERROR');
    }
  },
};
