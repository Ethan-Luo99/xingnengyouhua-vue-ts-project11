/**
 * 分析批次引擎（单例，设计文档 1.2 / 4.2 / 5 / 6 / R2 / R5）：
 * - Worker 可用：池化动态 pull，长任务按预估耗时降序入队（R4）
 * - Worker 不可用：主线程任务间切片（setTimeout(0) 宏任务让出，见 6.1 偏离说明）
 * - 取消：terminate 硬取消 + 惰性重建；batchId 世代校验丢弃迟到结果
 * - 批次启动只由用户事件调用 start()，不在任何 effect 中触发（R5）
 * - HMR：import.meta.hot.dispose 中终止全部 Worker（R2）
 */
import { runRegisteredTask, taskList, TASK_COUNT, type TaskSpec } from '../tasks/registry'
import { analysisStore } from '../store/analysisStore'
import type { WorkerRequest, WorkerResponse } from './protocol'
import {
  createModuleWorker,
  resolvePoolSize,
  supportsModuleWorkers,
  WorkerPool,
} from './workerPool'

export interface StartInfo {
  batchId: number
  mode: 'pool' | 'main-thread'
  poolSize: number
  totalEstimateMs: number
}

/**
 * 任务间让出（降级路径，设计文档 6.1）。
 * 文档允许 scheduler.yield() 或 setTimeout(0) 二选一；真机实测 scheduler.yield()
 * 在 headless Chrome 153 中仅让出续延、不让出宏任务（setTimeout(0)/rAF/输入在
 * 连续任务链中全程得不到处理，主线程表现为持续忙等），因此采用保证宏任务边界的
 * setTimeout(0)，使定时器、rAF、点击与 CDP 评估都能在任务间运行。
 */
function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

export class AnalysisEngine {
  private batchId = 0
  private running = false
  private pool: WorkerPool | null = null
  private queue: TaskSpec[] = []
  private head = 0
  private retry: number[] = []
  private idle = new Set<number>()
  private inflight = 0
  private currentByWorker = new Map<number, number>()
  private fallbackCancelled = false

  get isRunning(): boolean {
    return this.running
  }

  start(): StartInfo {
    if (this.running) throw new Error('analysis already running')
    this.running = true
    this.batchId += 1
    const batchId = this.batchId
    this.head = 0
    this.retry = []
    this.inflight = 0
    this.currentByWorker.clear()
    this.fallbackCancelled = false
    this.queue = [...taskList].sort((a, b) => b.estimatedMs - a.estimatedMs)

    analysisStore.startBatch(batchId, TASK_COUNT)

    const useWorkers = typeof Worker !== 'undefined' && supportsModuleWorkers()
    if (useWorkers) {
      const poolSize = resolvePoolSize()
      this.startPool(batchId, poolSize)
      return { batchId, mode: 'pool', poolSize, totalEstimateMs: this.queueTotalMs() }
    }
    void this.runMainThread(batchId)
    return { batchId, mode: 'main-thread', poolSize: 1, totalEstimateMs: this.queueTotalMs() }
  }

  cancel(): void {
    if (!this.running) return
    const batchId = this.batchId
    this.running = false
    if (this.pool) {
      this.pool.terminateAll()
      this.pool = null
    }
    this.fallbackCancelled = true
    this.idle.clear()
    this.currentByWorker.clear()
    this.inflight = 0
    analysisStore.cancelBatch(batchId)
  }

  /** HMR 清理：终止旧模块创建的全部 Worker，防止泄漏（R2）。 */
  dispose(): void {
    this.pool?.terminateAll()
    this.pool = null
    this.running = false
    this.fallbackCancelled = true
  }

  private queueTotalMs(): number {
    return this.queue.reduce((sum, task) => sum + task.estimatedMs, 0)
  }

  // ---- Worker 池路径 -------------------------------------------------

  private startPool(batchId: number, poolSize: number): void {
    const pool = new WorkerPool(createModuleWorker, poolSize, {
      onMessage: (response, workerIndex) => this.handleResponse(batchId, response, workerIndex),
      onError: (workerIndex) => this.handleWorkerError(batchId, workerIndex),
    })
    this.pool = pool
    pool.start()
    for (let i = 0; i < poolSize; i++) this.idle.add(i)
    this.dispatch(batchId)
  }

