// Web Push 送出（RFC 8291 aes128gcm + RFC 8292 VAPID），只用 WebCrypto，沒有相依套件。
// ponytail: 自己實作是為了不在 Workers 上拖一包 Node 相依；要換成現成套件的話，只有 sendPush() 這個出口要改。

const enc = s => new TextEncoder().encode(s);

const b64 = {
  decode(s){
    const t = s.replace(/-/g,'+').replace(/_/g,'/');
    const bin = atob(t + '='.repeat((4 - t.length % 4) % 4));
    return Uint8Array.from(bin, c => c.charCodeAt(0));
  },
  encode(buf){
    let bin = '';
    for (const b of new Uint8Array(buf)) bin += String.fromCharCode(b);
    return btoa(bin).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
  }
};

function concat(...parts){
  const out = new Uint8Array(parts.reduce((n,p) => n + p.length, 0));
  let i = 0;
  for (const p of parts) { out.set(p, i); i += p.length; }
  return out;
}

async function hkdf(salt, ikm, info, len){
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits(
    { name:'HKDF', hash:'SHA-256', salt, info }, key, len * 8));
}

// 回傳完整的 aes128gcm 內容：salt(16) | rs(4) | idlen(1) | 臨時公鑰(65) | 密文
export async function encryptPayload(payload, p256dh, auth){
  const uaPublic = b64.decode(p256dh);
  const authSecret = b64.decode(auth);
  const as = await crypto.subtle.generateKey({ name:'ECDH', namedCurve:'P-256' }, true, ['deriveBits']);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', as.publicKey));
  const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name:'ECDH', namedCurve:'P-256' }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name:'ECDH', public: uaKey }, as.privateKey, 256));

  const ikm = await hkdf(authSecret, shared, concat(enc('WebPush: info\0'), uaPublic, asPublic), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, enc('Content-Encoding: nonce\0'), 12);

  const aesKey = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const plaintext = concat(enc(payload), new Uint8Array([2]));   // 0x02 = 最後一筆記錄
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name:'AES-GCM', iv: nonce }, aesKey, plaintext));

  const head = new Uint8Array(21);
  head.set(salt, 0);
  new DataView(head.buffer).setUint32(16, 4096);                 // record size
  head[20] = asPublic.length;
  return concat(head, asPublic, ct);
}

// VAPID 的 Authorization header
export async function vapidHeader(audience, { publicKey, privateKey, subject }){
  const pub = b64.decode(publicKey);
  const jwk = {
    kty:'EC', crv:'P-256', ext:true,
    x: b64.encode(pub.slice(1,33)),
    y: b64.encode(pub.slice(33,65)),
    d: privateKey
  };
  const key = await crypto.subtle.importKey('jwk', jwk, { name:'ECDSA', namedCurve:'P-256' }, false, ['sign']);
  const head = b64.encode(enc(JSON.stringify({ typ:'JWT', alg:'ES256' })));
  const body = b64.encode(enc(JSON.stringify({
    aud: audience, sub: subject, exp: Math.floor(Date.now()/1000) + 12 * 3600
  })));
  const sig = await crypto.subtle.sign({ name:'ECDSA', hash:'SHA-256' }, key, enc(`${head}.${body}`));
  return `vapid t=${head}.${body}.${b64.encode(sig)}, k=${publicKey}`;
}

// 回傳 push service 的 HTTP 狀態；404/410 代表訂閱失效，呼叫端自己清掉
export async function sendPush(subscription, payload, vapid, ttl = 86400){
  const body = await encryptPayload(payload, subscription.keys.p256dh, subscription.keys.auth);
  const res = await fetch(subscription.endpoint, {
    method: 'POST',
    headers: {
      'TTL': String(ttl),
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      'Authorization': await vapidHeader(new URL(subscription.endpoint).origin, vapid)
    },
    body
  });
  return res.status;
}

export const _internal = { b64, concat, hkdf };
