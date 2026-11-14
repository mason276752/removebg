<script setup>
// 去背：BiRefNet_lite 在瀏覽器裡算出遮罩，再用筆刷修補。全部在瀏覽器裡做——
//   * 模型：有 WebGPU 用 1024 精細版、沒有用 512 版跑 CPU（原因見 rmbg/models.js）
//   * 推論：onnxruntime-web，在 Web Worker 裡跑（見 rmbg/）
//   * 修補：左邊塗遮罩、右邊即時預覽（移植自 rust-ai-webtool，見 mask/）
//   * 串接：ZIP 編輯器可以把圖片傳過來，結果打包成 ZIP 傳回去（見 bridge.js）
import { computed, markRaw, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import Icon from './components/Icon.vue'
import MaskEditor from './components/MaskEditor.vue'
import { bridgeSupported, listen, sendToEditor } from './bridge.js'
import { makeZip } from './zip.js'
import { fmtBytes, saveBlob, timeStamp, uniqueName } from './util.js'
import { MODELS } from './rmbg/models.js'
import { cancelAll, detectBackend, maskFor } from './rmbg/index.js'

// ---------- toast ----------
const toastMsg = ref('')
let toastTimer
function toast(msg) {
  toastMsg.value = msg
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => { toastMsg.value = '' }, 3600)
}

const backend = ref('') // 'webgpu' | 'wasm'
const backendLabel = computed(() =>
  backend.value === 'webgpu' ? 'WebGPU 加速' : backend.value === 'wasm' ? 'CPU 運算' : '偵測中…',
)
const modelNote = computed(() => {
  const m = MODELS[backend.value]
  return m ? `${m.size}×${m.size} 模型，第一次要下載約 ${Math.round(m.bytes / 1e6)}MB，之後從快取讀` : ''
})

/** 超過這個像素數，修補用的畫布（原圖＋疊色兩份 RGBA）會吃掉好幾百 MB。 */
const MAX_PIXELS = 40_000_000

// ---------- 圖片 ----------
// File、Blob、遮罩一律 markRaw：交給 Vue 代理的話，原生方法會因為 `this` 是 Proxy 而出錯，
// 幾百萬個位元組的陣列也不該被逐一追蹤。
// { id, file, name, srcUrl, width, height, status, stage, progress, error, alpha, modelAlpha, result, run }
// status: 'queued' | 'running' | 'done' | 'error'；result: { blob, url }
const items = ref([])
const selectedId = ref(null)
const selected = computed(() => items.value.find((i) => i.id === selectedId.value) || null)
const doneItems = computed(() => items.value.filter((i) => i.status === 'done'))
const fileInput = ref(null)
const editor = ref(null)

const isImage = (f) => f.type.startsWith('image/') || /\.(png|jpe?g|webp|gif|bmp|avif|svg|ico)$/i.test(f.name)

function addFiles(list, from) {
  const files = [...list]
  const images = files.filter(isImage)
  if (!images.length) {
    if (files.length) toast('沒有可以處理的圖片')
    return
  }
  const added = images.map((f) => ({
    id: crypto.randomUUID(),
    file: markRaw(f),
    name: f.name || 'image.png',
    srcUrl: URL.createObjectURL(f),
    width: 0,
    height: 0,
    status: 'queued',
    stage: '',
    progress: 0,
    error: '',
    alpha: null,
    modelAlpha: null,
    result: null,
    run: 0,
  }))
  items.value.push(...added)
  if (!selected.value) selectedId.value = added[0].id
  const skipped = files.length - images.length
  const who = from === 'zipeditor' ? '從 ZIP 編輯器收到' : '已加入'
  toast(`${who} ${images.length} 張圖片${skipped ? `（略過 ${skipped} 個不是圖片的）` : ''}`)
  pump()
}

function setResult(item, blob) {
  if (item.result) URL.revokeObjectURL(item.result.url)
  item.result = { blob: markRaw(blob), url: URL.createObjectURL(blob) }
}

async function removeItem(item) {
  if (item.id === selectedId.value) await flushEdits()
  if (item.status === 'running') cancelAll() // 讓 pump 裡那張以「已取消」結束
  if (item.result) URL.revokeObjectURL(item.result.url)
  URL.revokeObjectURL(item.srcUrl)
  const i = items.value.indexOf(item)
  items.value.splice(i, 1)
  if (selectedId.value === item.id) selectedId.value = items.value[Math.min(i, items.value.length - 1)]?.id ?? null
}

