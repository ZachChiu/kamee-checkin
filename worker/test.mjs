// node worker/test.mjs
import assert from 'node:assert';
import { encryptPayload, vapidHeader, _internal } from './push.mjs';
import worker, { needsReminder, remindAll } from './index.mjs';

const { b64, concat, hkdf } = _internal;
const enc = s => new TextEncoder().encode(s);
const subtle = crypto.subtle;

/* ---- 1. 推播內容加解密（模擬瀏覽器端解回來） ---- */
const ua = await subtle.generateKey({ name:'ECDH', namedCurve:'P-256' }, true, ['deriveBits']);
const uaPub = new Uint8Array(await subtle.exportKey('raw', ua.publicKey));
const auth = crypto.getRandomValues(new Uint8Array(16));
const keys = { p256dh: b64.encode(uaPub), auth: b64.encode(auth) };

const body = await encryptPayload('哈囉 KAMEE', keys.p256dh, keys.auth);
assert.strictEqual(body[20], 65, '公鑰長度欄位');
assert.strictEqual(new DataView(body.buffer, body.byteOffset).getUint32(16), 4096, 'record size');

const salt = body.slice(0, 16), asPub = body.slice(21, 86), ct = body.slice(86);
const asKey = await subtle.importKey('raw', asPub, { name:'ECDH', namedCurve:'P-256' }, false, []);
const shared = new Uint8Array(await subtle.deriveBits({ name:'ECDH', public: asKey }, ua.privateKey, 256));
const ikm = await hkdf(auth, shared, concat(enc('WebPush: info\0'), uaPub, asPub), 32);
const cek = await hkdf(salt, ikm, enc('Content-Encoding: aes128gcm\0'), 16);
const nonce = await hkdf(salt, ikm, enc('Content-Encoding: nonce\0'), 12);
const aes = await subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']);
const plain = new Uint8Array(await subtle.decrypt({ name:'AES-GCM', iv: nonce }, aes, ct));
assert.strictEqual(plain[plain.length - 1], 2, '記錄分隔位元組');
assert.strictEqual(new TextDecoder().decode(plain.slice(0, -1)), '哈囉 KAMEE');

/* ---- 2. VAPID JWT 可被公鑰驗章 ---- */
const vk = await subtle.generateKey({ name:'ECDSA', namedCurve:'P-256' }, true, ['sign','verify']);
const vapid = {
  publicKey: b64.encode(new Uint8Array(await subtle.exportKey('raw', vk.publicKey))),
  privateKey: (await subtle.exportKey('jwk', vk.privateKey)).d,
  subject: 'mailto:test@example.com'
};
const header = await vapidHeader('https://fcm.googleapis.com', vapid);
const [, t, k] = header.match(/^vapid t=([^,]+), k=(.+)$/);
assert.strictEqual(k, vapid.publicKey);
const [h, p, sig] = t.split('.');
assert.deepStrictEqual(JSON.parse(new TextDecoder().decode(b64.decode(h))), { typ:'JWT', alg:'ES256' });
const claims = JSON.parse(new TextDecoder().decode(b64.decode(p)));
assert.strictEqual(claims.aud, 'https://fcm.googleapis.com');
assert.strictEqual(claims.sub, 'mailto:test@example.com');
assert.ok(claims.exp > Date.now()/1000 && claims.exp <= Date.now()/1000 + 12*3600 + 5, 'exp 在 12 小時內');
assert.ok(await subtle.verify({ name:'ECDSA', hash:'SHA-256' }, vk.publicKey, b64.decode(sig), enc(`${h}.${p}`)), '簽章可驗證');

/* ---- 3. 要不要提醒 ---- */
const sub = { endpoint:'https://x/y', keys };
assert.strictEqual(needsReminder({ subscription: sub }, '2026-09-16'), true);
assert.strictEqual(needsReminder({ subscription: sub, lastCheckin:'2026-09-16' }, '2026-09-16'), false);
assert.strictEqual(needsReminder({ subscription: sub, notified:'2026-09-16' }, '2026-09-16'), false);
assert.strictEqual(needsReminder({ subscription: sub, lastCheckin:'2026-09-15' }, '2026-09-16'), true);
assert.strictEqual(needsReminder({}, '2026-09-16'), false);

