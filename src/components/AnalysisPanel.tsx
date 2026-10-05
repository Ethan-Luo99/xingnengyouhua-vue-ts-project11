import { memo } from 'react'
import { useAnalysis } from './useAnalysis'
import type { BatchSnapshot, TaskOutcome } from '../store/analysisStore'
import './AnalysisPanel.css'

function formatMs(ms: number): string {
  return `${ms.toFixed(1)}ms`
}

const ResultRow = memo(function ResultRow({ outcome }: { outcome: TaskOutcome | null }) {
  if (outcome === null) {
    return (
      <li className="result-row result-pending">
        <span className="result-id">…</span>
        <span className="result-status">排队中</span>
        <span className="result-ms">—</span>
      </li>
    )
  }
  return (
    <li className={`result-row result-${outcome.status}`}>
      <span className="result-id">{outcome.taskId}</span>
      <span className="result-status">{outcome.status === 'done' ? '完成' : `错误:${outcome.message}`}</span>
      <span className="result-ms">{outcome.status === 'done' ? formatMs(outcome.workerMs) : '—'}</span>
    </li>
  )
})

function ResultList({ snapshot }: { snapshot: BatchSnapshot }) {
  // 列表本体直接订阅原始快照：流式上屏，不允许延迟（4.2）
  return (
    <ul className="result-list" aria-label="分析结果">
      {snapshot.results.map((outcome, index) => (
        <ResultRow key={index} outcome={outcome} />
      ))}
    </ul>
  )
}

function StatsSummary({
  snapshot,
  avgWorkerMs,
  slowest,
}: {
  snapshot: BatchSnapshot
  avgWorkerMs: number
  slowest: readonly TaskOutcome[]
}) {
  return (
    <div className="stats">
      <p className="stats-line">
        已完成 <strong>{snapshot.completed}</strong>/{snapshot.total}，平均任务耗时{' '}
        <strong>{formatMs(avgWorkerMs)}</strong>
      </p>
      <ol className="slowest-list">
        {slowest.map((outcome) => (
          <li key={outcome.taskId}>
            {outcome.taskId} — {formatMs(outcome.workerMs)}
          </li>
        ))}
      </ol>
    </div>
  )
}

export default function AnalysisPanel() {
  const { snapshot, stats, isPending, lastStart, start, cancel } = useAnalysis()
  const running = snapshot.phase === 'running'
  const elapsed =
    snapshot.phase === 'running' || snapshot.phase === 'idle'
      ? null
      : snapshot.endedAt - snapshot.startedAt

  return (
    <section id="analysis-panel">
      <h2>计算批次分析（500 任务 · 5ms–800ms）</h2>
      <div className="controls">
        <button
          type="button"
          className="start-btn"
          onClick={start}
          disabled={running || isPending}
        >
          {isPending && !running ? '初始化中…' : '开始分析'}
        </button>
        <button type="button" className="cancel-btn" onClick={cancel} disabled={!running}>
          取消
        </button>
        <span className="mode-hint">
          {lastStart
            ? `模式：${lastStart.mode === 'pool' ? `Worker 池 ×${lastStart.poolSize}` : '主线程切片'} · 预估串行 ${(lastStart.totalEstimateMs / 1000).toFixed(1)}s`
            : navigator.hardwareConcurrency
              ? `hardwareConcurrency=${navigator.hardwareConcurrency}`
              : 'hardwareConcurrency 不可用'}
        </span>
      </div>

      <div className="progress" role="progressbar" aria-valuemin={0} aria-valuemax={100}>
        <div
          className="progress-bar"
          style={{ width: `${Math.min(100, stats.progress * 100).toFixed(2)}%` }}
        />
      </div>
      <p className="phase-line">
        状态：{snapshot.phase}
        {elapsed !== null && snapshot.startedAt > 0 ? ` · 批次墙钟耗时 ${formatMs(elapsed)}` : ''}
        {snapshot.phase === 'cancelled' ? '（在途与缓冲结果已丢弃）' : ''}
      </p>

      {snapshot.phase !== 'idle' && (
        <>
          <StatsSummary
            snapshot={snapshot}
            avgWorkerMs={stats.avgWorkerMs}
            slowest={stats.slowest}
          />
          <ResultList snapshot={snapshot} />
        </>
      )}
    </section>
  )
}
