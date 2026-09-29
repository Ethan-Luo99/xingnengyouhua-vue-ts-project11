# 500 任务批量分析 — Worker 池方案设计文档

- 目标栈锚定：React **19.3.0**、`react-dom` **19.3.0**、Vite **8.3.0**、TypeScript **6.0.2**（`tsconfig.app.json` 中 `target: es2023`、`moduleResolution: bundler`、`erasableSyntaxOnly`）。
- 零新增依赖：仅使用浏览器原生能力（Worker / structured clone / Atomics / Auto-Reset / 原生流）与现有栈。
- 批次参数：约 500 个纯计算函数，单任务 5ms~800ms（跨度 160 倍），串行合计约 90s；要求 60fps 不卡、流式上屏、可取消、4 核与 16 核设备都有合理吞吐。


---

## 1. 执行模型选型

### 1.1 量化对比表

下表所有"倍数/耗时"均为**待实测占位值**，测量方法见 1.3；本表只给可证伪的相对关系，不凭空填绝对数字。

| 维度 | A. 主线程 time-slicing | B. 单 Worker | C. Worker 池（本方案选型） | D. SAB + Atomics |
|---|---|---|---|---|
| 60fps 可交互 | 不可靠：scheduler 只切任务**之间**，单个 800ms 任务无法切片 → 该任务期间长任务、点击/滚动掉帧 | 好：计算全离主线程，主线程只做克隆+渲染 | 好：同 B，主线程更空闲 | 好（计算面）；但要求跨源隔离，且复杂度高 |
| 4 核吞吐 vs 串行 | ≈1×（切片不增加算力） | ≈1×（仅 1 个 worker） | ≈3×（3 计算 worker，留 1 核给主线程/合成；待实测） | ≈3×（同上限） |
| 16 核吞吐 vs 串行 | ≈1× | ≈1× | ≈8~15×（按 worker 数，待实测取最优） | ≈8~15×，但受 SAB 序列化/锁竞争影响，待实测 |
| 异构（5~800ms）负载均衡 | 无并行可言 | 队头阻塞：一个 800ms 任务独占 worker，后续全等 | work-stealing/动态拉取，长尾被摊薄（量化见 1.3 尾延迟指标） | 同样可动态分发，但锁竞争在高频小任务（5ms）上可能反噬 |
| 取消"不浪费计算" | 切片点可取消，几乎不浪费 | 在途任务不可中断，**最多浪费 1 个任务（≤800ms）** | 在途任务每 worker ≤1 个，**最多浪费 W 个（≈ W×800ms 最坏）**，概率上远低 | 同 C，且需自行做 flag 检查点，800ms 纯同步仍不可中断 |
| 流式上屏 | 切片点可回流，可行 | 串行完成顺序回流，可行但慢 | 每个任务完成即回流，天然流式 | 需轮询/wake 通知，原生消息通道反而被绕过 |
| 结构化克隆开销 | 无 | 1 条通道，克隆总量同任务量 | W 条通道并发克隆，单条更短，主线程分摊 | 可做到零克隆（共享内存），这是 D 的唯一硬优势 |
| 工程复杂度 / TS 6 类型成本 | 低 | 低 | 中：池管理、协议、竞态 | 高：内存布局、同步原语、跨源隔离、边界安全 |
| 部署前置条件 | 无 | 无 | 无（经典 Worker 全浏览器支持） | 必须 COOP/COEP 跨源隔离；企业代理/老设备会失效 |
| 内存 | 最低 | 1 份 worker 堆 | W 份 worker 堆（风险见第 7 节） | 共享 1 份缓冲，但每 worker 仍各有栈/模块副本 |
| 可降级性 | 本身即降级终点 | 强 | 强（worker 数可退化到 1） | 差（隔离缺失即整体不可用） |

关键事实（非量化，可直接锚定）：
- **Worker 无法中断一个正在运行的同步函数**。5ms~800ms 的任务粒度下单任务最长 800ms，这决定了 C/D 取消时的"在途浪费上界"。
- 本场景是**CPU 密集**，不是共享内存密集；500 条结果对象的克隆是"每任务一次、低频、小载荷"，D 消除克隆的收益小（见第 3 节实测），而其跨源隔离成本是全局的、不可逆的。
- time-slicing 对**单任务 800ms**无解（除非要求每个计算函数内部协作式 yield，侵入 500 个函数，违反"纯计算函数不改"的隐含前提），直接淘汰 A。
- B 在 16 核设备上浪费 15 个核，违反"高端设备合理吞吐"，淘汰 B。