async function clearAll() {
  for (const item of [...items.value]) await removeItem(item)
}

async function select(item) {
  if (item.id === selectedId.value) return
  await flushEdits()
  selectedId.value = item.id
}

// ---------- 解碼與合成 ----------

/** 檔案 → 轉正後的 ImageBitmap；createImageBitmap 不吃的（例如 SVG）先經過 <img>。 */
async function bitmapOf(file) {
  try {
    return await createImageBitmap(file, { imageOrientation: 'from-image' })
  } catch {
    const url = URL.createObjectURL(file)
    try {
      const img = new Image()
      img.src = url
      await img.decode()
      return await createImageBitmap(img)
    } catch {
      throw new Error('瀏覽器解不開這個格式（HEIC 請先用 Paste → JPG 轉檔）')
    } finally {
      URL.revokeObjectURL(url)
    }
  }
}

/** 原圖 ＋ 遮罩 → 透明背景的 PNG。 */
async function cutout(file, alpha, w, h) {
  const bitmap = await bitmapOf(file)
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  const g = c.getContext('2d', { willReadFrequently: true })
  g.drawImage(bitmap, 0, 0, w, h)
  bitmap.close()
  const img = g.getImageData(0, 0, w, h)
  for (let i = 0; i < alpha.length; i++) img.data[i * 4 + 3] = alpha[i]
  g.putImageData(img, 0, 0)
  const blob = await new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('圖片太大，瀏覽器無法輸出'))), 'image/png'))
  c.width = c.height = 0
  return blob
}

// ---------- 依序去背 ----------
let pumping = false
async function pump() {
  if (pumping || !backend.value) return
  pumping = true
  try {
    for (;;) {
      const item = items.value.find((i) => i.status === 'queued')
      if (!item) break
      await process(item)
    }
  } finally {
    pumping = false
  }
}

// 每次開始處理一張就發一個序號；取消（移除）之後才回來的結果，序號對不上就作廢。
let runSeq = 0

async function process(item) {
  const run = ++runSeq
  item.run = run
  item.status = 'running'
  item.stage = ''
  item.progress = 0
  item.error = ''
  const onStage = (stage, progress = 0) => {
    item.stage = stage
    item.progress = progress
  }
  try {
    let bitmap = await bitmapOf(item.file)
    item.width = bitmap.width
    item.height = bitmap.height
    if (bitmap.width * bitmap.height > MAX_PIXELS) {
      bitmap.close()
      throw new Error(`圖片太大（${bitmap.width}×${bitmap.height}），請先縮小到 ${MAX_PIXELS / 1e6}MP 以內`)
    }
    let alpha
    try {
      alpha = await maskFor(bitmap, backend.value, onStage)
    } catch (err) {
      // WebGPU 偶爾會在特定驅動上失敗或算出 NaN；改用 CPU 版重算一次（bitmap 已轉移出去，要重新解碼）。
      if (backend.value !== 'webgpu' || err.message === '已取消') throw err
      console.warn('webgpu failed, falling back to wasm', err)
      backend.value = 'wasm'
      toast('GPU 加速無法使用，改用 CPU 運算')
      bitmap = await bitmapOf(item.file)
      alpha = await maskFor(bitmap, 'wasm', onStage)
    }
    const blob = await cutout(item.file, alpha, item.width, item.height)
    if (item.run !== run || !items.value.includes(item)) return
    item.alpha = markRaw(alpha)
    item.modelAlpha = markRaw(alpha.slice())
    setResult(item, blob)
    item.status = 'done'
  } catch (err) {
    if (item.run !== run || !items.value.includes(item)) return
    item.status = 'error'
    item.error = String(err.message || err)
    if (/bad_alloc|memory|allocation/i.test(item.error)) item.error = '記憶體不夠，請先縮小圖片再試'
  }
}

function retry(item) {
  item.status = 'queued'
  item.error = ''
  pump()
}

