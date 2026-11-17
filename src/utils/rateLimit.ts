import { Env } from '../types';

export async function checkRateLimit(
  request: Request,
  env: Env,
): Promise<{ allowed: boolean; remaining: number; resetAt: number }> {
  const maxRequests = Math.max(
    10,
    Number(env.RATE_LIMIT_REQUESTS || '120') || 120,
  );
  const windowSeconds = Math.max(
    10,
    Number(env.RATE_LIMIT_WINDOW_SECONDS || '60') || 60,
  );

  const clientIp =
    request.headers.get('CF-Connecting-IP') ||
    request.headers.get('X-Forwarded-For')?.split(',')[0]?.trim() ||
    'unknown';

  const nowSec = Math.floor(Date.now() / 1000);
  const windowStart = nowSec - (nowSec % windowSeconds);
  const rateKey = `ip:${clientIp}`;

  try {
    const existing = await env.DB.prepare(
      'SELECT window_start, request_count FROM rate_limits WHERE rate_key = ?',
    )
      .bind(rateKey)
      .first<{ window_start: number; request_count: number }>();

    if (!existing || existing.window_start !== windowStart) {
      await env.DB.prepare(
        `INSERT INTO rate_limits (rate_key, window_start, request_count)
         VALUES (?, ?, 1)
         ON CONFLICT(rate_key) DO UPDATE SET window_start = excluded.window_start, request_count = 1`,
      )
        .bind(rateKey, windowStart)
        .run();
      return {
        allowed: true,
        remaining: maxRequests - 1,
        resetAt: windowStart + windowSeconds,
      };
    }

    const nextCount = existing.request_count + 1;
    await env.DB.prepare(
      'UPDATE rate_limits SET request_count = ? WHERE rate_key = ?',
    )
      .bind(nextCount, rateKey)
      .run();

    return {
      allowed: nextCount <= maxRequests,
      remaining: Math.max(0, maxRequests - nextCount),
      resetAt: windowStart + windowSeconds,
    };
  } catch {
    // Fail open if rate_limits table has not been migrated yet
    return {
      allowed: true,
      remaining: maxRequests,
      resetAt: windowStart + windowSeconds,
    };
  }
}
