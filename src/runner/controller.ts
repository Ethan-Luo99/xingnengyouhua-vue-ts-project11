/**
 * 批次调度（设计文档 §1.2 / §2.2 / §5 / §6）：
 * - 动态 pull 分发：Worker 完成一个领一个；队列按预估耗时降序（R4 长尾先入队）
 * - 取消：terminate 硬取消 + 惰性重建 + batchId 世代校验
 * - 降级：Worker / 模块 Worker 不可用 → 主线程任务间切片
 * - 批次结束（含取消）即 terminate 全池，防 Worker 内存膨胀（R1）
 */
import { taskDescriptors, TASK_COUNT } from '../tasks/registry'
import type { TaskDescriptor } from '../tasks/registry'
import { acquirePool, terminatePool } from '../workers/pool'
import type { ResultMessage, TaskMessage } from '../workers/analysis.worker'
import * as store from '../store/analysisStore'
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

export function startAnalysis(): void {
  // R5：幂等——运行中重复触发（含 StrictMode 场景）不发起第二批
  if (store.getSnapshot().status === 'running') return

  const backend = selectBackend()
  const batchId = store.beginBatch(backend, TASK_COUNT)
  const queue = buildQueue()

  if (backend === 'main-thread') {
    void runMainThreadBatch(batchId, queue)
    return
  }
  runWorkerBatch(batchId, queue)
}

export function cancelAnalysis(): void {
  if (store.getSnapshot().status !== 'running') return
  // 先翻世代/清缓冲，再硬杀 Worker；旧批次迟到消息由 store 入口丢弃（§5.2）
  store.cancelBatch()
  terminatePool()
}

function runWorkerBatch(batchId: number, queue: TaskDescriptor[]): void {
  const workers = acquirePool()
  const inFlight = new Map<Worker, TaskDescriptor>()
  let activeWorkers = 0

  const maybeFinish = (): void => {
    if (queue.length === 0 && inFlight.size === 0) {
      store.completeBatch(batchId)
      // R1：批次结束 terminate 全池，下一批惰性重建
      terminatePool()
    }
  }

  const dispatch = (worker: Worker): void => {
    const task = queue.shift()
    if (!task || !store.isCurrentBatch(batchId)) {
      if (task) queue.unshift(task)
      maybeFinish()
      return
    }
    inFlight.set(worker, task)
    const msg: TaskMessage = { taskId: task.taskId, params: task.params, batchId }
    worker.postMessage(msg)
  }

  for (const worker of workers) {
    activeWorkers += 1
    worker.onmessage = (e: MessageEvent<ResultMessage>) => {
      const { batchId: msgBatchId, result } = e.data
      inFlight.delete(worker)
      // 世代校验在 store 入口再兜一层（双保险，§5.2）
      store.receiveResult(msgBatchId, result)
      if (store.isCurrentBatch(batchId)) {
        dispatch(worker)
      } else {
        maybeFinish()
      }
    }
    worker.onerror = () => {
      // 容错：在途任务重新入队，剔除故障 Worker；池空则降级主线程跑完余量
      const pending = inFlight.get(worker)
      if (pending) queue.unshift(pending)
      inFlight.delete(worker)
      worker.onmessage = null
      worker.onerror = null
      worker.terminate()
      activeWorkers -= 1
      if (activeWorkers === 0 && store.isCurrentBatch(batchId)) {
        terminatePool()
        void runMainThreadBatch(batchId, queue)
      }
    }
    dispatch(worker)
  }
}
