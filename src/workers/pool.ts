/**
 * Worker 池（设计文档 §1.2 / §5.1 / §7-R2）：
 * - 大小 clamp(hardwareConcurrency - 1, 2, 16)；hardwareConcurrency 缺失/异常回退 4（§6.1）
 * - 模块级单例 + 惰性重建：terminate 硬取消后池销毁，下一批次重建
 * - import.meta.hot.dispose 清理，防 HMR 下 Worker 泄漏（R2）
 */

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

export function getPoolSize(): number {
  const hc = navigator.hardwareConcurrency
  if (Number.isFinite(hc) && hc >= 1) {
    return clamp(hc - 1, 2, 16)
  }
  // 缺失/为 0/非有限值：保守回退（文档 §6.1）
  return 4
}

export function createWorker(): Worker {
  return new Worker(new URL('./analysis.worker.ts', import.meta.url), {
    type: 'module',
  })
}

let pool: Worker[] | null = null

/** 惰性建池：已存在则复用；上一批 terminate 后此处重建 */
export function acquirePool(): Worker[] {
  if (!pool) {
    const size = getPoolSize()
    pool = Array.from({ length: size }, () => createWorker())
  }
  return pool
}

/** 硬取消/批次结束：terminate 全池并置空（下次 acquirePool 惰性重建） */
export function terminatePool(): void {
  if (!pool) return
  for (const worker of pool) {
    worker.onmessage = null
    worker.onerror = null
    worker.terminate()
  }
  pool = null
}

export function poolAlive(): boolean {
  return pool !== null
}

// R2：HMR 时清理池，避免旧 Worker 泄漏累积
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    terminatePool()
  })
}
