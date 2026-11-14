/**
 * maskBrush —— 去背遮罩的手繪修補核心（純資料，無 DOM 相依，故可直接用 node 測）。
 *
 * 操作對象是一塊 RGBA 緩衝（就是 canvas 的 ImageData.data）：**只改 alpha**，RGB 一律不動。
 * 這是刻意的——編輯用的緩衝每個像素都保留原圖 RGB，只有 alpha 是模型算出的遮罩，
 * 所以「還原」＝把 alpha 塗回 255（原圖自然浮現）、「擦除」＝塗成 0，不需要另存一份原圖。
 *
 * 復原（undo）以「一次筆畫」為單位，且只記錄**真的被改動**的像素的舊值
 * （筆刷重複掃過同一點不會重複記錄），因此記憶體與塗抹面積成正比，
 * 不是每步都複製整張圖——大圖上這個差別很大。
 */

/** 一次筆畫最多保留幾步可復原。 */
export const UNDO_LIMIT = 20

/**
 * @param {number} width
 * @param {number} height
 * @param {Uint8ClampedArray} rgba 長度需為 width*height*4；**就地修改**
 */
export function createMaskEditor(width, height, rgba) {
  if (rgba.length !== width * height * 4) {
    throw new Error(`rgba 長度不符：${rgba.length} != ${width * height * 4}`)
  }
  const n = width * height
  // 本次筆畫是否已記錄過該像素的舊值（避免同一點被重複記錄）。
  const touched = new Uint8Array(n)
  const undoStack = []

  let stroke = null // { idx: number[], old: number[], box: {x0,y0,x1,y1} }

  const emptyBox = () => ({ x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity })
  const growBox = (box, x0, y0, x1, y1) => {
    if (x0 < box.x0) box.x0 = x0
    if (y0 < box.y0) box.y0 = y0
    if (x1 > box.x1) box.x1 = x1
    if (y1 > box.y1) box.y1 = y1
  }
  const boxOrNull = (box) => (box.x1 < box.x0 || box.y1 < box.y0 ? null : { ...box })

  return {
    width,
    height,
    data: rgba,

    get canUndo() {
      return undoStack.length > 0
    },
    /** 測試/除錯用：目前累積的可復原步數。 */
    get undoDepth() {
      return undoStack.length
    },

    beginStroke() {
      stroke = { idx: [], old: [], box: emptyBox() }
    },

    /**
     * 蓋一個圓形筆刷印章（半徑 r，影像像素座標）。
     * @returns {{x0,y0,x1,y1}|null} 實際改動的範圍（供呼叫端只重畫髒矩形）
     */
    stamp(cx, cy, r, value) {
      if (!stroke) this.beginStroke()
      const x0 = Math.max(0, Math.floor(cx - r))
      const x1 = Math.min(width - 1, Math.ceil(cx + r))
      const y0 = Math.max(0, Math.floor(cy - r))
      const y1 = Math.min(height - 1, Math.ceil(cy + r))
      if (x1 < x0 || y1 < y0) return null
      const r2 = r * r
      const box = emptyBox()
      for (let y = y0; y <= y1; y++) {
        const dy = y - cy
        for (let x = x0; x <= x1; x++) {
          const dx = x - cx
          if (dx * dx + dy * dy > r2) continue
          const i = y * width + x
          const a = i * 4 + 3
          if (rgba[a] === value) continue
          if (!touched[i]) {
            touched[i] = 1
            stroke.idx.push(i)
            stroke.old.push(rgba[a])
          }
          rgba[a] = value
          growBox(box, x, y, x, y)
        }
      }
      const dirty = boxOrNull(box)
      if (dirty) growBox(stroke.box, dirty.x0, dirty.y0, dirty.x1, dirty.y1)
      return dirty
    },

    /**
     * 從 (x0,y0) 拖到 (x1,y1)：沿途補點，避免快速拖曳畫成一串分離的圓點。
     * @returns {{x0,y0,x1,y1}|null} 整段的髒矩形
     */
    line(fromX, fromY, toX, toY, r, value) {
      const dx = toX - fromX
      const dy = toY - fromY
      const steps = Math.max(1, Math.ceil(Math.hypot(dx, dy) / Math.max(0.5, r / 2)))
      const box = emptyBox()
      for (let s = 1; s <= steps; s++) {
        const d = this.stamp(fromX + (dx * s) / steps, fromY + (dy * s) / steps, r, value)
        if (d) growBox(box, d.x0, d.y0, d.x1, d.y1)
      }
      return boxOrNull(box)
    },

    /**
     * 收筆：把這次筆畫壓進復原堆疊。
     * @returns {boolean} 這次筆畫是否真的改到東西
     */
    endStroke() {
      if (!stroke) return false
      const changed = stroke.idx.length > 0
      if (changed) {
        for (const i of stroke.idx) touched[i] = 0 // 只清掃到的點，不整張清
        undoStack.push({
          idx: Uint32Array.from(stroke.idx),
          old: Uint8Array.from(stroke.old),
          box: boxOrNull(stroke.box),
        })
        if (undoStack.length > UNDO_LIMIT) undoStack.shift()
      }
      stroke = null
      return changed
    },

    /**
     * 復原一步。
     * @returns {{x0,y0,x1,y1}|null} 需要重畫的範圍；沒東西可復原時回 null
     */
    undo() {
      const s = undoStack.pop()
      if (!s) return null
      for (let k = 0; k < s.idx.length; k++) rgba[s.idx[k] * 4 + 3] = s.old[k]
      return s.box
    },
  }
}
