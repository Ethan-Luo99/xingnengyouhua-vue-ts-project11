/**
 * 批次调度核心（设计文档 §1.2 / §2.2 / §5 / §7-R4；本轮三项扩展的实现位置）：
 *
 * 1) 暂停/恢复：派发闸口 store.isDispatchOpen —— paused 时不派发新任务，
 *    在途任务跑完照常 store.receiveResult 入库；恢复后从 queue 断点续跑，
 *    已完成任务不在队列中、天然不重跑。
 * 2) 动态扩缩（每 scaleIntervalMs，默认 2000ms）：依据在途占比（busy/size）
 *    与最近完成任务的实测耗时（actualMs 的滑动均值）调整池大小，clamp [2,16]。
 *    扩容新建 Worker；缩容只回收空闲 Worker，绝不 terminate 在途 Worker。
 * 3) 看门狗（每 watchdogIntervalMs 巡检）：在途任务实际耗时 > 3×预估 且 > 2s
 *    判定僵死 → terminate 该 Worker、任务重试一次；二次僵死 → error 结果落库，
 *    批次整体继续直至完成。
 *
 * Worker 传输层可注入（WorkerFactory）：生产用真实模块 Worker，自测用 FakeWorker。
 */
import type { TaskDescriptor, TaskResult } from '../tasks/registry'
import {
  MAX_POOL_SIZE,
  MIN_POOL_SIZE,
  clamp,
  createPoolManager,
} from '../workers/pool'
import type { PoolManager, WorkerFactory, WorkerTransport } from '../workers/pool'
import * as store from '../store/analysisStore'

export interface BatchTimingOptions {
  /** 动态扩缩巡检间隔（默认 2000ms，需求 2） */
  scaleIntervalMs?: number
  /** 看门狗巡检间隔（默认 250ms） */
  watchdogIntervalMs?: number
  /** 僵死阈值：实际耗时超过预估的倍数（默认 3，需求 3） */
  zombieEstimateFactor?: number
  /** 僵死阈值：绝对下限毫秒（默认 2000，需求 3） */
  zombieMinMs?: number
}

export interface BatchRunOptions extends BatchTimingOptions {
  /** 初始池大小（默认 getInitialPoolSize 的 clamp 逻辑，测试可覆盖） */
  initialPoolSize?: number
}

/** 全部 Worker 故障时的交接回调：携带剩余队列（含在途回退任务），由主线程降级跑完 */
export type AllWorkersFailedHandler = (batchId: number, remaining: TaskDescriptor[]) => void

interface BusySlot {
  task: TaskDescriptor
  startedAt: number
}

/** 最近完成任务实测耗时的滑动窗口（供扩缩决策，需求 2） */
class DurationStats {
  private readonly samples: number[] = []
  private readonly capacity: number
  constructor(capacity = 20) {
    this.capacity = capacity
  }
  observe(durationMs: number): void {
    this.samples.push(durationMs)
    if (this.samples.length > this.capacity) this.samples.shift()
  }
  average(): number | null {
    if (this.samples.length === 0) return null
    return this.samples.reduce((sum, value) => sum + value, 0) / this.samples.length
  }
}

export class BatchRunner {
  private readonly pool: PoolManager
  private readonly batchId: number
  private readonly queue: TaskDescriptor[]
  private readonly busy = new Map<WorkerTransport, BusySlot>()
  private readonly attemptsByKey = new Map<string, number>()
  private readonly durations = new DurationStats()
  private readonly scaleTimer: ReturnType<typeof setInterval>
  private readonly watchdogTimer: ReturnType<typeof setInterval>
  private readonly scaleIntervalMs: number
  private readonly watchdogIntervalMs: number
  private readonly zombieFactor: number
  private readonly zombieMinMs: number
  private finished = false
  private readonly onAllWorkersFailed?: AllWorkersFailedHandler

  constructor(
    batchId: number,
    queue: readonly TaskDescriptor[],
    factory: WorkerFactory,
    options: BatchRunOptions = {},
    onAllWorkersFailed?: AllWorkersFailedHandler,
  ) {
    this.batchId = batchId
    this.onAllWorkersFailed = onAllWorkersFailed
    const initialSize = clamp(
      options.initialPoolSize ?? MIN_POOL_SIZE,
      MIN_POOL_SIZE,
      MAX_POOL_SIZE,
    )
    this.pool = createPoolManager(factory, initialSize)
    // 复制一份队列，避免改动入参；任务只出不进（重试 unshift 回本队列头部）
    this.queue = [...queue]
    this.scaleIntervalMs = options.scaleIntervalMs ?? 2000
    this.watchdogIntervalMs = options.watchdogIntervalMs ?? 250
    this.zombieFactor = options.zombieEstimateFactor ?? 3
    this.zombieMinMs = options.zombieMinMs ?? 2000
    this.scaleTimer = setInterval(() => this.onScaleTick(), this.scaleIntervalMs)
    this.watchdogTimer = setInterval(() => this.onWatchdogTick(), this.watchdogIntervalMs)
  }

