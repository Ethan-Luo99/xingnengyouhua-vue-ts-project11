/**
 * Worker 池（设计文档 1.2 / 6.2）：
 * - 大小 clamp(hardwareConcurrency - 1, 2, 16)，异常值（缺失/0/1）安全降级
 * - new URL + import.meta.url 实例化模块 Worker（Vite 8 标准形式）
 * - 动态 pull：Worker 空闲即领取下一个任务
 * - terminate 硬取消 + 惰性重建（5.1 / R1）
 */
import type { WorkerRequest, WorkerResponse } from './protocol'

export const MIN_POOL = 2
export const MAX_POOL = 16
const FALLBACK_CONCURRENCY = 4

export function resolvePoolSize(): number {
  let cores: number
  try {
    cores = navigator.hardwareConcurrency
  } catch {
    cores = Number.NaN
  }
  if (!Number.isFinite(cores)) return FALLBACK_CONCURRENCY
  return Math.min(MAX_POOL, Math.max(MIN_POOL, Math.floor(cores) - 1))
}

export function supportsModuleWorkers(): boolean {
  if (typeof Worker === 'undefined') return false
  let supported = false
  try {
    const probe: WorkerOptions = {
      get type() {
        supported = true
        return 'module'
      },
    } as WorkerOptions
    const probeWorker = new Worker('data:text/javascript,', probe)
    probeWorker.terminate()
  } catch {
    return false
  }
  return supported
}

export function createModuleWorker(): Worker {
  return new Worker(new URL('../workers/analysis.worker.ts', import.meta.url), {
    type: 'module',
  })
}

interface PoolSlot {
  worker: Worker
  inFlight: boolean
}

export interface PoolCallbacks {
  onMessage: (response: WorkerResponse, workerIndex: number) => void
  onError: (workerIndex: number) => void
}

export class WorkerPool {
  private slots: PoolSlot[] = []

  private readonly createWorker: () => Worker
  private readonly callbacks: PoolCallbacks
  private readonly size: number

  constructor(createWorker: () => Worker, size: number, callbacks: PoolCallbacks) {
    this.createWorker = createWorker
    this.callbacks = callbacks
    this.size = size
  }

  start(): void {
    for (let i = 0; i < this.size; i++) this.slots.push(this.openSlot(i))
  }

  get workerCount(): number {
    return this.size
  }

  /** 硬取消：立即终止全部 Worker，旧实例回调随实例销毁被解除（5.2 双保险）。 */
  terminateAll(): void {
    for (const slot of this.slots) slot.worker.terminate()
    this.slots = []
  }

  /**
   * 替换死亡 Worker：仅在批次运行中、Worker 异常退出时调用。
   * 当前在途任务由调用方重新入队（纯计算，重试安全）。
   */
  replaceWorker(index: number): void {
    this.slots[index]?.worker.terminate()
    this.slots[index] = this.openSlot(index)
  }

  send(index: number, message: WorkerRequest): void {
    this.slots[index].inFlight = true
    this.slots[index].worker.postMessage(message)
  }

  private openSlot(index: number): PoolSlot {
    const worker = this.createWorker()
    const slot: PoolSlot = { worker, inFlight: false }
    worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      slot.inFlight = false
      this.callbacks.onMessage(event.data, index)
    }
    worker.onerror = () => {
      slot.inFlight = false
      this.callbacks.onError(index)
    }
    return slot
  }
}
