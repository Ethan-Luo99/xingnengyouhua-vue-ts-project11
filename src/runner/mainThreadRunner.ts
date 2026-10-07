/**
 * 降级路径（设计文档 §6.1）：Worker 不可用时在主线程跑同一注册表，
 * 任务间让出事件循环（scheduler.yield，缺失时回退 setTimeout(0)），
 * 与 Worker 路径共用同一 store 协议（batchId 世代校验照常生效）。
 * 暂停语义与 Worker 路径一致：暂停时不执行新任务，恢复后断点续跑。
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

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function runMainThreadBatch(
  batchId: number,
  queue: readonly TaskDescriptor[],
): Promise<void> {
  for (const task of queue) {
    // 取消/跨世代：任务间让出 + 执行前各查一次存活
    if (!store.isLiveBatch(batchId)) return
    await yieldToMain()
    if (!store.isLiveBatch(batchId)) return
    // 暂停：停在任务边界等待恢复（不执行新任务）；取消则退出
    while (store.getSnapshot().status === 'paused') {
      await wait(100)
    }
    if (!store.isLiveBatch(batchId)) return
    const result = taskRegistry[task.taskId](task.params)
    store.receiveResult(batchId, result)
  }
  store.completeBatch(batchId)
}
