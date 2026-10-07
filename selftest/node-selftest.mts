/**
 * Node 自测（无第三方依赖）：worker_threads 提供真实线程与真 terminate。
 * 证据点：
 *  1. 暂停后在途正常入库、无新派发；恢复后断点续跑不重复
 *  2. 缩容只回收空闲 Worker、绝不 terminate 在途；扩容新建 Worker
 *  3. 僵死任务重试一次后 error 落库，批次整体完成
 *  4. 重新开始：旧批次消息被世代校验丢弃，不污染新批次
 * 运行：node --experimental-strip-types selftest/node-selftest.mts
 */
import { BatchRunner } from '../src/runner/batchScheduler.ts'
import * as store from '../src/store/analysisStore.ts'
import { taskDescriptors, makeZombieTask } from '../src/tasks/registry.ts'
import type { TaskDescriptor } from '../src/tasks/registry.ts'
import { NodeThreadFactory } from './nodeTransport.ts'

interface Assertion {
  name: string
  pass: boolean
  detail: string
}

const assertions: Assertion[] = []
let failures = 0

function check(name: string, pass: boolean, detail = ''): void {
  assertions.push({ name, pass, detail })
  if (!pass) failures += 1
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function waitFor(predicate: () => boolean, timeoutMs: number, label: string): Promise<boolean> {
  return new Promise((resolve) => {
    const start = Date.now()
    const timer = setInterval(() => {
      if (predicate()) {
        clearInterval(timer)
        resolve(true)
      } else if (Date.now() - start > timeoutMs) {
        clearInterval(timer)
        console.log(`  [waitFor timeout] ${label}`)
        resolve(false)
      }
    }, 20)
  })
}

function makeTasks(prefix: string, count: number, targetMs: number): TaskDescriptor[] {
  return taskDescriptors.slice(0, count).map((d, i) => ({
    taskId: `${prefix}-${i}`,
    params: { targetMs, seed: d.params.seed },
  }))
}

function resultIds(): string[] {
  return store.getSnapshot().results.map((r) => r.taskId)
}

function uniqueCount(): number {
  return new Set(resultIds()).size
}

// ── 场景 1：暂停/恢复 ──────────────────────────────────────────────────────
async function testPauseResume(): Promise<void> {
  console.log('\n=== 场景 1：暂停 / 恢复（断点续跑、不重复） ===')
  const factory = new NodeThreadFactory()
  const tasks = makeTasks("pause", 8, 120)
  const batchId = store.beginBatch('worker-pool', tasks.length, 2)
  const runner = new BatchRunner(batchId, tasks, factory, {
    initialPoolSize: 2,
    scaleIntervalMs: 60_000, // 本场景关掉自动扩缩，纯看暂停语义
    watchdogIntervalMs: 100,
  })
  runner.start()

  // 等 2 个在途任务跑着，然后立即暂停
  await sleep(60)
  store.pauseBatch()
  const snapAtPause = store.getSnapshot()
  const completedAtPause = snapAtPause.completed
  await sleep(400) // 远大于单任务 120ms：在途应已全部入库
  const snapPaused = store.getSnapshot()

  check('暂停后状态为 paused', snapPaused.status === 'paused', `status=${snapPaused.status}`)
  check(
    '暂停期间在途任务跑完照常入库（恰好初始池 2 个）',
    snapPaused.completed >= Math.min(2, tasks.length),
    `completed=${snapPaused.completed}`,
  )
  check(
    '暂停后无新派发：completed 稳定在上限值（2）',
    snapPaused.completed <= 2,
    `completed=${snapPaused.completed}`,
  )
  check(
    '暂停 400ms 内 completed 不再增长（无新任务执行）',
    snapPaused.completed === completedAtPause || snapPaused.completed <= 2,
    `atPause=${completedAtPause} after400ms=${snapPaused.completed}`,
  )
  // 更强断言：暂停期间只有 2 个结果（在途），第 3 个任务绝不开跑
  check('暂停期间仅在途任务入库，未启动第 3 个任务', snapPaused.completed === 2,
    `completed=${snapPaused.completed}`)

  const idsWhilePaused = resultIds()
  store.resumeBatch()
  runner.resume()

  const done = await waitFor(() => store.getSnapshot().status === 'done', 10_000, 'resume done')
  const finalSnap = store.getSnapshot()
  check('恢复后批次完成', done && finalSnap.status === 'done', `status=${finalSnap.status}`)
  check('恢复后结果总数 = 任务总数', finalSnap.completed === tasks.length,
    `completed=${finalSnap.completed}/${tasks.length}`)
  check('无重复结果（断点续跑不重跑）', uniqueCount() === tasks.length,
    `unique=${uniqueCount()}/${finalSnap.completed}`)
  check('暂停前入库的结果在最终结果中保留',
    idsWhilePaused.every((id) => resultIds().includes(id)),
    `kept=${idsWhilePaused.join(',')}`)
  runner.cancel()
}

// ── 场景 1b：暂停到在途全部排空（队列空）后恢复，批次必须完成（边界） ────────
async function testPauseDrainedResume(): Promise<void> {
  console.log('\n=== 场景 1b：暂停至队列/在途排空后恢复（不得卡死） ===')
  const factory = new NodeThreadFactory()
  const tasks = makeTasks('drain', 3, 50)
  const batchId = store.beginBatch('worker-pool', tasks.length, 3)
  const runner = new BatchRunner(batchId, tasks, factory, {
    initialPoolSize: 3,
    scaleIntervalMs: 60_000,
    watchdogIntervalMs: 100,
  })
  runner.start()
  await sleep(20)
  store.pauseBatch()
  // 3 个任务全部在途，暂停后它们跑完入库；队列已空
  await sleep(500)
  const drained = store.getSnapshot()
  check('暂停态下在途全部入库（3/3）', drained.completed === 3 && drained.status === 'paused',
    `completed=${drained.completed} status=${drained.status}`)
  store.resumeBatch()
  runner.resume()
  const done = await waitFor(() => store.getSnapshot().status === 'done', 5_000, 'drain resume done')
  check('恢复后批次正确完成（无卡死）', done, `status=${store.getSnapshot().status}`)
  runner.cancel()
}

// ── 场景 2：动态扩缩（缩容不杀在途 + 扩容新建） ────────────────────────────
async function testGrow(): Promise<void> {
  console.log('\n=== 场景 2a：动态扩容（高占用 → 新建 Worker） ===')
  const factory = new NodeThreadFactory()
  const tasks: TaskDescriptor[] = [
    ...makeTasks('long', 4, 400),
    ...makeTasks('grow', 28, 30),
  ]
  const batchId = store.beginBatch('worker-pool', tasks.length, 2)
  const runner = new BatchRunner(batchId, tasks, factory, {
    initialPoolSize: 2,
    scaleIntervalMs: 300,
    watchdogIntervalMs: 500,
  })

  const poolSizes: number[] = []
  const unsubscribe = store.subscribe(() => {
    const size = store.getSnapshot().poolSize
    // 只记录批次运行期（>=1）的池大小；结束 teardown 归零不属于扩缩决策
    if (size >= 1 && poolSizes[poolSizes.length - 1] !== size) poolSizes.push(size)
  })
  runner.start()

  const done = await waitFor(() => store.getSnapshot().status === 'done', 20_000, 'grow done')
  unsubscribe()
  const finalSnap = store.getSnapshot()
  check('批次完成', done && finalSnap.status === 'done', `status=${finalSnap.status}`)
  check('全部任务有结果且无重复',
    finalSnap.completed === tasks.length && uniqueCount() === tasks.length,
    `completed=${finalSnap.completed} unique=${uniqueCount()}`)
  check('运行期发生过扩容（池大小曾 > 2）',
    poolSizes.some((size) => size > 2), `sizes=${poolSizes.join('→')}`)
  check('扩容确实新建了 Worker（创建总数 > 初始 2）',
    factory.created.length > 2, `created=${factory.created.length}`)
  check('池大小运行期始终 clamp 在 [2,16]',
    poolSizes.every((size) => size >= 2 && size <= 16), `sizes=${poolSizes.join('→')}`)
  const busyKilled = factory.terminations.filter((t) => t.task !== null)
  check('全程从未 terminate 在途 Worker',
    busyKilled.length === 0,
    `terminations=${factory.terminations.length}, busyKilled=${busyKilled.length}`)
  runner.cancel()
}

async function testShrink(): Promise<void> {
  console.log('\n=== 场景 2b：动态缩容（低占用 → 只回收空闲 Worker） ===')
  const factory = new NodeThreadFactory()
  // 初始池 6；只给 2 个长任务：启动即仅 2 忙 4 空闲，tick 判定低占用 → 缩到 2
  const tasks = makeTasks('shrink', 2, 500)
  const batchId = store.beginBatch('worker-pool', tasks.length, 6)
  const runner = new BatchRunner(batchId, tasks, factory, {
    initialPoolSize: 6,
    scaleIntervalMs: 100,
    watchdogIntervalMs: 500,
  })
  const poolSizes: number[] = []
  const unsubscribe = store.subscribe(() => {
    const size = store.getSnapshot().poolSize
    if (size >= 1 && poolSizes[poolSizes.length - 1] !== size) poolSizes.push(size)
  })
  runner.start()

  // 等缩容决策落地（2 个长任务仍在跑）
  await sleep(700)
  const runningSnap = store.getSnapshot()
  const minRunningSize = Math.min(...poolSizes)
  const shrunk = poolSizes.some((size) => size < 6)

  check('任务在途期间发生缩容（回收空闲 Worker）', shrunk, `sizes=${poolSizes.join('→')}`)
  check('在途期间池大小不低于在途任务数 2（绝不杀在途）',
    minRunningSize >= 2, `minRunningSize=${minRunningSize} sizes=${poolSizes.join('→')}`)
  // 铁证：此时任何 terminate 都不能携带在途任务
  const busyKilled = factory.terminations.filter((t) => t.task !== null)
  check('缩容 terminate 的全部是空闲 Worker（在途被杀 = 0）',
    busyKilled.length === 0,
    `terminations=${factory.terminations.length}, busyKilled=${busyKilled.length}`)
  check('在途任务未受影响：批次仍在 running/paused 之外的正常推进',
    runningSnap.status === 'running' || runningSnap.status === 'done',
    `status=${runningSnap.status}`)
  unsubscribe()

  const done = await waitFor(() => store.getSnapshot().status === 'done', 10_000, 'shrink done')
  const finalSnap = store.getSnapshot()
  check('缩容后在途任务跑完、批次完成', done && finalSnap.status === 'done',
    `status=${finalSnap.status}`)
  check('2 个在途任务结果齐全（证明未被 terminate）',
    finalSnap.completed === 2 && uniqueCount() === 2,
    `completed=${finalSnap.completed} unique=${uniqueCount()}`)
  runner.cancel()
}

async function testAutoscale(): Promise<void> {
  await testGrow()
  await testShrink()
}

// ── 场景 3：看门狗僵死重试一次后失败，批次继续完成 ─────────────────────────
async function testWatchdog(): Promise<void> {
  console.log('\n=== 场景 3：看门狗（僵死重试 1 次 → error 落库，批次完成） ===')
  const factory = new NodeThreadFactory()
  // 预估 100ms，阈值 max(3*100, 500)=500ms；僵死任务实跑 1500ms
  const zombie = makeZombieTask(100, 1500)
  const normal = makeTasks("watch", 3, 60)
  const tasks = [zombie, ...normal]
  const batchId = store.beginBatch('worker-pool', tasks.length, 2)
  const runner = new BatchRunner(batchId, tasks, factory, {
    initialPoolSize: 2,
    scaleIntervalMs: 60_000,
    watchdogIntervalMs: 50,
    zombieEstimateFactor: 3,
    zombieMinMs: 500,
  })
  runner.start()

  const done = await waitFor(() => store.getSnapshot().status === 'done', 20_000, 'watchdog done')
  const snap = store.getSnapshot()
  const results = snap.results
  const zombieResults = results.filter((r) => r.taskId === zombie.taskId)
  const errorResults = zombieResults.filter((r) => r.error)

  check('批次整体完成（不因僵死中断）', done && snap.status === 'done', `status=${snap.status}`)
  check('僵死任务最终恰有 1 条 error 结果',
    zombieResults.length === 1 && errorResults.length === 1,
    `zombieResults=${zombieResults.length}, errors=${errorResults.length}`)
  check('error 结果标记正确且信息可见',
    errorResults[0]?.error === true &&
      typeof errorResults[0]?.errorMessage === 'string' &&
      errorResults[0].errorMessage.includes('watchdog'),
    `msg=${errorResults[0]?.errorMessage ?? 'none'}`)
  check('errorCount 计数为 1', snap.errorCount === 1, `errorCount=${snap.errorCount}`)
  check('正常任务全部成功入库',
    normal.every((t) => results.some((r) => r.taskId === t.taskId && !r.error)),
    `completed=${results.filter((r) => !r.error).length}/${normal.length}`)
  check('总结果数 = 任务总数（error 占位也算一条，无丢失无重复）',
    snap.completed === tasks.length && uniqueCount() === tasks.length,
    `completed=${snap.completed}/${tasks.length}`)
  // 两次僵死各 terminate 1 个 Worker（首次 + 重试），且均为在途硬杀（这是看门狗的特许场景）
  check('看门狗对僵死 Worker 执行了真 terminate',
    factory.terminations.some((t) => t.task === zombie.taskId),
    `terminationsWithZombie=${factory.terminations.filter((t) => t.task === zombie.taskId).length}`)
  runner.cancel()
}

// ── 场景 4：重新开始的世代隔离 ─────────────────────────────────────────────
async function testRestartIsolation(): Promise<void> {
  console.log('\n=== 场景 4：重新开始（旧批次迟到消息被丢弃，不污染新批次） ===')
  const factory = new NodeThreadFactory()
  const tasksA = makeTasks("batchA", 6, 80)
  const batchA = store.beginBatch('worker-pool', tasksA.length, 2)
  const runnerA = new BatchRunner(batchA, tasksA, factory, {
    initialPoolSize: 2,
    scaleIntervalMs: 60_000,
    watchdogIntervalMs: 100,
  })
  runnerA.start()
  await sleep(50)
  runnerA.cancel() // 旧批次硬终止
  store.cancelBatch()

  const tasksB = makeTasks("batchB", 4, 50)
  const batchB = store.beginBatch('worker-pool', tasksB.length, 2)
  const runnerB = new BatchRunner(batchB, tasksB, factory, {
    initialPoolSize: 2,
    scaleIntervalMs: 60_000,
    watchdogIntervalMs: 100,
  })
  runnerB.start()
  const done = await waitFor(() => store.getSnapshot().status === 'done', 10_000, 'batchB done')
  const snap = store.getSnapshot()

  check('新批次完成', done && snap.status === 'done', `status=${snap.status}`)
  check('新批次 batchId 大于旧批次（世代自增）', batchB > batchA, `${batchA} → ${batchB}`)
  check('新批次结果数 = 新批次任务数（旧结果未混入）',
    snap.completed === tasksB.length, `completed=${snap.completed}/${tasksB.length}`)
  check('新批次结果 id 全部属于新批次',
    snap.results.every((r) => tasksB.some((t) => t.taskId === r.taskId)),
    `ids=${snap.results.map((r) => r.taskId).join(',')}`)
  runnerB.cancel()
}

async function main(): Promise<void> {
  await testPauseResume()
  await testPauseDrainedResume()
  await testAutoscale()
  await testWatchdog()
  await testRestartIsolation()

  console.log(`\n──── 合计 ${assertions.length} 项断言，失败 ${failures} 项 ────`)
  process.exitCode = failures === 0 ? 0 : 1
  // 给被 terminate 的线程留出退出时间
  setTimeout(() => process.exit(failures === 0 ? 0 : 1), 200)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
