/**
 * Worker 池批次执行器（本轮在设计文档既有架构上平滑扩展）：
 * - 暂停/恢复：暂停只停止派发，在途任务跑完照常入库；恢复从断点续跑
 *   （已完成 taskId 幂等去重，绝不重跑）
 * - 动态扩缩容：每 2s 依据在途占比 + 最近完成实测耗时调池（autoScale.ts），
 *   clamp [2,16]；扩容新建 Worker，缩容只回收空闲 Worker
 * - 看门狗：实际耗时 > max(2000ms, 3×预估) 视为僵死，terminate 该 Worker 并
 *   原地重试一次；二次僵死合成 error 结果，批次继续直至完成
 */
import type { TaskDescriptor, TaskFailure, TaskOutcome } from '../tasks/registry'
import { getInitialPoolSize, WorkerPool } from '../workers/pool'
import type { ResultMessage, TaskMessage } from '../workers/analysis.worker'
import * as store from '../store/analysisStore'
import { decidePoolSize, SCALE_TICK_MS } from './autoScale'

const WATCHDOG_TICK_MS = 100
const WATCHDOG_MIN_MS = 2000
const WATCHDOG_ESTIMATE_FACTOR = 3
const MAX_ATTEMPTS = 2

interface Inflight {
  task: TaskDescriptor
  /** 第几次尝试（1 起） */
  attempts: number
  dispatchedAt: number
}

export interface RunnerEvents {
  onLog?: (msg: string) => void
}

export interface BatchRunnerOptions {
  events?: RunnerEvents
  initialSize?: number
  /** 自动扩缩容开关（生产默认开；自测缩容/看门狗场景关闭以保证确定性） */
  autoScale?: boolean
}

export class BatchRunner {
  private readonly pool: WorkerPool
  private readonly queue: TaskDescriptor[]
  private readonly inflight = new Map<Worker, Inflight>()
  /** 已完成/已失败 taskId（断点续跑不重跑的记账，store 入口另有幂等双保险） */
  private readonly finished = new Set<string>()
  private readonly attemptsByTask = new Map<string, number>()
  private recentSamples: { actualMs: number }[] = []
  /** 自测/调试：每次派发的 { taskId, at(performance.now()) }，仅保留最近 2000 条 */
  private dispatchLog: { taskId: string; at: number }[] = []
  private scaleTimer: ReturnType<typeof setInterval> | null = null
  private watchdogTimer: ReturnType<typeof setInterval> | null = null
  private settled = false

  private readonly batchId: number
  private readonly events: RunnerEvents
  private readonly autoScaleEnabled: boolean

  constructor(
    batchId: number,
    queue: readonly TaskDescriptor[],
    options: BatchRunnerOptions = {},
  ) {
    this.batchId = batchId
    this.events = options.events ?? {}
    this.autoScaleEnabled = options.autoScale ?? true
    // 复制队列，避免排序/取队污染调用方
    this.queue = [...queue]
    const initialSize = options.initialSize ?? getInitialPoolSize()
    this.pool = new WorkerPool(initialSize, (worker) => this.attach(worker))
    // 池引用就绪后再给初始 Worker 绑事件并派发
    this.pool.prime()
    store.setPoolSize(batchId, this.pool.size)
  }

  start(): void {
    this.log(`start batch=${this.batchId} pool=${this.pool.size} tasks=${this.queue.length}`)
    // 初始池已在构造函数建好并 attach -> dispatch；这里只启动周期任务
    if (this.autoScaleEnabled) {
      this.scaleTimer = setInterval(() => this.scaleTick(), SCALE_TICK_MS)
    }
    this.watchdogTimer = setInterval(() => this.watchdogTick(), WATCHDOG_TICK_MS)
  }

  get poolSize(): number {
    return this.pool.size
  }

  get inFlightCount(): number {
    return this.pool.inFlightCount
  }

  get queuedCount(): number {
    return this.queue.length
  }

  /** 自给定时间戳（performance.now()）以来的派发记录，供自测断言暂停期不派发 */
  dispatchesSince(t0: number): { taskId: string; at: number }[] {
    return this.dispatchLog.filter((entry) => entry.at >= t0)
  }

  /** 每个 taskId 的累计派发次数（断点续跑/缩容不得导致重复派发） */
  dispatchCounts(): Record<string, number> {
    const counts: Record<string, number> = {}
    for (const entry of this.dispatchLog) {
      counts[entry.taskId] = (counts[entry.taskId] ?? 0) + 1
    }
    return counts
  }

  /** 当前在途任务 id（自测：缩容瞬间记录，验证其照常完成且只派发一次） */
  inflightTaskIds(): string[] {
    return [...this.inflight.values()].map((info) => info.task.taskId)
  }

  /** 任务累计尝试次数（看门狗：僵死任务应恰为 2 次） */
  attemptCount(taskId: string): number {
    return this.attemptsByTask.get(taskId) ?? 0
  }

