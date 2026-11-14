# 去背

用 AI 在瀏覽器裡去除圖片背景，再用筆刷修補細節。純前端，圖片不會上傳到任何伺服器。

👉 https://mason276752.github.io/removebg/

## 功能

- **AI 去背**：BiRefNet_lite 找出主體，人像、商品、動物、物件都可以，輸出透明背景的 PNG
- **手動修補**：左邊原圖疊紅色遮罩、右邊即時預覽；「保留」「去除」兩種筆刷，⌘Z 復原，也能一鍵回到 AI 結果
- **批次處理**：一次放很多張（選檔、拖曳、貼上都可以），依序去背，可以打包下載
- **iPhone 的 HEIC／HEIF 照片**：Safari 直接解碼；其他瀏覽器遇到時才載入 HEIF 解碼器（約 800 KB，只下載一次），同樣在本機運算
- **WebGPU 加速**：有 WebGPU 用 1024 精細版（約 2 秒一張），沒有就用 512 版跑 CPU（約 4 秒）

## 和其他工具串接

工具都放在 `mason276752.github.io` 底下，屬於同一個 origin，可以用 [BroadcastChannel](https://developer.mozilla.org/docs/Web/API/BroadcastChannel) 互傳檔案：

- 在 [ZIP 編輯器](https://mason276752.github.io/zipeditor/) 勾選圖片（或在預覽裡）按「去背」，檔案會傳過來（`{type:'files'}`）
- 這裡按「傳到 ZIP 編輯器」，結果打包成 ZIP 傳回去（`{type:'zip'}`），可以合併到目前的資料夾
- 按「傳到圖片放大」，去背的圖直接交給[圖片放大](https://mason276752.github.io/upscale/)，透明背景會保留；圖片放大那邊也能把結果傳過來去背
- 按「傳到 Paste → JPG」，交給 [Paste → JPG](https://mason276752.github.io/paste2jpg/) 轉檔；選 WebP 會保留透明，檔案比 PNG 小很多

對方的分頁沒開的話會自動開新分頁。協定見 [`src/bridge.js`](src/bridge.js)，與 zipeditor、paste2jpg 相同。

## 模型

兩顆都是 [ZhengPeng7/BiRefNet_lite](https://huggingface.co/ZhengPeng7/BiRefNet_lite)（MIT，權重也是），只差 ONNX 匯出方式，第一次使用時從 Hugging Face 下載（約 100MB），之後存在瀏覽器的 Cache Storage：

| 後端 | 模型 | 為什麼 |
| --- | --- | --- |
| WebGPU | [jiabins0303/birefnet-lite-1024-webgpu](https://huggingface.co/jiabins0303/birefnet-lite-1024-webgpu) | onnx-community 的原版 1024 匯出在瀏覽器裡會 `std::bad_alloc`：deform_conv 被拆成 GatherND，全掉回 CPU，在 32 位元 WASM 堆積上要好幾個 392MB 的緩衝（原生量到峰值 10.5GB）。這版只改圖結構，權重不變 |
| CPU（WASM） | [studioludens/birefnet-lite-512](https://huggingface.co/studioludens/birefnet-lite-512) | 1024 那顆在 WASM 上一樣記憶體不足；512 版單執行緒約 4 秒。**不要拿它跑 WebGPU**：實測整張輸出是壞的 |

實測（同一張 1600×900 照片，與原生 fp32 的 1024 原版比較）：WebGPU 版 IoU 0.983、CPU 版 IoU 0.884。模型網址釘在特定 commit（見 `src/rmbg/models.js`）。

修補編輯器移植自 rust-ai-webtool（私人專案）（`src/mask/`）；那邊的遮罩由後端的 RMBG-2.0 算，但 RMBG-2.0 是 CC BY-NC 4.0（不可商用）且需要登入同意條款才能下載，不適合放在公開網頁，所以這裡換成 BiRefNet。

## 開發

```sh
npm install
npm run dev        # http://localhost:5173/removebg/
npm test
npm run build      # 輸出到 dist/
```

推到 `main` 後，GitHub Actions 會跑測試、建置並發布到 GitHub Pages。

## 授權

- 模型：BiRefNet_lite（MIT）。BiRefNet_lite 的訓練資料包含 DIS5K，該資料集本身有商用限制，商業用途請自行評估
- [onnxruntime-web](https://github.com/microsoft/onnxruntime)（MIT）、[Vue](https://vuejs.org/)（MIT）
- [heic-to](https://github.com/hoppergee/heic-to)（內含 [libheif](https://github.com/strukturag/libheif)，LGPL-3.0）：未修改，打包成獨立的檔案，只在瀏覽器無法原生解碼 HEIF 時載入；授權全文隨網站發布在 `heic-to.LICENSE`
