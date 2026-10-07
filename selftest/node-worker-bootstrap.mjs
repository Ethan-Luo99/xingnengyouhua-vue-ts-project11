// Node 自测用 Worker（worker_threads）：与 src/workers/analysis.worker.ts 行为一致，
// 直接 import 共享任务注册表，执行忙等任务。terminate() 可真正硬杀在途任务。
import { parentPort } from 'node:worker_threads'
import { taskRegistry } from '../src/tasks/registry.ts'

parentPort.on('message', (msg) => {
  const { taskId, params, batchId } = msg
  const fn = taskRegistry[taskId]
  if (!fn) throw new Error(`unknown taskId: ${taskId}`)
  const result = fn(params)
  parentPort.postMessage({ taskId, batchId, result })
})
