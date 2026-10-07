/**
 * 纯副作用注册模块：把 dev 自测任务（ps-/lt-/md-/hang-）注册进共享注册表。
 * 主线程（testApi）与 Worker（analysis.worker）都静态 import 本模块，
 * 保证 Worker 侧 onmessage 触发前已能查到测试 taskId。
 *
 * 生产安全：全部代码（含任务 id/参数字面量）都在 import.meta.env.DEV 守卫内，
 * 生产构建中 DEV 静态为 false，整个模块体不可达而被 tree-shake，
 * build 产物中检索不到 hang-/lt-/ps-/md 任何测试标记。
 */
import { registerDevTask } from '../tasks/registry'

if (import.meta.env.DEV) {
  // 看门狗验收僵死任务：预估 50ms，实际忙等 60s（超 max(2s,3×50ms) 阈值）
  const hangTaskDescriptors = ['hang-0', 'hang-1', 'hang-2', 'hang-3'].map((taskId, i) => ({
    taskId,
    params: { targetMs: 50, seed: 0xdead00 + i, extraBusyMs: 60_000 },
  }))

  for (let i = 0; i < 20; i += 1) {
    registerDevTask(`ps-${String(i).padStart(2, '0')}`, { targetMs: 250, seed: 0x909000 + i })
  }
  for (let i = 0; i < 12; i += 1) {
    registerDevTask(`lt-${String(i).padStart(2, '0')}`, { targetMs: 400, seed: 0x515100 + i })
  }
  for (let i = 0; i < 24; i += 1) {
    registerDevTask(`md-${String(i).padStart(2, '0')}`, { targetMs: 500, seed: 0x252500 + i })
  }
  for (const descriptor of hangTaskDescriptors) {
    registerDevTask(descriptor.taskId, descriptor.params)
  }
}
