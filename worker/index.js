/**
 * 健康記録アプリ用 Cloudflare Worker（中継サーバー）
 *
 * 役割：
 * - 公開ページ(index.html)からは「軽い合言葉(APP_TOKEN)」だけを受け取る
 * - 本物のGitHubトークン(GH_TOKEN)はこのWorker側の「シークレット」として保管し、
 *   公開ページのコードには一切登場させない
 * - 合言葉が正しければ、代わりにGitHubのfitness-dataリポジトリを読み書きする
 *
 * Worker のシークレット（Settings → Variables and Secrets、または wrangler secret put）：
 *   GH_TOKEN            : GitHubのfine-grainedトークン(fitness-dataのContents読み書きのみ)
 *   APP_TOKEN           : index.html側と共有する合言葉
 *   VAPID_PUBLIC_KEY    : プッシュ通知の公開鍵（フェーズ2で使用）
 *   VAPID_PRIVATE_KEY   : プッシュ通知の秘密鍵（フェーズ2で使用）
 */

const GH_OWNER = "t-mrcl";
const GH_REPO = "fitness-data";
const RECORDS_PATH = "records.json";
const SUBS_PATH = "subscriptions.json";

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders() });
    }
    if (request.method !== "POST") {
      return jsonResponse({ ok: false, error: "method not allowed" }, 405);
    }

    let body;
    try {
      body = await request.json();
    } catch (err) {
      return jsonResponse({ ok: false, error: "invalid json" }, 400);
    }

    // 合言葉のチェック(第三者からの書き込みを防ぐ)
    if (body.token !== env.APP_TOKEN) {
      return jsonResponse({ ok: false, error: "invalid token" }, 403);
    }

    try {
      if (body.mode === "subscribe") {
        return await handleSubscribe(body, env);
      }
      return await handleRecords(body, env);
    } catch (err) {
      return jsonResponse({ ok: false, error: String(err) }, 502);
    }
  },
};

// 記録データ(records.json)の追加・上書き・全置換
async function handleRecords(body, env) {
  const file = await ghGetFile(RECORDS_PATH, env);
  const current = file.json || {};

  let updated, message;
  if (body.mode === "replace") {
    updated = body.all;
    message = "データ構造の変換を反映";
  } else {
    updated = current;
    updated[body.date] = body.record;
    message = body.date + " の記録を更新";
  }

  await ghPutFile(RECORDS_PATH, updated, message, file.sha, env);
  return jsonResponse({ ok: true });
}

// 通知の購読情報(subscriptions.json)を保存する。endpointが同じものは重複させない。
async function handleSubscribe(body, env) {
  if (!body.subscription || !body.subscription.endpoint) {
    return jsonResponse({ ok: false, error: "no subscription" }, 400);
  }
  const file = await ghGetFile(SUBS_PATH, env);
  const list = Array.isArray(file.json) ? file.json : [];

  const exists = list.some((s) => s.endpoint === body.subscription.endpoint);
  if (!exists) list.push(body.subscription);

  await ghPutFile(SUBS_PATH, list, "通知の購読を追加", file.sha, env);
  return jsonResponse({ ok: true, count: list.length });
}

// --- GitHub ファイル操作 ---

function ghUrl(path) {
  return `https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/contents/${path}`;
}
function ghHeaders(env) {
  return {
    "Authorization": `Bearer ${env.GH_TOKEN}`,
    "Accept": "application/vnd.github+json",
    "Content-Type": "application/json",
    "User-Agent": "fitness-proxy-worker",
  };
}

// ファイルを取得。存在しなければ {json:null, sha:null} を返す
async function ghGetFile(path, env) {
  const res = await fetch(ghUrl(path), { headers: ghHeaders(env) });
  if (res.status === 404) return { json: null, sha: null };
  if (!res.ok) throw new Error("github get failed: " + res.status);
  const file = await res.json();
  return { json: JSON.parse(decodeBase64(file.content)), sha: file.sha };
}

// ファイルを書き込む。shaがnullなら新規作成、あれば更新
async function ghPutFile(path, obj, message, sha, env) {
  const payload = {
    message,
    content: encodeBase64(JSON.stringify(obj, null, 2)),
  };
  if (sha) payload.sha = sha;
  const res = await fetch(ghUrl(path), {
    method: "PUT",
    headers: ghHeaders(env),
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error("github put failed: " + res.status);
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: Object.assign({ "Content-Type": "application/json" }, corsHeaders()),
  });
}

function encodeBase64(str) {
  return btoa(unescape(encodeURIComponent(str)));
}
function decodeBase64(b64) {
  return decodeURIComponent(escape(atob(b64.replace(/\n/g, ""))));
}
