/**
 * 批次生命周期入口（设计文档 §1.2 / §2.2 / §5 / §6）：
 * - 开始 / 暂停 / 恢复 / 取消 / 重新开始
 * - 取消走 terminate 硬取消 + batchId 世代校验（§5.1/§5.2），旧批次消息不污染新批次
 * - Worker / 模块 Worker 不可用 -> 主线程任务间切片降级（§6.1）
 * - 运行逻辑见 BatchRunner；本文件只做后端选择、世代切换与降级接线
 */
import { taskDescriptors } from '../tasks/registry'
import type { TaskDescriptor } from '../tasks/registry'
import * as store from '../store/analysisStore'
import { BatchRunner } from './batchRunner'
import { runMainThreadBatch } from './mainThreadRunner'

/** §6.2：模块 Worker 特性检测（data: URL 空 Worker 构造即检测，随即 terminate） */
function supportsModuleWorkers(): boolean {
  if (typeof Worker === 'undefined') return false
  let supported = false
  try {
    const tester = {
      get type() {
        supported = true
        return 'module' as const
      },
    }
    const probe = new Worker('data:text/javascript,', tester as WorkerOptions)
    probe.terminate()
  } catch {
    return false
  }
  return supported
}

export function selectBackend(): store.Backend {
  return supportsModuleWorkers() ? 'worker-pool' : 'main-thread'
}

/** 长任务按预估耗时降序入队（R4：压缩尾部拖尾） */
function buildQueue(): TaskDescriptor[] {
  return [...taskDescriptors].sort((a, b) => b.params.targetMs - a.params.targetMs)
}

export interface StartOptions {
  queue?: readonly TaskDescriptor[]
  initialPoolSize?: number
  autoScale?: boolean
}

let activeRunner: BatchRunner | null = null
let activeBatchId = 0

/** R5：幂等——运行/暂停中重复触发不另起批次 */
export function startAnalysis(options: StartOptions = {}): void {
  const status = store.getSnapshot().status
  if (status === 'running' || status === 'paused') return

  const backend = selectBackend()
  const queue = options.queue ? [...options.queue] : buildQueue()
  const total = queue.length
  const batchId = store.beginBatch(backend, total, options.initialPoolSize ?? 0)
  activeBatchId = batchId

  if (backend === 'main-thread') {
    activeRunner = null
    void runMainThreadBatch(batchId, queue)
    return
  }

  const runner = new BatchRunner(batchId, queue, {
    initialSize: options.initialPoolSize,
    autoScale: options.autoScale,
  })
  activeRunner = runner
  // 全池故障 -> 主线程跑完剩余任务（既有降级语义）
  runner.failOverToMainThread = () => {
    const remaining = runner.takeRemainingQueue()
    void runMainThreadBatch(batchId, remaining)
  }
  runner.start()
}

export function pauseAnalysis(): void {
  activeRunner?.pause()
}

export function resumeAnalysis(): void {
  activeRunner?.resume()
}

export function cancelAnalysis(): void {
  const status = store.getSnapshot().status
  if (status !== 'running' && status !== 'paused') return
  // 先解绑 runner，再翻世代，最后 terminate：旧批次迟到消息由 store 入口丢弃（§5.2）
  const runner = activeRunner
  activeRunner = null
  store.cancelBatch()
  runner?.cancel()
}

/**
 * 暂停/运行中"重新开始"：按现有取消语义安全终止旧批次，再发起新批次。
 * 新批次 batchId 自增，旧 Worker 全部 terminate，旧批次消息不可能污染新批次。
 */
export function restartAnalysis(options: StartOptions = {}): void {
  cancelAnalysis()
  startAnalysis(options)
}

export function getActiveBatchId(): number {
  return activeBatchId
}

export function getActiveRunner(): BatchRunner | null {
  return activeRunner
}

// R2：HMR 时 terminate 当前批次池，防止旧 Worker 泄漏累积
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    activeRunner?.cancel()
    activeRunner = null
  })
}
