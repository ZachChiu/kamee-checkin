# KAMEE 打卡（PWA）

純靜態網頁，資料存在瀏覽器 localStorage，沒有後端。

## 本機執行

    python3 -m http.server 8000

開 http://localhost:8000 。Service worker 在 localhost 與 https 下才會註冊。

## GitHub Pages

1. 推到 GitHub 的 `main`。
2. Settings → Pages → Source 選 `Deploy from a branch`，branch `main`、資料夾 `/ (root)`。
3. 網址 `https://<帳號>.github.io/<repo>/`。路徑都是相對的，放在子目錄可直接運作。

## 檔案

- `index.html` — 全部畫面與邏輯
- `sw.js` — service worker（network-first，離線可開）
- `manifest.webmanifest`、`icons/` — 安裝成 App 用
- `test.html` — 連續天數計算的自我檢查，瀏覽器開啟看結果
