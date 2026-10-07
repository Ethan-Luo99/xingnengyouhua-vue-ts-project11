/**
 * Worker 池（设计文档 §1.2 / §5.1 / §7-R1/R2）：
 * - 初始大小 clamp(hardwareConcurrency - 1, 2, 16)；hardwareConcurrency 缺失/异常回退 4（§6.1）
 * - 模块级单例；批次运行中支持动态扩缩（本轮新增，不推翻 §1.2 结论：
 *   上限 16、下限 2、hardwareConcurrency 仍只决定初始大小）
 * - 扩容 = 新建 Worker；缩容只回收空闲 Worker，绝不 terminate 在途 Worker
 * - 批次结束/硬取消 terminate 全池（R1 内存膨胀缓解 + §5.1 硬取消），下批重建
 * - import.meta.hot.dispose 清理，防 HMR 下 Worker 泄漏（R2）
 */

export const MIN_POOL_SIZE = 2
export const MAX_POOL_SIZE = 16

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

export function getInitialPoolSize(): number {
  const hc = navigator.hardwareConcurrency
  if (Number.isFinite(hc) && hc >= 1) {
    return clamp(hc - 1, MIN_POOL_SIZE, MAX_POOL_SIZE)
  }
  // 缺失/为 0/非有限值：保守回退（文档 §6.1）
  return 4
}

export function createWorker(): Worker {
  return new Worker(new URL('./analysis.worker.ts', import.meta.url), {
    type: 'module',
  })
}

/**
 * 动态 Worker 池。busy 集合记录在途 Worker：
 * - shrink 只 terminate 不在 busy 中的存活 Worker
 * - 看门狗 killZombie 显式接管被强杀 Worker 的记账（从 busy 移除）
 */
export class WorkerPool {
  private alive = new Set<Worker>()
  private busy = new Set<Worker>()
  private desired: number
  private readonly onAttach: (worker: Worker) => void

  constructor(initialSize: number, attach: (worker: Worker) => void) {
    this.onAttach = attach
    this.desired = clamp(initialSize, MIN_POOL_SIZE, MAX_POOL_SIZE)
    // 构造期只建 Worker 不 attach：attach 内通常含派发，需由调用方在
    // 池引用就绪后显式 prime()，避免构造中途回调访问未完成对象
    for (let i = 0; i < this.desired; i += 1) this.spawn()
  }

  /** 初始 Worker 绑定事件（构造完成后由调用方调用一次） */
  prime(): void {
    for (const worker of this.alive) this.onAttach(worker)
  }

  /** 当前存活 Worker 数（UI 展示口径） */
  get size(): number {
    return this.alive.size
  }

  /** 目标大小（最近一次 resize 后、受缩容约束可能尚未达到） */
  get desiredSize(): number {
    return this.desired
  }

  get inFlightCount(): number {
    return this.busy.size
  }

  isBusy(worker: Worker): boolean {
    return this.busy.has(worker)
  }

  /** 全部存活 Worker（批次启动时逐个派发用） */
  workers(): Worker[] {
    return [...this.alive]
  }

  private spawn(): Worker {
    const worker = createWorker()
    this.alive.add(worker)
    return worker
  }

  /** 运行中扩容：新建并立即 attach（attach 内派发新任务） */
  private grow(): Worker {
    const worker = this.spawn()
    this.onAttach(worker)
    return worker
  }

  markBusy(worker: Worker): void {
    this.busy.add(worker)
  }

  markIdle(worker: Worker): void {
    this.busy.delete(worker)
  }

  /**
   * 动态调池。返回实际存活数。
   * @param canFinishIdle 无剩余队列时是否允许立即回收空闲 Worker（批次收尾用）
   */
  resize(target: number): { size: number; added: number; removed: number; blocked: number } {
    this.desired = clamp(target, MIN_POOL_SIZE, MAX_POOL_SIZE)
    let added = 0
    while (this.alive.size < this.desired) {
      this.grow()
      added += 1
    }
    let removed = 0
    // 只回收空闲 Worker；在途 Worker 跑完后由调度方 drainIdle 继续回收
    for (const worker of [...this.alive]) {
      if (this.alive.size - removed <= this.desired) break
      if (!this.busy.has(worker)) {
        this.killWorker(worker)
        removed += 1
      }
    }
    const blocked = Math.max(0, this.alive.size - this.desired)
    return { size: this.alive.size, added, removed, blocked }
  }

  /** 缩容目标未达成时，在任务完成的瞬间尝试回收该 Worker（仅当空闲且超编） */
  drainIdle(worker: Worker): boolean {
    if (!this.alive.has(worker)) return false
    if (this.busy.has(worker)) return false
    if (this.alive.size <= this.desired) return false
    this.killWorker(worker)
    return true
  }

  /** 看门狗：强杀僵死 Worker（唯一允许 terminate 在途 Worker 的路径） */
  killZombie(worker: Worker): void {
    this.busy.delete(worker)
    this.killWorker(worker)
  }

  /** 故障 Worker 剔除（onerror 路径） */
  evict(worker: Worker): void {
    this.busy.delete(worker)
    this.killWorker(worker)
  }

  /**
   * 补齐被看门狗/故障剔除的 Worker：存活数低于目标（或上限）时新建一个。
   * 内部已 attach + 派发，调用方不要重复 attach。
   */
  replaceWorker(): Worker | null {
    if (this.alive.size >= MAX_POOL_SIZE) return null
    this.desired = Math.min(
      MAX_POOL_SIZE,
      Math.max(this.desired, this.alive.size + 1),
    )
    return this.grow()
  }

  private killWorker(worker: Worker): void {
    this.alive.delete(worker)
    this.busy.delete(worker)
    worker.onmessage = null
    worker.onerror = null
    worker.terminate()
  }

  /** 硬取消/批次结束：terminate 全池（在途也杀，§5.1） */
  terminateAll(): void {
    for (const worker of [...this.alive]) this.killWorker(worker)
    this.desired = 0
  }
}

// R2：HMR 时由调度器（controller）在 import.meta.hot.dispose 中
// terminate 当前批次池，避免旧 Worker 泄漏累积。
