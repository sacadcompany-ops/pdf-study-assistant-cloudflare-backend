import { AuthUser, Env, JwtClaims, UserRole } from '../types';
import {
  hashPassword,
  signJwt,
  verifyJwt,
  verifyPassword,
} from '../utils/crypto';
import {
  errorResponse,
  generateId,
  isValidEmail,
  jsonResponse,
  parseJsonBody,
} from '../utils/http';

export interface AuthContext {
  user: AuthUser;
  claims: JwtClaims;
}

export async function authenticateRequest(
  request: Request,
  env: Env,
): Promise<AuthContext | null> {
  const authHeader = request.headers.get('Authorization') || '';
  if (!authHeader.startsWith('Bearer ')) return null;
  const token = authHeader.slice(7).trim();
  if (!token) return null;

  const claims = await verifyJwt(token, env.JWT_SECRET);
  if (!claims) return null;

  // Check token revocation table
  const revoked = await env.DB.prepare(
    'SELECT jti FROM revoked_tokens WHERE jti = ?',
  )
    .bind(claims.jti)
    .first<{ jti: string }>();
  if (revoked) return null;

  const user = await env.DB.prepare(
    'SELECT id, name, email, role, created_at FROM users WHERE id = ?',
  )
    .bind(claims.sub)
    .first<AuthUser>();
  if (!user) return null;

  return { user, claims };
}

export async function handleRegister(
  request: Request,
  env: Env,
): Promise<Response> {
  const body = await parseJsonBody<{
    name?: string;
    email?: string;
    password?: string;
    admin_invite_code?: string;
  }>(request);

  if (!body) {
    return errorResponse('Invalid JSON request body', 400);
  }

  const name = (body.name || '').trim();
  const email = (body.email || '').trim().toLowerCase();
  const password = body.password || '';
  const inviteCode = (body.admin_invite_code || '').trim();

  if (name.length < 2 || name.length > 80) {
    return errorResponse('Name must be between 2 and 80 characters', 400);
  }
  if (!isValidEmail(email)) {
    return errorResponse('Valid email address is required', 400);
  }
  if (password.length < 8 || password.length > 128) {
    return errorResponse('Password must be between 8 and 128 characters', 400);
  }

  let role: UserRole = 'student';
  if (inviteCode.length > 0) {
    if (!env.ADMIN_INVITE_CODE || inviteCode !== env.ADMIN_INVITE_CODE) {
      return errorResponse('Invalid administrator invite code', 403);
    }
    role = 'admin';
  }

  const existing = await env.DB.prepare(
    'SELECT id FROM users WHERE email = ?',
  )
    .bind(email)
    .first<{ id: string }>();
  if (existing) {
    return errorResponse('An account with this email already exists', 409);
  }

  const id = generateId('usr');
  const passwordHash = await hashPassword(password);
  const createdAt = new Date().toISOString();

  await env.DB.prepare(
    'INSERT INTO users (id, name, email, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  )
    .bind(id, name, email, passwordHash, role, createdAt)
    .run();

  const user: AuthUser = { id, name, email, role, created_at: createdAt };
  const { token, claims } = await signJwt(user, env.JWT_SECRET);

  return jsonResponse(
    {
      success: true,
      token,
      expires_at: claims.exp,
      user,
    },
    201,
  );
}

export async function handleLogin(
  request: Request,
  env: Env,
): Promise<Response> {
  const body = await parseJsonBody<{
    email?: string;
    password?: string;
  }>(request);

  if (!body) {
    return errorResponse('Invalid JSON request body', 400);
  }

  const email = (body.email || '').trim().toLowerCase();
  const password = body.password || '';

  if (!isValidEmail(email) || !password) {
    return errorResponse('Email and password are required', 400);
  }

  const row = await env.DB.prepare(
    'SELECT id, name, email, password_hash, role, created_at FROM users WHERE email = ?',
  )
    .bind(email)
    .first<AuthUser & { password_hash: string }>();

  if (!row || !(await verifyPassword(password, row.password_hash))) {
    return errorResponse('Invalid email or password', 401);
  }

  const user: AuthUser = {
    id: row.id,
    name: row.name,
    email: row.email,
    role: row.role,
    created_at: row.created_at,
  };
  const { token, claims } = await signJwt(user, env.JWT_SECRET);

  return jsonResponse({
    success: true,
    token,
    expires_at: claims.exp,
    user,
  });
}

export async function handleLogout(
  request: Request,
  env: Env,
): Promise<Response> {
  const auth = await authenticateRequest(request, env);
  if (!auth) {
    return errorResponse('Unauthorized', 401);
  }

  await env.DB.prepare(
    'INSERT OR IGNORE INTO revoked_tokens (jti, expires_at) VALUES (?, ?)',
  )
    .bind(auth.claims.jti, auth.claims.exp)
    .run();

  // Opportunistic cleanup of expired revocations
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare('DELETE FROM revoked_tokens WHERE expires_at < ?')
    .bind(now)
    .run();

  return jsonResponse({ success: true, message: 'Logged out successfully' });
}

export async function handleMe(
  request: Request,
  env: Env,
): Promise<Response> {
  const auth = await authenticateRequest(request, env);
  if (!auth) {
    return errorResponse('Unauthorized', 401);
  }
  return jsonResponse({ success: true, user: auth.user });
}
