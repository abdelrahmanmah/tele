const express = require('express');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { randomBytes, createCipheriv, createDecipheriv } = require('node:crypto');
const QRCode = require('qrcode');
const { Api, TelegramClient } = require('teleproto');
const { StringSession } = require('teleproto/sessions');
const { Raw } = require('teleproto/events');
const { computeCheck } = require('teleproto/Password');
const { classify, contentHash, matchesFilters } = require('./lib/collector');

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '24kb' }));
app.use((req, res, next) => {
  res.set('Cache-Control', 'no-store');
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'no-referrer');
  res.set('X-Frame-Options', 'DENY');
  next();
});

function bad(message) { const e = new Error(message); e.status = 400; return e; }
function key() {
  const value = process.env.SESSION_ENCRYPTION_KEY || '';
  const decoded = Buffer.from(value, 'base64url');
  if (decoded.length !== 32) throw new Error('SESSION_ENCRYPTION_KEY must be a 32-byte base64url secret');
  return decoded;
}
function seal(client, apiId, apiHash) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  const payload = Buffer.from(JSON.stringify({ id: apiId, hash: apiHash,
    session: client.session.save(), at: Date.now() }));
  const encrypted = Buffer.concat([cipher.update(payload), cipher.final()]);
  return `v1.${Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64url')}`;
}
function unseal(token) {
  if (typeof token !== 'string' || token.length > 4096 || !token.startsWith('v1.'))
    throw bad('Invalid session. Connect Telegram again.');
  try {
    const value = Buffer.from(token.slice(3), 'base64url');
    const decipher = createDecipheriv('aes-256-gcm', key(), value.subarray(0, 12));
    decipher.setAuthTag(value.subarray(12, 28));
    const data = JSON.parse(Buffer.concat([decipher.update(value.subarray(28)), decipher.final()]).toString());
    if (!Number.isInteger(data.id) || typeof data.hash !== 'string' ||
      typeof data.session !== 'string' || Date.now() - data.at > 12 * 60 * 60 * 1000 || data.at > Date.now() + 60_000)
      throw new Error('expired');
    return data;
  } catch { throw bad('Your session has expired. Connect Telegram again.'); }
}
const QR_RESET_ERRORS = new Set(['AUTH_TOKEN_EXPIRED', 'AUTH_KEY_UNREGISTERED',
  'AUTH_KEY_INVALID', 'AUTH_KEY_DUPLICATED', 'SESSION_EXPIRED', 'SESSION_REVOKED']);
async function withClient(saved, operation, qrLogin = false) {
  const client = new TelegramClient(new StringSession(saved.session || ''), saved.id, saved.hash,
    { connectionRetries: 1, requestRetries: 1, autoReconnect: false });
  client.setLogLevel('error');
  if (qrLogin) client.updates.catch(error => {
    // An unauthenticated QR session cannot answer updates.GetState yet.
    if (error.errorMessage !== 'AUTH_KEY_UNREGISTERED') console.error('Telegram QR update error:', error);
  });
  try { await client.connect(); return await operation(client); }
  finally { await client.disconnect().catch(() => {}); }
}
function exportToken(client, saved) {
  return client.invoke(new Api.auth.ExportLoginToken({ apiId: saved.id,
    apiHash: saved.hash, exceptIds: [] }));
}
async function qrPayload(client, saved, result) {
  if (!(result instanceof Api.auth.LoginToken)) throw new Error('Telegram returned an unexpected QR response');
  const qrUrl = `tg://login?token=${Buffer.from(result.token).toString('base64url')}`;
  return { token: seal(client, saved.id, saved.hash), qr_url: qrUrl,
    qr_image: await QRCode.toDataURL(qrUrl, { width: 252, margin: 2 }),
    expires_at: new Date(Number(result.expires) * 1000).toISOString() };
}
function displayName(user) {
  return [user?.firstName, user?.lastName].filter(Boolean).join(' ') || user?.username || 'your account';
}
async function connectedPayload(client, saved) {
  if (!await client.checkAuthorization()) return null;
  return { status: 'connected', token: seal(client, saved.id, saved.hash), name: displayName(await client.getMe()) };
}
async function completeLogin(client, saved, result) {
  if (result instanceof Api.auth.LoginTokenMigrateTo) {
    await client._switchDC(Number(result.dcId));
    result = await client.invoke(new Api.auth.ImportLoginToken({ token: result.token }));
  }
  if (result instanceof Api.auth.LoginTokenSuccess) {
    return { status: 'connected', token: seal(client, saved.id, saved.hash),
      name: displayName(result.authorization.user) };
  }
  return { status: 'waiting', ...await qrPayload(client, saved, result) };
}
function route(fn) { return (req, res, next) => Promise.resolve().then(() => fn(req.body || {}, req)).then(data => res.json(data)).catch(next); }

