# 计算批次 Worker 化：性能优化与技术设计方案

- 仓库基线：React 19.3.0 / ReactDOM 19.3.0 / Vite 8.3 / TypeScript 6.0.2 / oxlint，零第三方运行时依赖
- 场景：单次批次 500 个纯计算函数，单任务 5ms~800ms，串行合计约 90s
- 验收：执行期 60fps 可交互；结果流式上屏；可中途取消且无浪费计算；4 核与 16 核均有合理吞吐
- 约束：不新增 npm 依赖；除第 6 节外不含实现代码

---

## 1. 执行模型选型

### 1.1 四条路线量化对比

下表中的数字均为**基于任务模型的推算值**，每个数字后标注测量方法（M1~M4），落地前必须用真实任务集复测。

| 维度 | A. 主线程 time-slicing | B. 单 Worker | C. Worker 池 | D. SAB + 原子锁 |
|---|---|---|---|---|
| 60fps 可交互 | ❌ 单任务最长 800ms，同步函数不可切片，必然掉帧（M1） | ✅ 主线程零计算 | ✅ 主线程零计算 | ✅ 主线程零计算 |
| 4 核总耗时（推算） | ≈90s + 切片调度损耗 | ≈90s（串行） | ≈90s / 3 ≈ 30s（M2） | ≈30s，与 C 同量级 |
| 16 核总耗时（推算） | ≈90s | ≈90s | ≈90s / 15 ≈ 6s + 尾部长任务（M2） | ≈6s，与 C 同量级 |
| 取消粒度 | 任务间（长任务内不可取消） | 任务间 / terminate | 任务间 / terminate | 任务间 / terminate |
| 通信开销 | 无 | postMessage，µs 级/条（M3） | postMessage，µs 级/条 × 500（M3） | 近零（共享内存），但需跨源隔离 |
| 部署约束 | 无 | 无 | 无 | COOP/COEP 响应头，破坏未隔离的第三方脚本/iframe |
| 实现复杂度 | 低 | 低 | 中（队列 + 分发 + 回收） | 高（手写调度协议、Atomics 竞态） |

测量方法：

- **M1（帧率）**：Chrome DevTools Performance 面板录制执行期，统计 dropped frames；或用 `requestAnimationFrame` 时间戳差值直方图，>32ms 的间隔即为肉眼可感知卡顿。800ms 同步任务必然产生 ≥1 个 800ms 的帧间隔，A 路线一票否决。
- **M2（吞吐）**：以 `performance.now()` 记录批次起止与每任务起止。并行加速比上限 = `min(可用核数, 500)`，实际受最长任务（800ms）尾部效应限制：16 核时理论 6s，但最后一个 800ms 任务决定下界，实测预期 6~7s。4 核预留 1 核给主线程，池大小取 `hardwareConcurrency - 1`。
- **M3（消息开销）**：对代表性任务描述对象（<1KB）与结果对象做 1000 次 `postMessage` 往返计时取中位数。预期单向 µs~数十 µs 级，相对 5~800ms 的任务体占比 <0.1%，可忽略——这正是 D 路线"省通信"价值不成立的量化依据。
- **M4（核数自适应）**：在 DevTools 中将 CPU 节流 4×/6× 模拟低端机，并分别在 4 核与 16 核物理机跑 M2，验证池大小策略 `navigator.hardwareConcurrency - 1` 的吞吐曲线。

### 1.2 最终选型：C. Worker 池（唯一结论）

- **否决 A**：纯计算同步函数无法 time-slice，800ms 长任务直接击穿 60fps 验收线，无补救手段。
- **否决 B**：不利用多核，16 核机器上 90s 与 4 核相同，违反"高端设备合理吞吐"验收标准。
- **否决 D**：SAB + Atomics 的唯一收益是省掉 postMessage 开销，而 M3 证明该开销占比 <0.1%；代价却是强制跨源隔离（`Cross-Origin-Opener-Policy: same-origin` + `Cross-Origin-Embedder-Policy: require-corp`），会导致页面内未带 CORP 头的第三方资源全部加载失败，且需手写基于 `Atomics.wait/notify` 的调度协议，竞态风险高。收益/代价比不成立。
- **选择 C**：动态任务队列 + `hardwareConcurrency - 1` 个 Worker，任务级 work-stealing（主线程统一发任务，Worker 完成一个领一个），天然适配 5~800ms 的异构耗时——不存在静态切分导致的"快核等慢核"问题；取消时 `terminate()` 可硬杀在途任务；无任何部署约束。