### 1.2 最终选型：C — 固定大小 Worker 池 + 动态任务拉取

唯一取舍，不做"组合使用/视情况而定"：

1. **Worker 数 `W = min(navigator.hardwareConcurrency - 1, 8)`，下限 1**。4 核 → 3 worker；16 核 → 8（封顶，超过 8 对这种 ms 级任务是上下文切换与克隆竞争的负收益，封顶值 8 本身也要在目标机实测校准，见 1.3）。始终留 1 核给主线程保证 60fps。
2. **动态分发（pull 模式）**：主线程持有任务队列，worker 完成一个就 post 回结果并立即请求下一个（或主线程按"保持每 worker 在途 ≤2"的小窗口推送）。异构耗时下这天然负载均衡，避免静态均分出现"某 worker 分到多个 800ms"的长尾。
3. 主线程只做：队列调度、克隆、状态存储、React 渲染。绝不在主线程执行 500 个函数中的任何一个。

**不选 D 的决定性理由（三条，均锚定本场景）**：
- 结果是 500 个**异构对象**而非定长数值数组，用 SAB 需要为每种结果设计二进制布局（或外挂字符串表），工程量与 TS 6 类型维护成本高，而克隆实测若只占总耗时个位数百分比（测量见 3.2），收益不成立。
- COOP/COEP 是**整站级**降级约束（所有跨源资源、图片、CDN、内嵌页都要配合 CORS/CORP），演示级需求不应把全站锁进跨源隔离。
- D 的取消、流式通知仍要回到消息通道或 Atomics.waitAsync，没有简化任何核心难题。

### 1.3 每个量化断言的测量方法（无数字，只给协议）

- **并行加速比**：实现 4 条路线的最小可运行基准（或至少 A/B/C），在 4 核与 16 核真机各跑 3 次完整 500 批次，`performance.now()` 包住 `start→全部完成`，`加速比 = 串行基线墙钟 / 方案墙钟`。
- **worker 数扫描**：W 取 1..`hardwareConcurrency`，逐档测总墙钟与 P95 帧时长，画"吞吐-W 曲线"和"掉帧-W 曲线"，8 这个封顶必须由曲线拐点证实或修正，不许拍脑袋。
- **60fps 指标**：分析进行中持续点击计数器 + 程序化滚动，用 `PerformanceObserver` 采集 `longtask`（entryType `longtask`，>50ms 计数）和 `event`/`interaction`（INP），以及 rAF 帧间隔 P95；验收线：0 个 >100ms 长任务、帧间隔 P95 ≤ ~20ms（120Hz 设备按其帧预算换算）。
- **尾延迟/负载均衡**：记录每 worker 的忙碌时间，`负载不均度 = max(忙碌) − min(忙碌)`，对比"静态 500/W 均分"与"动态拉取"。
- 所有基准跑在 `vite build` 后的 `vite preview`（生产构建、关闭 HMR、固定 CPU 调频或至少同温度状态），避免 dev 模式与热节流污染。


---

## 2. 任务分发设计

### 2.1 约束：函数无法跨 postMessage 边界

`postMessage` 使用**结构化克隆算法（structured clone）**，可克隆：对象、数组、Map/Set、ArrayBuffer/TypedArray、Date、RegExp 等；**不可克隆：函数（含闭包）、DOM 节点、类实例的原型链/方法、Error 子类、带函数属性的对象**。对含函数的对象调用会抛 `DataCloneError: ... could not be cloned`。

因此如果 500 个函数定义在主线程、且是闭包（引用外部变量），直接 `postMessage(fn)` 必然失败。关键区分两层：

- **函数本体（代码）**：根本不经过克隆，必须以"Worker 里本来就有这份代码"的方式到达。
- **函数的输入数据/参数（含闭包捕获的值）**：这些是数据，可以结构化克隆。

真正要解决的是把"闭包捕获的外部变量"显式化为**可克隆的参数**，而不是搬运函数。

