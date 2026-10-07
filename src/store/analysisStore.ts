/**
 * 手写零依赖 store（设计文档 §4.1 / §4.3 / §5.2；本轮扩展暂停态）：
 * - subscribe / getSnapshot 协议，快照不可变、引用稳定（未变化时返回同一引用）
 * - Worker 结果先入缓冲区，rAF 与 50ms 定时器取先到者合帧，单次 notify（§4.3）
 * - batchId 世代校验：非当前批次的消息在入口直接丢弃（§5.2）
 * - 暂停（paused）：停止派发新任务；在途任务结果照常入库；恢复断点续跑
 * - 取消瞬间清空在途缓冲与已上屏结果（§5.1）
 */
import type { TaskResult } from '../tasks/registry'

export type Backend = 'worker-pool' | 'main-thread'
export type Status = 'idle' | 'running' | 'paused' | 'cancelled' | 'done'

export interface AnalysisSnapshot {
  batchId: number
  status: Status
  backend: Backend | null
  total: number
  /** 已落库结果数（含 error 结果；每个任务恰好一条） */
  completed: number
  /** 看门狗二次僵死后标记失败的结果数 */
  errorCount: number
  results: readonly TaskResult[]
  /** 当前池大小（worker-pool 路径）；main-thread / idle 时为 0 */
  poolSize: number
  startedAt: number | null
  pausedAt: number | null
  finishedAt: number | null
}

type Listener = () => void

const initialSnapshot: AnalysisSnapshot = {
  batchId: 0,
  status: 'idle',
  backend: null,
  total: 0,
  completed: 0,
  errorCount: 0,
  results: [],
  poolSize: 0,
  startedAt: null,
  pausedAt: null,
  finishedAt: null,
}

let snapshot: AnalysisSnapshot = initialSnapshot
const listeners = new Set<Listener>()

let buffer: TaskResult[] = []
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

/** 批次存活（running 或 paused）：在途结果仍可入库 */
export function isLiveBatch(batchId: number): boolean {
  return (
    snapshot.batchId === batchId &&
    (snapshot.status === 'running' || snapshot.status === 'paused')
  )
}

/** 派发闸口：仅 running 才允许派发新任务（paused 时停止派发） */
export function isDispatchOpen(batchId: number): boolean {
  return snapshot.batchId === batchId && snapshot.status === 'running'
}

/** 兼容旧调用方：运行中（含暂停态）判定 */
export function isCurrentBatch(batchId: number): boolean {
  return isLiveBatch(batchId)
}

function notify(): void {
  for (const listener of listeners) listener()
}

/** 发起新批次：世代号自增，重置全部状态。返回新 batchId。 */
export function beginBatch(backend: Backend, total: number, poolSize: number): number {
  cancelScheduledFlush()
  buffer = []
  snapshot = {
    batchId: snapshot.batchId + 1,
    status: 'running',
    backend,
    total,
    completed: 0,
    errorCount: 0,
    results: [],
    poolSize,
    startedAt: performance.now(),
    pausedAt: null,
    finishedAt: null,
  }
  notify()
  return snapshot.batchId
}

/** 更新当前池大小（动态扩缩后调用；UI 实时显示） */
export function setPoolSize(poolSize: number): void {
  if (snapshot.poolSize === poolSize) return
  snapshot = { ...snapshot, poolSize }
  notify()
}

/** 暂停：仅 running → paused；在途结果继续入库（receiveResult 放行 paused） */
export function pauseBatch(): void {
  if (snapshot.status !== 'running') return
  snapshot = { ...snapshot, status: 'paused', pausedAt: performance.now() }
  notify()
}

/** 恢复：仅 paused → running，未完成任务继续派发，已完成结果不重跑 */
export function resumeBatch(): void {
  if (snapshot.status !== 'paused') return
  snapshot = { ...snapshot, status: 'running', pausedAt: null }
  notify()
}

/**
 * 结果入口（Worker onmessage 与主线程降级路径共用）。
 * running 与 paused 均放行：暂停只停派发，在途任务跑完照常入库。
 * 世代校验：迟到/跨批次消息直接丢弃并打日志（验收自测断言点，§5.2）。
 */
export function receiveResult(batchId: number, result: TaskResult): void {
  if (!isLiveBatch(batchId)) {
    console.log(
      `[analysisStore] dropped late result: task=${result.taskId} msgBatch=${batchId} currentBatch=${snapshot.batchId} status=${snapshot.status}`,
    )
    return
  }
  buffer.push(result)
  scheduleFlush()
}

/** 批次完成（running / paused 均可，仅当前批次生效） */
export function completeBatch(batchId: number): void {
  if (!isLiveBatch(batchId)) return
  flushNow()
  snapshot = { ...snapshot, status: 'done', finishedAt: performance.now() }
  notify()
}

/** 硬取消（running / paused 均可）：清空缓冲与结果，取消未决 flush */
export function cancelBatch(): void {
  if (snapshot.status !== 'running' && snapshot.status !== 'paused') return
  cancelScheduledFlush()
  buffer = []
  snapshot = {
    ...snapshot,
    status: 'cancelled',
    completed: 0,
    results: [],
    poolSize: 0,
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
  const errorCount = merged.reduce((n, r) => n + (r.error ? 1 : 0), 0)
  buffer = []
  snapshot = { ...snapshot, results: merged, completed: merged.length, errorCount }
  notify()
}
