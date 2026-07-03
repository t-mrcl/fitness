/**
 * Service Worker（通知の裏方）
 * - push       : サーバーから届いた通知を画面に表示する
 * - notificationclick : 通知をタップしたらアプリを開く／前面に出す
 */

// すぐ有効化する（更新をためらわない）
self.addEventListener("install", (e) => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

// 通知が届いたとき
self.addEventListener("push", (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; }
  catch (e) { data = { body: event.data ? event.data.text() : "" }; }

  const title = data.title || "健康記録";
  const options = {
    body: data.body || "今日の記録がまだです。入力しましょう。",
    icon: "icon-192.png",
    badge: "icon-192.png",
    data: { url: data.url || "./" }, // タップ時に開くURL
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

// 通知をタップしたとき：既に開いていれば前面に出して一番上へ、なければ新しく開く
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || "./";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        if ("focus" in c) {
          c.postMessage({ type: "scrollTop" }); // ページに「一番上へ」と伝える
          return c.focus();
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(target); // 新規で開く場合は元々一番上
    })
  );
});