### 2.2 "函数本体"到达 Worker 的至少两种可行方案

**方案 ① 静态任务注册表（本方案采用）**
把 500 个纯计算函数实现为独立模块（如 `src/tasks/registry.ts`），**不引用任何主线程单例/DOM/React 状态**，导出一个 `id → handler` 的注册表；Worker 用 ESM 静态 `import` 同一份模块。主线程只 postMessage `{ id: 42, payload: {...可克隆参数...} }`，Worker 查 `registry[id](payload)`。
- 闭包外部变量：在主线程构建任务时把捕获值**求值后放入 `payload`**（闭包 → 显式数据），在构建点用 TS 类型约束 payload 必须可克隆（见 2.3）。
- 安全性：Worker 不 `eval` 外来代码，代码路径全部在打包产物内、受 CSP 约束，最安全。
- 工程风险：要求任务函数"纯化"，不能直接闭包主线程活对象（如 `Map` 实例、回调），需要一次性重构；注册表是静态的，任务集需在构建期已知（本场景满足：固定约 500 个）。

**方案 ② 源码字符串 + Worker 内 `new Function`/`eval`（拒绝，但需说明）**
主线程把函数 `fn.toString()` 当字符串传过去，Worker 端 `new Function('payload', body)` 重建；外部变量仍需另传数据快照。
- 安全性：等同于远程代码执行，任何用户/服务端可影响的源码进 Worker 即 XSS 级风险；且必须放开 Worker 的 `script-src 'unsafe-eval'` CSP。
- 工程风险：`toString()` 拿不到闭包词法环境（拿到也无法重建绑定），babel/TS 转译、箭头函数、class 私有字段、模块依赖全部会坏；不可静态分析、不可 tree-shake。仅适合完全自包含且可信的表达式，**本项目明确不用**。

**其他可提的变体（不作为主选）**：
- 动态 `import()` 已知模块 URL（仍是静态代码白名单的一种，能力介于①②之间，适合任务集按懒加载分片）。
- `importScripts`（经典 Worker）：Vite/ESM 下不优先。

### 2.3 可克隆性的编译期保障

利用 TS 6 在 `tsconfig.app.json` 已开启的严格能力，定义跨线程消息类型时约束载荷为结构化克隆可表达的类型（原始值、普通对象/数组、`ArrayBuffer`/TypedArray、`Date`、`Map`、`Set` 及其递归组合，**禁止函数/符号/DOM 类型**）。注意 TS 类型系统不能 100% 阻止运行期 `Proxy`/函数混入，运行时仍以构建任务处的纯化约定为准；可用一次性开发态断言（尝试 `postMessage` 自克隆一份或 `structuredClone(payload)` 自测）在 dev 下早暴露，不进生产热路径。


---

## 3. 数据回流设计

### 3.1 结构化克隆开销如何量化（方法，不预设数字）

对"500 个结果对象逐条 postMessage 回主线程"测量克隆+入队成本，分两端测：

- **发送端（Worker 内）成本**：`const t0 = performance.now(); postMessage(msg); const t1 = performance.now();` —— 注意 `postMessage` 返回时克隆**可能尚未全部完成**（浏览器实现可能把克隆分摊），故这只是下界，需配合下面的总量法。
- **总量法（推荐主口径）**：固定不渲染、空 message 回调，跑完整 500 批次得到墙钟 T_a；改为回传**等数量但极小载荷**（仅 `{id}`）得到 T_b；`T_a − T_b` 近似"真实结果载荷的克隆+传输"净成本（任务计算量两次相同可抵消）。再除以 500 得单任务均摊。
- **对象大小基线**：先统计真实结果对象的字段与字节规模。JSON 长度是粗糙代理，更准的是用代表性样本在隔离页里 `performance.mark/measure` 包住 `structuredClone(obj)` 直接测纯克隆 CPU 时间（这是标准 `structuredClone` 全局函数，特性见第 6 节）。
- **判定阈值**：当克隆净成本 / 总墙钟 < 5%（实测得出，不是假设）即维持普通克隆；超过约 10% 或克隆在主线程造成可观测长任务（见 1.3 的 longtask 观测）才升级方案。

