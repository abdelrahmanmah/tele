const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const vm = require('node:vm');

const source = readFileSync(join(__dirname, '..', 'public', 'app.js'), 'utf8')
  .split("$('refresh-qr').addEventListener('click',refreshQR);")[0];

async function resetScenario(disconnectFails) {
  const events = [];
  const elements = new Map();
  const fakeDb = { transaction(names) {
    const tx = { objectStore(name) { return { clear() { events.push(`clear:${name}`); } }; } };
    queueMicrotask(() => tx.oncomplete());
    return tx;
  } };
  const context = vm.createContext({ fakeDb, AbortController, setTimeout, clearTimeout,
    document: { getElementById(id) {
      if (!elements.has(id)) elements.set(id, { textContent: '', disabled: false, dataset: {}, hidden: false });
      return elements.get(id);
    } },
    sessionStorage: { removeItem(key) { events.push(`remove:${key}`); }, setItem() {} },
    confirm: () => true,
    alert: () => events.push('alert'),
    window: { location: { reload() { events.push('reload'); } } },
    fetch: async path => {
      events.push(path);
      if (disconnectFails) throw Error('Network unavailable');
      return { ok: true, json: async () => ({ disconnected: true }) };
    } });
  vm.runInContext(source, context);
  return { events, run: () => vm.runInContext("db=fakeDb;state.token='encrypted';resetApp()", context) };
}

test('disconnect and reset clears both browser stores before returning to step one', async () => {
  const { events, run } = await resetScenario(false);
  await run();
  assert.deepEqual(events, ['/api/disconnect', 'clear:raw', 'clear:filtered',
    'remove:mersad-session-v1', 'reload']);
});

test('local reset still works when Telegram disconnection cannot be confirmed', async () => {
  const { events, run } = await resetScenario(true);
  await run();
  assert.deepEqual(events, ['/api/disconnect', 'clear:raw', 'clear:filtered',
    'remove:mersad-session-v1', 'alert', 'reload']);
});