/* ---- 4. API 路由與輸入檢查 ---- */
const store = new Map();
const env = {
  SUBS: {
    get: async (k, t) => { const v = store.get(k); return v == null ? null : (t === 'json' ? JSON.parse(v) : v) },
    put: async (k, v) => { store.set(k, v) },
    delete: async k => { store.delete(k) },
    list: async ({ prefix }) => ({ keys: [...store.keys()].filter(k => k.startsWith(prefix)).map(name => ({ name })), list_complete: true })
  },
  VAPID_PUBLIC_KEY: vapid.publicKey, VAPID_PRIVATE_KEY: vapid.privateKey, VAPID_SUBJECT: vapid.subject
};
const call = (path, init) => worker.fetch(new Request('https://app.test' + path, init), env);
const post = (path, data) => call(path, { method:'POST', body: JSON.stringify(data) });

assert.strictEqual((await call('/api/config')).status, 200);
assert.strictEqual((await (await call('/api/config')).json()).vapidPublicKey, vapid.publicKey);
assert.strictEqual((await call('/nope')).status, 404);
assert.strictEqual((await post('/api/subscribe', { uid:'bad uid!', subscription: sub })).status, 400);
assert.strictEqual((await post('/api/subscribe', { uid:'abcd1234', subscription:{ endpoint:'http://x', keys } })).status, 400, '非 https 要擋');
assert.strictEqual((await post('/api/subscribe', { uid:'abcd1234', subscription:{ endpoint:'https://x' } })).status, 400, '缺 keys 要擋');
assert.strictEqual((await post('/api/subscribe', { uid:'abcd1234', subscription: sub, tz:'Asia/Taipei' })).status, 200);
assert.ok(store.has('sub:abcd1234'));
assert.strictEqual((await post('/api/checkin', { uid:'abcd1234', date:'16/09/2026' })).status, 400, '日期格式要擋');
assert.strictEqual((await post('/api/checkin', { uid:'abcd1234', date:'2026-09-16' })).status, 200);
assert.strictEqual(JSON.parse(store.get('sub:abcd1234')).lastCheckin, '2026-09-16');
assert.strictEqual((await (await post('/api/checkin', { uid:'nobody12', date:'2026-09-16' })).json()).stored, false);
assert.strictEqual((await call('/api/subscribe?uid=abcd1234', { method:'DELETE' })).status, 200);
assert.strictEqual(store.size, 0);

/* ---- 5. 排程：送出、記錄、清掉失效訂閱 ---- */
const today = new Intl.DateTimeFormat('en-CA', { timeZone:'Asia/Taipei' }).format(new Date());
store.set('sub:aaaaaaaa', JSON.stringify({ subscription:{ ...sub, endpoint:'https://push.test/ok' }, tz:'Asia/Taipei' }));
store.set('sub:bbbbbbbb', JSON.stringify({ subscription:{ ...sub, endpoint:'https://push.test/gone' }, tz:'Asia/Taipei' }));
store.set('sub:cccccccc', JSON.stringify({ subscription:{ ...sub, endpoint:'https://push.test/ok2' }, tz:'Asia/Taipei', lastCheckin: today }));

const calls = [];
globalThis.fetch = async (endpoint, init) => {
  calls.push({ endpoint, ttl: init.headers.TTL, cencoding: init.headers['Content-Encoding'],
    auth: init.headers.Authorization.slice(0, 8), len: init.body.length });
  return new Response(null, { status: endpoint.endsWith('/gone') ? 410 : 201 });
};
const result = await remindAll(env);
assert.deepStrictEqual(result, { sent: 1, removed: 1 });
assert.strictEqual(calls.length, 2, '今天打過卡的人不送');
assert.ok(calls.every(c => c.ttl === '86400' && c.cencoding === 'aes128gcm' && c.auth === 'vapid t='));
assert.ok(calls.every(c => c.len > 86), '內容有加密過');
assert.strictEqual(store.has('sub:bbbbbbbb'), false, '410 要刪掉');
assert.strictEqual(JSON.parse(store.get('sub:aaaaaaaa')).notified, today);
assert.deepStrictEqual(await remindAll(env), { sent: 0, removed: 0 }, '同一天不重複提醒');

console.log('worker ok');