// ---------- 修補後存回清單 ----------
// 每一筆都存會太頻繁（大圖編一次 PNG 要將近一秒），停筆一下再存；匯出或換圖前一定先存完。
let commitTimer = null
let committing = Promise.resolve()

function onEdited() {
  clearTimeout(commitTimer)
  commitTimer = setTimeout(commitNow, 500)
}

function commitNow() {
  clearTimeout(commitTimer)
  commitTimer = null
  const item = selected.value
  const ed = editor.value
  if (!item || !ed) return committing
  committing = committing.then(async () => {
    try {
      const { alpha, blob } = await ed.snapshot()
      item.alpha = markRaw(alpha)
      setResult(item, blob)
    } catch (err) {
      toast(`無法儲存修改：${err.message}`)
    }
  })
  return committing
}

/** 有還沒存的修改就先存完。 */
function flushEdits() {
  return commitTimer ? commitNow() : committing
}

// ---------- 輸出 ----------
const outName = (item) => `${item.name.replace(/\.[^.]+$/, '') || 'image'}-去背.png`

async function downloadOne(item) {
  await flushEdits()
  saveBlob(item.result.blob, outName(item))
}

function zipList() {
  const taken = new Set()
  return doneItems.value.map((i) => ({ name: uniqueName(outName(i), taken), blob: i.result.blob }))
}
const zipName = () => `removebg-${timeStamp()}.zip`

async function downloadAll() {
  await flushEdits()
  saveBlob(await makeZip(zipList()), zipName())
}

const sending = ref(false)
async function sendAll() {
  if (sending.value || !doneItems.value.length) return
  sending.value = true
  // 同步呼叫：ZIP 編輯器沒開的話要在這次點擊裡開新分頁；打包前才等修改存完。
  const res = await sendToEditor(async () => {
    await flushEdits()
    return new File([await makeZip(zipList())], zipName(), { type: 'application/zip' })
  })
  sending.value = false
  if (res === 'sent') toast(`已把 ${doneItems.value.length} 張去背圖傳到 ZIP 編輯器`)
  else if (res === 'blocked') toast('瀏覽器擋下了新分頁，請先開啟 ZIP 編輯器再傳送')
  else toast('ZIP 編輯器沒有回應，請再試一次')
}

const statusText = (i) =>
  i.status === 'queued' ? '等待中'
    : i.status === 'running'
      ? (i.stage === 'download' ? `下載模型 ${Math.round(i.progress * 100)}%` : i.stage === 'run' ? '去背中…' : '準備中…')
      : i.status === 'done' ? `${i.width}×${i.height} · ${fmtBytes(i.result.blob.size)}`
        : i.error

// ---------- 輸入：選檔、拖放、貼上 ----------
function pick() {
  fileInput.value?.click()
}
function onPick(e) {
  addFiles(e.target.files || [])
  e.target.value = ''
}

function onPaste(e) {
  const files = [...(e.clipboardData?.files || [])]
  if (!files.some(isImage)) return
  e.preventDefault()
  addFiles(files)
}

const dragging = ref(false)
let dragDepth = 0
const hasFiles = (e) => !!e.dataTransfer && [...e.dataTransfer.types].includes('Files')
function onDragEnter(e) {
  if (!hasFiles(e)) return
  e.preventDefault()
  dragDepth++
  dragging.value = true
}
function onDragOver(e) {
  if (!hasFiles(e)) return
  e.preventDefault()
  e.dataTransfer.dropEffect = 'copy'
}
function onDragLeave(e) {
  if (hasFiles(e) && --dragDepth <= 0) {
    dragDepth = 0
    dragging.value = false
  }
}
function onDrop(e) {
  if (!hasFiles(e)) return
  e.preventDefault()
  dragDepth = 0
  dragging.value = false
  addFiles(e.dataTransfer.files)
}

function onBeforeUnload(e) {
  if (commitTimer) commitNow()
  if (items.value.some((i) => i.status === 'done')) {
    e.preventDefault()
    e.returnValue = ''
  }
}

