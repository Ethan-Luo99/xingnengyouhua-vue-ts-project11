/**
 * 手写零依赖外部 store（设计文档 4.1）。
 * - subscribe / getSnapshot，快照引用在无变更时保持稳定，供 useSyncExternalStore 使用。
 * - Worker/降级路径只把结果 push 进缓冲区；rAF（50ms 定时器兜底，先到者）合帧，
 *   每帧最多一次 notify（设计文档 4.3）。
 * - batchId 世代校验：非当前批次的入口一律丢弃（设计文档 5.2）。
 */

export type BatchPhase = 'idle' | 'running' | 'done' | 'cancelled'

export interface TaskOutcome {
  taskId: string
  ordinal: number
  status: 'done' | 'error'
  workerMs: number
  value: number | null
  message: string | null
}

export interface BatchSnapshot {
  batchId: number
  phase: BatchPhase
  total: number
  completed: number
  startedAt: number
  endedAt: number
  results: readonly (TaskOutcome | null)[]
}

type StoreListener = () => void
type LogEntry = ['accept' | 'stale-drop' | 'flush' | 'start' | 'done' | 'cancel', number, number?]

const DEBUG_KEY = 'batch-debug'

function debugEnabled(): boolean {
  try {
    return globalThis.localStorage?.getItem(DEBUG_KEY) === '1'
  } catch {
    return false
  }
}

function log(entry: LogEntry): void {
  if (debugEnabled()) {
    const [kind, batchId, n] = entry
    console.info('[batch-store]', kind, batchId, n ?? '')
  }
  const sink = (globalThis as { __batchLog?: (e: LogEntry) => void }).__batchLog
  sink?.(entry)
}

const IDLE_SNAPSHOT: BatchSnapshot = {
  batchId: 0,
  phase: 'idle',
  total: 0,
  completed: 0,
  startedAt: 0,
  endedAt: 0,
  results: Object.freeze([]),
}

class AnalysisStore {
  private snapshot: BatchSnapshot = IDLE_SNAPSHOT
  private buffer: TaskOutcome[] = []
  private listeners = new Set<StoreListener>()
  private scheduled = false
  private frameHandle: number | undefined
  private timerHandle: ReturnType<typeof setTimeout> | undefined

  subscribe = (listener: StoreListener): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getSnapshot = (): BatchSnapshot => this.snapshot

  startBatch(batchId: number, total: number): void {
    this.cancelFrame()
    this.buffer = []
    this.snapshot = {
      batchId,
      phase: 'running',
      total,
      completed: 0,
      startedAt: performance.now(),
      endedAt: 0,
      results: new Array<TaskOutcome | null>(total).fill(null),
    }
    log(['start', batchId, total])
    this.emit()
  }

  /** 所有结果（含在途迟到消息）的唯一入口；非当前批次立即丢弃。 */
  accept(outcome: TaskOutcome, batchId: number): void {
    if (batchId !== this.snapshot.batchId || this.snapshot.phase !== 'running') {
      log(['stale-drop', batchId, outcome.ordinal])
      return
    }
    this.buffer.push(outcome)
    log(['accept', batchId, outcome.ordinal])
    this.scheduleFlush()
  }

  endBatch(batchId: number, phase: 'done' | 'cancelled'): void {
    if (batchId !== this.snapshot.batchId) {
      log(['stale-drop', batchId])
      return
    }
    this.flushBuffer(phase === 'cancelled')
    this.snapshot = { ...this.snapshot, phase, endedAt: performance.now() }
    log([phase === 'done' ? 'done' : 'cancel', batchId])
    this.emit()
  }

  /** 取消瞬间：缓冲结果全部丢弃，不产生任何 flush（设计文档第 5 节）。 */
  cancelBatch(batchId: number): void {
    this.endBatch(batchId, 'cancelled')
  }

  private scheduleFlush(): void {
    if (this.scheduled) return
    this.scheduled = true
    // rAF 与 50ms 定时器，先到者执行 flush 并取消另一个（4.3）
    const run = () => {
      this.scheduled = false
      this.frameHandle = undefined
      this.timerHandle = undefined
      this.flushBuffer(false)
    }
    if (typeof requestAnimationFrame === 'function') {
      this.frameHandle = requestAnimationFrame(run)
    }
    this.timerHandle = setTimeout(run, 50)
  }

  private flushBuffer(drop: boolean): void {
    this.cancelFrame()
    if (this.buffer.length === 0) return
    const incoming = this.buffer
    this.buffer = []
    if (drop) {
      log(['flush', this.snapshot.batchId, -incoming.length])
      return
    }
    const prev = this.snapshot
    const results = prev.results.slice()
    for (const outcome of incoming) results[outcome.ordinal] = outcome
    this.snapshot = { ...prev, results, completed: prev.completed + incoming.length }
    log(['flush', prev.batchId, incoming.length])
    this.emit()
  }

  private cancelFrame(): void {
    if (this.frameHandle !== undefined && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(this.frameHandle)
    }
    this.frameHandle = undefined
    if (this.timerHandle !== undefined) clearTimeout(this.timerHandle)
    this.timerHandle = undefined
    this.scheduled = false
  }

  private emit(): void {
    for (const listener of this.listeners) listener()
  }
}

export const analysisStore = new AnalysisStore()
