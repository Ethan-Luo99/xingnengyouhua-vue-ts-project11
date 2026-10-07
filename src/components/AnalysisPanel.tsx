/**
 * 分析面板（设计文档 §4：useSyncExternalStore 快照直驱 + useTransition 批次动作）。
 * 本轮扩展：暂停/恢复/重新开始按钮、暂停状态展示、当前池大小、error 结果可见。
 */
import { useEffect, useState, useTransition } from 'react'
import { useAnalysisSnapshot } from '../store/hooks'
import {
  cancelAnalysis,
  pauseAnalysis,
  restartAnalysis,
  resumeAnalysis,
  startAnalysis,
} from '../runner/controller'

const STATUS_TEXT: Record<string, string> = {
  idle: '空闲',
  running: '运行中',
  paused: '已暂停（在途任务继续入库，停止派发新任务）',
  cancelled: '已取消',
  done: '已完成',
}

function formatMs(ms: number | null): string {
  if (ms === null) return '—'
  return `${(ms / 1000).toFixed(1)}s`
}

/** 200ms 节拍时钟：驱动“已用时”展示，避免渲染期直接调用 performance.now() */
function useClockTick(active: boolean): number {
  const [now, setNow] = useState(() => performance.now())
  useEffect(() => {
    if (!active) return
    const id = setInterval(() => setNow(performance.now()), 200)
    return () => clearInterval(id)
  }, [active])
  return now
}

export function AnalysisPanel() {
  const snap = useAnalysisSnapshot()
  const [isPending, startTransition] = useTransition()
  const isActive = snap.status === 'running' || snap.status === 'paused'
  const now = useClockTick(isActive)

  return (
    <section className="analysis-panel" aria-label="批量分析">
      <header className="panel-header">
        <h1>Worker 池批量分析</h1>
        <div className="controls">
          {!isActive && (
            <button
              type="button"
              className="btn primary"
              disabled={isPending}
              onClick={() => startTransition(() => startAnalysis())}
            >
              {snap.status === 'idle' ? '开始分析' : '开始'}
            </button>
          )}
          {snap.status === 'running' && (
            <button
              type="button"
              className="btn warn"
              onClick={() => startTransition(() => pauseAnalysis())}
            >
              暂停
            </button>
          )}
          {snap.status === 'paused' && (
            <button
              type="button"
              className="btn primary"
              onClick={() => startTransition(() => resumeAnalysis())}
            >
              恢复
            </button>
          )}
          {isActive && (
            <button
              type="button"
              className="btn"
              onClick={() => startTransition(() => cancelAnalysis())}
            >
              取消
            </button>
          )}
          <button
            type="button"
            className="btn ghost"
            onClick={() => startTransition(() => restartAnalysis())}
            title="旧批次安全终止，发起全新批次（断点不续跑）"
          >
            重新开始
          </button>
        </div>
      </header>

      <div className={`status-banner status-${snap.status}`} role="status">
        <span className="status-dot" aria-hidden="true" />
        <span>状态：{STATUS_TEXT[snap.status] ?? snap.status}</span>
        {snap.status === 'paused' && (
          <span className="paused-hint">— 恢复后从断点续跑，不重跑已完成任务</span>
        )}
      </div>

      <dl className="metrics">
        <div>
          <dt>进度</dt>
          <dd>
            {snap.completed}/{snap.total}
            {snap.errorCount > 0 && (
              <span className="error-count">（失败 {snap.errorCount}）</span>
            )}
          </dd>
        </div>
        <div>
          <dt>当前池大小</dt>
          <dd>{snap.status === 'idle' ? '—' : snap.poolSize}</dd>
        </div>
        <div>
          <dt>后端</dt>
          <dd>
            {snap.backend === 'main-thread'
              ? '主线程降级'
              : snap.backend === 'worker-pool'
                ? 'Worker 池'
                : '—'}
          </dd>
        </div>
        <div>
          <dt>批次号</dt>
          <dd>{snap.batchId === 0 ? '—' : snap.batchId}</dd>
        </div>
        <div>
          <dt>已用时</dt>
          <dd>
            {snap.startedAt === null
              ? '—'
              : formatMs(
                  (snap.finishedAt ?? (snap.status === 'paused' ? snap.pausedAt : now) ?? now) -
                    snap.startedAt,
                )}
          </dd>
        </div>
      </dl>

      <progress
        className="progress"
        max={snap.total || 1}
        value={snap.completed}
        aria-label="完成进度"
      />

      <ResultList />
    </section>
  )
}

function ResultList() {
  const snap = useAnalysisSnapshot()
  const results = snap.results
  if (results.length === 0) {
    return <p className="empty-hint">尚无结果。点击“开始分析”跑 500 个计算任务。</p>
  }
  // 结果按 taskId 排序展示（乱序到达，§5.2）
  const ordered = [...results].sort((a, b) => a.taskId.localeCompare(b.taskId))
  return (
    <div className="result-wrap">
      <h2>
        结果列表 <span className="result-count">{ordered.length} 条</span>
      </h2>
      <ul className="result-list">
        {ordered.map((r) => (
          <li key={r.taskId} className={r.error ? 'result-row error' : 'result-row'}>
            <code className="task-id">{r.taskId}</code>
            {r.error ? (
              <span className="result-error" title={r.errorMessage}>
                失败（看门狗）：{r.errorMessage}
              </span>
            ) : (
              <>
                <span className="checksum">checksum={r.checksum}</span>
                <span className="duration">{r.actualMs.toFixed(1)}ms</span>
              </>
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}
