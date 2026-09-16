import { sendPush } from './push.mjs';

const JSONH = { 'content-type': 'application/json; charset=utf-8' };
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: JSONH });

// 台灣當天日期；cron 固定在台灣 09:00 觸發
// ponytail: 單一時區。要服務其他時區就改成每小時跑一次 cron，用 rec.tz 挑出當地剛好 09:00 的人
const todayIn = tz => new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date());
const hourIn = tz => Number(new Intl.DateTimeFormat('en-GB',
  { timeZone: tz, hour: '2-digit', hourCycle: 'h23' }).format(new Date()));
const DEFAULT_HOUR = 9;

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

export function needsReminder(rec, today, hour){
  if (!rec?.subscription) return false;
  if ((rec.hour ?? DEFAULT_HOUR) !== hour) return false;        // 還沒到這個人設定的時間
  return rec.lastCheckin !== today && rec.notified !== today;
}

const vapidFrom = env => ({
  publicKey: env.VAPID_PUBLIC_KEY,
  privateKey: env.VAPID_PRIVATE_KEY,
  subject: env.VAPID_SUBJECT || 'mailto:noreply@example.com'
});
const isHour = v => Number.isInteger(v) && v >= 0 && v <= 23;

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
        const { uid, subscription, tz, hour } = await readJson(request);
        if (!isUid(uid) || !validSubscription(subscription)) return json({ error: 'bad request' }, 400);
        const rec = await env.SUBS.get(KEY(uid), 'json') || {};
        await env.SUBS.put(KEY(uid), JSON.stringify({
          ...rec, subscription, tz: typeof tz === 'string' ? tz.slice(0, 64) : 'Asia/Taipei',
          hour: isHour(hour) ? hour : (rec.hour ?? DEFAULT_HOUR),
          updated: new Date().toISOString()
        }));
        return json({ ok: true });
      }

      // 開啟通知後馬上送一則，讓使用者當場知道有沒有通
      // ponytail: 沒有節流，uid 是猜不到的隨機字串，內容也固定；真的被亂打再加 rate limit
      if (url.pathname === '/api/test' && request.method === 'POST') {
        const { uid } = await readJson(request);
        if (!isUid(uid)) return json({ error: 'bad request' }, 400);
        const rec = await env.SUBS.get(KEY(uid), 'json');
        if (!rec?.subscription) return json({ error: 'not subscribed' }, 404);
        const hour = rec.hour ?? DEFAULT_HOUR;
        let status;
        try {
          status = await sendPush(rec.subscription, JSON.stringify({
            title: '通知開好了 🔔',
            body: `之後每天 ${String(hour).padStart(2,'0')}:00 沒打卡就會提醒你`,
            url: '/'
          }), vapidFrom(env));
        } catch (e) {                   // 多半是 VAPID 金鑰沒設好或公私鑰不成對
          return json({ ok: false, error: 'push failed', detail: String(e).slice(0, 160) }, 502);
        }
        if (status === 404 || status === 410) await env.SUBS.delete(KEY(uid));
        return json({ ok: status >= 200 && status < 300, status });
      }

      if (url.pathname === '/api/subscribe' && request.method === 'DELETE') {
        const uid = url.searchParams.get('uid');
        if (!isUid(uid)) return json({ error: 'bad request' }, 400);
        await env.SUBS.delete(KEY(uid));
        return json({ ok: true });
      }

      // ponytail: 單一共用密碼，夠一個人用的後台；要多人再換成真的帳號
      if (url.pathname === '/api/broadcast' && request.method === 'POST') {
        if (!env.ADMIN_TOKEN || request.headers.get('x-admin-token') !== env.ADMIN_TOKEN)
          return json({ error: 'unauthorized' }, 401);
        const { title, body } = await readJson(request);
        const payload = JSON.stringify({
          title: String(title || 'KAMEE 打卡提醒').slice(0, 80),
          body: String(body || '記得今天的保健品 🌿').slice(0, 160),
          url: '/'
        });
        return json(await broadcast(env, payload));
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

// 回傳 'sent' | 'removed' | 'failed'
async function pushOne(env, name, rec, payload, vapid){
  let status;
  try { status = await sendPush(rec.subscription, payload, vapid) }
  catch { return 'failed' }
  if (status === 404 || status === 410) { await env.SUBS.delete(name); return 'removed' }
  return status >= 200 && status < 300 ? 'sent' : 'failed';
}

// 後台那顆按鈕：不管有沒有打卡，現在就送給所有訂閱者
export async function broadcast(env, payload){
  const vapid = vapidFrom(env);
  let cursor, sent = 0, removed = 0, failed = 0;
  do {
    const page = await env.SUBS.list({ prefix: 'sub:', cursor });
    cursor = page.list_complete ? null : page.cursor;
    for (const { name } of page.keys) {
      const rec = await env.SUBS.get(name, 'json');
      if (!rec?.subscription) continue;
      const r = await pushOne(env, name, rec, payload, vapid);
      if (r === 'sent') sent++; else if (r === 'removed') removed++; else failed++;
    }
  } while (cursor);
  return { sent, removed, failed };
}

export async function remindAll(env){
  const vapid = vapidFrom(env);
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
      const tz = rec?.tz || 'Asia/Taipei';
      const today = todayIn(tz);
      if (!needsReminder(rec, today, hourIn(tz))) continue;
      const r = await pushOne(env, name, rec, payload, vapid);
      if (r === 'removed') { removed++; continue }
      if (r === 'sent') {
        await env.SUBS.put(name, JSON.stringify({ ...rec, notified: today }));
        sent++;
      }
    }
  } while (cursor);
  return { sent, removed };
}
