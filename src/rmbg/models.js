// 去背模型。兩顆都是 BiRefNet_lite（ZhengPeng7，MIT，權重與程式碼都是），只差匯出方式：
//
// * WebGPU：jiabins0303 的 1024 版。onnx-community 的原版匯出在瀏覽器裡會 OOM——
//   deform_conv 被拆成 GatherND，WebGPU 不收、全掉回 CPU，在 32 位元的 WASM 堆積上
//   一次要好幾個 392MB 的 im2col 緩衝（原生量到峰值 10.5GB）。這版只改圖結構
//   （GatherND → Gather、32 路 Split 拆成小樹），權重不變。
// * CPU：studioludens 的 512 版。1024 那顆在 WASM 上一樣 OOM；512 單執行緒約 4 秒。
//   **不要拿它跑 WebGPU**：實測 fp16 在 WebGPU 上整張輸出是壞的（跟原版 IoU 為 0）。
//
// 網址釘在特定 commit，上游改檔案也不會讓這裡默默換成別的模型。
// 輸出是 logits（要自己套 sigmoid），前處理是 ImageNet 的 mean/std。

export const MODELS = {
  webgpu: {
    url: 'https://huggingface.co/jiabins0303/birefnet-lite-1024-webgpu/resolve/1ad01cef0f4101a285c5a3e0bd7f15597d93403f/onnx/model_fp16.onnx',
    bytes: 114834127,
    size: 1024,
  },
  wasm: {
    url: 'https://huggingface.co/studioludens/birefnet-lite-512/resolve/962e67969ec6acec9c19fab76acee4f5e22e990c/onnx/model_fp16.onnx',
    bytes: 98484532,
    size: 512,
  },
}

export const MEAN = [0.485, 0.456, 0.406]
export const STD = [0.229, 0.224, 0.225]

/**
 * 把 size×size 的 RGBA 轉成模型輸入（CHW、ImageNet 正規化）。
 * @param {Uint8ClampedArray} rgba
 */
export function toInput(rgba, size) {
  const n = size * size
  const out = new Float32Array(3 * n)
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < 3; c++) out[c * n + i] = (rgba[i * 4 + c] / 255 - MEAN[c]) / STD[c]
  }
  return out
}

/**
 * logits → 0~255 的遮罩（sigmoid）。有 NaN 就回 null：那是 GPU 算壞了，呼叫端要改走 CPU。
 * @param {Float32Array} logits
 */
export function toMask(logits) {
  const out = new Uint8ClampedArray(logits.length)
  for (let i = 0; i < logits.length; i++) {
    const z = logits[i]
    if (Number.isNaN(z)) return null
    out[i] = 255 / (1 + Math.exp(-z))
  }
  return out
}
