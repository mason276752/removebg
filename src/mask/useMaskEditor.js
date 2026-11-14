// 去背結果的左右對照編輯器：左邊塗遮罩、右邊即時預覽。
//
// 編輯用的緩衝**每個像素都保留原圖 RGB**，只有 alpha 是模型算出的遮罩。所以兩邊畫面都
// 能從同一份資料推出來，也不會有對不齊的問題：
//   左：原圖（RGB 原樣）＋ alpha 處疊一層淺紅 → 一眼看出「哪些會被保留」，也是塗抹的畫布
//   右：原圖 RGB ＋ alpha → 實際去背結果（棋盤格代表透明）
// 使用者在**左邊**塗，因為要修的地方（髮絲、殘留背景）只有在看得到原圖時才找得到；
// 直接在右邊的去背圖上塗，被刪掉的地方是空白的，根本不知道要往哪裡塗。
//
// 移植自 rust-ai-webtool（那邊的遮罩來自後端；這裡直接吃瀏覽器裡算出的 alpha）。
// 這裡只管「座標換算、畫布重繪、狀態」；真正改像素的邏輯在 ./maskBrush.js（有單元測試）。
import { nextTick, reactive, ref } from 'vue'
import { createMaskEditor } from './maskBrush.js'

/** 遮罩疊色：淺紅、半透明——太濃會看不見底下的原圖，反而不好對位。 */
const MASK_RGB = [255, 64, 64]
const MASK_STRENGTH = 0.35

