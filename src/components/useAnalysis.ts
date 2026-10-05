/**
 * 订阅分析 store 的 hook（4.1 / 4.2）：
 * - useSyncExternalStore 直接拿原始快照（结果列表本体，流式不延迟）
 * - useDeferredValue 只包派生视图输入
 * - useTransition 只包"开始/取消"这类批次生命周期动作
 */
import {
  useCallback,
  useDeferredValue,
  useState,
  useSyncExternalStore,
  useTransition,
} from 'react'
import { analysisStore, type BatchSnapshot, type TaskOutcome } from '../store/analysisStore'
import { analysisEngine, type StartInfo } from '../engine/analysisEngine'

export interface DerivedStats {
  completed: number
  progress: number
  avgWorkerMs: number
  slowest: readonly TaskOutcome[]
}

export function deriveStats(snapshot: BatchSnapshot): DerivedStats {
  let sumWorkerMs = 0
  let doneCount = 0
  let slowest: TaskOutcome[] = []
  for (const outcome of snapshot.results) {
    if (outcome === null) continue
    if (outcome.status === 'done') {
      doneCount += 1
      sumWorkerMs += outcome.workerMs
      slowest.push(outcome)
    }
  }
  slowest = slowest.sort((a, b) => b.workerMs - a.workerMs).slice(0, 10)
  return {
    completed: snapshot.completed,
    progress: snapshot.total === 0 ? 0 : snapshot.completed / snapshot.total,
    avgWorkerMs: doneCount === 0 ? 0 : sumWorkerMs / doneCount,
    slowest,
  }
}

export function useAnalysis(): {
  snapshot: BatchSnapshot
  stats: DerivedStats
  isPending: boolean
  lastStart: StartInfo | null
  start: () => void
  cancel: () => void
} {
  const snapshot = useSyncExternalStore(analysisStore.subscribe, analysisStore.getSnapshot)
  // 只延迟派生物；结果列表直接用 snapshot，不延迟（4.2 边界）
  const deferredSnapshot = useDeferredValue(snapshot)
  const stats = deriveStats(deferredSnapshot)
  const [isPending, startTransition] = useTransition()
  const [lastStart, setLastStart] = useState<StartInfo | null>(null)

  const start = useCallback(() => {
    // 批次启动只由用户事件触发（R5）；生命周期更新放进 transition（4.2）
    startTransition(() => {
      const info = analysisEngine.start()
      setLastStart(info)
    })
  }, [])

  const cancel = useCallback(() => {
    startTransition(() => {
      analysisEngine.cancel()
    })
  }, [])

  return { snapshot, stats, isPending, lastStart, start, cancel }
}
