/**
 * Worker 入口（设计文档 §6.2）：模块 Worker，直接 import 共享任务注册表。
 */
import { taskRegistry } from '../tasks/registry'
import type { TaskMessage, ResultMessage } from './protocol'

self.onmessage = (e: MessageEvent<TaskMessage>) => {
  const { taskId, params, batchId } = e.data
  const fn = taskRegistry[taskId]
  if (!fn) {
    throw new Error(`unknown taskId: ${taskId}`)
  }
  const result = fn(params)
  self.postMessage({ taskId, batchId, result } satisfies ResultMessage)
}