---

## 2. 任务分发设计

### 2.1 约束：函数不可结构化克隆

`postMessage` 走结构化克隆算法，`Function` 类型不在可克隆类型列表中。若任务函数定义在主线程并直接 `postMessage(fn)`，会同步抛出 `DataCloneError: ... could not be cloned`。闭包更不会"随函数一起过去"——闭包捕获的外部变量本质上是主线程堆上的引用，跨线程无共享堆（不引入 SAB 的前提下）。

### 2.2 方案一：任务注册表 + 可序列化参数（选定）

- 机制：500 个计算函数定义在一个**主线程与 Worker 共同 import 的模块**中，导出为 `{ [taskId]: (params) => result }` 注册表。主线程只发送 `{ taskId, params }`（`params` 必须可结构化克隆），Worker 收到后查表执行。
- 对"闭包引用外部变量"的处理：这是一次有意的重构——把闭包捕获显式化为函数入参。纯计算函数的捕获值按定义是输入数据，显式化后反而提升可测试性。
- 安全性：Worker 只执行仓库内静态代码，无动态求值，CSP 无需放开 `unsafe-eval`。
- 工程风险：低。风险点仅在于开发者把不可克隆值（DOM 节点、函数、类实例方法）塞进 `params`，由 TypeScript 类型约束（params 声明为可克隆类型）+ 开发期一次 `DataCloneError` 即可暴露。
- 与 Vite 8 的契合：共享模块被主包与 Worker 包分别打包，Vite 自动处理；HMR 时 Worker 模块随主模块一起失效重建（见第 7 节风险）。

### 2.3 方案二：函数体序列化 + 动态求值（否决）

- 机制：`fn.toString()` 得到源码字符串，postMessage 到 Worker 后用 `new Function(code)` / `eval` / Blob URL `importScripts` 还原执行。
- 安全性：差。要求 CSP 放开 `unsafe-eval`；源码字符串在构建期会被 minify，函数内引用的模块作用域标识符（import 的辅助函数、常量）在 Worker 侧全部解析失败——`toString()` 只保留函数体文本，**闭包与模块作用域一并丢失**，这恰好是本场景（函数引用外部变量）的致命伤。
- 工程风险：高。sourcemap 断裂导致 Worker 内报错无法定位；TS 类型系统在字符串边界完全失效；Vite 8 生产构建的标识符压缩使该方案在 dev 能跑、prod 必炸。

### 2.4 结论

采用方案一（注册表 + 可序列化参数）。方案二在本场景"函数引用外部变量"的前提下从根源上不成立，且引入 CSP 与构建期风险。

---

## 3. 数据回流设计

### 3.1 结构化克隆开销的量化评估

- 测量方法：构造代表性结果对象（按演示场景假设为数十~数百字节的小对象：数值、短字符串、小数组），在主线程内用 `structuredClone` 跑 10000 次取 p50/p99；同时用 `postMessage` 回环（Worker 原样回传）测端到端延迟。两者相减即序列化/反序列化之外的通道开销。
- 预期结论（需实测确认）：小对象克隆为 µs 级，500 个结果合计 <5ms，且分散在数十秒的批次周期内，对 60fps 无影响。
- 决策阈值：单结果对象序列化后 **>1MB**（典型如大数组、图像 buffer）时，克隆开销进入 ms~十 ms 级，才需要考虑替代方案。

### 3.2 各替代方案的适用条件

