/**
 * 页面内自测编排（仅 dev，App.tsx 动态引入）。
 * 通过 window.__batchTest 驱动批次，轮询状态做断言。
 * 完成后 window.__batchTestResult = { ok, checks, logs }。
 *
 * 场景：
 *  A 暂停/恢复：暂停后在途照常入库、暂停期不派发；恢复断点续跑不重复
 *  B 动态缩容：缩到 2 时在途 Worker 不被杀，在途任务照常完成且只派发一次
 *  C 看门狗：僵死任务重试一次后 error，批次整体完成
 *  D 动态扩容/缩容：运行中池大小随策略变化且始终在 [2,16]
 *  E 暂停中重新开始：旧批次取消、batchId 自增、新批次结果不被旧批次污染
 */
import type { TestBatchApi } from './testApi'
import './testApi'

type TestApi = NonNullable<(typeof globalThis) & { __batchTest?: TestBatchApi }['__batchTest']>

export interface CheckResult {
  name: string
  pass: boolean
  detail: string
}

export interface SelfTestResult {
  ok: boolean
  checks: CheckResult[]
  logs: string[]
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitFor(
  fn: () => boolean,
  { timeout = 15000, interval = 50, label = 'condition' }: { timeout?: number; interval?: number; label?: string } = {},
): Promise<void> {
  const t0 = performance.now()
  while (performance.now() - t0 < timeout) {
    if (fn()) return
    await sleep(interval)
  }
  throw new Error(`timeout waiting for: ${label}`)
}

const get = (api: TestApi) =>
  api.getState() as {
    snapshot: {
      batchId: number
      status: string
      total: number
      completed: number
      failed: number
      poolSize: number
      results: ReadonlyArray<{ taskId: string; status?: string; error?: string }>
    }
    stats: { poolSize: number; inFlight: number; queued: number; finished: number } | null
    inflightTaskIds: string[]
    dispatchCounts: Record<string, number>
    attempts: Record<string, number>
  }

/** A: 暂停/恢复 + 断点续跑不重复 */
async function scenarioPauseResume(api: TestApi, checks: CheckResult[]): Promise<void> {
  api.start({ queue: 'pause', poolSize: 4 })
  await waitFor(() => get(api).snapshot.status === 'running', { label: 'A running' })
  // 250ms 任务、池 4：启动 130ms 后 4 个在途、16 个排队，暂停窗口稳定
  await sleep(130)
  api.pause()
  await waitFor(() => get(api).snapshot.status === 'paused', { label: 'A paused' })

  const atPause = get(api)
  const completedAtPause = atPause.snapshot.completed
  const inflightAtPause = atPause.stats?.inFlight ?? 0
  await sleep(700) // 250ms 在途任务全部应跑完

  const duringPause = get(api)
  const inflightDrained = (duringPause.stats?.inFlight ?? -1) === 0
  checks.push({
    name: 'A1 暂停后在途任务跑完照常入库',
    pass: inflightDrained && duringPause.snapshot.completed >= completedAtPause + Math.max(1, inflightAtPause),
    detail: `暂停时 completed=${completedAtPause} inFlight=${inflightAtPause}; 900ms 后 completed=${duringPause.snapshot.completed} inFlight=${duringPause.stats?.inFlight}`,
  })
  const completedGrew = duringPause.snapshot.completed
  await sleep(400)
  const pausedStable = get(api).snapshot.completed === completedGrew
  const noNewDispatch = get(api).stats?.queued === duringPause.stats?.queued
  checks.push({
    name: 'A2 暂停中不再派发新任务（结果与队列均冻结）',
    pass: pausedStable && noNewDispatch,
    detail: `暂停后结果停在 ${completedGrew}/${duringPause.snapshot.total}，queued=${duringPause.stats?.queued} 未再减少`,
  })

  const resumeBatchId = get(api).snapshot.batchId
  api.resume()
  await waitFor(() => get(api).snapshot.status === 'done', { label: 'A done', timeout: 20000 })
  const end = get(api)
  const counts = end.dispatchCounts
  const maxDispatch = Math.max(0, ...Object.values(counts))
  const allOnce = Object.keys(counts).length === end.snapshot.total && maxDispatch === 1
  checks.push({
    name: 'A3 恢复后断点续跑：全部任务完成且每任务恰好派发一次',
    pass:
      end.snapshot.status === 'done' &&
      end.snapshot.batchId === resumeBatchId &&
      end.snapshot.completed === end.snapshot.total &&
      allOnce,
    detail: `batch=${end.snapshot.batchId} 完成 ${end.snapshot.completed}/${end.snapshot.total}；派发任务数=${Object.keys(counts).length} 最大派发次数=${maxDispatch}`,
  })
}

/** B: 缩容只回收空闲 Worker，绝不 terminate 在途 */
async function scenarioShrink(api: TestApi, checks: CheckResult[]): Promise<void> {
  // 12 个 400ms 长任务 + 初始池 10：启动后 10 个在途、2 个排队
  api.start({ queue: 'long', poolSize: 10 })
  await waitFor(() => get(api).snapshot.status === 'running', { label: 'B running' })
  await sleep(120)
  const before = get(api)
  const inflightBefore = before.inflightTaskIds.slice().sort()
  // 立即缩到 2：10 个 Worker 全忙 => 一个空闲 Worker 都回收不了
  api.forceResize(2)
  await sleep(120)
  const rightAfter = get(api)
  checks.push({
    name: 'B1 全部在途时缩容：不 terminate 任何在途 Worker',
    pass:
      rightAfter.stats?.inFlight === inflightBefore.length &&
      rightAfter.inflightTaskIds.slice().sort().join('|') === inflightBefore.join('|') &&
      (rightAfter.stats?.poolSize ?? 0) === 10,
    detail: `缩容前 inFlight=${inflightBefore.length} pool=${before.stats?.poolSize}；缩到 2 后 inFlight=${rightAfter.stats?.inFlight} pool=${rightAfter.stats?.poolSize}（被阻塞，零回收）`,
  })

  // 等这一批在途跑完：每跑完一个都应 drainIdle 回收，且结果照常入库
  await waitFor(() => get(api).snapshot.status === 'done', { label: 'B done', timeout: 12000 })
  const end = get(api)
  const counts = end.dispatchCounts
  const allOnce = Object.keys(counts).length === 12 && Math.max(0, ...Object.values(counts)) === 1
  const poolNeverBelow = end.snapshot.failed === 0
  checks.push({
    name: 'B2 在途任务全部正常完成，且每任务只派发一次，无僵死误杀',
    pass: end.snapshot.completed === 12 && allOnce && poolNeverBelow,
    detail: `完成 ${end.snapshot.completed}/12，失败=${end.snapshot.failed}；派发任务数=${Object.keys(counts).length}，最大派发次数=${Math.max(0, ...Object.values(counts))}`,
  })
}

/** C: 僵死看门狗——terminate 僵死 Worker、重试一次、二次僵死 error，批次完成 */
async function scenarioWatchdog(api: TestApi, checks: CheckResult[]): Promise<void> {
  // 8 个短任务 + 4 个 60s 挂死任务（预估 50ms，阈值 max(2s,150ms)=2s）
  api.start({ queue: 'zombie', poolSize: 6 })
  await waitFor(() => get(api).snapshot.status === 'done', { label: 'C done', timeout: 16000 })
  const end = get(api)
  const hangIds = ['hang-0', 'hang-1', 'hang-2', 'hang-3']
  const byId = new Map(end.snapshot.results.map((r) => [r.taskId, r]))
  const normal = end.snapshot.results.filter((r) => !r.taskId.startsWith('hang-'))
  const hangFailures = hangIds.map((id) => byId.get(id))
  const allHangFailed = hangFailures.every((r) => r && r.status === 'error')
  const attemptsOk = hangIds.every((id) => end.attempts[id] === 2)
  checks.push({
    name: 'C1 4 个僵死任务均重试一次后标记为 error（结果列表可见）',
    pass: allHangFailed && attemptsOk,
    detail: `僵死结果：${hangIds
      .map((id, i) => `${id}=${hangFailures[i]?.status ?? 'MISSING'}(attempts=${end.attempts[id] ?? 0})`)
      .join('，')}`,
  })
  checks.push({
    name: 'C2 8 个正常任务全部成功，批次整体跑完到 done',
    pass:
      end.snapshot.status === 'done' &&
      normal.length === 8 &&
      normal.every((r) => r.status !== 'error') &&
      end.snapshot.completed === 12 &&
      end.snapshot.failed === 4,
    detail: `status=${end.snapshot.status} 成功正常任务=${normal.length}/8，completed=${end.snapshot.completed}/12，failed=${end.snapshot.failed}`,
  })
}

/** D: 运行中动态扩缩容，池大小在 [2,16] 内变化且 UI 口径同步 */
async function scenarioAutoScale(api: TestApi, checks: CheckResult[]): Promise<void> {
  // 24 个 500ms 任务、初始池 2：占比 100% + 有积压，2s tick 必扩容
  api.start({ queue: 'medium', poolSize: 2, autoScale: true })
  const sizes = new Set<number>([2])
  const t0 = performance.now()
  let grew = false
  while (performance.now() - t0 < 14000) {
    const s = get(api)
    sizes.add(s.snapshot.poolSize)
    if (s.snapshot.poolSize > 2) grew = true
    if (s.snapshot.status === 'done') {
      sizes.add(s.snapshot.poolSize)
      break
    }
    await sleep(100)
  }
  const end = get(api)
  const observed = [...sizes]
  const inRange = observed.every((n) => n >= 2 && n <= 16)
  checks.push({
    name: 'D1 高占比+积压时自动扩容，池大小始终 clamp 在 [2,16]',
    pass: grew && inRange,
    detail: `观测到池大小序列=${observed.join('->')}；完成 ${end.snapshot.completed}/${end.snapshot.total}`,
  })
  checks.push({
    name: 'D2 扩容新建 Worker，批次最终完成且任务不重复',
    pass:
      end.snapshot.status === 'done' &&
      end.snapshot.completed === 24 &&
      Object.keys(end.dispatchCounts).length === 24 &&
      Math.max(0, ...Object.values(end.dispatchCounts)) === 1,
    detail: `status=${end.snapshot.status} completed=${end.snapshot.completed}/24，派发任务数=${Object.keys(end.dispatchCounts).length}`,
  })
}

/** E: 暂停中"重新开始"——旧批次安全终止，新批次不被旧批次消息污染 */
async function scenarioRestartWhilePaused(api: TestApi, checks: CheckResult[]): Promise<void> {
  api.start({ queue: 'pause', poolSize: 4 })
  await waitFor(() => get(api).snapshot.status === 'running', { label: 'E running' })
  await sleep(130)
  api.pause()
  await waitFor(() => get(api).snapshot.status === 'paused', { label: 'E paused' })
  await sleep(700) // 让旧批次在途 drain 完
  const oldBatchId = get(api).snapshot.batchId

  // 暂停态直接发起新批次（不同队列前缀，便于识别污染）
  api.restart({ queue: 'long', poolSize: 3 })
  const after = get(api)
  const newBatchId = after.snapshot.batchId
  await waitFor(() => get(api).snapshot.status === 'done', { label: 'E new done', timeout: 12000 })
  const end = get(api)
  const onlyNewTasks = end.snapshot.results.every((r) => r.taskId.startsWith('lt-'))
  const noOldIds = end.snapshot.results.every((r) => !r.taskId.startsWith('ps-'))
  checks.push({
    name: 'E1 暂停中重新开始：旧批次取消、batchId 自增',
    pass: newBatchId === oldBatchId + 1,
    detail: `旧 batch=${oldBatchId}（暂停态）-> 新 batch=${newBatchId}`,
  })
  checks.push({
    name: 'E2 新批次结果不被旧批次污染（仅含新队列任务）且完整完成',
    pass:
      end.snapshot.batchId === newBatchId &&
      end.snapshot.status === 'done' &&
      end.snapshot.completed === 12 &&
      onlyNewTasks &&
      noOldIds,
    detail: `新 batch=${end.snapshot.batchId} 完成 ${end.snapshot.completed}/12；结果任务 id 全部为 lt- 前缀（${onlyNewTasks}），无旧 task- 前缀（${noOldIds}）`,
  })
}

export async function runSelfTest(): Promise<void> {
  const api = (globalThis as { __batchTest?: TestApi }).__batchTest
  if (!api) {
    console.error('[selftest] window.__batchTest not found')
    return
  }
  const logs: string[] = []
  const originalLog = console.log
  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(' '))
    originalLog.apply(console, args)
  }

  const checks: CheckResult[] = []
  const scenarios: Array<[string, (a: TestApi, c: CheckResult[]) => Promise<void>]> = [
    ['A pause/resume', scenarioPauseResume],
    ['B shrink', scenarioShrink],
    ['C watchdog', scenarioWatchdog],
    ['D autoscale', scenarioAutoScale],
    ['E restart-while-paused', scenarioRestartWhilePaused],
  ]
  for (const [name, scenario] of scenarios) {
    originalLog(`[selftest] === scenario ${name} begin ===`)
    try {
      await scenario(api, checks)
    } catch (err) {
      checks.push({ name: `${name}（运行异常）`, pass: false, detail: String(err) })
    }
    originalLog(`[selftest] === scenario ${name} end ===`)
  }
  console.log = originalLog

  const result: SelfTestResult = {
    ok: checks.every((c) => c.pass),
    checks,
    logs: logs.filter((line) => line.startsWith('[runner]') || line.startsWith('[analysisStore]')),
  }
  ;(globalThis as { __batchTestResult?: SelfTestResult }).__batchTestResult = result
  originalLog(
    `[selftest] RESULT ${result.ok ? 'PASS' : 'FAIL'} ${checks.filter((c) => c.pass).length}/${checks.length} checks`,
  )
  for (const c of checks) {
    originalLog(`[selftest] ${c.pass ? 'PASS' : 'FAIL'} ${c.name} — ${c.detail}`)
  }
}

// 仅 dev：暴露给 CDP 自测脚本显式触发（不在模块加载时自动跑，
// 避免批次/Worker 与首屏渲染抢资源）
const g = globalThis as { __runBatchSelfTest?: () => Promise<void> }
g.__runBatchSelfTest = runSelfTest