export function useMaskEditor() {
  const rightCanvas = ref(null) // 去背預覽（輸出的就是這張）
  const leftCanvas = ref(null) // 原圖＋紅色遮罩，也是塗抹的互動層

  const state = reactive({
    ready: false,
    w: 0,
    h: 0,
    tool: 'keep', // 'keep'=塗上遮罩（保留） | 'remove'=擦掉遮罩（去除）
    brush: 40, // 直徑，螢幕像素
    dirty: false, // 載入後有沒有手動改過
    canUndo: false,
  })
  /** 筆刷游標圈圈（跟著滑鼠，讓使用者看得到筆刷實際大小）。 */
  const cursor = reactive({ x: 0, y: 0, inside: false })

  // 非響應式的大型緩衝：放進 reactive 會被 Vue 代理，每個像素存取都走 proxy，慢到不能用。
  let brush = null // createMaskEditor(...)
  let imgData = null // ImageData（唯一真實來源）；brush 就地改它的 alpha
  let overlayData = null // 左圖用：原圖 RGB 依 alpha 疊紅，alpha 恆 255
  let leftCtx = null
  let rightCtx = null
  let painting = false
  let lastPt = null

  /**
   * 原圖 ＋ 遮罩 → 可編輯的 RGBA 緩衝 → 左右兩張畫布。
   *
   * ⚠ 原圖與遮罩分開傳、在**這裡**才合成：canvas 2D 是 premultiplied alpha，RGBA 畫進 canvas
   * 再 `getImageData` 讀回時，alpha=0 的像素 RGB 會全變 0，於是「保留」筆刷塗回來的會是
   * 黑色而不是原圖。原圖不透明地畫進去、再把 alpha 寫進緩衝，就不會被 premultiply 破壞。
   *
   * @param {CanvasImageSource} source 原圖（已轉正）
   * @param {Uint8ClampedArray} alpha 每像素一個位元組
   */
  async function load(source, alpha, w, h) {
    state.w = w
    state.h = h
    // ⚠ 先讓 ready 為 true，<canvas> 才會被 v-if 掛進 DOM；否則下面拿不到 ref。
    state.ready = true
    await nextTick()
    const right = rightCanvas.value
    const left = leftCanvas.value
    if (!right || !left) {
      state.ready = false
      throw new Error('畫布初始化失敗')
    }
    for (const cv of [right, left]) {
      cv.width = w
      cv.height = h
    }
    rightCtx = right.getContext('2d', { willReadFrequently: true })
    leftCtx = left.getContext('2d', { willReadFrequently: true })
    rightCtx.clearRect(0, 0, w, h)
    rightCtx.drawImage(source, 0, 0, w, h)
    imgData = rightCtx.getImageData(0, 0, w, h)
    for (let i = 0; i < alpha.length; i++) imgData.data[i * 4 + 3] = alpha[i]

    brush = createMaskEditor(w, h, imgData.data)
    rightCtx.clearRect(0, 0, w, h)
    rightCtx.putImageData(imgData, 0, 0)
    // 左圖從同一份資料推導（保證與右圖逐像素對齊）
    overlayData = new ImageData(w, h)
    refreshOverlay({ x0: 0, y0: 0, x1: w - 1, y1: h - 1 })
    leftCtx.putImageData(overlayData, 0, 0)
    state.canUndo = false
    state.dirty = false
  }

  /**
   * 依 imgData 的 alpha，把左圖指定區域重算成「原圖 RGB ＋ 淺紅遮罩」。
   * 只算髒矩形，故拖曳時的成本與塗抹面積成正比，而非整張圖。
   */
  function refreshOverlay(box) {
    const w = state.w
    const src = imgData.data
    const dst = overlayData.data
    for (let y = box.y0; y <= box.y1; y++) {
      for (let x = box.x0; x <= box.x1; x++) {
        const i = (y * w + x) * 4
        const t = (src[i + 3] / 255) * MASK_STRENGTH
        dst[i] = src[i] + (MASK_RGB[0] - src[i]) * t
        dst[i + 1] = src[i + 1] + (MASK_RGB[1] - src[i + 1]) * t
        dst[i + 2] = src[i + 2] + (MASK_RGB[2] - src[i + 2]) * t
        dst[i + 3] = 255 // 左圖是不透明的原圖，紅色只是疊色，不是透明度
      }
    }
  }

  /**
   * 只重畫髒矩形——大圖上每次 pointermove 都整張 putImageData 會嚴重掉幀。
   * 左右兩張都要更新：左邊是紅色遮罩（塗抹回饋），右邊是套用後的去背結果（即時預覽）。
   */
  function repaint(box) {
    if (!box || !imgData) return
    const w = box.x1 - box.x0 + 1
    const h = box.y1 - box.y0 + 1
    rightCtx?.putImageData(imgData, 0, 0, box.x0, box.y0, w, h)
    refreshOverlay(box)
    leftCtx?.putImageData(overlayData, 0, 0, box.x0, box.y0, w, h)
  }

  // ---- 筆刷 ----

  /** 螢幕座標 → 影像像素座標（塗抹發生在左圖，故以左圖的顯示尺寸換算）。 */
  function toImagePoint(ev) {
    const cv = leftCanvas.value
    const r = cv.getBoundingClientRect()
    return {
      x: ((ev.clientX - r.left) / r.width) * cv.width,
      y: ((ev.clientY - r.top) / r.height) * cv.height,
      scale: cv.width / r.width, // 螢幕 px → 影像 px
    }
  }
  // 筆刷大小以「螢幕像素」定義（不管圖多大，手感一致），故要乘上縮放比換成影像像素。
  const brushRadius = (scale) => (state.brush * scale) / 2
  const brushValue = () => (state.tool === 'keep' ? 255 : 0)

  function onBrushDown(ev) {
    if (!state.ready || !brush) return
    ev.preventDefault()
    // 抓住 pointer：拖出畫布外再放開也收得到 pointerup，筆畫不會卡在「還按著」的狀態。
    try { leftCanvas.value.setPointerCapture?.(ev.pointerId) } catch { /* 忽略 */ }
    painting = true
    brush.beginStroke()
    const p = toImagePoint(ev)
    repaint(brush.stamp(p.x, p.y, brushRadius(p.scale), brushValue()))
    lastPt = p
  }

  function onBrushMove(ev) {
    cursor.x = ev.clientX
    cursor.y = ev.clientY
    if (!painting || !brush) return
    ev.preventDefault()
    const p = toImagePoint(ev)
    repaint(brush.line(lastPt.x, lastPt.y, p.x, p.y, brushRadius(p.scale), brushValue()))
    lastPt = p
  }

  /** @returns {boolean} 這一筆有沒有真的改到東西 */
  function onBrushUp(ev) {
    if (!painting) return false
    painting = false
    lastPt = null
    if (ev?.pointerId != null) {
      try { leftCanvas.value?.releasePointerCapture?.(ev.pointerId) } catch { /* 未擷取成功過 */ }
    }
    const changed = !!brush?.endStroke()
    if (changed) state.dirty = true
    state.canUndo = !!brush?.canUndo
    return changed
  }

  /** @returns {boolean} 有沒有復原到東西 */
  function undoStroke() {
    if (!brush) return false
    const box = brush.undo()
    if (!box) return false
    repaint(box)
    state.canUndo = brush.canUndo
    state.dirty = true
    return true
  }

  /** 目前的遮罩（複本），存回清單用。 */
  function currentAlpha() {
    const a = new Uint8ClampedArray(state.w * state.h)
    for (let i = 0; i < a.length; i++) a[i] = imgData.data[i * 4 + 3]
    return a
  }

  /** 輸出 PNG：存的就是右邊那張畫布——所見即所得。 */
  function toBlob() {
    return new Promise((resolve, reject) => {
      rightCanvas.value.toBlob((b) => (b ? resolve(b) : reject(new Error('畫布轉檔失敗'))), 'image/png')
    })
  }

  return {
    state, cursor, leftCanvas, rightCanvas,
    load, onBrushDown, onBrushMove, onBrushUp, undoStroke, currentAlpha, toBlob,
  }
}
