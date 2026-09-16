// node scripts/vapid.mjs — 產生一組 VAPID 金鑰（不需要額外套件）
const b64 = buf => Buffer.from(buf).toString('base64url');
const pair = await crypto.subtle.generateKey({ name:'ECDSA', namedCurve:'P-256' }, true, ['sign','verify']);
const pub = await crypto.subtle.exportKey('raw', pair.publicKey);
const { d } = await crypto.subtle.exportKey('jwk', pair.privateKey);
console.log('VAPID_PUBLIC_KEY  =', b64(pub));
console.log('VAPID_PRIVATE_KEY =', d);
console.log('\n公鑰填進 wrangler.toml 的 [vars]，私鑰用：npx wrangler secret put VAPID_PRIVATE_KEY');
