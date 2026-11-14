import { test } from 'vitest'
import assert from 'node:assert/strict'
import { MEAN, STD, toInput, toMask } from './models.js'

test('前處理：RGBA → CHW 平面排列，並做 ImageNet 正規化', () => {
  // 2×2：紅、白、黑、黑
  const rgba = new Uint8ClampedArray([255, 0, 0, 255, 255, 255, 255, 255, 0, 0, 0, 255, 0, 0, 0, 255])
  const x = toInput(rgba, 2)
  const n = 4
  assert.equal(x.length, 3 * n)
  assert.ok(Math.abs(x[0] - (1 - MEAN[0]) / STD[0]) < 1e-6, 'R 平面的第一個點')
  assert.ok(Math.abs(x[n] - (0 - MEAN[1]) / STD[1]) < 1e-6, 'G 平面的第一個點')
  assert.ok(Math.abs(x[2 * n + 1] - (1 - MEAN[2]) / STD[2]) < 1e-6, 'B 平面的第二個點')
})

test('後處理：logits 經 sigmoid 變成 0~255（模型輸出的不是機率）', () => {
  const m = toMask(new Float32Array([-30, 0, 30]))
  assert.deepEqual([...m], [0, 128, 255])
})

test('有 NaN 就回 null，讓呼叫端改走 CPU 重算，而不是存出一張全黑的遮罩', () => {
  assert.equal(toMask(new Float32Array([0, NaN])), null)
})