- **Transferable（ArrayBuffer 转移）**：零拷贝，但所有权随之转移（Worker 侧 buffer 失效），且要求结果本身就是二进制或先序列化为二进制——对结构化结果对象反而多一次手动编解码。仅当单结果为大体积二进制（>1MB，如计算生成的 Float32Array）时启用。
- **SharedArrayBuffer**：零拷贝且可双向读写，但触发跨源隔离部署要求（见 1.2），本场景结果体量完全不值得。
- **只回传索引**：适用于"结果已存在于主线程可访问的共享存储、Worker 只写回位置"的架构——该架构本身依赖 SAB，与本方案选型冲突，不适用。

### 3.3 结论

**直接 postMessage 回传结果对象（结构化克隆），不引入 Transferable / SAB / 索引回传。** 依据：结果对象小（<1KB 量级），克隆开销经 3.1 方法实测预期占比 <0.1%；简单性换来取消协议（第 5 节）与内存管理（第 7 节）的可靠性。若未来出现大体积二进制结果，按 3.2 的阈值条件局部升级为 Transferable，不影响整体架构。

---

## 4. 与 React 19 的集成

### 4.1 状态管理选型：useSyncExternalStore（唯一结论）

三方向对比：

- **useSyncExternalStore（选定）**：Worker 结果天然是 React 之外的外部数据源（由 `onmessage` 事件驱动）。用一个手写 store（约 50 行，零依赖）持有结果数组与进度，`subscribe` 由消息缓冲的 flush 回调触发，`getSnapshot` 返回不可变快照引用。React 19 并发渲染下该 API 保证 tearing-free，且渲染可被中断——正好匹配"流式高频更新 + 页面保持可交互"。
- **useReducer + Context（否决）**：每条 Worker 消息触发一次 dispatch，Context value 变更导致整棵订阅树重渲染。500 条消息在数秒内到达时，未细粒度订阅的组件（计数器、按钮）被无谓卷入渲染；要规避就得手写选择器/分片 Context，复杂度反超手写 store。
- **外部状态库（否决）**：硬性约束不引入新 npm 依赖，zustand/jotai/redux 均不可用；且对本场景属于杀鸡用牛刀。

### 4.2 useTransition 与 useDeferredValue 的分工

- **useTransition**：用于**批次生命周期动作**——"开始分析"点击后初始化 Worker 池、重置结果集合并置 `isPending`；以及取消后清理状态。这些更新不紧急（用户不需要在 16ms 内看到池建好），包进 `startTransition` 后，计数器点击等紧急更新可插队，保证交互零阻塞。
- **useDeferredValue**：用于**派生视图**——结果列表的过滤/排序/统计摘要（如"已完成 237/500，平均耗时 182ms"）。结果快照高频变化时，派生计算与长列表渲染用延迟值兜底，React 19 会先渲染旧派生值、后台算新值，避免输入框/滚动被派生渲染阻塞。
- 注意边界：结果列表本体由 store 快照直接驱动（这是验收要求的"流式上屏"，不能延迟）；`useDeferredValue` 只包派生物，不包原始结果流，否则违反"每完成一批就更新 UI"。

### 4.3 高频流式更新的批处理

- **React 19 自动批处理的边界**：自动批处理只合并**同一个宏任务/事件回调内**的多次 setState。每条 Worker `onmessage` 是独立宏任务，500 条消息 = 500 个宏任务，React 无法跨宏任务合并——若每条消息都直接通知 store，最坏情况触发 500 次渲染调度。这就是必须手动批处理的原因。
- **手动批处理策略**：主线程 `onmessage` 只把结果 push 进缓冲区，不通知；用 `requestAnimationFrame`（或 50ms 定时器，取先到者）做 flush——每帧最多一次 `store.notify()`，快照替换为新的不可变数组。500 条结果 → 实际渲染次数 ≈ 批次秒数 × 60 的上限，且每帧渲染量恒定。
- 与验收标准的对应："每完成一批就更新 UI"中的"一批"即一次 rAF flush（最多 16.7ms 延迟），人眼无感知，满足流式要求。

---

## 5. 取消与竞态

### 5.1 协议层取消设计

