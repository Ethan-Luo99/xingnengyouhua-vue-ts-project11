/**
 * 动态扩缩容策略（本轮新增）。每 2s 由 BatchRunner 调用一次：
 * 依据 在途任务占比（排队压力）与最近完成任务的实测耗时（任务粒度）
 * 决定目标池大小，结果 clamp 到 [2, 16]。
 *
 * 纯函数，便于自测断言；不引入任何依赖。
 */
import { clamp, MAX_POOL_SIZE, MIN_POOL_SIZE } from '../workers/pool'

/** 最近完成任务样本：实测耗时 ms（队列降序派发，越到后面任务越短） */
export interface ScaleSample {
  actualMs: number
}

export interface ScaleInput {
  currentSize: number
  /** 尚未派发的队列长度 */
  queued: number
  /** 在途任务数 */
  inFlight: number
  /** 自上次 tick 以来完成的任务样本 */
  samples: readonly ScaleSample[]
}

export interface ScaleDecision {
  target: number
  reason: string
}

/**
 * 决策规则（带回差，避免抖动）：
 * - 在途占比 >= 0.8 且队列仍有积压 => +2（强排队压力，快速扩容）
 * - 占比 >= 0.6 且队列非空       => +1
 * - 占比 <= 0.35 且最近完成任务平均耗时 < 300ms（小任务，低占用）
 *   且无积压                    => -2
 * - 占比 <= 0.5 且队列已空       => -1
 * - 其他保持
 * 连续 tick 的小幅变化由调用方直接应用；单次步长封顶 2。
 */
export function decidePoolSize(input: ScaleInput): ScaleDecision {
  const { currentSize, queued, inFlight, samples } = input
  const denom = Math.max(1, currentSize)
  const occupancy = inFlight / denom
  const hasBacklog = queued > 0

  if (occupancy >= 0.8 && hasBacklog) {
    return {
      target: clamp(currentSize + 2, MIN_POOL_SIZE, MAX_POOL_SIZE),
      reason: `high occupancy ${occupancy.toFixed(2)} with backlog ${queued}`,
    }
  }
  if (occupancy >= 0.6 && hasBacklog) {
    return {
      target: clamp(currentSize + 1, MIN_POOL_SIZE, MAX_POOL_SIZE),
      reason: `occupancy ${occupancy.toFixed(2)} with backlog ${queued}`,
    }
  }
  const avgMs =
    samples.length > 0
      ? samples.reduce((sum, s) => sum + s.actualMs, 0) / samples.length
      : null
  if (!hasBacklog && occupancy <= 0.35 && avgMs !== null && avgMs < 300) {
    return {
      target: clamp(currentSize - 2, MIN_POOL_SIZE, MAX_POOL_SIZE),
      reason: `low occupancy ${occupancy.toFixed(2)}, avg ${avgMs.toFixed(0)}ms, no backlog`,
    }
  }
  if (!hasBacklog && occupancy <= 0.5) {
    return {
      target: clamp(currentSize - 1, MIN_POOL_SIZE, MAX_POOL_SIZE),
      reason: `occupancy ${occupancy.toFixed(2)} and queue drained`,
    }
  }
  return { target: currentSize, reason: `steady (occ ${occupancy.toFixed(2)}, q ${queued})` }
}

export const SCALE_TICK_MS = 2000
