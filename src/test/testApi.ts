/**
 * 仅供 dev 自测使用的页面钩子（生产构建被 import.meta.env.DEV 静态剔除，
 * 见 App.tsx）。无头自测脚本通过 window.__batchTest 驱动批次并断言状态。
 *
 * 测试任务（lt-/md-/hang-）统一在 devTestTasks.ts 注册进共享注册表，
 * 主线程与 Worker 均会执行该注册，保证 Worker 能查到这些 taskId。
 */
import './registerDevTasks'
import { taskDescriptors } from '../tasks/registry'
import type { TaskDescriptor } from '../tasks/registry'
import * as controller from '../runner/controller'
import * as store from '../store/analysisStore'
import { getInitialPoolSize } from '../workers/pool'

type QueueKind = 'normal' | 'short' | 'pause' | 'long' | 'medium' | 'zombie'

function makeQueue(kind: QueueKind): TaskDescriptor[] {
  switch (kind) {
    case 'normal':
      return [...taskDescriptors]
    case 'short':
      // 暂停验收：取预估耗时最短的 40 个短任务（5~100ms 档），
      // 保证秒级完成且暂停瞬间仍有任务在途/排队
      return [...taskDescriptors]
        .sort((a, b) => a.params.targetMs - b.params.targetMs)
        .slice(0, 40)
    case 'pause':
      // 暂停/恢复主验收队列：20 个 250ms 任务，池 4 时暂停窗口稳定
      // （暂停瞬间必有在途与排队），整批约 1.3s 跑完
      return Array.from({ length: 20 }, (_, i) => ({
        taskId: `ps-${String(i).padStart(2, '0')}`,
        params: { targetMs: 250, seed: 0x909000 + i },
      }))
    case 'long':
      // 缩容验收：12 个 400ms 长任务。初始池 10 起步时全部在途，
      // forceResize 到 2 时全部 Worker 忙 => 只能等跑完才能回收
      return Array.from({ length: 12 }, (_, i) => ({
        taskId: `lt-${String(i).padStart(2, '0')}`,
        params: { targetMs: 400, seed: 0x515100 + i },
      }))
    case 'medium':
      // 自动扩缩容验收：24 个 500ms 中等任务，初始池 2 时 2s tick 必然触发扩容
      return Array.from({ length: 24 }, (_, i) => ({
        taskId: `md-${String(i).padStart(2, '0')}`,
        params: { targetMs: 500, seed: 0x252500 + i },
      }))
    case 'zombie': {
      // 看门狗验收：8 个正常短任务 + 4 个挂死任务（预估 50ms，实际 60s）
      const hangs = ['hang-0', 'hang-1', 'hang-2', 'hang-3'].map((taskId, i) => ({
        taskId,
        params: { targetMs: 50, seed: 0xdead00 + i, extraBusyMs: 60_000 },
      }))
      return [...taskDescriptors.slice(0, 8), ...hangs]
    }
  }
}

interface StartOpts {
  queue?: QueueKind
  poolSize?: number
  autoScale?: boolean
}

export interface TestBatchApi {
  start: (opts?: StartOpts) => void
  pause: () => void
  resume: () => void
  cancel: () => void
  restart: (opts?: StartOpts) => void
  /** 自测：强制缩容到目标值（验证不 terminate 在途） */
  forceResize: (target: number) => void
  getState: () => Record<string, unknown>
  initialPoolSize: () => number
}

function startWith(opts: StartOpts = {}): void {
  controller.startAnalysis({
    queue: makeQueue(opts.queue ?? 'short'),
    initialPoolSize: opts.poolSize,
    autoScale: opts.autoScale ?? false,
  })
}

const api: TestBatchApi = {
  start: startWith,
  pause: controller.pauseAnalysis,
  resume: controller.resumeAnalysis,
  cancel: controller.cancelAnalysis,
  restart: (opts) =>
    controller.restartAnalysis({
      queue: makeQueue(opts?.queue ?? 'short'),
      initialPoolSize: opts?.poolSize,
      autoScale: opts?.autoScale ?? false,
    }),
  forceResize: (target) => controller.getActiveRunner()?.forceResize(target),
  getState: () => {
    const snapshot = store.getSnapshot()
    const runner = controller.getActiveRunner()
    return {
      snapshot,
      stats: runner ? runner.stats() : null,
      inflightTaskIds: runner ? runner.inflightTaskIds() : [],
      dispatchCounts: runner ? runner.dispatchCounts() : {},
      attempts: runner
        ? Object.fromEntries(
            snapshot.results.map((item) => [item.taskId, runner.attemptCount(item.taskId)]),
          )
        : {},
    }
  },
  initialPoolSize: getInitialPoolSize,
}

;(globalThis as { __batchTest?: TestBatchApi }).__batchTest = api

export type { QueueKind }