app.get('/api/health', (req, res) => res.json({ ok: true,
  configured: (() => { try { key(); return true; } catch { return false; } })() }));

app.post('/api/start', route(async body => {
  const rawId = String(body.api_id || '').trim();
  const hash = String(body.api_hash || '').trim();
  if (!/^\d+$/.test(rawId) || Number(rawId) < 1 || Number(rawId) > 2147483647 || !/^[a-f\d]{32}$/i.test(hash))
    throw bad('Check your API ID and API Hash against my.telegram.org.');
  const saved = { id: Number(rawId), hash, session: '' };
  return withClient(saved, async client => qrPayload(client, saved, await exportToken(client, saved)), true);
}));

app.post('/api/poll', route(async body => {
  const saved = unseal(body.token);
  try {
    return await withClient(saved, async client => {
      const connected = await connectedPayload(client, saved);
      if (connected) return connected;
      const expires = Date.parse(String(body.expires_at || ''));
      try {
        const remaining = expires - Date.now() - 2000;
        if (!String(body.qr_url || '').startsWith('tg://login?token=') || !Number.isFinite(remaining) || remaining <= 0)
          return await completeLogin(client, saved, await exportToken(client, saved));
        const raw = new Raw({});
        let handler;
        const update = new Promise(resolve => {
          handler = event => { if (event instanceof Api.UpdateLoginToken) resolve(); };
          client.addEventHandler(handler, raw);
        });
        let accepted;
        try { accepted = await Promise.race([update.then(() => true), new Promise(resolve => setTimeout(() => resolve(false), Math.min(12000, remaining)))]); }
        finally { client.removeEventHandler(handler, raw); }
        if (!accepted) {
          const nowConnected = await connectedPayload(client, saved);
          if (nowConnected) return nowConnected;
          if (expires - Date.now() > 2000) return { status: 'unchanged' };
        }
        return await completeLogin(client, saved, await exportToken(client, saved));
      } catch (err) {
        if (err.errorMessage === 'SESSION_PASSWORD_NEEDED')
          return { status: 'password', token: seal(client, saved.id, saved.hash) };
        throw err;
      }
    }, true);
  } catch (err) {
    if (!QR_RESET_ERRORS.has(err.errorMessage)) throw err;
    const fresh = { ...saved, session: '' };
    return withClient(fresh, async client => ({ status: 'waiting', reset: true,
      ...await qrPayload(client, fresh, await exportToken(client, fresh)) }), true);
  }
}));

app.post('/api/refresh-qr', route(async body => {
  const saved = unseal(body.token);
  try {
    return await withClient(saved, async client =>
      await connectedPayload(client, saved) || await completeLogin(client, saved, await exportToken(client, saved)), true);
  } catch (err) {
    if (!QR_RESET_ERRORS.has(err.errorMessage)) throw err;
    const fresh = { ...saved, session: '' };
    return withClient(fresh, async client => ({ status: 'waiting', reset: true,
      ...await qrPayload(client, fresh, await exportToken(client, fresh)) }), true);
  }
}));

app.post('/api/disconnect', route(async body => {
  const saved = unseal(body.token);
  return withClient(saved, async client => {
    try {
      await client.invoke(new Api.auth.LogOut());
      return { disconnected: true };
    } catch (err) {
      if (['AUTH_KEY_UNREGISTERED', 'AUTH_KEY_INVALID', 'SESSION_EXPIRED', 'SESSION_REVOKED'].includes(err.errorMessage))
        return { disconnected: true, already_ended: true };
      throw err;
    }
  }, true);
}));

app.post('/api/password', route(async body => {
  const saved = unseal(body.token);
  const password = body.password;
  if (typeof password !== 'string' || !password || password.length > 256)
    throw bad('Enter your two-step verification password.');
  return withClient(saved, async client => {
    try {
      const settings = await client.invoke(new Api.account.GetPassword());
      const check = await computeCheck(settings, password);
      const authorization = await client.invoke(new Api.auth.CheckPassword({ password: check }));
      return { status: 'connected', token: seal(client, saved.id, saved.hash),
        name: displayName(authorization.user) };
    } catch (err) {
      if (err.errorMessage === 'PASSWORD_HASH_INVALID') throw bad('Incorrect password. Check it and try again.');
      throw err;
    }
  }, true);
}));

