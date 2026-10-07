/**
 * Worker 消息协议（设计文档 §2.2 / §3.3 / §5.2）：
 *   主 → Worker: { taskId, params, batchId }
 *   Worker → 主: { taskId, batchId, result }
 * 独立成模块，使调度器不直接引用 worker 入口（便于注入测试传输层）。
 */
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
