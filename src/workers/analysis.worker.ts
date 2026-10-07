/**
 * Worker 入口（设计文档 §6.2）：模块 Worker，直接 import 共享任务注册表。
 * 消息协议：
 *   主 → Worker: { taskId, params, batchId }
 *   Worker → 主: { taskId, batchId, result }
 */
import { taskRegistry } from '../tasks/registry'
import type { TaskParams, TaskResult } from '../tasks/registry'

// dev 自测任务（lt-/md-/ps-/hang-）在 Worker 侧注册。
// 静态导入保证 onmessage 触发前注册完成；registerDevTasks 内部以
// import.meta.env.DEV 守卫，生产构建中整段被 tree-shake（无运行时开销）。
import '../test/registerDevTasks'


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