  private nextOrdinal(): number | null {
    const retried = this.retry.pop()
    if (retried !== undefined) return retried
    if (this.head >= this.queue.length) return null
    const ordinal = this.head
    this.head += 1
    return ordinal
  }

  private dispatch(batchId: number): void {
    const pool = this.pool
    if (!pool || batchId !== this.batchId) return
    let ordinal = this.nextOrdinal()
    while (ordinal !== null && this.idle.size > 0) {
      const workerIndex = this.idle.values().next().value as number
      this.idle.delete(workerIndex)
      this.currentByWorker.set(workerIndex, ordinal)
      this.inflight += 1
      const task = this.queue[ordinal]
      const request: WorkerRequest = {
        type: 'run',
        batchId,
        ordinal,
        taskId: task.id,
        handlerId: task.handlerId,
        params: task.params,
      }
      pool.send(workerIndex, request)
      ordinal = this.nextOrdinal()
    }
  }

  private handleResponse(
    batchId: number,
    response: WorkerResponse,
    workerIndex: number,
  ): void {
    // 世代校验：取消后旧 Worker 即使有迟到消息也直接丢弃（5.2 / R6）
    if (!this.running || batchId !== this.batchId) return
    this.inflight -= 1
    this.currentByWorker.delete(workerIndex)
    this.idle.add(workerIndex)

    const outcome = {
      taskId: response.taskId,
      ordinal: response.ordinal,
      workerMs: response.type === 'result' ? response.durationMs : 0,
      ...(response.type === 'result'
        ? { status: 'done' as const, value: response.result.value, message: null }
        : { status: 'error' as const, value: null, message: response.message }),
    }
    analysisStore.accept(outcome, batchId)

    this.dispatch(batchId)
    if (this.head >= this.queue.length && this.retry.length === 0 && this.inflight === 0) {
      this.complete(batchId)
    }
  }

  private handleWorkerError(batchId: number, workerIndex: number): void {
    if (!this.running || batchId !== this.batchId) return
    // 仅当该槽位仍有在途任务（onmessage 未先到达）时才重新入队，
    // 避免正常完成后 error 事件重复扣减
    if (this.currentByWorker.has(workerIndex)) {
      const lostOrdinal = this.currentByWorker.get(workerIndex) as number
      this.currentByWorker.delete(workerIndex)
      this.inflight -= 1
      this.idle.delete(workerIndex)
      this.retry.push(lostOrdinal)
      this.pool?.replaceWorker(workerIndex)
      this.idle.add(workerIndex)
      this.dispatch(batchId)
    }
  }

  private complete(batchId: number): void {
    // R1：每批结束销毁全池，下次开始惰性重建，杜绝 Worker 内堆膨胀
    this.pool?.terminateAll()
    this.pool = null
    this.running = false
    analysisStore.endBatch(batchId, 'done')
  }

  // ---- 主线程降级路径（同一注册表、同一 store 协议，6.1） -------------

  private async runMainThread(batchId: number): Promise<void> {
    while (!this.fallbackCancelled) {
      // 让出点之后、领取下一任务之前再检查一次：取消最多浪费当前任务，
      // 不会消费在 setTimeout(0) 窗口里排队的后续任务（任务间取消语义）
      const ordinal = this.nextOrdinal()
      if (ordinal === null) {
        if (this.running && batchId === this.batchId) {
          this.running = false
          analysisStore.endBatch(batchId, 'done')
        }
        return
      }
      const task = this.queue[ordinal]
      try {
        const start = performance.now()
        const result = runRegisteredTask(task.handlerId, task.params)
        analysisStore.accept(
          {
            taskId: task.id,
            ordinal,
            status: 'done',
            workerMs: performance.now() - start,
            value: result.value,
            message: null,
          },
          batchId,
        )
      } catch (err) {
        analysisStore.accept(
          {
            taskId: task.id,
            ordinal,
            status: 'error',
            workerMs: 0,
            value: null,
            message: err instanceof Error ? err.message : String(err),
          },
          batchId,
        )
      }
      if (this.fallbackCancelled) return
      await yieldToEventLoop()
      if (this.fallbackCancelled) return
    }
  }
}

export const analysisEngine = new AnalysisEngine()

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    analysisEngine.dispose()
  })
}
