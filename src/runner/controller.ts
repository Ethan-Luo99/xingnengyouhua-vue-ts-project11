/**
 * 批次调度入口（设计文档 §1.2 / §2.2 / §5 / §6；本轮扩展暂停/恢复/重新开始）：
 * - 动态 pull 分发：Worker 完成一个领一个；队列按预估耗时降序（R4 长尾先入队）
 * - 暂停 = 停止派发新任务，在途跑完照常入库；恢复 = 断点续跑，不重跑已完成
 * - 取消/重新开始：terminate 硬取消 + batchId 世代校验丢弃旧批次消息（§5.2）；
 *   “重新开始”在取消语义后立刻发起新批次，新旧世代隔离、消息互不污染
 * - 降级：Worker / 模块 Worker 不可用 → 主线程任务间切片
 * - 批次结束（含取消）即 terminate 全池，防 Worker 内存膨胀（R1）
 */
import { taskDescriptors } from '../tasks/registry'
import type { TaskDescriptor } from '../tasks/registry'
import { getInitialPoolSize, realWorkerFactory } from '../workers/pool'
import type { WorkerFactory } from '../workers/pool'
import * as store from '../store/analysisStore'
import { runMainThreadBatch } from './mainThreadRunner'
import { BatchRunner } from './batchScheduler'
import type { BatchRunOptions } from './batchScheduler'

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

/** 长任务按预估耗时降序入队（R4：压缩尾部拖尾）；extraTasks 置于最前优先执行 */
function buildQueue(
  extraTasks: readonly TaskDescriptor[] = [],
  base: readonly TaskDescriptor[] = taskDescriptors,
): TaskDescriptor[] {
  const regular = [...base].sort(
    (a, b) => b.params.targetMs - a.params.targetMs,
  )
  return [...extraTasks, ...regular]
}

/** 批次配置（自测注入：僵死任务 / 传输层 / 定时参数），生产路径均走默认值 */
export interface StartOptions {
  extraTasks?: readonly TaskDescriptor[]
  factory?: WorkerFactory
  timing?: BatchRunOptions
  /** 自测用：只取常规任务集前 N 个（默认全部 500） */
  limit?: number
}

let activeRunner: BatchRunner | null = null

function startBatch(options: StartOptions = {}): void {
  const backend = options.factory !== undefined ? 'worker-pool' : selectBackend()
  const base =
    options.limit !== undefined ? taskDescriptors.slice(0, options.limit) : taskDescriptors
  const queue = buildQueue(options.extraTasks, base)
  const initialPoolSize = options.timing?.initialPoolSize ?? getInitialPoolSize()
  const batchId = store.beginBatch(backend, queue.length, initialPoolSize)

  if (backend === 'main-thread') {
    void runMainThreadBatch(batchId, queue)
    return
  }

  const runner = new BatchRunner(batchId, queue, options.factory ?? realWorkerFactory, {
    initialPoolSize,
    ...options.timing,
  }, (failedBatchId, remaining) => {
    // §6.1：池内 Worker 全部故障 → 剩余任务交主线程任务间切片跑完（同一 store 协议）
    if (failedBatchId !== store.getSnapshot().batchId) return
    void runMainThreadBatch(failedBatchId, remaining)
  })
  activeRunner = runner
  runner.start()
}

/** 开始分析（idle/done/cancelled 态可用） */
export function startAnalysis(options?: StartOptions): void {
  const status = store.getSnapshot().status
  if (status === 'running' || status === 'paused') return
  startBatch(options)
}

/** 暂停：只关派发闸口，不 terminate；在途任务跑完照常入库 */
export function pauseAnalysis(): void {
  if (store.getSnapshot().status !== 'running') return
  store.pauseBatch()
}

/** 恢复：开闸并通知调度器立即补派发；已完成任务不在队列，天然不重跑 */
export function resumeAnalysis(): void {
  if (store.getSnapshot().status !== 'paused') return
  store.resumeBatch()
  activeRunner?.resume()
}

/** 取消：硬终止当前批次（running / paused 均可） */
export function cancelAnalysis(): void {
  const status = store.getSnapshot().status
  if (status !== 'running' && status !== 'paused') return
  activeRunner?.cancel()
  activeRunner = null
  store.cancelBatch()
}

/**
 * 重新开始：旧批次按现有取消语义安全终止（terminate + 世代号自增），
 * 旧 Worker 的迟到消息因 batchId 不匹配在 store 入口丢弃，新批次不受污染。
 */
export function restartAnalysis(options?: StartOptions): void {
  const status = store.getSnapshot().status
  if (status === 'running' || status === 'paused') {
    cancelAnalysis()
  }
  startBatch(options)
}
