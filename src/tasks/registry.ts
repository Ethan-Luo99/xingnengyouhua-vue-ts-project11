/**
 * 任务注册表（主线程与 Worker 共同 import 的共享模块，见设计文档 2.2 / 6.2）。
 *
 * 耗时分布（参数写死，确定性生成，便于复测）：
 * - 415 个任务均匀分布于 [5ms, 250ms)，期望均值 127.5ms
 * - 50  个任务均匀分布于 [200ms, 400ms)，期望均值 300ms
 * - 25  个任务均匀分布于 [400ms, 600ms)，期望均值 500ms
 * - 10  个长尾任务固定耗时 680~780ms（均 >600ms，覆盖文档要求的至少 5 个）
 * 期望串行合计 ≈ 415*127.5 + 50*300 + 25*500 + 7275 ≈ 87.7s（与文档"约 90s"一致）
 *
 * 随机数使用固定种子的 mulberry32，任何机器上生成的 500 个任务完全一致。
 * 任务体通过分块检查 performance.now() 自旋到目标耗时，因此跨机器实际耗时
 * 即标注的 estimatedMs（误差亚毫秒级），不依赖任何模块级可变缓存。
 */

export interface CloneableParams {
  durationMs: number
  kernel: 0 | 1 | 2
}

export interface TaskResult {
  value: number
  iterations: number
}

export type TaskHandler = (params: CloneableParams) => TaskResult

export type HandlerId = 'trig' | 'intmix' | 'sqrt'

export interface TaskSpec {
  id: string
  handlerId: HandlerId
  params: CloneableParams
  estimatedMs: number
}

export const TASK_COUNT = 500
export const MAX_TASK_MS = 800

const BAND_SMALL = 415
const BAND_MID = 50
const BAND_HEAVY = 25
const TAIL_DURATIONS = [680, 695, 705, 715, 720, 730, 740, 750, 765, 780]
const RNG_SEED = 20261005

function mulberry32(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) | 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function now(): number {
  return performance.now()
}

/** 分块自旋：每 CHUNK 次迭代检查一次时间，保证实际耗时贴近目标且结果不可被 JIT 消除。 */
function spinUntil(deadline: number, chunk: number, step: (i: number) => number): { value: number; iterations: number } {
  let acc = 0
  let i = 0
  for (;;) {
    const limit = i + chunk
    for (; i < limit; i++) acc += step(i)
    if (now() >= deadline) break
  }
  return { value: acc, iterations: i }
}

const trigHandler: TaskHandler = ({ durationMs }) =>
  spinUntil(now() + durationMs, 2000, (i) => Math.sin(i * 0.001) + Math.cos(i * 0.0007))

const intMixHandler: TaskHandler = ({ durationMs }) =>
  spinUntil(now() + durationMs, 8000, (i) => {
    let x = (i * 0x9e3779b1) >>> 0
    x ^= x >>> 16
    x = Math.imul(x, 0x7feb352d)
    x ^= x >>> 15
    x = Math.imul(x, 0x846ca68b)
    x ^= x >>> 16
    return x & 1
  })

const sqrtHandler: TaskHandler = ({ durationMs }) =>
  spinUntil(now() + durationMs, 3000, (i) => Math.sqrt(i + 1) - Math.sqrt(i + 1.5) + 1 / (i + 3))

export const taskRegistry: Record<string, TaskHandler> = {
  trig: trigHandler,
  intmix: intMixHandler,
  sqrt: sqrtHandler,
}

const REGISTRY_KEYS: readonly HandlerId[] = ['trig', 'intmix', 'sqrt']

function buildTaskList(): TaskSpec[] {
  const rand = mulberry32(RNG_SEED)
  const specs: TaskSpec[] = []
  const bands: Array<[number, number, number]> = [
    [BAND_SMALL, 5, 250],
    [BAND_MID, 200, 400],
    [BAND_HEAVY, 400, 600],
  ]
  let ordinal = 0
  for (const [count, min, max] of bands) {
    for (let j = 0; j < count; j++) {
      const durationMs = Math.round(min + rand() * (max - min))
      specs.push({
        id: `task-${String(ordinal).padStart(4, '0')}`,
        handlerId: REGISTRY_KEYS[ordinal % 3],
        params: { durationMs, kernel: ordinal % 3 as 0 | 1 | 2 },
        estimatedMs: durationMs,
      })
      ordinal++
    }
  }
  for (const durationMs of TAIL_DURATIONS) {
    specs.push({
      id: `task-${String(ordinal).padStart(4, '0')}`,
      handlerId: REGISTRY_KEYS[ordinal % 3],
      params: { durationMs, kernel: ordinal % 3 as 0 | 1 | 2 },
      estimatedMs: durationMs,
    })
    ordinal++
  }
  if (specs.length !== TASK_COUNT) {
    throw new Error(`registry: expected ${TASK_COUNT} tasks, got ${specs.length}`)
  }
  return specs
}

export const taskList: readonly TaskSpec[] = Object.freeze(buildTaskList())

/** Worker 侧按 handlerId 查注册表执行（taskId 只用于结果定位，见 5.2）。 */
export function runRegisteredTask(handlerId: HandlerId, params: CloneableParams): TaskResult {
  return taskRegistry[handlerId](params)
}