let stopListening = () => {}
onMounted(async () => {
  window.addEventListener('paste', onPaste)
  window.addEventListener('dragenter', onDragEnter)
  window.addEventListener('dragover', onDragOver)
  window.addEventListener('dragleave', onDragLeave)
  window.addEventListener('drop', onDrop)
  window.addEventListener('beforeunload', onBeforeUnload)
  stopListening = listen((files, from) => addFiles(files, from || 'zipeditor'))
  backend.value = await detectBackend()
  await nextTick()
  pump()
})
onBeforeUnmount(() => {
  window.removeEventListener('paste', onPaste)
  window.removeEventListener('dragenter', onDragEnter)
  window.removeEventListener('dragover', onDragOver)
  window.removeEventListener('dragleave', onDragLeave)
  window.removeEventListener('drop', onDrop)
  window.removeEventListener('beforeunload', onBeforeUnload)
  stopListening()
})
</script>

<template>
  <div class="app" :class="{ dragging }">
    <header class="top">
      <div class="brand">
        <svg viewBox="0 0 32 32" width="30" height="30" aria-hidden="true"><rect width="32" height="32" rx="8" fill="#a21caf"/><path d="M8 8h4M8 8v4M24 8h-4M24 8v4M8 24h4M8 24v-4M24 24h-4M24 24v-4" stroke="#fff" stroke-width="2" stroke-linecap="round"/><circle cx="16" cy="13.5" r="3.2" fill="#fff"/><path d="M10.5 22.5c.8-3.3 3-5 5.5-5s4.7 1.7 5.5 5z" fill="#fff"/></svg>
        <div>
          <h1>去背</h1>
          <p v-if="!items.length">AI 自動去除圖片背景，再用筆刷修補細節。檔案不會離開你的裝置。</p>
        </div>
      </div>
      <span class="badge" :class="backend" :title="modelNote">{{ backendLabel }}</span>
    </header>

    <template v-if="!items.length">
      <section class="start panel">
        <Icon name="image" class="hero" />
        <strong>把圖片拖進來、貼上，或選擇檔案</strong>
        <span>PNG、JPG、WebP、AVIF……一次可以放很多張，放進來就開始去背</span>
        <div class="start-btns">
          <button type="button" class="btn primary" @click="pick"><Icon name="upload" />選擇圖片</button>
        </div>
      </section>

      <section class="about panel">
        <h2>可以做什麼</h2>
        <ul>
          <li><strong>AI 去背</strong>：用 BiRefNet 模型找出主體，人像、商品、動物、物件都可以，輸出透明背景的 PNG。</li>
          <li><strong>手動修補</strong>：AI 漏掉的髮絲、多留的背景，用「保留」「去除」筆刷塗一下，右邊即時看到結果。</li>
          <li><strong>批次處理</strong>：一次放很多張，依序去背，可以打包下載。</li>
          <li><strong>串接 ZIP 編輯器</strong>：在 <a href="../zipeditor/">ZIP 編輯器</a>勾選圖片就能傳過來，去背後再按「傳到 ZIP 編輯器」放回去。</li>
          <li><strong>不上傳</strong>：模型下載到瀏覽器裡執行（第一次約 100MB，之後從快取讀）。有 WebGPU 的瀏覽器（Chrome、Edge、新版 Safari）用 1024 精細版、幾秒一張；其他用 512 版跑 CPU。</li>
        </ul>
      </section>
    </template>

    <template v-else>
      <section class="panel section">
        <h2>
          圖片 <span class="count">{{ items.length }}</span>
          <span class="grow"></span>
          <button type="button" class="btn small" @click="pick"><Icon name="plus" />加入圖片</button>
          <button type="button" class="btn small danger" @click="clearAll"><Icon name="trash" />全部清除</button>
        </h2>
        <ul class="grid">
          <li v-for="item in items" :key="item.id" :class="{ active: item.id === selectedId, [item.status]: true }">
            <button type="button" class="thumb" :title="item.name" @click="select(item)">
              <img :src="item.result?.url || item.srcUrl" alt="" loading="lazy" />
              <span v-if="item.status === 'running' && item.stage === 'download'" class="bar"><span :style="{ width: item.progress * 100 + '%' }"></span></span>
            </button>
            <div class="meta">
              <b :title="item.name">{{ item.name }}</b>
              <span class="status">
                <span v-if="item.status === 'running' || item.status === 'queued'" class="spinner small" aria-hidden="true"></span>
                {{ statusText(item) }}
              </span>
            </div>
            <div class="row-btns">
              <button v-if="item.status === 'done'" type="button" class="btn small icon" title="下載" @click="downloadOne(item)"><Icon name="download" /></button>
              <button v-if="item.status === 'error'" type="button" class="btn small icon" title="重試" @click="retry(item)"><Icon name="refresh" /></button>
              <button type="button" class="btn small icon danger" title="移除" @click="removeItem(item)"><Icon name="x" /></button>
            </div>
          </li>
        </ul>
        <div class="actions">
          <span class="grow muted">{{ doneItems.length }} / {{ items.length }} 張完成</span>
          <button v-if="doneItems.length > 1" type="button" class="btn" @click="downloadAll"><Icon name="download" />打包下載</button>
          <button v-if="bridgeSupported" type="button" class="btn primary" :disabled="sending || !doneItems.length" @click="sendAll">
            <Icon name="send" />傳到 ZIP 編輯器
          </button>
        </div>
      </section>

      <section v-if="selected" class="panel section">
        <h2 class="title">
          <span class="grow">{{ selected.name }}</span>
          <button v-if="selected.status === 'done'" type="button" class="btn small primary" @click="downloadOne(selected)">
            <Icon name="download" />下載 PNG
          </button>
        </h2>
        <MaskEditor v-if="selected.status === 'done'" ref="editor" :key="selected.id" :item="selected"
                    @change="onEdited" @error="toast" />
        <div v-else-if="selected.status === 'error'" class="banner error">{{ selected.error }}</div>
        <div v-else class="banner">
          <span class="spinner" aria-hidden="true"></span>
          <span>{{ statusText(selected) }}</span>
          <span v-if="selected.stage === 'download'" class="muted">（第一次使用要下載模型，之後會快很多）</span>
          <span v-else-if="backend === 'wasm' && selected.stage === 'run'" class="muted">（CPU 運算，一張約需數秒到十幾秒）</span>
        </div>
      </section>
    </template>

    <footer>
      去背 · 所有運算都在瀏覽器內完成 ·
      模型 <a href="https://huggingface.co/ZhengPeng7/BiRefNet_lite">BiRefNet_lite</a>（MIT）·
      <a href="../zipeditor/">ZIP 編輯器</a> ·
      <a href="../">更多工具</a> ·
      <a href="https://github.com/mason276752/removebg">GitHub 原始碼</a>
    </footer>

    <div class="toast" :class="{ show: toastMsg }" role="status" aria-live="polite">
      <span>{{ toastMsg }}</span>
    </div>

    <input ref="fileInput" type="file" accept="image/*" multiple hidden @change="onPick" />
  </div>
