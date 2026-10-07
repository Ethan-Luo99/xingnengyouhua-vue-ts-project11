/**
 * 浏览器端到端自测桥（仅在 URL 带 ?selftest=<scenario> 时激活）：
 * 通过 controller 的注入式 StartOptions 跑确定性场景，并在 window.__SELFTEST__
 * 暴露快照供 CDP 脚本断言。生产路径（无 query 参数）完全不激活。
 */
import { makeZombieTask, taskDescriptors } from '../tasks/registry'
import {
  cancelAnalysis,
  pauseAnalysis,
  restartAnalysis,
  resumeAnalysis,
  startAnalysis,
} from '../runner/controller'
import * as store from '../store/analysisStore'

export interface SelfTestReport {
  snapshot: () => unknown
  controls: {
    pause: () => void
    resume: () => void
    cancel: () => void
    restart: () => void
  }
}

declare global {
  interface Window {
    __SELFTEST__?: SelfTestReport
  }
}

function waitForDone(): Promise<void> {
  return new Promise((resolve) => {
    const unsubscribe = store.subscribe(() => {
      const status = store.getSnapshot().status
      if (status === 'done') {
        unsubscribe()
        resolve()
      }
    })
  })
}

export function maybeStartBrowserSelfTest(): void {
  if (typeof window === 'undefined') return
  const params = new URLSearchParams(window.location.search)
  const scenario = params.get('selftest')
  if (!scenario) return

  const report: SelfTestReport = {
    snapshot: () => store.getSnapshot(),
    controls: {
      pause: pauseAnalysis,
      resume: resumeAnalysis,
      cancel: cancelAnalysis,
      restart: restartAnalysis,
    },
  }
  window.__SELFTEST__ = report
  void waitForDone()

  if (scenario === 'pause' || scenario === 'restart') {
    // 与生产同参数的标准批次（真实 500 任务），由 CDP 脚本驱动暂停等动作
    startAnalysis()
  } else if (scenario === 'shrink') {
    // 2 个真实长任务 + 初始 8 池：在途占比 0.25 持续 ~700ms，确定性触发缩容
    const longTasks = [...taskDescriptors]
      .sort((a, b) => b.params.targetMs - a.params.targetMs)
      .slice(0, 2)
    startAnalysis({
      extraTasks: longTasks,
      limit: 0,
      timing: {
        initialPoolSize: 8,
        scaleIntervalMs: 250,
      },
    })
  } else if (scenario === 'watchdog') {
    // 小批次 + 僵死任务：阈值 max(3*400,1200)=1200ms，僵死实跑 2500ms
    startAnalysis({
      extraTasks: [makeZombieTask(400, 2500)],
      timing: {
        watchdogIntervalMs: 100,
        zombieEstimateFactor: 3,
        zombieMinMs: 1200,
      },
    })
  }
}
