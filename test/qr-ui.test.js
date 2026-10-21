const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const vm = require('node:vm');

const source = readFileSync(join(__dirname, '..', 'public', 'app.js'), 'utf8')
  .split("$('refresh-qr').addEventListener('click',refreshQR);")[0];

async function runQrScenario(expiresAt, responses) {
  const elements = new Map();
  const calls = [];
  const document = { getElementById(id) {
    if (!elements.has(id)) elements.set(id, { hidden: id === 'connected-card', disabled: false, textContent: '', src: '' });
    return elements.get(id);
  } };
  const context = vm.createContext({ document, sessionStorage: { setItem() {} },
    fetch: async path => {
      calls.push(path);
      const next = responses.shift();
      assert.ok(next, `Unexpected request: ${path}`);
      return { ok: next.ok, json: async () => next.data };
    },
    setTimeout });
  vm.runInContext(source, context);
  context.initialExpiry = expiresAt;
  vm.runInContext("state.step=2;state.token='encrypted';state.qrUrl='tg://login?token=old';state.expiresAt=initialExpiry;pollQR();", context);
  for (let i = 0; i < 50 && !elements.get('connected-name')?.textContent; i++)
    await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(elements.get('connected-card')?.hidden, false);
  assert.match(elements.get('connected-name').textContent, /is connected/);
  return calls;
}

test('expired QR response refreshes the code and detects a successful scan', async () => {
  const calls = await runQrScenario(new Date(Date.now() + 20000).toISOString(), [
    { ok: false, data: { error: 'Telegram: AUTH_TOKEN_EXPIRED.' } },
    { ok: true, data: { status: 'waiting', token: 'fresh', qr_url: 'tg://login?token=new',
      qr_image: 'data:image/png;base64,AA==', expires_at: new Date(Date.now() + 30000).toISOString() } },
    { ok: true, data: { status: 'connected', token: 'authorized', name: 'Researcher' } }
  ]);
  assert.deepEqual(calls, ['/service/poll', '/service/refresh-qr', '/service/poll']);
});

test('an already expired QR is refreshed before another poll', async () => {
  const calls = await runQrScenario(new Date(Date.now() - 1000).toISOString(), [
    { ok: true, data: { status: 'waiting', token: 'fresh', qr_url: 'tg://login?token=new',
      qr_image: 'data:image/png;base64,AA==', expires_at: new Date(Date.now() + 30000).toISOString() } },
    { ok: true, data: { status: 'connected', token: 'authorized', name: 'Researcher' } }
  ]);
  assert.deepEqual(calls, ['/service/refresh-qr', '/service/poll']);
});

test('a pending scan keeps the current QR until Telegram confirms or it expires', async () => {
  const calls = await runQrScenario(new Date(Date.now() + 20000).toISOString(), [
    { ok: true, data: { status: 'unchanged' } },
    { ok: true, data: { status: 'connected', token: 'authorized', name: 'Researcher' } }
  ]);
  assert.deepEqual(calls, ['/service/poll', '/service/poll']);
});
