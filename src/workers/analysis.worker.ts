/**
 * Worker 入口（设计文档 §6.2）：模块 Worker，直接 import 共享任务注册表。
 * 消息协议：
 *   主 → Worker: { taskId, params, batchId }
 *   Worker → 主: { taskId, batchId, result }
 */
import { taskRegistry } from '../tasks/registry'
import type { TaskParams, TaskResult } from '../tasks/registry'

export interface TaskMessage {
  taskId: string
  params: TaskParams
  batchId: number
}

export interface ResultMessage {
  taskId: string
  batchId: number
  result: TaskResult
}

self.onmessage = (e: MessageEvent<TaskMessage>) => {
  const { taskId, params, batchId } = e.data
  const fn = taskRegistry[taskId]
  if (!fn) {
    throw new Error(`unknown taskId: ${taskId}`)
  }
  const result = fn(params)
  self.postMessage({ taskId, batchId, result } satisfies ResultMessage)
}
