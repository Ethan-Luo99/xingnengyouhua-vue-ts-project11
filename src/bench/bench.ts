/**
 * 仅用于验收压测的 dev 页面（不打进生产包，也不被 App 引用）：
 * 1. 串行基线：主线程顺序执行同一注册表的全部 500 个任务
 * 2. 池化：与生产相同的 new URL 模块 Worker 池，clamp(hardwareConcurrency-1,2,16)
 * 任务体为达到目标墙钟耗时的自旋，迭代数在不同运行间有抖动，故正确性校验
 * 不比较数值，而是：全部 500 任务完成、每个任务实际耗时达到其标注耗时（容差 15%）。
 * 结果写到 window.__benchResult，供 scripts/devr-cdp-test.mjs 通过 CDP 读取。
 */
import { runRegisteredTask, taskList } from '../tasks/registry'
import type { WorkerRequest, WorkerResponse } from '../engine/protocol'

declare global {
  interface Window {
    __benchResult?: unknown
    __benchLog?: (line: string) => void
  }
}

const out = document.getElementById('out') as HTMLPreElement
function say(line: string): void {
  out.textContent += `\n${line}`
  console.log('[bench]', line)
  window.__benchLog?.(line)
}

interface Timing {
  ms: number
  completed: number
  metTarget: number
  minRatio: number
  maxRatio: number
}

function summarize(durations: number[], targets: readonly number[]): Timing {
  let metTarget = 0
  let minRatio = Infinity
  let maxRatio = 0
  durations.forEach((actual, index) => {
    const target = targets[index]
    const ratio = actual / target
    if (ratio < minRatio) minRatio = ratio
    if (ratio > maxRatio) maxRatio = ratio
    // 容差：达到目标的 85%（自旋分块检查的固有误差远小于此）
    if (actual >= target * 0.85) metTarget += 1
  })
  return { ms: 0, completed: durations.filter((d) => d > 0).length, metTarget, minRatio, maxRatio }
}

async function serialBaseline(): Promise<Timing> {
  say('serial: start')
  const durations = new Array<number>(taskList.length).fill(0)
  const start = performance.now()
  for (let index = 0; index < taskList.length; index++) {
    const task = taskList[index]
    const t0 = performance.now()
    runRegisteredTask(task.handlerId, task.params)
    durations[index] = performance.now() - t0
  }
  const summary = summarize(
    durations,
    taskList.map((t) => t.estimatedMs),
  )
  summary.ms = performance.now() - start
  say(
    `serial: done ${summary.ms.toFixed(1)}ms completed=${summary.completed} metTarget=${summary.metTarget}`,
  )
  return summary
}

function resolvePoolSize(): number {
  const cores = Number.isFinite(navigator.hardwareConcurrency)
    ? navigator.hardwareConcurrency
    : 4
  return Math.min(16, Math.max(2, Math.floor(cores) - 1))
}

function poolRun(poolSize: number): Promise<Timing> {
  return new Promise((resolve) => {
    say(`pool x${poolSize}: start`)
    const workers: Worker[] = []
    let next = 0
    let inflight = 0
    const durations = new Array<number>(taskList.length).fill(0)
    const ordered = [...taskList].sort((a, b) => b.estimatedMs - a.estimatedMs)
    const start = performance.now()
    const finish = (): void => {
      const summary = summarize(
        durations,
        ordered.map((t) => t.estimatedMs),
      )
      summary.ms = performance.now() - start
      workers.forEach((w) => w.terminate())
      say(
        `pool x${poolSize}: done ${summary.ms.toFixed(1)}ms completed=${summary.completed} metTarget=${summary.metTarget}`,
      )
      resolve(summary)
    }
    const dispatch = (worker: Worker): void => {
      if (next >= ordered.length) {
        if (inflight === 0) finish()
        return
      }
      const ordinal = next
      next += 1
      inflight += 1
      const task = ordered[ordinal]
      const request: WorkerRequest = {
        type: 'run',
        batchId: 1,
        ordinal,
        taskId: task.id,
        handlerId: task.handlerId,
        params: task.params,
      }
      worker.postMessage(request)
    }
    for (let i = 0; i < poolSize; i++) {
      const worker = new Worker(new URL('../workers/analysis.worker.ts', import.meta.url), {
        type: 'module',
      })
      workers.push(worker)
      worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
        const msg = event.data
        if (msg.type === 'result') durations[msg.ordinal] = msg.durationMs
        inflight -= 1
        dispatch(worker)
      }
      dispatch(worker)
    }
  })
}

async function main(): Promise<void> {
  const cores = navigator.hardwareConcurrency
  const poolSize = resolvePoolSize()
  say(`env hardwareConcurrency=${cores} poolSize=${poolSize} tasks=${taskList.length}`)
  const serial = await serialBaseline()
  const pool = await poolRun(poolSize)
  const result = {
    cores,
    poolSize,
    taskCount: taskList.length,
    serialMs: serial.ms,
    poolMs: pool.ms,
    speedup: serial.ms / pool.ms,
    serialCompleted: serial.completed,
    serialMetTarget: serial.metTarget,
    poolCompleted: pool.completed,
    poolMetTarget: pool.metTarget,
    poolMinRatio: pool.minRatio,
    poolMaxRatio: pool.maxRatio,
    correct:
      serial.completed === taskList.length &&
      pool.completed === taskList.length &&
      pool.metTarget === taskList.length,
  }
  window.__benchResult = result
  say(`RESULT ${JSON.stringify(result)}`)
}

void main()