  stats(): {
    poolSize: number
    inFlight: number
    queued: number
    finished: number
  } {
    return {
      poolSize: this.pool.size,
      inFlight: this.inflight.size,
      queued: this.queue.length,
      finished: this.finished.size,
    }
  }

  private log(msg: string): void {
    const line = `[runner] ${msg}`
    console.log(line)
    this.events.onLog?.(line)
  }

  /** 暂停：仅翻状态；在途不干预，跑完后 handler 见 paused 不再派发 */
  pause(): void {
    if (!this.alive() || store.getSnapshot().status !== 'running') return
    store.pauseBatch(this.batchId)
    this.log(`paused: inFlight=${this.inflight.size} queued=${this.queue.length}`)
  }

  /** 恢复：给暂停期间跑空的空闲 Worker 补派任务，从断点续跑 */
  resume(): void {
    if (!this.alive() || store.getSnapshot().status !== 'paused') return
    store.resumeBatch(this.batchId)
    let dispatched = 0
    for (const worker of this.pool.workers()) {
      if (!this.pool.isBusy(worker)) {
        this.dispatch(worker)
        dispatched += 1
      }
    }
    this.log(`resumed: refilled ${dispatched} idle workers, queued=${this.queue.length}`)
  }

  /** 硬取消（§5.1）：停计时器 + terminate 全池（在途也立即终止） */
  cancel(): void {
    if (this.settled || !store.isBatchAlive(this.batchId)) return
    this.log(`cancel: terminating ${this.pool.size} workers`)
    this.stopTimers()
    this.pool.terminateAll()
    this.settled = true
  }

  private alive(): boolean {
    return store.isBatchAlive(this.batchId)
  }

  private stopTimers(): void {
    if (this.scaleTimer !== null) clearInterval(this.scaleTimer)
    if (this.watchdogTimer !== null) clearInterval(this.watchdogTimer)
    this.scaleTimer = null
    this.watchdogTimer = null
  }

  /** 新建 Worker（初始/扩容）绑定事件并尝试派发 */
  private attach(worker: Worker): void {
    worker.onmessage = (e: MessageEvent<ResultMessage>) => this.onResult(worker, e.data)
    worker.onerror = () => this.onWorkerError(worker)
    this.dispatch(worker)
  }

  /**
   * 派发下一条任务给空闲 worker。
   * 暂停态 / 批次非存活 / 无任务 / worker 在途 => 不派发。
   */
  private dispatch(worker: Worker): void {
    if (this.settled || !this.alive()) return
    if (store.getSnapshot().status === 'paused') return
    if (this.pool.isBusy(worker)) return
    // 缩容超编：空闲 Worker 优先回收（绝不影响在途），而不是领取新任务
    if (this.pool.drainIdle(worker)) {
      this.reportPoolSize()
      this.log(`shrink reclaimed idle worker, pool=${this.pool.size}`)
      return
    }
    const task = this.nextTask()
    if (!task) {
      this.handleIdle(worker)
      return
    }
    this.pool.markBusy(worker)
    const attempts = (this.attemptsByTask.get(task.taskId) ?? 0) + 1
    this.attemptsByTask.set(task.taskId, attempts)
    this.inflight.set(worker, { task, attempts, dispatchedAt: performance.now() })
    this.dispatchLog.push({ taskId: task.taskId, at: performance.now() })
    if (this.dispatchLog.length > 2000) this.dispatchLog.shift()
    const msg: TaskMessage = { taskId: task.taskId, params: task.params, batchId: this.batchId }
    worker.postMessage(msg)
  }

  /** 取队头；跳过本批次已有终态的任务（断点续跑幂等） */
  private nextTask(): TaskDescriptor | null {
    while (this.queue.length > 0) {
      const task = this.queue.shift()!
      if (this.finished.has(task.taskId)) continue
      return task
    }
    return null
  }

  /** worker 空闲且无任务可派：若处于缩容超编状态则回收，否则检查批次收尾 */
  private handleIdle(worker: Worker): void {
    if (this.pool.drainIdle(worker)) {
      this.reportPoolSize()
      this.log(`shrink reclaimed idle worker, pool=${this.pool.size}`)
      return
    }
    this.maybeFinish()
  }

  private onResult(worker: Worker, msg: ResultMessage): void {
    const info = this.inflight.get(worker)
    this.inflight.delete(worker)
    this.pool.markIdle(worker)
    if (!this.alive()) {
      // 取消/跨世代：不再派发（terminate 由 cancel 统一处理）
      return
    }
    if (info) {
      const actualMs = msg.result.actualMs
      this.recentSamples.push({ actualMs })
      if (!this.finished.has(info.task.taskId)) {
        this.finished.add(info.task.taskId)
        // store 入口做世代 + taskId 双重幂等校验
        store.receiveResult(msg.batchId, msg.result)
      }
    }
    this.dispatch(worker)
  }

