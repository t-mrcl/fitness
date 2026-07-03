/**
 * Web Push 送信の実装（Cloudflare Worker の Web Crypto で完結）
 * - VAPID (RFC 8292) でこのアプリからの通知だと署名
 * - 本文を aes128gcm (RFC 8291/8188) で暗号化
 * ライブラリに頼らず標準のWeb暗号APIだけで実装している。
 */

// --- 基本ユーティリティ ---
function b64urlToBytes(s) {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  const pad = s.length % 4 ? "=".repeat(4 - (s.length % 4)) : "";
  const bin = atob(s + pad);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr;
}
function bytesToB64url(bytes) {
  let bin = "";
  const arr = new Uint8Array(bytes);
  for (let i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function utf8(str) { return new TextEncoder().encode(str); }
function concat(...arrays) {
  let len = 0;
  for (const a of arrays) len += a.length;
  const out = new Uint8Array(len);
  let off = 0;
  for (const a of arrays) { out.set(a, off); off += a.length; }
  return out;
}

async function hmacSha256(keyBytes, dataBytes) {
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, dataBytes);
  return new Uint8Array(sig);
}

// --- VAPIDのJWTを作る（ES256署名） ---
async function makeVapidJWT(endpoint, vapidPublicKey, vapidPrivateKey, subject) {
  const url = new URL(endpoint);
  const aud = url.origin;
  const header = { typ: "JWT", alg: "ES256" };
  const payload = {
    aud,
    exp: Math.floor(Date.now() / 1000) + 12 * 60 * 60, // 12時間有効
    sub: subject,
  };
  const enc = (obj) => bytesToB64url(utf8(JSON.stringify(obj)));
  const signingInput = enc(header) + "." + enc(payload);

  // VAPID秘密鍵(32バイト)と公開鍵(65バイト)からJWKを組み立ててインポート
  const pub = b64urlToBytes(vapidPublicKey); // 0x04 || X(32) || Y(32)
  const jwk = {
    kty: "EC",
    crv: "P-256",
    d: vapidPrivateKey,
    x: bytesToB64url(pub.slice(1, 33)),
    y: bytesToB64url(pub.slice(33, 65)),
    ext: true,
  };
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, utf8(signingInput));
  return signingInput + "." + bytesToB64url(new Uint8Array(sig));
}

// --- 本文を aes128gcm で暗号化 ---
async function encryptPayload(payloadBytes, uaPublicB64, authB64) {
  const uaPublic = b64urlToBytes(uaPublicB64); // 受信側公開鍵 65バイト
  const authSecret = b64urlToBytes(authB64);   // 16バイト

  // 送信側の使い捨て鍵ペア
  const asKeyPair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey("raw", asKeyPair.publicKey)); // 65バイト

  const uaKey = await crypto.subtle.importKey("raw", uaPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ecdhSecret = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, asKeyPair.privateKey, 256));

  // RFC 8291: 共有鍵からIKMを導出
  const prkCombine = await hmacSha256(authSecret, ecdhSecret);
  const keyInfo = concat(utf8("WebPush: info"), new Uint8Array([0]), uaPublic, asPublic);
  const ikm = await hmacSha256(prkCombine, concat(keyInfo, new Uint8Array([1])));

  // RFC 8188: CEK と NONCE を導出
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const prk = await hmacSha256(salt, ikm);
  const cek = (await hmacSha256(prk, concat(utf8("Content-Encoding: aes128gcm"), new Uint8Array([0, 1])))).slice(0, 16);
  const nonce = (await hmacSha256(prk, concat(utf8("Content-Encoding: nonce"), new Uint8Array([0, 1])))).slice(0, 12);

  // 平文 + 区切り(0x02) を暗号化
  const record = concat(payloadBytes, new Uint8Array([2]));
  const aesKey = await crypto.subtle.importKey("raw", cek, { name: "AES-GCM" }, false, ["encrypt"]);
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, tagLength: 128 }, aesKey, record));

  // aes128gcm ヘッダ: salt(16) || rs(4) || idlen(1) || keyid(as_public 65) || 暗号文
  const rs = new Uint8Array([0, 0, 0x10, 0]); // レコードサイズ 4096
  const idlen = new Uint8Array([asPublic.length]);
  return concat(salt, rs, idlen, asPublic, cipher);
}

/**
 * 1つの購読先に通知を送る。戻り値は fetch の Response。
 * statusCode 201 が成功。404/410 は購読が失効している合図。
 */
export async function sendWebPush(subscription, payloadObj, vapid) {
  const endpoint = subscription.endpoint;
  const jwt = await makeVapidJWT(endpoint, vapid.publicKey, vapid.privateKey, vapid.subject);
  const body = await encryptPayload(utf8(JSON.stringify(payloadObj)), subscription.keys.p256dh, subscription.keys.auth);

  return fetch(endpoint, {
    method: "POST",
    headers: {
      "Authorization": `vapid t=${jwt}, k=${vapid.publicKey}`,
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
      "TTL": "86400",
    },
    body,
  });
}
