// 在 Web Worker 裡跑去背模型（onnxruntime-web）。
//
// 訊息：
//   → {id, backend, bitmap}        bitmap 是原圖（ImageBitmap，已依 EXIF 轉正）
//   ← {id, stage: 'download', progress}  第一次要下載模型（約 100MB，之後從快取讀）
//   ← {id, stage: 'run'}
//   ← {id, alpha}                  與原圖同尺寸的遮罩（每像素一個位元組）
//   ← {id, error, nan?}            nan：GPU 算出 NaN，呼叫端應改用 CPU 重算
import * as ort from 'onnxruntime-web'
import { MODELS, toInput, toMask } from './models.js'

// 模型載入時會印一長串「移除沒用到的常數」之類的警告，對使用者沒有意義
// （JS 這層用 env.logLevel、原生那層用 session 的 logSeverityLevel）。
ort.env.logLevel = 'error'
// 多執行緒需要 cross-origin isolation，GitHub Pages 給不了；硬開只會多一行警告。
ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 1) : 1

const CACHE = 'removebg-models-v1'

/** 下載模型並放進 Cache Storage；之後開頁面直接從快取讀，不必再等 100MB。 */
async function download(model, onProgress) {
  let cache = null
  try {
    cache = await caches.open(CACHE)
    const hit = await cache.match(model.url)
    if (hit) return new Uint8Array(await hit.arrayBuffer())
  } catch {
    // 無痕模式或被封鎖的儲存空間：照樣下載，只是不快取
  }
  const res = await fetch(model.url)
  if (!res.ok) throw new Error(`模型下載失敗（HTTP ${res.status}）`)
  const total = Number(res.headers.get('content-length')) || model.bytes
  let buf = new Uint8Array(total)
  let got = 0
  let shown = -1
  const reader = res.body.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (got + value.length > buf.length) {
      const bigger = new Uint8Array(Math.max(buf.length * 2, got + value.length))
      bigger.set(buf.subarray(0, got))
      buf = bigger
    }
    buf.set(value, got)
    got += value.length
    const pct = Math.floor((got / total) * 100)
    if (pct !== shown) onProgress((shown = pct) / 100)
  }
  const data = got === buf.length ? buf : buf.slice(0, got)
  try {
    await cache?.put(model.url, new Response(data, { headers: { 'content-type': 'application/octet-stream' } }))
  } catch {
    // 空間不夠就不快取，下次再下載
  }
  return data
}

// 一次只留一顆模型：兩顆都上百 MB，切換後原本那顆就不會再用了。
let loaded = null // { backend, session: Promise<InferenceSession> }
function session(backend, onProgress) {
  if (loaded?.backend !== backend) {
    loaded?.session.then((s) => s.release()).catch(() => {})
    const p = download(MODELS[backend], onProgress).then((bytes) =>
      ort.InferenceSession.create(bytes, { executionProviders: [backend], graphOptimizationLevel: 'all', logSeverityLevel: 3 }),
    )
    p.catch(() => { if (loaded?.session === p) loaded = null }) // 失敗的不要留著，下次重試
    loaded = { backend, session: p }
  }
  return loaded.session
}

async function removeBackground({ id, backend, bitmap }) {
  const { size: S } = MODELS[backend]
  const W = bitmap.width
  const H = bitmap.height
  const sess = await session(backend, (progress) => self.postMessage({ id, stage: 'download', progress }))
  self.postMessage({ id, stage: 'run' })

  // 縮成 S×S（不保持比例：模型就是這樣訓練的）。
  const small = new OffscreenCanvas(S, S)
  const g = small.getContext('2d', { willReadFrequently: true })
  g.imageSmoothingQuality = 'high'
  g.drawImage(bitmap, 0, 0, S, S)
  bitmap.close()
  const input = new ort.Tensor('float32', toInput(g.getImageData(0, 0, S, S).data, S), [1, 3, S, S])
  const outputs = await sess.run({ [sess.inputNames[0]]: input })
  input.dispose()
  const logits = outputs[sess.outputNames[0]]
  const mask = toMask(logits.data)
  logits.dispose()
  if (!mask) {
    self.postMessage({ id, error: 'GPU 算出無效的結果', nan: true })
    return
  }

  // 遮罩放大回原圖尺寸：當成灰階圖畫進 S×S，再交給畫布做平滑縮放。
  const img = new ImageData(S, S)
  for (let i = 0; i < mask.length; i++) {
    img.data[i * 4] = mask[i]
    img.data[i * 4 + 3] = 255
  }
  g.putImageData(img, 0, 0)
  const big = new OffscreenCanvas(W, H)
  const bg = big.getContext('2d', { willReadFrequently: true })
  bg.imageSmoothingQuality = 'high'
  bg.drawImage(small, 0, 0, W, H)
  const px = bg.getImageData(0, 0, W, H).data
  const alpha = new Uint8ClampedArray(W * H)
  for (let i = 0; i < alpha.length; i++) alpha[i] = px[i * 4]
  self.postMessage({ id, alpha }, [alpha.buffer])
}

self.onmessage = async (e) => {
  try {
    await removeBackground(e.data)
  } catch (err) {
    self.postMessage({ id: e.data.id, error: String(err?.message || err) })
  }
}
