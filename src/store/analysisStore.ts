/**
 * 手写零依赖 store（设计文档 §4.1 / §4.3 / §5.2）：
 * - subscribe / getSnapshot 协议，快照不可变、引用稳定（未变化时返回同一引用）
 * - Worker 结果先入缓冲区，rAF 与 50ms 定时器取先到者合帧，单次 notify（§4.3）
 * - batchId 世代校验：非当前批次的消息在入口直接丢弃（§5.2）
 * - 取消瞬间清空在途缓冲与已上屏结果（§5.1）
 * - 暂停（paused）：在途结果照常缓冲上屏，恢复从断点续跑；结果按 taskId 幂等去重
 */
import type { TaskOutcome } from '../tasks/registry'

export type Backend = 'worker-pool' | 'main-thread'
export type Status = 'idle' | 'running' | 'paused' | 'cancelled' | 'done'

export interface AnalysisSnapshot {
  batchId: number
  status: Status
  backend: Backend | null
  total: number
  completed: number
  failed: number
  /** 动态扩缩容：调度器上报的当前池大小（主线程降级路径恒为 1） */
  poolSize: number
  results: readonly TaskOutcome[]
  startedAt: number | null
  finishedAt: number | null
}

type Listener = () => void

const initialSnapshot: AnalysisSnapshot = {
  batchId: 0,
  status: 'idle',
  backend: null,
  total: 0,
  completed: 0,
  failed: 0,
  poolSize: 0,
  results: [],
  startedAt: null,
  finishedAt: null,
}

let snapshot: AnalysisSnapshot = initialSnapshot
const listeners = new Set<Listener>()

let buffer: TaskOutcome[] = []
let receivedTaskIds: Set<string> = new Set()
let flushScheduled = false
let rafId: number | null = null
let timerId: ReturnType<typeof setTimeout> | null = null

const raf: (cb: (time: number) => void) => number =
  typeof globalThis.requestAnimationFrame === 'function'
    ? globalThis.requestAnimationFrame.bind(globalThis)
    : (cb) => setTimeout(() => cb(performance.now()), 16) as unknown as number

const cancelRaf: (id: number) => void =
  typeof globalThis.cancelAnimationFrame === 'function'
    ? globalThis.cancelAnimationFrame.bind(globalThis)
    : (id) => clearTimeout(id)

export function subscribe(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function getSnapshot(): AnalysisSnapshot {
  return snapshot
}

/** 世代匹配且批次仍存活（running 或 paused；paused 下在途结果照常入库） */
export function isBatchAlive(batchId: number): boolean {
  return (
    snapshot.batchId === batchId &&
    (snapshot.status === 'running' || snapshot.status === 'paused')
  )
}

function notify(): void {
  for (const listener of listeners) listener()
}

/** 发起新批次：世代号自增，重置全部状态。返回新 batchId。 */
export function beginBatch(backend: Backend, total: number, poolSize = 0): number {
  cancelScheduledFlush()
  buffer = []
  receivedTaskIds = new Set()
  snapshot = {
    batchId: snapshot.batchId + 1,
    status: 'running',
    backend,
    total,
    completed: 0,
    failed: 0,
    poolSize,
    results: [],
    startedAt: performance.now(),
    finishedAt: null,
  }
  notify()
  return snapshot.batchId
}

/**
 * 结果入口（Worker onmessage 与主线程降级路径共用）。
 * 世代校验：迟到/跨批次消息直接丢弃并打日志（验收自测断言点）。
 * taskId 幂等：同批次同一任务只入库一次（断点续跑/重试/迟到消息双保险）。
 */
export function receiveResult(batchId: number, outcome: TaskOutcome): boolean {
  if (batchId !== snapshot.batchId || (snapshot.status !== 'running' && snapshot.status !== 'paused')) {
    console.log(
      `[analysisStore] dropped late result: task=${outcome.taskId} msgBatch=${batchId} currentBatch=${snapshot.batchId} status=${snapshot.status}`,
    )
    return false
  }
  if (receivedTaskIds.has(outcome.taskId)) {
    console.log(
      `[analysisStore] dropped duplicate result: task=${outcome.taskId} batch=${batchId}`,
    )
    return false
  }
  receivedTaskIds.add(outcome.taskId)
  buffer.push(outcome)
  scheduleFlush()
  return true
}

/** 批次完成（仅当前批次生效） */
export function completeBatch(batchId: number): void {
  if (!isBatchAlive(batchId)) return
  flushNow()
  snapshot = { ...snapshot, status: 'done', finishedAt: performance.now() }
  notify()
}

/** 暂停：停止派发新任务；在途结果继续入库。重复暂停幂等。 */
export function pauseBatch(batchId: number): void {
  if (snapshot.batchId !== batchId || snapshot.status !== 'running') return
  flushNow()
  snapshot = { ...snapshot, status: 'paused' }
  notify()
}

/** 恢复：从断点继续（派发侧按队列与已完成集合续跑，不重跑）。重复恢复幂等。 */
export function resumeBatch(batchId: number): void {
  if (snapshot.batchId !== batchId || snapshot.status !== 'paused') return
  snapshot = { ...snapshot, status: 'running' }
  notify()
}

/** 调度器上报当前池大小（动态扩缩容 UI 展示） */
export function setPoolSize(batchId: number, poolSize: number): void {
  if (snapshot.batchId !== batchId || !isBatchAlive(batchId)) return
  if (snapshot.poolSize === poolSize) return
  snapshot = { ...snapshot, poolSize }
  notify()
}

/** 硬取消：世代号随下次 beginBatch 自增；此处清空缓冲与结果，取消未决 flush */
export function cancelBatch(): void {
  if (snapshot.status !== 'running' && snapshot.status !== 'paused') return
  cancelScheduledFlush()
  buffer = []
  receivedTaskIds = new Set()
  snapshot = {
    ...snapshot,
    status: 'cancelled',
    completed: 0,
    failed: 0,
    poolSize: 0,
    results: [],
    finishedAt: performance.now(),
  }
  notify()
}

function scheduleFlush(): void {
  if (flushScheduled) return
  flushScheduled = true
  // §4.3：rAF 或 50ms 定时器，取先到者
  rafId = raf(flushNow)
  timerId = setTimeout(flushNow, 50)
}

function cancelScheduledFlush(): void {
  if (rafId !== null) cancelRaf(rafId)
  if (timerId !== null) clearTimeout(timerId)
  rafId = null
  timerId = null
  flushScheduled = false
}

function flushNow(): void {
  if (!flushScheduled) return
  cancelScheduledFlush()
  if (buffer.length === 0) return
  const merged = snapshot.results.concat(buffer)
  buffer = []
  let failed = 0
  for (const item of merged) {
    if ('status' in item && item.status === 'error') failed += 1
  }
  snapshot = { ...snapshot, results: merged, completed: merged.length, failed }
  notify()
}