核心事实：**Worker 中正在执行的同步函数无法被任何消息中断**（`onmessage` 要等当前同步代码让出事件循环才派发）。因此取消协议分两层：

- **队列层（软取消）**：主线程清空未分发任务队列，并向各 Worker 发 `{ type: 'cancel', batchId }`。Worker 在完成当前任务、回传结果后、领取下一任务前检查取消标记，停止领新任务。已在跑的当前任务会跑完——这是软取消的固有代价（最长浪费一个 800ms 任务 × 池大小）。
- **进程层（硬取消）**：若验收要求"取消后不产生浪费的计算"，直接 `worker.terminate()`——浏览器强制回收 Worker 线程，在途同步函数立即终止，CPU 即刻释放。代价是池销毁，下次开始需重建（Worker 冷启动实测约 10~50ms/个，M2 方法可测，相对批次总耗时可忽略）。
- **选定策略**：**terminate 硬取消 + 惰性重建**。理由：验收标准明确"不产生浪费的计算"，软取消必然浪费最多 N 个在途任务；纯计算函数无副作用，硬杀无状态损坏风险；重建成本可忽略。

### 5.2 迟到结果的丢弃

- 竞态窗口：`terminate()` 调用前 Worker 已 `postMessage` 但主线程尚未派发 `onmessage`；或软取消路径下在途任务完成后回传。
- 机制：**批次世代号（batchId / epoch）**。每发起一批自增，所有任务消息与结果消息都携带 batchId；主线程 store 持有 currentBatchId，`onmessage` 中 `msg.batchId !== currentBatchId` 直接丢弃。terminate 后旧 Worker 实例的回调闭包同时被解除引用（removeEventListener / 置 null），双保险。
- 结果乱序：Worker 池下结果本就乱序到达，快照按 taskId 定位写入，不依赖到达顺序；UI 按 taskId 排序渲染。

---

## 6. 降级与兼容

### 6.1 依赖的浏览器能力与检测

| 能力 | 检测方式 | 缺失时的降级路径 |
|---|---|---|
| `Worker` | `typeof Worker !== 'undefined'` | 降级为主线程任务间切片（每任务间 `scheduler.yield()` 或 setTimeout(0) 让出），接受长任务掉帧，功能可用 |
| 模块 Worker（`type: 'module'`） | 见 6.2 检测片段 | Vite 8 构建产物默认输出模块 Worker；老浏览器由 Vite 构建期 `worker.format: 'iife'` 兜底（构建配置，非运行时降级） |
| `structuredClone` | `typeof structuredClone === 'function'` | 本方案不直接调用它（postMessage 内部克隆由浏览器实现，无需显式 API），无需降级 |
| `navigator.hardwareConcurrency` | `Number.isFinite(navigator.hardwareConcurrency)` | 缺省回退池大小 4（保守值），上限钳制 16 |
| `SharedArrayBuffer` | `typeof SharedArrayBuffer !== 'undefined' && crossOriginIsolated` | 本方案不依赖 SAB，仅作记录：SAB 要求响应头 `Cross-Origin-Opener-Policy: same-origin` 与 `Cross-Origin-Embedder-Policy: require-corp`，且页面 `crossOriginIsolated === true` 才可用 |
| `scheduler.yield()` | `'scheduler' in window && 'yield' in scheduler` | 降级路径中回退为 `setTimeout(0)` |

### 6.2 Vite 8 下 Worker 的正确实例化

```ts
// src/workers/analysis.worker.ts —— Worker 入口（模块语法，可直接 import 共享任务注册表）
import { taskRegistry } from '../tasks/registry'

self.onmessage = (e: MessageEvent<{ taskId: string; params: unknown; batchId: number }>) => {
  const { taskId, params, batchId } = e.data
  const result = taskRegistry[taskId](params)
  self.postMessage({ taskId, batchId, result })
}
```

```ts
// 主线程实例化：Vite 8 推荐 new URL + import.meta.url 形式
function createWorker(): Worker {
  return new Worker(new URL('./workers/analysis.worker.ts', import.meta.url), {
    type: 'module',
  })
}
```

