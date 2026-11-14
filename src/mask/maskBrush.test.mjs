/**
 * maskBrush 的單元測試（`npm test`）。
 *
 * 這支測的是去背修補的核心不變量：只動 alpha、復原要能逐位元還原、
 * 髒矩形要真的涵蓋改動範圍（畫布只重畫髒矩形，涵蓋不足就會殘影）。
 */
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { createMaskEditor, UNDO_LIMIT } from './maskBrush.js'

/** 造一張 w×h 的圖：RGB 給可辨識的值、alpha 全 0（＝全透明，模擬「全被去掉」）。 */
function makeImage(w, h, alpha = 0) {
  const d = new Uint8ClampedArray(w * h * 4)
  for (let i = 0; i < w * h; i++) {
    d[i * 4] = (i * 7) % 256
    d[i * 4 + 1] = (i * 13) % 256
    d[i * 4 + 2] = (i * 29) % 256
    d[i * 4 + 3] = alpha
  }
  return d
}
const alphaAt = (d, w, x, y) => d[(y * w + x) * 4 + 3]
const rgbAt = (d, w, x, y) => [d[(y * w + x) * 4], d[(y * w + x) * 4 + 1], d[(y * w + x) * 4 + 2]]

test('建構時長度不符要擋下來', () => {
  assert.throws(() => createMaskEditor(4, 4, new Uint8ClampedArray(10)))
})

test('還原筆刷把 alpha 塗成 255，且完全不動 RGB', () => {
  const w = 32, h = 32
  const d = makeImage(w, h, 0)
  const before = rgbAt(d, w, 16, 16)
  const ed = createMaskEditor(w, h, d)
  ed.beginStroke()
  ed.stamp(16, 16, 5, 255)
  ed.endStroke()
  assert.equal(alphaAt(d, w, 16, 16), 255, '圓心應被塗滿')
  assert.deepEqual(rgbAt(d, w, 16, 16), before, 'RGB 不可被改動')
  assert.equal(alphaAt(d, w, 0, 0), 0, '圓外不應被碰到')
})

test('擦除筆刷把 alpha 塗成 0', () => {
  const w = 32, h = 32
  const d = makeImage(w, h, 255)
  const ed = createMaskEditor(w, h, d)
  ed.beginStroke()
  ed.stamp(16, 16, 4, 0)
  ed.endStroke()
  assert.equal(alphaAt(d, w, 16, 16), 0)
  assert.equal(alphaAt(d, w, 0, 0), 255)
})

test('筆刷是圓形，不是方形', () => {
  const w = 41, h = 41
  const d = makeImage(w, h, 0)
  const ed = createMaskEditor(w, h, d)
  ed.beginStroke()
  ed.stamp(20, 20, 10, 255)
  ed.endStroke()
  assert.equal(alphaAt(d, w, 20, 20), 255, '圓心')
  assert.equal(alphaAt(d, w, 20, 11), 255, '正上方邊緣內')
  // 角落 (13,13) 距圓心 ~9.9 → 在半徑內；(12,12) 距 ~11.3 → 在半徑外
  assert.equal(alphaAt(d, w, 12, 12), 0, '方形角落不該被塗到（證明是圓形）')
})

test('髒矩形涵蓋所有實際改動的像素', () => {
  const w = 40, h = 40
  const d = makeImage(w, h, 0)
  const ed = createMaskEditor(w, h, d)
  ed.beginStroke()
  const box = ed.stamp(20, 20, 6, 255)
  ed.endStroke()
  assert.ok(box, '應回傳髒矩形')
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (alphaAt(d, w, x, y) !== 0) {
        assert.ok(
          x >= box.x0 && x <= box.x1 && y >= box.y0 && y <= box.y1,
          `改動的像素 (${x},${y}) 落在髒矩形 ${JSON.stringify(box)} 之外`,
        )
      }
    }
  }
})

