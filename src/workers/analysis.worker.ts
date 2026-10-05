/// <reference lib="webworker" />
/**
 * Worker 入口（设计文档 6.2）：查共享注册表执行，回传结构化克隆结果。
 * 模块级无任何可变状态/缓存（R1）。
 */
import { runRegisteredTask } from '../tasks/registry'
import type { WorkerRequest, WorkerResponse } from '../engine/protocol'

const ctx = self as unknown as DedicatedWorkerGlobalScope

ctx.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const msg = event.data
  if (msg.type !== 'run') return
  let response: WorkerResponse
  try {
    const start = performance.now()
    const result = runRegisteredTask(msg.handlerId, msg.params)
    response = {
      type: 'result',
      batchId: msg.batchId,
      ordinal: msg.ordinal,
      taskId: msg.taskId,
      durationMs: performance.now() - start,
      result,
    }
  } catch (err) {
    response = {
      type: 'error',
      batchId: msg.batchId,
      ordinal: msg.ordinal,
      taskId: msg.taskId,
      message: err instanceof Error ? err.message : String(err),
    }
  }
  ctx.postMessage(response)
}
