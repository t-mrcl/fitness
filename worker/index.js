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

import { sendWebPush } from "./webpush.js";

const GH_OWNER = "t-mrcl";
const GH_REPO = "fitness-data";
const RECORDS_PATH = "records.json";
const SUBS_PATH = "subscriptions.json";

// プッシュ通知の公開鍵（index.htmlのVAPID_PUBLIC_KEYと同じ値。公開してOK）
const VAPID_PUBLIC_KEY = "BIpRyt-0tdoFwdFHkOnTJffYSmOERAaFjVDSZjGD2F9AAlD5w75qm04MLSWl9RNlifj5Ep3J0aGXXF3mZJbQ8n8";
const VAPID_SUBJECT = "https://t-mrcl.github.io/fitness/";
const APP_URL = "https://t-mrcl.github.io/fitness/";
// 「1日の区切り」の時刻。index.html の DAY_BOUNDARY_HOUR と必ず揃える
const DAY_BOUNDARY_HOUR = 5;

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
      if (body.mode === "runreminder") {
        // テスト用の手動実行。force:true で「入力済みでも必ず送る」
        const result = await sendReminderIfNeeded(env, body.force === true);
        return jsonResponse({ ok: true, ...result });
      }
      return await handleRecords(body, env);
    } catch (err) {
      return jsonResponse({ ok: false, error: String(err) }, 502);
    }
  },

  // 毎日の定時実行（cron）。wrangler.tomlで時刻を設定
  async scheduled(event, env, ctx) {
    ctx.waitUntil(sendReminderIfNeeded(env, false));
  },
};

// 「論理的な今日」の日付を返す（JST・朝5時が区切り）
function logicalTodayJST() {
  const jst = new Date(Date.now() + 9 * 3600 * 1000); // UTCの各フィールドがJSTの壁時計になる
  const dt = new Date(Date.UTC(jst.getUTCFullYear(), jst.getUTCMonth(), jst.getUTCDate()));
  if (jst.getUTCHours() < DAY_BOUNDARY_HOUR) dt.setUTCDate(dt.getUTCDate() - 1);
  const p = (n) => String(n).padStart(2, "0");
  return dt.getUTCFullYear() + "-" + p(dt.getUTCMonth() + 1) + "-" + p(dt.getUTCDate());
}

// その日の記録が無ければ、購読中の全端末に通知を送る
async function sendReminderIfNeeded(env, force) {
  const today = logicalTodayJST();

  const recFile = await ghGetFile(RECORDS_PATH, env);
  const records = recFile.json || {};
  const alreadyRecorded = !!records[today];

  if (alreadyRecorded && !force) {
    return { sent: 0, skipped: true, reason: "already recorded", date: today };
  }

  const subFile = await ghGetFile(SUBS_PATH, env);
  const subs = Array.isArray(subFile.json) ? subFile.json : [];
  if (subs.length === 0) return { sent: 0, skipped: true, reason: "no subscribers", date: today };

  const vapid = { publicKey: VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY, subject: VAPID_SUBJECT };
  const payload = { title: "健康記録", body: "今日の記録がまだです。入力しましょう。", url: APP_URL };

  let sent = 0;
  const alive = [];
  for (const sub of subs) {
    try {
      const res = await sendWebPush(sub, payload, vapid);
      if (res.status === 201 || res.status === 200) { sent++; alive.push(sub); }
      else if (res.status === 404 || res.status === 410) { /* 失効：残さない */ }
      else { alive.push(sub); } // 一時的な失敗は残す
    } catch (e) {
      alive.push(sub); // 例外時も残す
    }
  }

  // 失効した購読が減っていれば保存し直す
  if (alive.length !== subs.length) {
    await ghPutFile(SUBS_PATH, alive, "失効した購読を整理", subFile.sha, env);
  }

  return { sent, total: subs.length, date: today, forced: !!force };
}

// 記録データ(records.json)の追加・上書き・全置換・統合
async function handleRecords(body, env) {
  const file = await ghGetFile(RECORDS_PATH, env);
  const current = file.json || {};

  // 端末の全データ(body.all)をクラウドの既存データと「統合」する。
  // ・クラウドに無い日は追加する
  // ・両方にある日は savedAt(保存時刻)が新しい方を採用する
  // ・クラウドにしか無い日は絶対に消さない（データ消失を防ぐ）
  // 統合後の全データを返し、端末側にも取り込ませる（双方向同期）。
  if (body.mode === "mergeall") {
    const incoming = (body.all && typeof body.all === "object") ? body.all : {};
    const merged = Object.assign({}, current);
    let changed = false;
    for (const date in incoming) {
      const cloud = merged[date];
      const local = incoming[date];
      // クラウド側にこの日が無い、または端末側の保存時刻が新しければ端末側を採用
      const localNewer = !cloud || !cloud.savedAt || (local.savedAt && local.savedAt >= cloud.savedAt);
      if (localNewer && JSON.stringify(cloud) !== JSON.stringify(local)) {
        merged[date] = local;
        changed = true;
      }
    }
    // 中身が変わったときだけ書き込む（無駄なコミットを避ける）
    if (changed) await ghPutFile(RECORDS_PATH, merged, "端末のデータをクラウドへ統合", file.sha, env);
    return jsonResponse({ ok: true, records: merged, changed });
  }

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