test('沒有實際改動時回 null（不產生多餘重畫／復原步）', () => {
  const w = 16, h = 16
  const d = makeImage(w, h, 255)
  const ed = createMaskEditor(w, h, d)
  ed.beginStroke()
  const box = ed.stamp(8, 8, 3, 255) // 本來就是 255
  assert.equal(box, null)
  assert.equal(ed.endStroke(), false)
  assert.equal(ed.canUndo, false)
})

test('超出邊界的筆刷會被裁切，不會越界寫入', () => {
  const w = 16, h = 16
  const d = makeImage(w, h, 0)
  const ed = createMaskEditor(w, h, d)
  ed.beginStroke()
  ed.stamp(0, 0, 5, 255) // 圓心在角落
  ed.stamp(-50, -50, 3, 255) // 完全在外面
  ed.endStroke()
  assert.equal(alphaAt(d, w, 0, 0), 255)
  assert.equal(d.length, w * h * 4, '緩衝長度不可變')
})

test('復原逐位元還原 alpha', () => {
  const w = 24, h = 24
  const d = makeImage(w, h, 0)
  // 先弄出不均勻的初始 alpha，才驗得出「還原成原值」而非「一律歸零」
  for (let i = 0; i < w * h; i++) d[i * 4 + 3] = i % 256
  const snapshot = Uint8ClampedArray.from(d)
  const ed = createMaskEditor(w, h, d)
  ed.beginStroke()
  ed.line(4, 4, 20, 20, 4, 255)
  ed.endStroke()
  assert.notDeepEqual(Array.from(d), Array.from(snapshot), '筆畫應有改動')
  const box = ed.undo()
  assert.ok(box, '復原應回傳髒矩形')
  assert.deepEqual(Array.from(d), Array.from(snapshot), '復原後應與原本逐位元相同')
  assert.equal(ed.canUndo, false)
})

test('多筆畫逐步復原，順序為後進先出', () => {
  const w = 32, h = 32
  const d = makeImage(w, h, 0)
  const ed = createMaskEditor(w, h, d)
  ed.beginStroke(); ed.stamp(8, 8, 3, 255); ed.endStroke()
  const afterFirst = Uint8ClampedArray.from(d)
  ed.beginStroke(); ed.stamp(24, 24, 3, 255); ed.endStroke()
  assert.equal(ed.undoDepth, 2)
  ed.undo()
  assert.deepEqual(Array.from(d), Array.from(afterFirst), '應只退掉第二筆')
  assert.equal(alphaAt(d, w, 8, 8), 255, '第一筆仍在')
})

test('同一筆畫重複掃過同一點，只記錄一次原始值', () => {
  const w = 20, h = 20
  const d = makeImage(w, h, 0)
  const ed = createMaskEditor(w, h, d)
  ed.beginStroke()
  ed.stamp(10, 10, 5, 255)
  ed.stamp(10, 10, 5, 255) // 完全重疊
  ed.stamp(10, 10, 5, 0) // 再塗成 0
  ed.endStroke()
  const box = ed.undo()
  assert.ok(box)
  // 若舊值被第二次覆寫記錄成 255，這裡就會還原成 255 而非原本的 0
  assert.equal(alphaAt(d, w, 10, 10), 0, '應還原到「筆畫開始前」的值')
})

test('line 連續拖曳不留空隙', () => {
  const w = 60, h = 20
  const d = makeImage(w, h, 0)
  const ed = createMaskEditor(w, h, d)
  ed.beginStroke()
  ed.line(5, 10, 55, 10, 3, 255) // 一次跨很長，靠內插補點
  ed.endStroke()
  for (let x = 6; x <= 54; x++) {
    assert.equal(alphaAt(d, w, x, 10), 255, `x=${x} 出現空隙`)
  }
})

test('復原堆疊有上限，不會無限成長', () => {
  const w = 16, h = 16
  const d = makeImage(w, h, 0)
  const ed = createMaskEditor(w, h, d)
  for (let k = 0; k < UNDO_LIMIT + 5; k++) {
    ed.beginStroke()
    ed.stamp(8, 8, 2, k % 2 === 0 ? 255 : 0)
    ed.endStroke()
  }
  assert.equal(ed.undoDepth, UNDO_LIMIT)
})