</template>

<style scoped>
.top .badge {
  padding: 3px 10px; border-radius: 999px; border: 1px solid var(--line);
  color: var(--muted); font-size: 12px; font-weight: 600; white-space: nowrap; cursor: help;
}
.top .badge.webgpu { border-color: color-mix(in srgb, var(--accent) 45%, var(--line)); color: var(--accent); }

.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 10px; margin: 0; padding: 0; list-style: none; }
.grid li { display: grid; gap: 6px; padding: 8px; border: 1px solid var(--line); border-radius: 12px; }
.grid li.active { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent); }
.thumb {
  position: relative; display: block; width: 100%; aspect-ratio: 4 / 3; padding: 0; overflow: hidden;
  border: 0; border-radius: 8px; background: var(--checker); cursor: pointer;
}
.thumb img { width: 100%; height: 100%; object-fit: contain; }
.bar { position: absolute; left: 8px; right: 8px; bottom: 8px; height: 5px; border-radius: 3px; background: rgb(0 0 0 / .35); overflow: hidden; }
.bar span { display: block; height: 100%; background: var(--accent-strong); transition: width .2s; }
.meta { display: grid; min-width: 0; }
.meta b { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; font-weight: 600; }
.status { display: flex; align-items: center; gap: 6px; color: var(--muted); font-size: 12px; font-variant-numeric: tabular-nums; }
.error .status { color: var(--danger); }
.spinner.small { width: 11px; height: 11px; border-width: 2px; }
.row-btns { display: flex; justify-content: flex-end; gap: 6px; }
.actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-top: 12px; }
.muted { color: var(--muted); font-size: 13px; }
.title { overflow-wrap: anywhere; }
</style>
