import { useTransition } from 'react'
import { useAnalysisSnapshot } from '../store/hooks'
import {
  cancelAnalysis,
  pauseAnalysis,
  restartAnalysis,
  resumeAnalysis,
  startAnalysis,
} from '../runner/controller'
import type { AnalysisSnapshot } from '../store/analysisStore'
import './analysisPanel.css'

const STATUS_LABEL: Record<AnalysisSnapshot['status'], string> = {
  idle: '空闲',
  running: '运行中',
  paused: '已暂停',
  cancelled: '已取消',
  done: '已完成',
}

function elapsedMs(snapshot: AnalysisSnapshot): number | null {
  if (snapshot.startedAt === null) return null
  const end = snapshot.finishedAt ?? performance.now()
  return Math.max(0, end - snapshot.startedAt)
}

export function AnalysisPanel() {
  const snapshot = useAnalysisSnapshot()
  const [, startTransition] = useTransition()
  const live = snapshot.status === 'running' || snapshot.status === 'paused'

  const handleStart = () => startTransition(() => startAnalysis())
  const handleRestart = () => startTransition(() => restartAnalysis())
  const handlePause = () => pauseAnalysis()
  const handleResume = () => resumeAnalysis()
  const handleCancel = () => startTransition(() => cancelAnalysis())

  const elapsed = elapsedMs(snapshot)
  const pct = snapshot.total > 0 ? Math.round((snapshot.completed / snapshot.total) * 100) : 0

  return (
    <section className="analysis-panel" aria-label="Worker 池批量分析">
      <header className="analysis-header">
        <h1>计算批次 Worker 池分析</h1>
        <div className={`status-badge status-${snapshot.status}`} role="status">
          {STATUS_LABEL[snapshot.status]}
        </div>
      </header>

      <div className="controls">
        {!live ? (
          <button type="button" className="btn btn-primary" onClick={handleStart}>
            {snapshot.status === 'idle' ? '开始分析' : '重新开始'}
          </button>
        ) : (
          <button type="button" className="btn btn-primary" onClick={handleRestart}>
            重新开始（新批次）
          </button>
        )}
        <button type="button" className="btn" onClick={handlePause} disabled={snapshot.status !== 'running'}>
          暂停
        </button>
        <button type="button" className="btn" onClick={handleResume} disabled={snapshot.status !== 'paused'}>
          恢复
        </button>
        <button type="button" className="btn btn-danger" onClick={handleCancel} disabled={!live}>
          取消
        </button>
      </div>

      <p className="pause-hint" aria-live="polite">
        {snapshot.status === 'paused'
          ? '已暂停：不再派发新任务，在途任务跑完照常入库；恢复后从断点续跑，不重跑已完成任务。'
          : '暂停只停止派发，在途任务会跑完并入库。'}
      </p>

      <dl className="metrics">
        <div>
          <dt>批次号</dt>
          <dd>{snapshot.batchId}</dd>
        </div>
        <div>
          <dt>后端</dt>
          <dd>{snapshot.backend === 'worker-pool' ? 'Worker 池' : snapshot.backend === 'main-thread' ? '主线程降级' : '—'}</dd>
        </div>
        <div>
          <dt>当前池大小</dt>
          <dd>{snapshot.backend === 'main-thread' ? 1 : snapshot.poolSize}</dd>
        </div>
        <div>
          <dt>进度</dt>
          <dd>
            {snapshot.completed}/{snapshot.total}（{pct}%）
          </dd>
        </div>
        <div>
          <dt>失败</dt>
          <dd className={snapshot.failed > 0 ? 'metric-fail' : undefined}>{snapshot.failed}</dd>
        </div>
        <div>
          <dt>耗时</dt>
          <dd>{elapsed === null ? '—' : `${(elapsed / 1000).toFixed(1)}s`}</dd>
        </div>
      </dl>

      <div className="progress-track" aria-hidden="true">
        <div
          className="progress-fill"
          style={{ width: `${pct}%` }}
          data-status={snapshot.status}
        />
      </div>

      <div className="results">
        <h2>结果列表{live || snapshot.status === 'done' ? `（${snapshot.results.length}）` : ''}</h2>
        <ul className="result-list">
          {[...snapshot.results]
            .slice()
            .sort((a, b) => a.taskId.localeCompare(b.taskId))
            .map((item) => {
              const failed = 'status' in item
              return (
                <li key={item.taskId} className={failed ? 'result-error' : 'result-ok'}>
                  <span className="result-id">{item.taskId}</span>
                  {failed ? (
                    <span className="result-detail" title={item.error}>
                      error（重试 {item.attempts - 1} 次后失败）
                    </span>
                  ) : (
                    <span className="result-detail">
                      checksum={item.checksum} · {item.actualMs.toFixed(0)}ms
                    </span>
                  )}
                </li>
              )
            })}
        </ul>
      </div>
    </section>
  )
}