补充：结构化克隆发生在**发起 postMessage 的线程**，回流时克隆发生在 **Worker**，主线程主要承担反序列化+事件派发。因此回流克隆的大头本就不压主线程；主线程侧成本用空 vs 真实载荷的 message 处理时间同样能量化。

### 3.2 升级条件与本项目选择

| 方案 | 适用条件 | 成本/风险 |
|---|---|---|
| **普通结构化克隆（本项目默认）** | 单结果对象小（KB 级）、每任务只回一次、总 500 次 | 零额外复杂度；克隆在 worker 侧，主线程仅小反序列化 |
| **Transferable**（`ArrayBuffer`/`MessagePort`/…） | 结果是**大块二进制**（如几 MB~数百 MB 的 TypedArray、图像/音频/采样缓冲） | 转让后 worker 侧缓冲**失权**（detach），逻辑要保证不再用；对象元数据仍需克隆 |
| **SharedArrayBuffer** | 结果为**定长数值流**、需双向高频读写、克隆确成瓶颈 | 需跨源隔离（第 6 节）；要自管偏移量、对齐、字符串异构对象难表达、需 Atomics 同步 |
| **只回传索引/差异** | 结果可由"任务 id + 状态枚举 + 少量标量"表达，或大块数据留在 worker/共享内存 | 回流载荷最小；但要求主线程能凭 id 取到详情，详情不在主线程时需二次拉取协议 |

**本项目选择：普通结构化克隆回流 `{ batchId, id, status, result | error }`，并做时间批处理（见第 5 节）**。理由：结果是 500 个异构对象、每任务仅一次回流、属于低频小载荷，3.1 预期克隆占比个位数（须实测证伪）；不满足 Transferable 的"大块二进制"前提，也不满足 SAB 的"定长高频"前提。**只有当 3.1 实测越过阈值，才按此优先级演进：先"只回传索引/标量 + 必要时批量"，再对个别大字段用 Transferable；整批 SAB 是最后选项**（且会触发第 6 节跨源隔离，默认不启用）。

批量回流协议（配合第 5 节流式节奏）：worker 不每条都发，而是攒一个微批（如"最多 K 条或距上次 ≤ Δms"，K/Δ 由第 5 节实验定），一次 `postMessage(arrayOfResults)`，把 N 次克隆/事件摊成 1 次。注意这仍是流式（多批），不是最后一次性 500 条。


---

## 4. 与 React 19.3 的集成

### 4.1 状态驱动渲染选型

三方向中选定 **`useSyncExternalStore`（React 19.3 内置 hook）对接一个框架外的批次编排器 store**。

| 方向 | 结论 | 理由 |
|---|---|---|
| **useSyncExternalStore + 外部 store** | **选用** | Worker 消息来自 React 事件系统之外的 `message` 宏任务，外部 store（一个纯 TS 编排器类）天然承载；该 hook 正是为"外部可变数据源订阅 + 防撕裂快照"设计，React 19.3 下并发渲染读取外部状态不会撕裂；零依赖。 |
| useReducer + Context | 不用 | 500 条高频流式结果经 Context 会让**所有消费者重渲染**，需手工拆 context/做选择器，等于重造 store；reducer 的 dispatch 从 worker 消息回调触发可行，但订阅粒度与快照一致性要自己补。 |
| 外部状态库（Zustand/Redux 等） | 不用 | 硬性约束"不引入任何新 npm 依赖"；且 `useSyncExternalStore` 已覆盖所需订阅能力，无引入必要。 |

store 契约要点（不写实现代码，仅约定）：
- `subscribe(fn)`：注册 rAF 合并后的通知（见 4.3），返回退订函数。
- `getSnapshot()`：必须返回**引用稳定的不可变快照**（结果数组仅在新批次时换引用），否则 React 19.3 会因快照不等价进入重复渲染循环。
- `startBatch()` / `cancel()`：命令式入口，供按钮事件调用。
- 选择器粒度：列表区订阅"结果数组 + 进度"，计数器等无关组件不订阅该 store，从结构上保证分析期间计数器零重渲染。

### 4.2 useTransition / useDeferredValue 各自的位置

必须区分：**`useSyncExternalStore` 触发的外部 store 更新不能被包进 transition 变成可中断渲染**（外部源变更必须同步收敛以防撕裂）。所以并发 API 用在"派生/交互"层，而不是原始 worker 数据层：

