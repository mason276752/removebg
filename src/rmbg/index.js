// 主執行緒這一側：管理去背用的 Worker（見 worker.js），一次一張依序送進去。

let worker = null
const jobs = new Map()

function getWorker() {
  if (worker) return worker
  worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' })
  worker.onmessage = (e) => {
    const { id, stage, progress, alpha, error, nan } = e.data
    const job = jobs.get(id)
    if (!job) return
    if (stage) {
      job.onStage?.(stage, progress)
      return
    }
    jobs.delete(id)
    if (alpha) job.resolve(alpha)
    else job.reject(Object.assign(new Error(error), { nan: !!nan }))
  }
  worker.onerror = (e) => fail(new Error(`去背失敗：${e.message || '無法啟動運算'}`))
  return worker
}

function fail(err) {
  worker?.terminate()
  worker = null
  for (const job of jobs.values()) job.reject(err)
  jobs.clear()
}

/**
 * 算出一張圖的去背遮罩。`bitmap` 會被轉移給 Worker。
 *
 * @param {(stage: 'download'|'run', progress?: number) => void} onStage
 * @returns {Promise<Uint8ClampedArray>} 與原圖同尺寸、每像素一個位元組的 alpha
 */
export function maskFor(bitmap, backend, onStage) {
  return new Promise((resolve, reject) => {
    const id = crypto.randomUUID()
    jobs.set(id, { resolve, reject, onStage })
    getWorker().postMessage({ id, backend, bitmap }, [bitmap])
  })
}

/** 中斷進行中的去背（直接收掉 Worker；模型在快取裡，重新載入很快）。 */
export function cancelAll() {
  fail(new Error('已取消'))
}

/** 有 WebGPU 就用 GPU（1024 精細版），否則退回 CPU（512 版）。 */
export async function detectBackend() {
  try {
    if (navigator.gpu && (await navigator.gpu.requestAdapter())) return 'webgpu'
  } catch {
    // 某些瀏覽器有 navigator.gpu 但 requestAdapter 會丟例外（例如被政策關掉）
  }
  return 'wasm'
}
