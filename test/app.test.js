const test = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const app = require('../app');
const { classify, contentHash, matchesFilters } = require('../lib/collector');

test('EGX classification keeps the notebook conditions', () => {
  assert.deepEqual(classify('توصية شراء سهم فوري'), [['buy_recommendation'], ['FWRY']]);
  assert.deepEqual(classify('شائعة استحواذ على سهم فوري'), [['acquisition_rumor'], ['FWRY']]);
  assert.deepEqual(classify('استحواذ على سهم فوري'), [[], ['FWRY']]);
  assert.deepEqual(classify('خبر عام عن الطقس'), [[], []]);
  assert.equal(contentHash('سهم فوري https://t.me/a'), contentHash('سهم فوري https://t.me/b'));
});

test('search filters combine groups and expand known stock and country aliases', () => {
  const text = 'أرباح شركة فوري في مصر هذا العام';
  assert.equal(matchesFilters(text, { keywords: ['خسائر', 'أرباح'], stocks: ['FWRY'], countries: ['Egypt'] }), true);
  assert.equal(matchesFilters(text, { keywords: ['أرباح'], stocks: ['COMI'], countries: ['مصر'] }), false);
  assert.equal(matchesFilters(text, { stocks: ['فوري'], countries: ['السعودية'] }), false);
  assert.equal(matchesFilters('سهم XYZ في قطر', { stocks: ['XYZ'], countries: ['Qatar'] }), true);
});

test('page and API reject incomplete credentials without Telegram access', async () => {
  process.env.SESSION_ENCRYPTION_KEY = randomBytes(32).toString('base64url');
  const server = app.listen(0);
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    for (const path of ['/', '/app.js', '/style.css']) {
      const response = await fetch(base + path);
      assert.equal(response.status, 200, path);
    }
    assert.deepEqual(await (await fetch(base + '/api/health')).json(), { ok: true, configured: true });
    const badKeys = await fetch(base + '/api/start', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_id: 'abc', api_hash: 'invalid' }) });
    assert.equal(badKeys.status, 400);
    const badToken = await fetch(base + '/api/page', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'old-python-token' }) });
    assert.equal(badToken.status, 400);
    const badRefresh = await fetch(base + '/api/refresh-qr', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'old-python-token' }) });
    assert.equal(badRefresh.status, 400);
    const badDisconnect = await fetch(base + '/api/disconnect', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'old-python-token' }) });
    assert.equal(badDisconnect.status, 400);
  } finally {
    await new Promise((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
  }
});
