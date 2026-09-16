# KAMEE 打卡

前端是一頁靜態 HTML（資料存 localStorage），後端是一個 Cloudflare Worker：`/api/*` 收訂閱與打卡，
cron 每天台灣時間 09:00 對當天沒打卡的人送 Web Push。

    public/          前端（Workers 的靜態資產）
    worker/          Worker：API、排程、Web Push 加密
    scripts/vapid.mjs  產生 VAPID 金鑰
    wrangler.toml    Worker、KV、cron 設定

## 規則

- 只能打當天的卡，一天一次；日曆是唯讀的，不開放補打過去的卡。
- 連續天數踩到 7 / 14 / 30 / 60 / 90 天跳獎勵 modal 給代碼，內容在 `public/index.html` 的 `MILESTONES`。
- 今天還沒打卡時，連續天數從昨天起算（當天尚未結束，不算中斷）。

## 本機

    npm test              # 連續天數、打卡驗證、推播加密、API、排程
    npm run dev           # wrangler dev，http://127.0.0.1:8787
    curl "http://127.0.0.1:8787/cdn-cgi/local/scheduled"   # 手動觸發 cron

`npm run dev` 讀 `.dev.vars` 的 VAPID 金鑰（此檔不進版控）。

## 部署到 Cloudflare

1. `npx wrangler login`
2. `npm run vapid` → 公鑰填進 `wrangler.toml` 的 `VAPID_PUBLIC_KEY`，`VAPID_SUBJECT` 改成自己的 mailto
3. `npx wrangler kv namespace create SUBS` → 把 id 填進 `wrangler.toml` 的 `kv_namespaces`
4. `npm run deploy`
5. `npx wrangler secret put VAPID_PRIVATE_KEY` → 貼上第 2 步的私鑰
6. `npm run deploy` 再跑一次

cron 寫在 `wrangler.toml` 的 `triggers`（每小時一次），部署時一併註冊。
`VAPID_PRIVATE_KEY` 沒設好的話，`/api/test` 會回 502，前端會顯示送不出去。

## 提醒的實際行為

- 進站 1.2 秒後跳自家的 modal 問要不要開提醒，使用者按下去才觸發瀏覽器的權限框（Safari、Firefox 只接受
  由點擊觸發的權限請求，自動跳會被拒）。按過「先不要」就不再問。
- 開啟成功後立刻送一則測試通知，開關下方也有「送一則測試通知」可以隨時重送。
- 時間可以自己選，只支援整點，預設 09:00，存在 KV 的 `hour`。cron 每小時跑一次，
  Worker 依每個人的時區換算當地小時，對到才送。
- 開了提醒且訂閱成功：由 Worker 的 cron 推播，關掉頁面也會收到。cron 觸發時間有分鐘級誤差。
- 訂閱失敗或站台沒有後端（例如純靜態託管）：自動降級成前景計時器，只在頁面開著時提醒。
- iOS 要先「加入主畫面」（16.4 以上）才拿得到通知權限。
- 已打卡的人當天不會收到提醒，靠打卡時 POST `/api/checkin` 記錄；推播失敗回 404/410 時，該筆訂閱會被刪掉。

## 資料

KV 的 `sub:<uid>` 存 `{subscription, tz, hour, lastCheckin, notified}`。uid 是前端第一次開啟時產生的
隨機字串，存在瀏覽器，沒有帳號系統，換裝置就是新的人。打卡紀錄本身仍在 localStorage，
KV 只留判斷要不要提醒所需的最後打卡日。

## GitHub Pages

前端搬到 `public/` 之後，原本「branch main、資料夾 root」的設定會找不到 `index.html`。
主站改用 Cloudflare 的話，把 Pages 關掉即可；要兩邊都留，就加一個 workflow 部署 `public/`，
但 GitHub Pages 上沒有 `/api/*`，提醒會降級成只在頁面開著時運作。