- **`useTransition`**：用于用户主动发起的、会导致大块列表变化的**非紧急更新**，典型是"开始分析"后挂载结果列表视图、以及对 500 条结果做筛选/切换排序/切换 tab。把这类 `setState` 放进 `startTransition`，渲染长列表时计数器点击、输入仍保持紧急优先（`isPending` 可驱动按钮态）。它解决的是"协调大量结果 DOM 时的交互饥饿"。
- **`useDeferredValue`**：用于把"参与大列表渲染的值"（如筛选关键字、或从 store 快照派生的完整列表）延后一帧消费，紧急更新（计数器、滚动、输入回显）先用旧值，空闲再追平。它解决的是"高频结果到达 + 用户正在交互"时的让渡。与 4.3 的源节流叠加：源节流限制更新频率，`useDeferredValue` 处理单帧内仍可能过重的渲染。
- 对**流式进度/新增条目的呈现本身不包 transition**：那是外部 store 的同步快照，直接渲染即可；要控频率在 4.3 解决。

### 4.3 高频流式更新的批处理与 React 19 自动批处理边界

React 19.3 自动批处理事实（锚定版本，不沿用旧表述）：
- React 18 起自动批处理已覆盖 `setTimeout`/Promise/原生事件/异步回调（不再局限于 React 合成事件），React 19.3 保持该语义。
- **边界**：自动批处理以"同一次事件循环调度"为单位。每个 worker `message` 是**独立的宏任务**，因此跨多个 message 事件的更新**不会**被 React 19.3 自动合并；一个 message 内的多次 `setState` 才会同批。worker 若每条结果发一个 message，就是 500 次独立调度 → 500 次潜在提交，自动批处理救不了。

因此批处理必须做在**源头（store 订阅层）**，两层叠加：
1. **Worker 侧微批**（第 3.2 节）：每 ≤K 条或 ≤Δms 合并为一条 message，减少跨线程事件数。
2. **Store 侧 rAF 合并（关键）**：worker message 到达只更新内部缓冲并 `requestAnimationFrame` 调度一次通知；同一帧内再多 message 也只换一次快照、只通知一次 → 每帧最多一次 React 提交，把上屏频率钉在显示刷新率（60fps 设备即 ≤60 次/秒），且天然对齐 vsync，不与绘制争抢。组件拿到的是"截至本帧累计的全部新结果"，满足流式（分批可见）而非末批 500 条。

K/Δ 的量化标定（测量协议，不预设值）：用 rAF 节流为主，Δ 以"一帧预算"为上限（60Hz≈16.7ms）；K 通过实验取"单帧列表增量渲染耗时 ≤ 帧预算的 ~50%（留余量给交互）"的最大批量，用 React Profiler（React 19.3 DevTools Profiler）读每次提交的 actual duration，结合 1.3 的 longtask/帧 P95 联合定标。


---

## 5. 取消与竞态

### 5.1 不可中断的事实与浪费上界

Worker 一旦进入某个同步函数，主线程**无法抢占**；`worker.terminate()` 能强杀整个 worker（代价是销毁其堆/模块上下文，需重建），但不能"只取消当前一个任务"。本方案单任务最长 800ms，故协议必须围绕"**协作式取消 + 在途上界**"设计，而不是依赖强中断。

### 5.2 协议层面的取消设计

每条任务与每个批次携带单调标识：`batchId`（一次"开始分析"一个，建议 `crypto.randomUUID()`）+ `taskId`（500 内固定索引或唯一 id）。

取消流程（**不停机复用 worker**）：
1. 用户点取消 → 主线程 store 置 `status='cancelling'`，关闭任务分发闸门（不再给任何 worker 发新任务）。
2. 向所有 W 个 worker 广播一条控制消息 `{ type: 'cancel', batchId }`。
3. 每个 worker 在**任务边界**检查取消位：完成当前在途任务后，**不再向主线程请求/接受下一个**，直接进入 idle 并回 `{ type:'cancelled', batchId }`。
4. 对任务**内部存在天然分段循环**的少数长任务（仅限能改的），在循环检查点读取消标志，提前 break 并返回 `aborted`；对不可改的纯同步黑盒，接受其跑到自然结束。
5. 收齐 W 个 worker 的 `cancelled` 回执（或等其当前任务结束）后，store 置 `status='cancelled'`，回收 worker 到池（keep-alive，不 terminate）。