  /** 启动：绑定 Worker 事件并派发首批任务 */
  start(): void {
    for (const worker of this.pool.workers) {
      this.bindWorker(worker)
    }
    store.setPoolSize(this.pool.size)
    this.pump()
  }

  /** 暂停后恢复：立即补派发（pump 内部经 store.isDispatchOpen 闸口放行） */
  resume(): void {
    if (!store.isDispatchOpen(this.batchId)) return
    this.pump()
  }

  /** 硬取消（§5.1）：清定时器、terminate 全池；迟到消息由 store 世代校验丢弃 */
  cancel(): void {
    this.teardown()
  }

  /** 批次完成（含全部 error 结果落库）；调用前队列已空且无在途 */
  private finish(): void {
    if (this.finished) return
    this.finished = true
    // 先翻 done 再杀池（§5.1 / R1）：完成消息先于 terminate 生效
    store.completeBatch(this.batchId)
    this.teardown()
  }

  private teardown(): void {
    clearInterval(this.scaleTimer)
    clearInterval(this.watchdogTimer)
    this.busy.clear()
    this.pool.terminateAll()
    store.setPoolSize(0)
  }

  /** 给新扩容出来的 Worker 绑定事件（缩容 retire 时由 PoolManager 解绑） */
  private bindWorker(worker: WorkerTransport): void {
    worker.onResult = (event) => {
      this.handleResult(worker, event.data.result)
    }
    worker.onError = () => {
      this.handleWorkerError(worker)
    }
  }

  /** 派发泵：仅 running 派发；paused 直接停（在途任务跑完照常入库） */
  private pump(): void {
    if (!store.isDispatchOpen(this.batchId)) return
    for (const worker of this.pool.workers) {
      if (this.busy.has(worker)) continue
      const task = this.queue.shift()
      if (!task) break
      this.busy.set(worker, { task, startedAt: performance.now() })
      worker.postMessage({ taskId: task.taskId, params: task.params, batchId: this.batchId })
    }
    // 边界：暂停期间在途已全部跑完（队列空）后恢复时，泵取不到任务，需在此完成批次
    this.checkFinish()
  }

  private handleResult(worker: WorkerTransport, result: TaskResult): void {
    const slot = this.busy.get(worker)
    this.busy.delete(worker)
    if (slot) {
      this.durations.observe(Math.max(result.actualMs, 0.5))
    }
    // 世代入口兜底（§5.2）：running / paused 均入库；非当前批次直接丢弃
    store.receiveResult(this.batchId, result)
    if (!store.isLiveBatch(this.batchId)) {
      // 取消 / done：不再派发；若该 worker 是最后在途且批次已取消，无需额外动作
      return
    }
    if (store.isDispatchOpen(this.batchId)) {
      this.dispatchOne(worker)
      this.checkFinish()
    }
    // paused：在途结果已入库，不派发；恢复时 resume() 统一补派
  }

  /** 给单个空闲 Worker 派一个任务（结果回调路径，比全量 pump 更精准） */
  private dispatchOne(worker: WorkerTransport): void {
    if (!store.isDispatchOpen(this.batchId)) return
    const task = this.queue.shift()
    if (!task) return
    this.busy.set(worker, { task, startedAt: performance.now() })
    worker.postMessage({ taskId: task.taskId, params: task.params, batchId: this.batchId })
  }

  private handleWorkerError(worker: WorkerTransport): void {
    if (!store.isLiveBatch(this.batchId)) return
    // 容错：在途任务回到队首，剔除故障 Worker（沿用首轮实现语义）
    const slot = this.busy.get(worker)
    if (slot) {
      this.queue.unshift(slot.task)
      this.busy.delete(worker)
    }
    this.pool.retire(worker)
    store.setPoolSize(this.pool.size)
    console.log(
      `[batchScheduler] worker error, retired; pool=${this.pool.size} requeued=${slot?.task.taskId ?? 'none'}`,
    )
    if (this.pool.size === 0) {
      // 全部 Worker 故障：调度器退场，主线程降级跑完余量（§6.1，沿用首轮语义）
      clearInterval(this.scaleTimer)
      clearInterval(this.watchdogTimer)
      this.finished = true // 调度器不再推进批次（交给主线程路径，完成/取消仍由 store 判定）
      store.setPoolSize(0)
      const remaining = [...this.queue]
      this.queue.length = 0
      this.busy.clear()
      console.log(
        `[batchScheduler] all workers failed; handing over ${remaining.length} tasks to main-thread path`,
      )
      this.onAllWorkersFailed?.(this.batchId, remaining)
    }
  }

  private checkFinish(): void {
    if (this.queue.length === 0 && this.busy.size === 0) {
      this.finish()
    }
  }

  // ── 需求 2：动态扩缩（每 2s） ──────────────────────────────────────────

