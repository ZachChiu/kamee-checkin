import { sendPush } from './push.mjs';

const JSONH = { 'content-type': 'application/json; charset=utf-8' };
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: JSONH });

// 台灣當天日期；cron 固定在台灣 09:00 觸發
// ponytail: 單一時區。要服務其他時區就改成每小時跑一次 cron，用 rec.tz 挑出當地剛好 09:00 的人
const todayIn = tz => new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date());

const KEY = uid => `sub:${uid}`;
const isUid = v => typeof v === 'string' && /^[a-zA-Z0-9-]{8,64}$/.test(v);
const isDate = v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);

// 只收 https 的推播端點，長度設上限，避免存進奇怪的東西
function validSubscription(s){
  if (!s || typeof s !== 'object') return false;
  if (typeof s.endpoint !== 'string' || s.endpoint.length > 1024) return false;
  let u;
  try { u = new URL(s.endpoint) } catch { return false }
  if (u.protocol !== 'https:') return false;
  const k = s.keys;
  return !!k && typeof k.p256dh === 'string' && k.p256dh.length <= 200
             && typeof k.auth === 'string' && k.auth.length <= 100;
}

export function needsReminder(rec, today){
  return !!rec?.subscription && rec.lastCheckin !== today && rec.notified !== today;
}

async function readJson(request, limit = 4096){
  const body = await request.text();
  if (body.length > limit) throw new Error('payload too large');
  return JSON.parse(body);
}

export default {
  async fetch(request, env){
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return new Response('Not found', { status: 404 });

    try {
      if (url.pathname === '/api/config' && request.method === 'GET')
        return json({ vapidPublicKey: env.VAPID_PUBLIC_KEY || null });

      if (url.pathname === '/api/subscribe' && request.method === 'POST') {
        const { uid, subscription, tz } = await readJson(request);
        if (!isUid(uid) || !validSubscription(subscription)) return json({ error: 'bad request' }, 400);
        const rec = await env.SUBS.get(KEY(uid), 'json') || {};
        await env.SUBS.put(KEY(uid), JSON.stringify({
          ...rec, subscription, tz: typeof tz === 'string' ? tz.slice(0, 64) : 'Asia/Taipei',
          updated: new Date().toISOString()
        }));
        return json({ ok: true });
      }

      if (url.pathname === '/api/subscribe' && request.method === 'DELETE') {
        const uid = url.searchParams.get('uid');
        if (!isUid(uid)) return json({ error: 'bad request' }, 400);
        await env.SUBS.delete(KEY(uid));
        return json({ ok: true });
      }

      if (url.pathname === '/api/checkin' && request.method === 'POST') {
        const { uid, date } = await readJson(request);
        if (!isUid(uid) || !isDate(date)) return json({ error: 'bad request' }, 400);
        const rec = await env.SUBS.get(KEY(uid), 'json');
        if (!rec) return json({ ok: true, stored: false });        // 沒開提醒就不用記
        await env.SUBS.put(KEY(uid), JSON.stringify({ ...rec, lastCheckin: date }));
        return json({ ok: true, stored: true });
      }
    } catch {
      return json({ error: 'bad request' }, 400);
    }
    return json({ error: 'not found' }, 404);
  },

  async scheduled(event, env, ctx){
    ctx.waitUntil(remindAll(env));
  }
};

export async function remindAll(env){
  const vapid = {
    publicKey: env.VAPID_PUBLIC_KEY,
    privateKey: env.VAPID_PRIVATE_KEY,
    subject: env.VAPID_SUBJECT || 'mailto:noreply@example.com'
  };
  const payload = JSON.stringify({
    title: 'KAMEE 打卡提醒',
    body: '今天還沒打卡，記得吃保健品 🌿',
    url: '/'
  });

  let cursor, sent = 0, removed = 0;
  // ponytail: KV list 逐筆讀，幾千人以內夠用；再多就換 D1 一次查出來
  do {
    const page = await env.SUBS.list({ prefix: 'sub:', cursor });
    cursor = page.list_complete ? null : page.cursor;
    for (const { name } of page.keys) {
      const rec = await env.SUBS.get(name, 'json');
      const today = todayIn(rec?.tz || 'Asia/Taipei');
      if (!needsReminder(rec, today)) continue;
      let status;
      try { status = await sendPush(rec.subscription, payload, vapid) }
      catch { continue }
      if (status === 404 || status === 410) {                      // 訂閱失效，清掉
        await env.SUBS.delete(name); removed++; continue;
      }
      if (status >= 200 && status < 300) {
        await env.SUBS.put(name, JSON.stringify({ ...rec, notified: today }));
        sent++;
      }
    }
  } while (cursor);
  return { sent, removed };
}
