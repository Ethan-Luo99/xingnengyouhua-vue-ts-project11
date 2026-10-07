/**
 * Node 自测传输层：用 worker_threads 跑真实任务线程，提供与浏览器 Worker
 * 一致的 postMessage / terminate 语义（terminate 硬杀在途忙等任务）。
 */
import { Worker } from 'node:worker_threads'
import { fileURLToPath } from 'node:url'
import type {
  ResultEnvelope,
  WorkerFactory,
  WorkerTransport,
} from '../src/workers/pool.ts'
import type { ResultMessage, TaskMessage } from '../src/workers/protocol.ts'

const BOOTSTRAP = fileURLToPath(new URL('./node-worker-bootstrap.mjs', import.meta.url))

export class NodeThreadTransport implements WorkerTransport {
  onResult: ((event: ResultEnvelope) => void) | null = null
  onError: (() => void) | null = null
  terminated = false
  /** 最后一次派发、尚未回结果的任务（自测断言：terminate 时必须为空） */
  inFlightTask: string | null = null
  private readonly thread: Worker

  constructor() {
    this.thread = new Worker(BOOTSTRAP)
    this.thread.on('message', (data: ResultMessage) => {
      this.inFlightTask = null
      this.onResult?.({ data })
    })
    this.thread.on('error', (err: Error) => {
      console.log('[nodeTransport] thread error:', err.message)
      this.onError?.()
    })
  }

  postMessage(message: TaskMessage): void {
    this.inFlightTask = message.taskId
    this.thread.postMessage(message)
  }

  terminate(): void {
    this.terminated = true
    this.inFlightTask = null
    void this.thread.terminate()
  }
}

export class NodeThreadFactory implements WorkerFactory {
  readonly created: NodeThreadTransport[] = []
  /** 所有 terminate 事件：记录被杀时是否在途（断言缩容绝不杀在途） */
  readonly terminations: Array<{ task: string | null }> = []
  create(): WorkerTransport {
    const transport = new NodeThreadTransport()
    this.created.push(transport)
    const originalTerminate = transport.terminate.bind(transport)
    transport.terminate = () => {
      this.terminations.push({ task: transport.inFlightTask })
      originalTerminate()
    }
    return transport
  }
  get terminatedCount(): number {
    return this.created.filter((t) => t.terminated).length
  }
}
