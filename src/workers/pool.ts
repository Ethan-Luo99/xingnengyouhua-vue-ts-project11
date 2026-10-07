/**
 * Worker 池（设计文档 §1.2 / §5.1 / §7-R1/R2；本轮扩展动态扩缩）：
 * - 初始大小 clamp(hardwareConcurrency - 1, 2, 16)；hardwareConcurrency 缺失回退 4（§6.1）
 * - 动态扩缩范围同样 clamp 在 [2, 16]：扩容新建 Worker；缩容只 terminate 空闲 Worker
 * - 传输层抽象（WorkerTransport + WorkerFactory）：生产用真实模块 Worker，
 *   自测可注入 FakeWorker，无需浏览器即可确定性验证调度行为
 * - 批次结束/取消 terminate 全池（R1）；import.meta.hot.dispose 兜底清理（R2）
 */
import type { ResultMessage, TaskMessage } from './protocol'

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

export const MIN_POOL_SIZE = 2
export const MAX_POOL_SIZE = 16

export function getInitialPoolSize(): number {
  const hc = navigator.hardwareConcurrency
  if (Number.isFinite(hc) && hc >= 1) {
    return clamp(hc - 1, MIN_POOL_SIZE, MAX_POOL_SIZE)
  }
  // 缺失/为 0/非有限值：保守回退（文档 §6.1）
  return 4
}

/** 调度器视角的 Worker：真实 Worker 与测试 Fake 共同实现的最小接口 */
export interface ResultEnvelope {
  data: ResultMessage
}

export interface WorkerTransport {
  postMessage(message: TaskMessage): void
  terminate(): void
  onResult: ((event: ResultEnvelope) => void) | null
  onError: (() => void) | null
}

export interface WorkerFactory {
  create(): WorkerTransport
}

export function createWorker(): Worker {
  return new Worker(new URL('./analysis.worker.ts', import.meta.url), {
    type: 'module',
  })
}

/** 真实模块 Worker → WorkerTransport 适配器 */
export class WorkerAdapter implements WorkerTransport {
  onResult: ((event: ResultEnvelope) => void) | null = null
  onError: (() => void) | null = null
  private readonly worker: Worker
  constructor(worker: Worker) {
    this.worker = worker
    worker.onmessage = (event: MessageEvent<ResultMessage>) => {
      this.onResult?.(event as unknown as ResultEnvelope)
    }
    worker.onerror = () => {
      this.onError?.()
    }
  }
  postMessage(message: TaskMessage): void {
    this.worker.postMessage(message)
  }
  terminate(): void {
    this.worker.onmessage = null
    this.worker.onerror = null
    this.worker.terminate()
  }
}

/** 生产工厂 */
export const realWorkerFactory: WorkerFactory = {
  create(): WorkerTransport {
    return new WorkerAdapter(createWorker())
  },
}

/** 池管理器：只管 Worker 实例的增/删/全杀；忙闲判定由调度器负责 */
export interface PoolManager {
  readonly workers: readonly WorkerTransport[]
  readonly size: number
  grow(count: number): WorkerTransport[]
  /** 调用方保证传入的是空闲 Worker；本方法不做忙闲判断（防误杀在途） */
  retire(worker: WorkerTransport): void
  terminateAll(): void
}

// R2：HMR / 异常退出时兜底 terminate 全部批次残留 Worker
const liveManagers = new Set<PoolManager>()

export function createPoolManager(
  factory: WorkerFactory,
  initialSize: number,
): PoolManager {
  const workers: WorkerTransport[] = []
  const manager: PoolManager = {
    get workers() {
      return workers
    },
    get size() {
      return workers.length
    },
    grow(count: number): WorkerTransport[] {
      const added: WorkerTransport[] = []
      for (let i = 0; i < count; i += 1) {
        const worker = factory.create()
        workers.push(worker)
        added.push(worker)
      }
      return added
    },
    retire(worker: WorkerTransport): void {
      const index = workers.indexOf(worker)
      if (index === -1) return
      workers.splice(index, 1)
      worker.onResult = null
      worker.onError = null
      worker.terminate()
    },
    terminateAll(): void {
      for (const worker of workers) {
        worker.onResult = null
        worker.onError = null
        worker.terminate()
      }
      workers.length = 0
      liveManagers.delete(manager)
    },
  }
  manager.grow(initialSize)
  liveManagers.add(manager)
  return manager
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    for (const manager of liveManagers) manager.terminateAll()
  })
}