在途浪费上界（可直接给出，源自任务参数）：取消瞬间每 worker 至多 1 个在途任务，**最坏浪费 ≈ W × 800ms 的 CPU**（4 核 W=3 → 2.4s；16 核 W=8 → 6.4s 的总核时，但墙钟上因并行仍约 ≤800ms 即全部停下）。这是协议无法消除的物理上界；工程上保证"**不发放新任务**"从而不浪费其余数百个任务的计算，这才是大头。

若业务要求取消必须秒级生效（无法容忍 800ms 在途）：唯一手段是对该 worker `terminate()` 后重建，但重建有模块重新加载成本，仅对"用户连点/整批废弃"使用，不作为常规路径。本方案常规取消不 terminate。

### 5.3 迟到结果的丢弃（竞态）

所有回流消息在主线程入口做**双重门控**，任一不满足即静默丢弃：
- `msg.batchId === currentBatchId`（旧批次残留一律丢——覆盖"取消后又重新开始"的批次叠加）。
- `store.status` 不为 `cancelling/cancelled`，或该 taskId 仍在"在途白名单"内（取消后到达的结果即便 batchId 相同也丢弃，不写入快照、不渲染）。

由于快照是 rAF 合并换引用，取消发生时把缓冲中尚未 flush 的结果整批清空即可，不会有半个批次上屏。`taskId` 去重集合防止重复回执造成重复条目。整个判定在**进入 store 前**完成，被丢弃的消息不触发任何订阅通知（不引起渲染）。

### 5.4 重启竞态
"取消→立刻重新开始"会产生新 `batchId`；旧 worker 回执与旧迟到结果凭旧 id 全部命中 5.3 丢弃；新批次开始前确保分发闸门与取消位复位（可带一个 `epoch` 自增数随消息透传，worker 只认最新 epoch），避免上一轮控制消息误杀新一轮任务。


---

## 6. 降级与兼容

### 6.1 依赖的浏览器能力清单

| 能力 | 用途 | 是否本方案必需 | 备注 |
|---|---|---|---|
| Web Worker（经典 Worker，`window.Worker`） | 后台计算载体 | **必需** | 支持度极广；不可用时走 6.2 主线程降级 |
| **Worker 模块语法**（`new Worker(url, { type: 'module' })`） | 让 Worker 直接 ESM `import` 注册表/共享类型，配合 Vite 打包 | 选用（首选） | 现代 Chromium/Firefox/Safari 均支持；Vite 8 dev 用 ESM、build 产出正确分块 |
| 结构化克隆（postMessage 内置） | 传 payload/结果 | **必需**（随 Worker 一起可用） | Worker 场景天然具备，无需单独检测 |
| `structuredClone` 全局函数 | 仅 dev 自测 payload 可克隆性 | 可选 | 现代浏览器均有；不可用则跳过该开发断言 |
| `navigator.hardwareConcurrency` | 决定 W | 选用（有默认） | 可能缺失/被指纹策略置 0/谎报，需兜底 |
| `requestAnimationFrame` | 上屏节流对齐 vsync | 必需（主线程环境本就有） | 后台标签页会被暂停，见第 7 节 |
| `crypto.randomUUID()` | batchId | 可选（可降级） | 不可用时用自增计数器 |
| **SharedArrayBuffer + Atomics** | 仅在第 3 节阈值触发、升级共享内存时才需要 | **非必需（默认不启用）** | 依赖**跨源隔离**：响应头 `Cross-Origin-Opener-Policy: same-origin` + `Cross-Origin-Embedder-Policy: require-corp | credentialless`；需 `self.crossOriginIsolated === true` |
| Transferable（postMessage 第二参） | 仅大二进制字段升级时 | 可选 | 现代浏览器支持 |
| 动态 `import()` | 仅任务分片懒加载变体 | 可选 | 模块 worker 内可用 |

### 6.2 特性检测与降级路径（逐级，不并列和稀泥）

