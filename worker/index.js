/**
 * 健康記録アプリ用 Cloudflare Worker（中継サーバー）
 *
 * 役割：
 * - 公開ページ(index.html)からは「軽い合言葉(APP_TOKEN)」だけを受け取る
 * - 本物のGitHubトークン(GH_TOKEN)はこのWorker側の「シークレット」として保管し、
 *   公開ページのコードには一切登場させない
 * - 合言葉が正しければ、代わりにGitHubのfitness-dataリポジトリを読み書きする
 *
 * 使い方：
 * 1. Cloudflareのダッシュボードで新しいWorkerを作成し、この内容を貼り付ける
 * 2. Worker の Settings → Variables and Secrets で、以下2つをシークレットとして追加する
 *      GH_TOKEN   : GitHubのfine-grained personal access token
 *                   (fitness-dataリポジトリのContents読み書き権限のみ)
 *      APP_TOKEN  : index.html側と共有する、好きな文字列の合言葉
 * 3. デプロイ後に発行されるURLを index.html の WORKER_URL に設定する
 */

const GH_OWNER = "t-mrcl";
const GH_REPO = "fitness-data";
const GH_PATH = "records.json";

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

    const ghUrl = `https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/contents/${GH_PATH}`;
    const ghHeaders = {
      "Authorization": `Bearer ${env.GH_TOKEN}`,
      "Accept": "application/vnd.github+json",
      "Content-Type": "application/json",
      "User-Agent": "fitness-proxy-worker",
    };

    try {
      // 1. 現在のrecords.jsonの内容とshaを取得
      const getRes = await fetch(ghUrl, { headers: ghHeaders });
      if (!getRes.ok) throw new Error("github get failed: " + getRes.status);
      const file = await getRes.json();
      const current = JSON.parse(decodeBase64(file.content));

      // 2. modeに応じて内容を作る
      //    merge   : 指定した1日分のデータだけ追加・上書き(通常の保存時)
      //    replace : データ全体を渡された内容で丸ごと置き換える(データ構造の変換時)
      let updated, message;
      if (body.mode === "replace") {
        updated = body.all;
        message = "データ構造の変換を反映";
      } else {
        updated = current;
        updated[body.date] = body.record;
        message = body.date + " の記録を更新";
      }

      // 3. 更新後の内容をコミット
      const putRes = await fetch(ghUrl, {
        method: "PUT",
        headers: ghHeaders,
        body: JSON.stringify({
          message,
          content: encodeBase64(JSON.stringify(updated, null, 2)),
          sha: file.sha,
        }),
      });
      if (!putRes.ok) throw new Error("github put failed: " + putRes.status);

      return jsonResponse({ ok: true });
    } catch (err) {
      return jsonResponse({ ok: false, error: String(err) }, 502);
    }
  },
};

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
