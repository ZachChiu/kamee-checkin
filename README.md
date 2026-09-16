# KAMEE 打卡（PWA）

純靜態網頁，資料存在瀏覽器 localStorage，沒有後端。

## 本機執行

    python3 -m http.server 8000

開 http://localhost:8000 。Service worker 在 localhost 與 https 下才會註冊。

## GitHub Pages

1. 推到 GitHub 的 `main`。
2. Settings → Pages → Source 選 `Deploy from a branch`，branch `main`、資料夾 `/ (root)`。
3. 網址 `https://<帳號>.github.io/<repo>/`。路徑都是相對的，放在子目錄可直接運作。

## 規則

- 只能打當天的卡，一天一次；日曆格子不能點，補打過去的卡不開放。
- 連續天數踩到 7 / 14 / 30 / 60 / 90 天時跳出獎勵 modal，代碼寫在 `index.html` 的 `MILESTONES`。
- 今天還沒打卡時，連續天數從昨天起算（當天尚未結束，不算中斷）。

## 每日 09:00 提醒的實際行為

通知要使用者授權，開關在打卡按鈕下方。送達方式有兩條，都不保證秒級準時：

- 頁面開著：前景計時器在 09:00 觸發，當天沒打卡就送通知。頁面關掉即失效。
- 安裝成 PWA 後（Chrome/Edge）：service worker 的 periodic background sync 由瀏覽器決定觸發時機（通常一天數次），程式在 09:00 之後、當天未打卡且未提醒過時送出。
- iOS 要先「加入主畫面」（16.4 以上）才拿得到通知權限；背景送達仍需 Web Push。

要固定 09:00 送達、關掉 App 也一定收到，需要後端 Web Push（VAPID 金鑰 + 排程），本版沒有後端。

## 檔案

- `index.html` — 全部畫面與邏輯
- `sw.js` — service worker（network-first，離線可開）
- `manifest.webmanifest`、`icons/` — 安裝成 App 用
- `test.js` — 連續天數與打卡驗證的自我檢查，`node test.js`
