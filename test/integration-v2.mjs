import assert from 'node:assert/strict';

const origin = process.env.SYNC_TEST_ORIGIN || 'http://127.0.0.1:8792';
const inviteCode = process.env.SYNC_TEST_INVITE || 'local-invite';
const recoveryCode = process.env.SYNC_TEST_RECOVERY || 'huifuma';

async function request(path, { token, ...options } = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.body) headers['content-type'] = 'application/json';
  if (token) headers.authorization = `Bearer ${token}`;
  const response = await fetch(origin + path, { ...options, headers });
  const text = await response.text();
  let body = {};
  try { body = JSON.parse(text); } catch (_) { body = text; }
  return { response, body };
}

async function register(username, password = '123456') {
  return request('/api/register', {
    method: 'POST',
    body: JSON.stringify({ username, password, inviteCode }),
  });
}

const cleanSnapshot = {
  ddHistoryData: {}, ddTodos: {}, ddRecentGoals: [], ddCheckins: {},
  ddHealthData: {}, ddAlmanacRecords: {}, ddAppSettings: { name: '2.0测试' },
};

const page = await request('/');
assert.equal(page.response.status, 200);
assert.match(page.body, /cloud-sync-button/);
assert.match(page.body, /cloud-reset-panel/);
assert.match(page.body, /health-edit-btn/);
assert.match(page.body, /复盘总结/);
assert.doesNotMatch(page.body, /这些记录按天保存/);

const health = await request('/api/health');
assert.equal(health.response.status, 200);

const first = await register('v2_user_1');
assert.equal(first.response.status, 201);
assert.ok(first.body.token);

const uploaded = await request('/api/sync', {
  method: 'PUT', token: first.body.token,
  body: JSON.stringify({ data: cleanSnapshot, baseRevision: 0 }),
});
assert.equal(uploaded.response.status, 200);

const wrongRecovery = await request('/api/reset-password', {
  method: 'POST',
  body: JSON.stringify({ username: 'v2_user_1', recoveryCode: 'wrong', newPassword: '654321' }),
});
assert.equal(wrongRecovery.response.status, 401);

const reset = await request('/api/reset-password', {
  method: 'POST',
  body: JSON.stringify({ username: 'v2_user_1', recoveryCode, newPassword: '654321' }),
});
assert.equal(reset.response.status, 200);
assert.ok(reset.body.token);

const oldSession = await request('/api/sync', { token: first.body.token });
assert.equal(oldSession.response.status, 401);

const oldPassword = await request('/api/login', {
  method: 'POST', body: JSON.stringify({ username: 'v2_user_1', password: '123456' }),
});
assert.equal(oldPassword.response.status, 401);

const newLogin = await request('/api/login', {
  method: 'POST', body: JSON.stringify({ username: 'v2_user_1', password: '654321' }),
});
assert.equal(newLogin.response.status, 200);

const downloaded = await request('/api/sync', { token: newLogin.body.token });
assert.equal(downloaded.response.status, 200);
assert.equal(downloaded.body.data.ddAppSettings.name, '2.0测试');

for (let index = 2; index <= 51; index += 1) {
  const created = await register(`v2_user_${index}`);
  assert.equal(created.response.status, 201, `account ${index} should be created`);
}

console.log('2.0 integration checks passed: page, D1, numeric password, sync, fixed recovery code, session revocation, no 50-account cap.');