app.post('/api/source', route(async body => {
  const saved = unseal(body.token);
  const source = String(body.source || '').trim();
  if (!source || source.length > 180) throw bad('Enter a valid channel name or t.me link.');
  return withClient(saved, async client => {
    if (!await client.checkAuthorization()) throw bad('Your Telegram connection has expired. Connect your account again.');
    const entity = await client.getEntity(source);
    const input = await client.getInputEntity(entity);
    let peer;
    if (input instanceof Api.InputPeerChannel)
      peer = { kind: 'channel', id: String(input.channelId), access_hash: String(input.accessHash) };
    else if (input instanceof Api.InputPeerChat)
      peer = { kind: 'chat', id: String(input.chatId) };
    else throw bad('Choose a channel or group instead of a private chat.');
    let photo = '';
    try {
      const buffer = await client.downloadProfilePhoto(entity);
      if (Buffer.isBuffer(buffer) && buffer.length && buffer.length < 35_000)
        photo = `data:image/jpeg;base64,${buffer.toString('base64')}`;
    } catch { /* Image is optional. */ }
    return { peer, title: entity.title || source, username: entity.username || '', photo, source };
  });
}));

function parseDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw bad('Enter a valid date.');
  const date = Date.parse(`${value}T00:00:00Z`);
  if (!Number.isFinite(date)) throw bad('Enter a valid date.');
  return date;
}
function inputPeer(data) {
  if (!data || !/^\d+$/.test(String(data.id || ''))) throw bad('Invalid source.');
  if (data.kind === 'channel' && /^-?\d+$/.test(String(data.access_hash || '')))
    return new Api.InputPeerChannel({ channelId: BigInt(data.id), accessHash: BigInt(data.access_hash) });
  if (data.kind === 'chat') return new Api.InputPeerChat({ chatId: BigInt(data.id) });
  throw bad('Invalid source.');
}
function filterTerms(value) {
  return Array.isArray(value) ? value.slice(0, 12).map(x => String(x).trim().slice(0, 80)).filter(Boolean) : [];
}

app.post('/api/page', route(async body => {
  const saved = unseal(body.token);
  const peer = inputPeer(body.peer);
  const start = parseDate(body.start), end = parseDate(body.end);
  if (start >= end) throw bad('The start date must be before the end date.');
  const cursor = Number(body.cursor || 0);
  if (!Number.isSafeInteger(cursor) || cursor < 0) throw bad('Invalid message cursor.');
  if (!['egx', 'all'].includes(body.mode)) throw bad('Invalid search mode.');
  const keywords = filterTerms(body.keywords);
  const stocks = filterTerms(body.stocks);
  const countries = filterTerms(body.countries);
  const pageLimit = Number(body.limit || 60);
  if (!Number.isSafeInteger(pageLimit) || pageLimit < 1 || pageLimit > 60) throw bad('Invalid page size.');
  return withClient(saved, async client => {
    if (!await client.checkAuthorization()) throw bad('Your Telegram connection has expired. Connect your account again.');
    const messages = await client.getMessages(peer, { limit: pageLimit,
      ...(cursor ? { offsetId: cursor } : { offsetDate: Math.floor(end / 1000) }) });
    const rows = [], rawRows = [];
    let reachedStart = false;
    for (const m of messages) {
      const date = typeof m.date === 'number' ? m.date * 1000 : new Date(m.date).getTime();
      if (!Number.isFinite(date)) continue;
      if (date < start) { reachedStart = true; break; }
      const text = m.message || '';
      if (date >= end || !text.trim()) continue;
      const [categories, companies] = classify(text);
      const id = String(body.peer.id);
      const username = /^[a-z\d_]{1,32}$/i.test(String(body.username || '')) ? body.username : '';
      const url = username ? `https://t.me/${username}/${m.id}` : body.peer.kind === 'channel' ? `https://t.me/c/${id}/${m.id}` : '';
      const row = { chat_id: id, chat_title: String(body.title || ''), chat_username: username,
        message_id: String(m.id), date_utc: new Date(date).toISOString(), text, url,
        categories: categories.join('|'), companies: companies.join('|'), content_sha256: contentHash(text) };
      rawRows.push(row);
      if ((body.mode === 'all' || categories.length) && matchesFilters(text, { keywords, stocks, countries })) rows.push(row);
    }
    return { rows, raw_rows: rawRows, scanned: messages.length,
      cursor: messages.length ? Number(messages[messages.length - 1].id) : cursor,
      done: !messages.length || reachedStart || messages.length < pageLimit };
  });
}));

app.get('/', (req, res) => res.type('html').send(readFileSync(join(__dirname, 'public', 'index.html'))));
app.use(express.static(join(__dirname, 'public')));
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  const seconds = Number(err.seconds || /FLOOD_WAIT_(\d+)/.exec(err.errorMessage || '')?.[1] || 0);
  if (seconds) return res.status(429).json({ error: `Telegram asked us to wait ${seconds} seconds.`, wait_seconds: seconds });
  if (err.status === 400) return res.status(400).json({ error: err.message });
  if (err.errorMessage) return res.status(400).json({ error: `Telegram: ${err.errorMessage}. Check your credentials and access.` });
  console.error('API error:', err);
  return res.status(500).json({ error: 'A connection error occurred. Please try again.' });
});

if (require.main === module) app.listen(process.env.PORT || 3000, () => console.log('Mersad is ready'));
module.exports = app;
