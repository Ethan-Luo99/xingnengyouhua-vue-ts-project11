/**
 * 任务注册表（设计文档 §2.2 方案一：注册表 + 可序列化参数）
 *
 * 主线程与 Worker 共同 import 本模块。postMessage 只携带
 * `{ taskId, params }`，Worker 侧查表执行，函数本体不跨线程。
 *
 * ── 任务集生成参数（写死，确定性生成，共 500 个任务）──
 * PRNG：mulberry32，种子 0xC0FFEE（固定，保证每次加载生成同一任务集）。
 * 耗时分布（targetMs，单位 ms）：
 *   - 440 个：uniform(5, 100)     短任务主体
 *   -  40 个：uniform(100, 300)   中等任务
 *   -  12 个：uniform(300, 600)   长任务
 *   -   8 个：uniform(600, 800)   长尾任务（全部 >600ms，满足 ≥5 个长尾要求）
 * 串行总耗时期望 ≈ 440*52.5 + 40*200 + 12*450 + 8*700 ≈ 42.1s。
 * 单任务耗时用“忙等到 targetMs”实现，与机器算力无关，分布稳定可复现。
 */

export interface TaskParams {
  /** 目标耗时（ms），任务忙等至该时长；同时作为入队排序的预估耗时（文档 R4） */
  targetMs: number
  /** 每个任务独立的确定性种子，驱动计算内容，防止结果被编译器优化掉 */
  seed: number
  /**
   * 测试专用：在 targetMs 之外额外忙等的时长（ms），用于构造
   * "实际耗时远超预估"的僵死任务以验收看门狗；正常 500 任务均不设置。
   */
  extraBusyMs?: number
}

export interface TaskResult {
  taskId: string
  /** 计算校验值（确定性，可用于核对 Worker 与主线程结果一致） */
  checksum: number
  /** 实测耗时（ms） */
  actualMs: number
}

/**
 * 任务最终失败（看门狗二次僵死后由主线程合成，见 controller 看门狗逻辑）。
 * status: 'error' 的条目与成功结果一样进入结果列表，批次继续直至完成。
 */
export interface TaskFailure {
  taskId: string
  status: 'error'
  /** 失败原因 */
  error: string
  /** 已重试次数（二次僵死 => 1） */
  attempts: number
  /** 合成时刻的耗时记录（ms），仅用于展示 */
  elapsedMs: number
}

/** 结果列表条目：成功结果或失败结果（成功结果不携带 status，保持原协议不变） */
export type TaskOutcome = TaskResult | TaskFailure

export type TaskFn = (params: TaskParams) => TaskResult

export const TASK_COUNT = 500

/** mulberry32：32 位确定性 PRNG */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const REGISTRY_SEED = 0xc0ffee

/** 分布档位：[个数, 下限 ms, 上限 ms]，顺序即生成顺序 */
const DISTRIBUTION: ReadonlyArray<readonly [count: number, min: number, max: number]> = [
  [440, 5, 100],
  [40, 100, 300],
  [12, 300, 600],
  [8, 600, 800],
]

export interface TaskDescriptor {
  taskId: string
  params: TaskParams
}

function generateTasks(): TaskDescriptor[] {
  const rand = mulberry32(REGISTRY_SEED)
  const tasks: TaskDescriptor[] = []
  let index = 0
  for (const [count, min, max] of DISTRIBUTION) {
    for (let i = 0; i < count; i += 1) {
      const targetMs = Math.round(min + rand() * (max - min))
      const seed = Math.floor(rand() * 0xffffffff)
      tasks.push({
        taskId: `task-${String(index).padStart(3, '0')}`,
        params: { targetMs, seed },
      })
      index += 1
    }
  }
  return tasks
}

/** 全部任务描述（生成顺序）；入队前由调度方按 targetMs 降序重排（文档 R4） */
export const taskDescriptors: readonly TaskDescriptor[] = generateTasks()

/**
 * 任务本体：忙等 targetMs，期间做确定性浮点运算。
 * 用 performance.now() 控制时长，保证分布在任意算力机器上一致。
 */
function computeTask(taskId: string, params: TaskParams): TaskResult {
  const start = performance.now()
  const totalMs = params.targetMs + (params.extraBusyMs ?? 0)
  let acc = params.seed % 1000
  let iter = params.seed >>> 8
  while (performance.now() - start < totalMs) {
    // 一轮混合运算，结果回灌 acc，防止循环被优化为空转
    acc = (acc * 1.0000001 + Math.sin(iter) * Math.cos(acc)) % 1e9
    iter = (iter * 1664525 + 1013904223) >>> 0
  }
  return {
    taskId,
    checksum: Math.abs(Math.floor(acc * 1e6)) % 1000000007,
    actualMs: performance.now() - start,
  }
}

/** 注册表：{ [taskId]: (params) => result }，主线程与 Worker 共用 */
export const taskRegistry: Record<string, TaskFn> = Object.fromEntries(
  taskDescriptors.map((d) => [d.taskId, (params: TaskParams) => computeTask(d.taskId, params)]),
)

/**
 * dev 自测任务注册入口（仅 dev 测试模块调用；注册进同一份共享注册表，
 * 保证 Worker 侧也能查到测试 taskId）。
 */
export function registerDevTask(taskId: string, params: TaskParams): void {
  if (taskRegistry[taskId]) return
  taskRegistry[taskId] = (incoming: TaskParams) =>
    computeTask(taskId, { ...params, ...incoming })
}

