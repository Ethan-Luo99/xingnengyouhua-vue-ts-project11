# 第二轮交付说明：暂停/恢复 · 动态扩缩池 · 超时看门狗

在 `docs/worker-batch-design.md` 既有架构（任务注册表 + Worker 池 + 硬取消/惰性重建 + 手写 store）上平滑扩展，未推翻任何方案结论。**未新增任何 npm 依赖。**

## 1. 实现落点

### 暂停 / 恢复
- `src/store/analysisStore.ts`：新增 `paused` 状态与 `pauseBatch()/resumeBatch()`。
  - 派发闸口拆分为两个判定：`isDispatchOpen`（仅 `running` 可派发新任务）与 `isLiveBatch`（`running|paused` 均接收在途结果）。
  - 因此**暂停只关派发，在途任务跑完照常 `receiveResult` 入库**。
- `src/runner/batchScheduler.ts`：`pump()/dispatchOne()` 派发前过 `isDispatchOpen`；恢复走 `controller.resumeAnalysis() → runner.resume() → pump()`。
  - 已完成任务不在队列中，**断点续跑天然不重跑**（用唯一 id 集合断言）。
  - 边界：暂停期间队列与在途全部排空时，恢复由 `pump()` 末尾 `checkFinish()` 正确收尾，不卡死。
- `src/runner/mainThreadRunner.ts`：降级路径在任务边界轮询 `paused`，语义一致。
- 重新开始：`restartAnalysis()` 先按既有取消语义硬终止旧批次（terminate + 世代号自增），再发起新批次；旧 Worker 迟到消息在 store 入口按 batchId 丢弃，**新旧批次消息互不污染**。

### 动态扩缩池（每 2s）
- `src/workers/pool.ts`：池重构为 `PoolManager`（`grow/retire/terminateAll`）+ 可注入 `WorkerFactory`（生产 `WorkerAdapter` 包真实模块 Worker）。
- `batchScheduler.onScaleTick()` 每 `scaleIntervalMs`（默认 2000ms）依据**在途占比 busy/size** 与**最近完成任务实测耗时滑动均值**（20 样本）决策：
  - 高占用（ratio ≥ 0.875）且有积压 → 扩容（实测耗时越长步子越大），新建 Worker 并绑定事件；
  - 低占用（ratio ≤ 0.5）→ 缩容，**只对不在 `busy` 表中的空闲 Worker 调 `retire()`，代码层 `if (this.busy.has(worker)) continue` 保证绝不 terminate 在途**。
  - 目标与实际池大小一律 `clamp [2,16]`；UI 经 `store.poolSize` 实时显示。
- 看门狗杀僵死 Worker 后会补建一个同容量 Worker（pause 下只占位、不派发）。

### 任务超时看门狗
- `batchScheduler.onWatchdogTick()`（默认 250ms 巡检）：在途任务 `elapsed > max(targetMs*3, 2000)` 判僵死。
- 一次僵死：`retire()`（terminate）该 Worker，任务以队首重试一次（`attemptsByKey` 记录）。
- 二次僵死：生成 `error=true` 的 `TaskResult` 落库（`errorMessage` 可见，列表红行 + `errorCount`），**不重试、批次继续直到完成**。
- 僵死任务注入点：`src/tasks/registry.ts` 新增 `makeZombieTask(targetMs, hangMs)` 与 `TaskParams.hangMs`，供端到端自测。

### UI
- `src/components/AnalysisPanel.tsx`（接到 `src/App.tsx`）：开始 / 暂停 / 恢复 / 取消 / 重新开始按钮、状态横幅（paused 明确提示“在途继续入库、停止派发、恢复断点续跑”）、进度（含失败数）、当前池大小、后端、批次号、已用时、按 taskId 排序的结果列表（error 行可见）。

## 2. 偏离点（相对原设计/常规模板，列出理由）

1. **池模块从单例数组改为 `PoolManager` + 传输层抽象**。
   理由：动态扩缩要求运行期增删 Worker；抽出 `WorkerFactory` 是为在 Node（worker_threads）下做确定性自测。生产仍走真实模块 Worker，R1/R2 的“批次结束 terminate 全池”“HMR dispose 清理”语义保留（并改为跟踪所有 manager 兜底清理）。未改变 §1.2 选型结论。

2. **任务注册表对“未知 taskId”提供 Proxy 回退**（按入参现算）。
   理由：自测需要任务集之外的任意 taskId（合成小批次 / 僵死任务）。生产 500 个静态 id 全部直接命中原表，回退不改变生产执行路径与结果；worker 侧不再因未知 id 抛错。

3. **store 把“可派发”与“批次存活”拆成两个谓词**（原实现只有 `isCurrentBatch`）。
   理由：暂停需求要求“paused 不收新任务但收在途结果”，单一 running 判定无法同时表达二者。保留了 `isCurrentBatch` 别名（= isLiveBatch）兼容既有调用方。

以上均不触碰 `docs/worker-batch-design.md` 的方案结论（执行模型 C、注册表、结构化克隆、useSyncExternalStore、terminate 硬取消 + 世代校验、主线程降级、clamp[2,16] 等全部保留）。

## 3. 自测证据（零 npm 依赖）

两套，均不依赖第三方库（Node 24 内置 strip-types / worker_threads / WebSocket；浏览器用系统缓存的 headless chromium + CDP）。

- Node 真线程（worker_threads，真实 terminate）：`npm run selftest:node`
  - 34 项断言，覆盖：暂停后在途入库且无新派发、恢复断点续跑不重复、暂停排空后恢复不卡死、扩容新建、缩容只回收空闲（`terminate 时在途任务=0` 铁证）、僵死重试一次后 error、重新开始世代隔离。
- 真实 headless Chromium 端到端（真实模块 Worker）：`npm run selftest:browser`（先 build）
  - 暂停/恢复 500 任务（完成 500、unique 500）、真实批次自动扩容日志、缩容场景（8 池/2 长任务只回收空闲、在途结果齐全）、看门狗僵死 error 行可见、暂停中重新开始新批次恰好 500。

脚本：`selftest/node-selftest.mts`、`selftest/nodeTransport.ts`、`selftest/node-worker-bootstrap.mjs`、`selftest/ts-loader.mjs`、`selftest/browser-cdp.mjs`；页面内桥 `src/selftest/browserHarness.ts`（仅 `?selftest=` 参数激活，生产路径不激活）。
