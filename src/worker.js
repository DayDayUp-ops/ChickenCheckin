const SESSION_SECONDS = 30 * 24 * 60 * 60;
const MAX_DATA_BYTES = 1_500_000;
const AUTH_WINDOW_SECONDS = 15 * 60;
const AUTH_MAX_FAILURES = 8;
const encoder = new TextEncoder();

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      ...extraHeaders,
    },
  });
}

function error(message, status = 400, code = 'bad_request', extra = {}) {
  return json({ ok: false, code, message, ...extra }, status);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function toBase64Url(bytes) {
  let binary = '';
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function randomToken(byteLength = 32) {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return toBase64Url(bytes);
}

async function sha256(value) {
  return toBase64Url(await crypto.subtle.digest('SHA-256', encoder.encode(value)));
}

async function secureEqual(left, right) {
  const [a, b] = await Promise.all([sha256(String(left)), sha256(String(right))]);
  let mismatch = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index++) {
    mismatch |= (a.charCodeAt(index) || 0) ^ (b.charCodeAt(index) || 0);
  }
  return mismatch === 0;
}

async function passwordHash(password, salt, pepper) {
  const key = await crypto.subtle.importKey(
    'raw', encoder.encode(pepper), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  return toBase64Url(await crypto.subtle.sign('HMAC', key, encoder.encode(`${salt}\0${password}`)));
}

function validPassword(password) {
  return typeof password === 'string' && password.length >= 6 && password.length <= 128;
}

async function authAttemptKey(request, kind, username) {
  const clientIp = request.headers.get('cf-connecting-ip') || 'local';
  return `${kind}:${await sha256(`${clientIp}\0${String(username).toLocaleLowerCase()}`)}`;
}

async function ensureAuthAllowed(env, key) {
  const now = Math.floor(Date.now() / 1000);
  const row = await env.DB.prepare('SELECT blocked_until AS blockedUntil FROM auth_attempts WHERE attempt_key = ?')
    .bind(key).first();
  if (Number(row?.blockedUntil || 0) > now) {
    const retryAfter = Number(row.blockedUntil) - now;
    return error(`尝试次数过多，请在${Math.ceil(retryAfter / 60)}分钟后重试`, 429, 'too_many_attempts', { retryAfter });
  }
  return null;
}

async function recordAuthFailure(env, key) {
  const now = Math.floor(Date.now() / 1000);
  const row = await env.DB.prepare('SELECT failures, updated_at AS updatedAt FROM auth_attempts WHERE attempt_key = ?')
    .bind(key).first();
  const recentFailures = row && Number(row.updatedAt) >= now - AUTH_WINDOW_SECONDS ? Number(row.failures || 0) : 0;
  const failures = recentFailures + 1;
  const blockedUntil = failures >= AUTH_MAX_FAILURES ? now + AUTH_WINDOW_SECONDS : 0;
  await env.DB.prepare(`
    INSERT INTO auth_attempts (attempt_key, failures, blocked_until, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(attempt_key) DO UPDATE SET failures = excluded.failures,
      blocked_until = excluded.blocked_until, updated_at = excluded.updated_at
  `).bind(key, failures, blockedUntil, now).run();
}

async function clearAuthFailures(env, key) {
  await env.DB.prepare('DELETE FROM auth_attempts WHERE attempt_key = ?').bind(key).run();
}

function validUsername(username) {
  return /^[\p{L}\p{N}_-]{2,30}$/u.test(username);
}

async function readBody(request) {
  const contentLength = Number(request.headers.get('content-length') || 0);
  if (contentLength > MAX_DATA_BYTES + 20_000) throw new Error('body_too_large');
  return request.json();
}

async function createSession(env, userId) {
  const token = randomToken();
  const tokenHash = await sha256(token);
  const expiresAt = Math.floor(Date.now() / 1000) + SESSION_SECONDS;
  await env.DB.prepare('DELETE FROM sessions WHERE expires_at <= ?').bind(Math.floor(Date.now() / 1000)).run();
  await env.DB.prepare('DELETE FROM auth_attempts WHERE updated_at <= ?').bind(Math.floor(Date.now() / 1000) - 86400).run();
  await env.DB.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)')
    .bind(tokenHash, userId, expiresAt).run();
  return { token, expiresAt };
}

async function authenticate(request, env) {
  const authorization = request.headers.get('authorization') || '';
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  if (!match) return null;
  const tokenHash = await sha256(match[1]);
  const row = await env.DB.prepare(`
    SELECT sessions.user_id AS userId, sessions.expires_at AS expiresAt, users.username AS username
    FROM sessions JOIN users ON users.id = sessions.user_id
    WHERE sessions.token_hash = ?
  `).bind(tokenHash).first();
  if (!row) return null;
  if (Number(row.expiresAt) <= Math.floor(Date.now() / 1000)) {
    await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(tokenHash).run();
    return null;
  }
  return { ...row, tokenHash };
}

async function register(request, env) {
  const body = await readBody(request);
  const username = String(body.username || '').trim();
  const password = String(body.password || '');
  const inviteCode = String(body.inviteCode || '');
  const attemptKey = await authAttemptKey(request, 'register', username);
  const blocked = await ensureAuthAllowed(env, attemptKey);
  if (blocked) return blocked;
  if (!env.INVITE_CODE || !env.AUTH_PEPPER) return error('服务器尚未配置同步密钥', 503, 'server_not_configured');
  if (!(await secureEqual(inviteCode, env.INVITE_CODE))) {
    await recordAuthFailure(env, attemptKey);
    return error('邀请码不正确', 403, 'invalid_invite');
  }
  if (!validUsername(username)) return error('同步账号须为2–30个汉字、字母、数字、下划线或短横线');
  if (!validPassword(password)) return error('同步密码长度须为6–128位');
  const salt = randomToken(18);
  const hash = await passwordHash(password, salt, env.AUTH_PEPPER);
  try {
    const result = await env.DB.prepare('INSERT INTO users (username, password_salt, password_hash) VALUES (?, ?, ?)')
      .bind(username, salt, hash).run();
    const userId = Number(result.meta?.last_row_id);
    await env.DB.prepare('INSERT INTO sync_data (user_id) VALUES (?)').bind(userId).run();
    await clearAuthFailures(env, attemptKey);
    const session = await createSession(env, userId);
    return json({ ok: true, username, ...session }, 201);
  } catch (caught) {
    const message = String(caught?.message || caught);
    if (message.includes('UNIQUE')) return error('该同步账号已存在', 409, 'username_exists');
    throw caught;
  }
}

async function login(request, env) {
  const body = await readBody(request);
  const username = String(body.username || '').trim();
  const password = String(body.password || '');
  const attemptKey = await authAttemptKey(request, 'login', username);
  const blocked = await ensureAuthAllowed(env, attemptKey);
  if (blocked) return blocked;
  const user = await env.DB.prepare('SELECT id, username, password_salt AS salt, password_hash AS hash FROM users WHERE username = ? COLLATE NOCASE')
    .bind(username).first();
  if (!user || !env.AUTH_PEPPER) {
    await recordAuthFailure(env, attemptKey);
    return error('同步账号或同步密码不正确', 401, 'invalid_credentials');
  }
  const candidate = await passwordHash(password, user.salt, env.AUTH_PEPPER);
  if (!(await secureEqual(candidate, user.hash))) {
    await recordAuthFailure(env, attemptKey);
    return error('同步账号或同步密码不正确', 401, 'invalid_credentials');
  }
  await clearAuthFailures(env, attemptKey);
  const session = await createSession(env, Number(user.id));
  return json({ ok: true, username: user.username, ...session });
}

async function resetPassword(request, env) {
  const body = await readBody(request);
  const username = String(body.username || '').trim();
  const recoveryCode = String(body.recoveryCode || '').trim();
  const newPassword = String(body.newPassword || '');
  const attemptKey = await authAttemptKey(request, 'reset', username);
  const blocked = await ensureAuthAllowed(env, attemptKey);
  if (blocked) return blocked;
  if (!validUsername(username)) return error('请输入正确的同步账号');
  if (!validPassword(newPassword)) return error('新密码长度须为6–128位');
  if (!recoveryCode) return error('请输入恢复码');
  if (!env.AUTH_PEPPER || !env.RECOVERY_CODE) return error('服务器尚未配置密码恢复功能', 503, 'server_not_configured');

  if (!(await secureEqual(recoveryCode, env.RECOVERY_CODE))) {
    await recordAuthFailure(env, attemptKey);
    return error('同步账号或恢复码不正确', 401, 'invalid_recovery');
  }

  const user = await env.DB.prepare('SELECT id, username FROM users WHERE username = ? COLLATE NOCASE')
    .bind(username).first();
  if (!user) {
    await recordAuthFailure(env, attemptKey);
    return error('同步账号或恢复码不正确', 401, 'invalid_recovery');
  }

  const passwordSalt = randomToken(18);
  const passwordHashValue = await passwordHash(newPassword, passwordSalt, env.AUTH_PEPPER);
  await env.DB.batch([
    env.DB.prepare('UPDATE users SET password_salt = ?, password_hash = ? WHERE id = ?')
      .bind(passwordSalt, passwordHashValue, user.id),
    env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(user.id),
  ]);
  await clearAuthFailures(env, attemptKey);
  const session = await createSession(env, Number(user.id));
  return json({ ok: true, username: user.username, ...session });
}

async function logout(request, env, auth) {
  await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(auth.tokenHash).run();
  return json({ ok: true });
}

async function getSyncData(env, auth) {
  const row = await env.DB.prepare('SELECT data_json AS dataJson, revision, updated_at AS updatedAt FROM sync_data WHERE user_id = ?')
    .bind(auth.userId).first();
  let data = {};
  try { data = JSON.parse(row?.dataJson || '{}'); } catch (_) { data = {}; }
  return json({ ok: true, username: auth.username, data, revision: Number(row?.revision || 0), updatedAt: row?.updatedAt || null });
}

async function putSyncData(request, env, auth) {
  const body = await readBody(request);
  if (!isPlainObject(body.data)) return error('同步数据格式不正确');
  const dataJson = JSON.stringify(body.data);
  if (encoder.encode(dataJson).byteLength > MAX_DATA_BYTES) return error('同步数据超过1.5MB上限', 413, 'data_too_large');
  const baseRevision = Number(body.baseRevision);
  if (!Number.isInteger(baseRevision) || baseRevision < 0) return error('同步版本不正确');
  const updatedAt = new Date().toISOString();
  let result;
  if (body.force === true) {
    result = await env.DB.prepare(`
      UPDATE sync_data SET data_json = ?, revision = revision + 1, updated_at = ? WHERE user_id = ?
    `).bind(dataJson, updatedAt, auth.userId).run();
  } else {
    result = await env.DB.prepare(`
      UPDATE sync_data SET data_json = ?, revision = revision + 1, updated_at = ?
      WHERE user_id = ? AND revision = ?
    `).bind(dataJson, updatedAt, auth.userId, baseRevision).run();
  }
  if (Number(result.meta?.changes || 0) === 0) {
    const current = await env.DB.prepare('SELECT revision, updated_at AS updatedAt FROM sync_data WHERE user_id = ?')
      .bind(auth.userId).first();
    return error('云端已有其他设备的新数据', 409, 'revision_conflict', {
      revision: Number(current?.revision || 0), updatedAt: current?.updatedAt || null,
    });
  }
  const current = await env.DB.prepare('SELECT revision, updated_at AS updatedAt FROM sync_data WHERE user_id = ?')
    .bind(auth.userId).first();
  return json({ ok: true, revision: Number(current.revision), updatedAt: current.updatedAt });
}

async function api(request, env, url) {
  try {
    if (request.method === 'GET' && url.pathname === '/api/health') {
      const probe = await env.DB.prepare('SELECT 1 AS ready').first();
      return json({ ok: probe?.ready === 1, service: 'xiaoshuai-checkin-sync' });
    }
    if (request.method === 'POST' && url.pathname === '/api/register') return register(request, env);
    if (request.method === 'POST' && url.pathname === '/api/login') return login(request, env);
    if (request.method === 'POST' && url.pathname === '/api/reset-password') return resetPassword(request, env);
    const auth = await authenticate(request, env);
    if (!auth) return error('请先登录云同步', 401, 'unauthorized');
    if (request.method === 'POST' && url.pathname === '/api/logout') return logout(request, env, auth);
    if (request.method === 'GET' && url.pathname === '/api/sync') return getSyncData(env, auth);
    if (request.method === 'PUT' && url.pathname === '/api/sync') return putSyncData(request, env, auth);
    return error('接口不存在', 404, 'not_found');
  } catch (caught) {
    if (String(caught?.message || caught).includes('body_too_large')) return error('请求内容过大', 413, 'body_too_large');
    console.error(caught);
    return error('服务器暂时无法处理请求', 500, 'server_error');
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) return api(request, env, url);
    let response;
    if (env.ASSETS && typeof env.ASSETS.fetch === 'function') {
      response = await env.ASSETS.fetch(request);
    } else if ((request.method === 'GET' || request.method === 'HEAD') && globalThis.__SITE_INDEX_HTML__) {
      response = new Response(request.method === 'HEAD' ? null : globalThis.__SITE_INDEX_HTML__, {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      });
    } else {
      response = new Response('Not found', { status: 404 });
    }
    const headers = new Headers(response.headers);
    headers.set('x-content-type-options', 'nosniff');
    headers.set('referrer-policy', 'no-referrer');
    headers.set('permissions-policy', 'camera=(), microphone=(), geolocation=()');
    headers.set('cache-control', 'no-cache');
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  },
};