  private onWorkerError(worker: Worker): void {
    const info = this.inflight.get(worker)
    this.inflight.delete(worker)
    this.pool.evict(worker)
    this.reportPoolSize()
    if (info && !this.finished.has(info.task.taskId)) {
      // 故障 Worker 的在途任务放回队头，交由其它 Worker 重试
      this.queue.unshift(info.task)
      this.log(`worker error: requeue ${info.task.taskId}, pool=${this.pool.size}`)
    }
    if (this.pool.size === 0) {
      // 全池故障：沿用既有降级结论，主线程跑完余量（controller 接线）
      this.log('pool exhausted; caller falls back to main-thread runner')
      this.failOverToMainThread()
      return
    }
    // 补一个新 Worker 维持目标容量（replaceWorker 内部已 attach + 派发）
    this.pool.replaceWorker()
  }

  /** 全池故障降级钩子，由 controller 注入（避免本文件直接依赖降级 runner 的循环引用） */
  failOverToMainThread: () => void = () => {}

  /** 全池故障：交出剩余队列（排除已完成），并停止 Worker 侧计时器 */
  takeRemainingQueue(): TaskDescriptor[] {
    this.stopTimers()
    this.settled = true
    return this.queue.filter((task) => !this.finished.has(task.taskId))
  }

  /** 每 2s 动态扩缩容 */
  private scaleTick(): void {
    if (this.settled || !this.alive()) return
    if (store.getSnapshot().status === 'paused') return
    const decision = decidePoolSize({
      currentSize: this.pool.size,
      queued: this.queue.length,
      inFlight: this.pool.inFlightCount,
      samples: this.recentSamples,
    })
    this.recentSamples = []
    if (decision.target === this.pool.size) return
    const before = this.pool.size
    const result = this.pool.resize(decision.target)
    this.reportPoolSize()
    // resize 新增的 Worker 已在 grow() 内 attach；缩容只回收了空闲 Worker
    this.log(
      `scale ${before}->${this.pool.size} (+${result.added} -${result.removed}${
        result.blocked ? ` blocked=${result.blocked}` : ''
      }): ${decision.reason}`,
    )
  }

  /** 自测专用：强制设定目标池大小（验证缩容不杀在途） */
  forceResize(target: number): void {
    const result = this.pool.resize(target)
    this.reportPoolSize()
    this.log(
      `forceResize ->${this.pool.size} (+${result.added} -${result.removed} blocked=${result.blocked})`,
    )
  }

  private reportPoolSize(): void {
    store.setPoolSize(this.batchId, this.pool.size)
  }

  /** 看门狗：扫描全部在途，超时即强杀 + 重试/失败 */
  private watchdogTick(): void {
    if (this.settled || !this.alive()) return
    if (store.getSnapshot().status === 'paused') return
    const now = performance.now()
    for (const [worker, info] of [...this.inflight]) {
      const estimate = info.task.params.targetMs
      const threshold = Math.max(WATCHDOG_MIN_MS, WATCHDOG_ESTIMATE_FACTOR * estimate)
      const elapsed = now - info.dispatchedAt
      if (elapsed <= threshold) continue
      this.handleZombie(worker, info, elapsed, threshold)
    }
  }

  private handleZombie(
    worker: Worker,
    info: Inflight,
    elapsed: number,
    threshold: number,
  ): void {
    const { task, attempts } = info
    this.log(
      `zombie detected task=${task.taskId} attempt=${attempts} elapsed=${elapsed.toFixed(0)}ms threshold=${threshold}ms`,
    )
    // 唯一允许 terminate 在途 Worker 的路径
    this.pool.killZombie(worker)
    this.inflight.delete(worker)

    if (attempts < MAX_ATTEMPTS) {
      // 原地重试一次：任务放回队头优先派发
      this.queue.unshift(task)
      this.log(`zombie retry task=${task.taskId} (attempt ${attempts + 1})`)
      // replaceWorker 内部已 attach + 派发（队头优先，新 Worker 立即领到重试任务）
      this.pool.replaceWorker()
    } else {
      // 二次僵死：标记失败，结果列表可见，批次继续
      const failure: TaskOutcome = {
        taskId: task.taskId,
        status: 'error',
        error: `watchdog: zombie after ${MAX_ATTEMPTS} attempts (elapsed ${elapsed.toFixed(0)}ms)`,
        attempts,
        elapsedMs: elapsed,
      } satisfies TaskFailure
      this.finished.add(task.taskId)
      store.receiveResult(this.batchId, failure)
      this.log(`zombie failed task=${task.taskId} after ${attempts} attempts; batch continues`)
      this.pool.replaceWorker()
      // 若未补到 Worker（已达上限），交给空闲 Worker 收尾检查
      this.maybeFinish()
    }
    this.reportPoolSize()
  }

  private maybeFinish(): void {
    if (this.settled || !this.alive()) return
    if (this.queue.length > 0 || this.inflight.size > 0) return
    this.settled = true
    this.stopTimers()
    this.log(`complete: finished=${this.finished.size} pool=${this.pool.size}`)
    store.completeBatch(this.batchId)
    // R1：批次结束 terminate 全池，下批重建
    this.pool.terminateAll()
  }
}
