/**
 * 降级路径（设计文档 §6.1）：Worker 不可用时在主线程跑同一注册表，
 * 任务间让出事件循环（scheduler.yield，缺失时回退 setTimeout(0)），
 * 与 Worker 路径共用同一 store 协议（batchId 世代校验照常生效）。
 */
import { taskRegistry } from '../tasks/registry'
import type { TaskDescriptor } from '../tasks/registry'
import * as store from '../store/analysisStore'

interface SchedulerLike {
  yield?: () => Promise<void>
}

function yieldToMain(): Promise<void> {
  const scheduler = (globalThis as { scheduler?: SchedulerLike }).scheduler
  if (scheduler && typeof scheduler.yield === 'function') {
    return scheduler.yield()
  }
  return new Promise((resolve) => setTimeout(resolve, 0))
}

export async function runMainThreadBatch(
  batchId: number,
  queue: readonly TaskDescriptor[],
): Promise<void> {
  for (const task of queue) {
    // 取消检查：任务间让出 + 执行前各查一次世代
    if (!store.isBatchAlive(batchId)) return
    await yieldToMain()
    // 暂停：在途任务语义在此路径为"当前尚未开始的任务"，等待恢复或取消
    while (store.getSnapshot().batchId === batchId && store.getSnapshot().status === 'paused') {
      await yieldToMain()
    }
    if (!store.isBatchAlive(batchId)) return
    const result = taskRegistry[task.taskId](task.params)
    store.receiveResult(batchId, result)
  }
  store.completeBatch(batchId)
}