1. **首选：模块 Worker 池**。检测 `typeof Worker !== 'undefined'`，并尝试以 `{ type: 'module' }` 实例化；`worker.onerror` 一次性回退。
2. **模块 worker 失败 → 经典 worker**：Vite 8 对 `new Worker(new URL('./x.worker.ts', import.meta.url), { type: 'classic' })` 也会打包成独立 chunk；注册表需写成不依赖 ESM 分包的自足入口（或由 Vite 打成 IIFE worker 产物）。
3. **Worker 整体不可用（极少数老旧 WebView/特殊 CSP）→ 主线程 time-slicing 降级器**：复用**同一注册表与同一 store 协议**，在主线程用"每任务之间让出一帧/`MessageChannel` 切片"执行，保证功能完整与流式/取消（任务边界可取消），仅放弃并行与对单任务 800ms 的流畅保证——此时明确提示"当前环境性能降级"。这是功能保底，不是性能达标。
4. **SAB 升级路径独立门控**：仅当 `self.crossOriginIsolated === true` **且**第 3.1 实测越阈值才启用；否则永远走结构化克隆，**不为本需求主动给整站加 COOP/COEP**。
5. **`hardwareConcurrency` 兜底**：缺失/≤1 时 `W=1`（即退化单 worker，仍优于主线程）；并对其值做合理上限（第 1 节封顶 8）。
6. 能力检测在应用启动时执行一次，结果存入运行时常量；worker 创建失败、`error` 事件、消息协议版本不符都要能触发对应降级与用户可见的错误态，而非白屏。

### 6.3 Vite 8 下 Worker 的正确实例化写法（本小节允许代码）

Vite 8 推荐用 `new URL('./..., import.meta.url)` + `new Worker(..., { type: 'module' })`，Vite 在 build 时会把该 worker 及其依赖切成独立产物，dev 下走原生 ESM worker。不要用字符串 URL（`new Worker('/x.js')`，dev/build 路径不一致）也不要靠 `?worker` 插件后缀（可用但非必需；`new URL` 形式最稳、TS 6 类型最好）。

```ts
// src/workers/pool.ts
import type { WorkerRequest, WorkerResponse } from './protocol'

function createWorker(): Worker {
  // Vite 8: 静态可分析的 new URL + import.meta.url，build 自动分 chunk
  return new Worker(new URL('./analysis.worker.ts', import.meta.url), {
    type: 'module',
    name: 'analysis-worker', // DevTools 里可读，便于排查
  })
}

const concurrency = navigator.hardwareConcurrency ?? 1
const WORKER_COUNT = Math.max(1, Math.min(concurrency - 1, 8))

// 线程间消息类型（payload 仅允许结构化克隆可表达的类型，见 2.3）
export function postTask(w: Worker, msg: WorkerRequest) {
  // 大 ArrayBuffer 才用第二参 transfer；本方案默认不 transfer
  w.postMessage(msg)
}
export function onResponse(handler: (msg: WorkerResponse) => void) {
  // 每个 worker 绑定同一个分流函数，按 batchId/taskId 在 store 入口去重/丢弃
}
```

Worker 入口用 ESM 静态导入注册表（代码随包到达，满足第 2 节方案①）：

```ts
// src/workers/analysis.worker.ts
import { registry } from '../tasks/registry'
import type { WorkerRequest, WorkerResponse } from './protocol'

let cancelled = false
let currentBatch = ''

self.onmessage = (e: MessageEvent<WorkerRequest>) => {
  const msg = e.data
  if (msg.type === 'cancel') {
    if (msg.batchId === currentBatch) cancelled = true
    return
  }
  if (msg.type === 'run') {
    currentBatch = msg.batchId
    cancelled = false
    const fn = registry[msg.taskId]
    // 纯同步执行；取消只在任务边界生效（第 5 节）
    const result = fn(msg.payload)
    const res: WorkerResponse = cancelled
      ? { type: 'result', batchId: msg.batchId, taskId: msg.taskId, status: 'aborted' }
      : { type: 'result', batchId: msg.batchId, taskId: msg.taskId, status: 'ok', result }
    ;(self as DedicatedWorkerGlobalScope).postMessage(res)
  }
}
```

> 生产构建注意：Vite 8 默认 worker 走独立打包，需在 CI 用 `vite build` 确认 worker chunk 产出且资源相对路径正确；部署到子路径时配合 `base` 配置，避免 worker 脚本 404（见第 7 节）。