  private onScaleTick(): void {
    if (!store.isDispatchOpen(this.batchId)) return
    if (this.finished) return
    const size = this.pool.size
    const busyCount = this.busy.size
    const busyRatio = busyCount / size
    const queueLen = this.queue.length
    if (queueLen === 0 && busyCount === 0) {
      this.finish()
      return
    }
    // 队列已空（只剩在途收尾）：不再扩容；空闲 Worker 可缩
    const avgMs = this.durations.average()

    let target = size
    // 扩容：有积压 + 在途占比高（全部 Worker 都在忙且任务已排队）
    if (queueLen > 0 && busyRatio >= 0.875 && size < MAX_POOL_SIZE) {
      // 实测耗时越长、单条消息摊薄收益越大，可一步多扩；短任务小步扩
      const step = avgMs !== null && avgMs > 150 ? (size <= 8 ? 2 : 1) : 1
      target = Math.min(MAX_POOL_SIZE, size + step)
    } else if (busyRatio <= 0.5 && size > MIN_POOL_SIZE) {
      // 缩容：在途占比低 → 回收空闲 Worker（一次缩一个，滞后由 tick 间隔天然提供）
      target = size - 1
    }

    if (target === size) return
    if (target > size) {
      const added = this.pool.grow(target - size)
      for (const worker of added) this.bindWorker(worker)
      store.setPoolSize(this.pool.size)
      console.log(
        `[autoScale] grow ${size}→${this.pool.size} busy=${busyCount}/${size} queue=${queueLen} avgMs=${avgMs?.toFixed(1) ?? 'n/a'}`,
      )
      this.pump()
    } else {
      this.shrinkTo(target)
    }
  }

  /** 缩容：只 terminate 空闲 Worker；在途 Worker 一律不碰（硬性要求） */
  private shrinkTo(target: number): void {
    let size = this.pool.size
    for (const worker of [...this.pool.workers]) {
      if (size <= target) break
      if (this.busy.has(worker)) continue // 绝不在途回收
      this.pool.retire(worker)
      size = this.pool.size
    }
    store.setPoolSize(this.pool.size)
    const busyCount = this.busy.size
    console.log(
      `[autoScale] shrink target=${target} actual=${this.pool.size} busy=${busyCount} idleKept=${this.pool.size - busyCount} (in-flight workers are never terminated)`,
    )
  }

  // ── 需求 3：任务超时看门狗 ─────────────────────────────────────────────

  private onWatchdogTick(): void {
    // paused 也巡检：在途任务照样在 Worker 里跑，僵死不能因暂停被放任
    if (!store.isLiveBatch(this.batchId) || this.finished) return
    const now = performance.now()
    const zombies: Array<{ worker: WorkerTransport; slot: BusySlot }> = []
    for (const [worker, slot] of this.busy) {
      const elapsed = now - slot.startedAt
      const deadline = Math.max(slot.task.params.targetMs * this.zombieFactor, this.zombieMinMs)
      if (elapsed > deadline) {
        zombies.push({ worker, slot })
      }
    }
    for (const { worker, slot } of zombies) {
      this.killZombie(worker, slot)
    }
  }

  /** 僵死处理：terminate 该 Worker；一次重试，二次僵死 error 落库 */
  private killZombie(worker: WorkerTransport, slot: BusySlot): void {
    const key = slot.task.taskId
    const priorAttempts = this.attemptsByKey.get(key) ?? 0
    // 先从在途摘除并 terminate（onmessage 引用解除，迟到结果无法回流）
    this.busy.delete(worker)
    this.pool.retire(worker)

    if (priorAttempts >= 1) {
      // 二次僵死：标记失败，结果列表可见；批次继续
      this.attemptsByKey.set(key, priorAttempts + 1)
      const errorResult: TaskResult = {
        taskId: key,
        checksum: 0,
        actualMs: Math.max(
          slot.task.params.targetMs * this.zombieFactor,
          this.zombieMinMs,
        ),
        error: true,
        errorMessage: `watchdog: task zombie after 1 retry (estimate=${slot.task.params.targetMs}ms)`,
      }
      console.log(`[watchdog] ${key} zombie again → marked error; batch continues`)
      store.receiveResult(this.batchId, errorResult)
    } else {
      // 一次僵死：重试一次，任务回到队首优先再跑
      this.attemptsByKey.set(key, 1)
      this.queue.unshift(slot.task)
      console.log(`[watchdog] ${key} zombie → terminated worker, retrying once (queue head)`)
    }

    // 补一个新 Worker 维持池容量（不构成“派发新任务”：pause 下只占位）
    const replacement = this.pool.grow(1)[0]
    if (replacement) {
      this.bindWorker(replacement)
    }
    store.setPoolSize(this.pool.size)

    if (store.isDispatchOpen(this.batchId)) {
      this.pump()
      this.checkFinish()
    }
  }
}