```ts
// 模块 Worker 特性检测（老浏览器回退到非 Worker 路径）
function supportsModuleWorkers(): boolean {
  let supported = false
  try {
    const tester = {
      get type() { supported = true; return 'module' as const },
    }
    // 构造即检测：不支持的浏览器会静默忽略 type 或抛错
    new Worker('data:text/javascript,', tester as WorkerOptions)
  } catch { /* ignore */ }
  return supported
}
```

说明：Vite 8 对 `new URL('./x.worker.ts', import.meta.url)` 在 dev 下走原生模块 Worker，build 下自动打包为独立 chunk；`?worker` 后缀导入写法同样支持，二者取其一即可，本方案统一用 `new URL` 形式（TS 6 下类型推导更直接）。

---

## 7. 风险清单

| # | 风险 | 严重度 | 说明与缓解 |
|---|---|---|---|
| R1 | **Worker 内存膨胀** | 高 | 500 个任务若在 Worker 内累积中间数据（闭包缓存、模块级数组），堆只增不减。缓解：每批结束 terminate 全池重建（与取消路径复用同一重建逻辑）；Worker 内禁止模块级可变缓存。 |
| R2 | **HMR 下 Worker 失效/泄漏** | 中 | Vite dev 下编辑共享任务模块会触发主页面 HMR，但已创建的 Worker 实例仍跑旧代码；组件重挂载若重建池而不 terminate 旧池，Worker 泄漏累积。缓解：池生命周期绑定在模块级单例 + `import.meta.hot.dispose` 中 terminate 全部。 |
| R3 | **hardwareConcurrency 虚报** | 中 | 容器/VM 中该值反映宿主机而非配额；移动 SoC 大小核（big.LITTLE）下 8 核≠8 倍吞吐。缓解：池大小钳制 `[2, 16]`；按 M4 实测曲线校准，而非信任理论值。 |
| R4 | **尾部长任务拖尾** | 中 | 动态分发下若 800ms 任务在最后时刻才被领取，总耗时 = 前 499 个并行耗时 + 800ms。缓解：按预估耗时降序入队（长任务先跑），将拖尾压缩到最短任务量级；预估用历史实测或静态标注。 |
| R5 | **React 19 StrictMode 双执行** | 中 | dev 下 StrictMode 双调用 effect，若批次启动写在 effect 中会发起两批、建两个池。缓解：批次启动只由用户事件触发，不进 effect；池单例以 batchId 幂等。 |
| R6 | **迟到结果竞态** | 低 | terminate 与 onmessage 派发之间的窗口期（见 5.2）。缓解：batchId 世代校验 + 解除监听双保险，已内建于协议。 |
| R7 | **消息风暴下的主线程积压** | 低 | 16 核时 500 条结果集中在数秒内到达，若每条都同步触发布局/渲染会掉帧。缓解：4.3 的 rAF 合帧批处理，每帧最多一次渲染。 |
| R8 | **Safari 模块 Worker 兼容性** | 低 | Safari 15+ 才支持模块 Worker，且历史上 `import.meta.url` 在 Worker 内有边界 bug。缓解：6.2 特性检测 + 主线程切片兜底路径；验收设备矩阵中明确最低 Safari 版本。 |

---

## 附：方案总览（一页结论）

- 执行模型：**Worker 池**，大小 `clamp(hardwareConcurrency - 1, 2, 16)`，动态队列分发，长任务先入队。
- 任务下发：共享模块**任务注册表**，消息只携带 `taskId + 可克隆参数`。
- 结果回流：**结构化克隆直传**，主线程 rAF 合帧后单次通知 store。
- React 集成：手写零依赖 store + `useSyncExternalStore`；`useTransition` 管批次生命周期，`useDeferredValue` 管派生视图。
- 取消：`terminate()` 硬取消 + 惰性重建 + batchId 世代校验丢弃迟到结果。
- 降级：无 Worker → 主线程任务间切片；无模块 Worker → 构建期 iife 或主线程兜底。
