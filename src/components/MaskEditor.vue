<script setup>
// 一張圖的去背修補：左邊原圖＋紅色遮罩（在這裡塗）、右邊即時的去背結果。
// 邏輯在 ../mask/useMaskEditor.js 與 ../mask/maskBrush.js。
import { onBeforeUnmount, onMounted } from 'vue'
import { useMaskEditor } from '../mask/useMaskEditor.js'

const props = defineProps({
  /** { file, width, height, alpha, modelAlpha } */
  item: { type: Object, required: true },
})
const emit = defineEmits(['change', 'error'])

const editor = useMaskEditor()
const { state: mask, cursor, leftCanvas, rightCanvas } = editor

async function load(alpha) {
  let bitmap
  try {
    bitmap = await createImageBitmap(props.item.file, { imageOrientation: 'from-image' })
    await editor.load(bitmap, alpha, props.item.width, props.item.height)
  } catch (err) {
    emit('error', String(err.message || err))
  } finally {
    bitmap?.close()
  }
}

// 父層以圖片 id 當 key，換一張就是新的元件，所以只在掛載時載入一次。
onMounted(() => load(props.item.alpha))

function up(ev) {
  if (editor.onBrushUp(ev)) emit('change')
}
function undo() {
  if (editor.undoStroke()) emit('change')
}
async function resetMask() {
  await load(props.item.modelAlpha)
  emit('change')
}

// Ctrl/⌘+Z 復原一筆
function onKey(e) {
  if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === 'z' && !/^(INPUT|TEXTAREA|SELECT)$/.test(e.target?.tagName)) {
    e.preventDefault()
    undo()
  }
}
onMounted(() => window.addEventListener('keydown', onKey))
onBeforeUnmount(() => window.removeEventListener('keydown', onKey))

/** 目前的遮罩與輸出 PNG，給父層存回清單。 */
async function snapshot() {
  return { alpha: editor.currentAlpha(), blob: await editor.toBlob() }
}
defineExpose({ snapshot })
</script>

<template>
  <div class="mask-editor">
    <div class="compare">
      <figure>
        <figcaption>原圖（<span class="mask-legend">紅色</span>＝保留的部分，在這裡用筆刷修）</figcaption>
        <div class="pane">
          <canvas ref="leftCanvas" class="edit-canvas"
                  @pointerdown="editor.onBrushDown" @pointermove="editor.onBrushMove"
                  @pointerup="up" @pointercancel="up"
                  @pointerenter="cursor.inside = true" @pointerleave="cursor.inside = false"></canvas>
        </div>
      </figure>
      <figure>
        <figcaption>去背結果</figcaption>
        <div class="pane checker">
          <canvas ref="rightCanvas" class="preview-canvas"></canvas>
        </div>
      </figure>
    </div>

    <div v-if="cursor.inside" class="brush-cursor" :class="mask.tool"
         :style="{ left: cursor.x + 'px', top: cursor.y + 'px', width: mask.brush + 'px', height: mask.brush + 'px' }"></div>

    <div class="tools">
      <div class="seg">
        <button type="button" :class="{ on: mask.tool === 'keep' }" @click="mask.tool = 'keep'">保留</button>
        <button type="button" :class="{ on: mask.tool === 'remove' }" @click="mask.tool = 'remove'">去除</button>
      </div>
      <label class="brush-size">筆刷
        <input v-model.number="mask.brush" type="range" min="4" max="200" step="2" />
        <span class="muted">{{ mask.brush }}px</span>
      </label>
      <button type="button" class="btn small" :disabled="!mask.canUndo" title="復原（⌘Z）" @click="undo">復原</button>
      <button type="button" class="btn small" @click="resetMask">回到 AI 結果</button>
    </div>
  </div>
</template>

<style scoped>
/* 左右對照：兩欄等寬，窄螢幕改上下堆疊 */
.compare { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
@media (max-width: 720px) { .compare { grid-template-columns: 1fr; } }
figure { display: flex; flex-direction: column; gap: 4px; margin: 0; }
figcaption { color: var(--muted); font-size: 12px; }
.pane {
  display: flex; align-items: center; justify-content: center; min-height: 120px;
  border: 1px solid var(--line); border-radius: 10px; overflow: hidden;
}
.checker { background: var(--checker); }
canvas { display: block; max-width: 100%; max-height: 62vh; object-fit: contain; }
/* touch-action:none 讓觸控筆／手指拖曳不會被瀏覽器當成捲動而中斷筆畫；
   cursor:none 是因為改用下面自訂的圈圈游標顯示實際筆刷大小 */
.edit-canvas { touch-action: none; cursor: none; }
.preview-canvas { pointer-events: none; }
.mask-legend { color: rgb(255, 64, 64); font-weight: 600; }

/* 跟著滑鼠的筆刷圈圈（fixed 定位，故用 clientX/Y） */
.brush-cursor {
  position: fixed; z-index: 50; transform: translate(-50%, -50%); pointer-events: none;
  border: 2px solid rgba(255, 255, 255, .9); border-radius: 50%;
  box-shadow: 0 0 0 1.5px rgba(0, 0, 0, .75);
}
/* 「保留」＝要塗上紅色遮罩，圈圈就用紅色預告；「去除」＝擦掉，用中性白色 */
.brush-cursor.keep { border-color: rgba(255, 64, 64, .95); background: rgba(255, 64, 64, .18); }

.tools { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; margin-top: 12px; }
.seg { display: inline-flex; border: 1px solid var(--line); border-radius: 10px; overflow: hidden; }
.seg button {
  min-height: 34px; border: 0; background: var(--panel); padding: 6px 16px; color: var(--muted);
  font: inherit; font-size: 14px; cursor: pointer;
}
.seg button + button { border-left: 1px solid var(--line); }
.seg button.on { background: var(--accent-soft); color: var(--accent); font-weight: 600; }
.brush-size { display: inline-flex; align-items: center; gap: 8px; color: var(--muted); font-size: 14px; }
.brush-size input { width: 130px; }
.muted { color: var(--muted); font-size: 13px; }
</style>
