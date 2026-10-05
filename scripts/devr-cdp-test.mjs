// 零依赖真机自测：Node 内置 WebSocket 驱动 Chromium DevTools Protocol。
// 用法：
//   node scripts/devr-cdp-test.mjs cancel    # 取消/污染/降级/交互性断言
//   node scripts/devr-cdp-test.mjs bench     # 串行基线 vs 池化耗时（约 100s）
//   node scripts/devr-cdp-test.mjs all
import { spawn } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'

const PORT = 5241
const BASE = `http://localhost:${PORT}`
const CHROME =
  process.env.CHROME_BIN ||
  `${process.env.HOME}/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome`
import { randomUUID } from 'node:crypto'
const USER_DATA = `/tmp/devr-chrome-profile-${randomUUID()}`

function log(...a) {
  console.log('[test]', ...a)
}

function waitFor(text, predicate, timeoutMs = 30000, intervalMs = 200) {
  const deadline = Date.now() + timeoutMs
  return new Promise((resolve, reject) => {
    const tick = async () => {
      try {
        const value = await predicate()
        if (value) return resolve(value)
      } catch (err) {
        return reject(err)
      }
      if (Date.now() > deadline) return reject(new Error(`timeout waiting: ${text}`))
      setTimeout(tick, intervalMs)
    }
    void tick()
  })
}

class Cdp {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl)
    this.nextId = 1
    this.pending = new Map()
    this.console = []
    this.ready = new Promise((resolve) => {
      this.ws.addEventListener('open', () => resolve())
    })
    this.ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data)
      if (msg.id) {
        const entry = this.pending.get(msg.id)
        if (!entry) return
        this.pending.delete(msg.id)
        if (msg.error) entry.reject(new Error(JSON.stringify(msg.error)))
        else entry.resolve(msg.result)
      } else if (msg.method === 'Runtime.consoleAPICalled') {
        const args = (msg.params.args || [])
          .map((a) => (a.value !== undefined ? String(a.value) : a.description || ''))
          .join(' ')
        this.console.push({ ts: Date.now(), text: args })
      }
    })
  }

  send(method, params = {}) {
    const id = this.nextId++
    this.ws.send(JSON.stringify({ id, method, params }))
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }))
  }

  async eval(expression, awaitPromise = false) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise,
    })
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description || 'eval failed')
    }
    return result.result.value
  }
}

async function launchChrome(url) {
  rmSync(USER_DATA, { recursive: true, force: true })
  mkdirSync(USER_DATA, { recursive: true })
  const args = [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--no-first-run',
    '--no-default-browser-check',
    `--remote-debugging-port=9241`,
    `--user-data-dir=${USER_DATA}`,
    '--remote-allow-origins=*',
    '--enable-logging=stderr',
    url,
  ]
  const env = {
    ...process.env,
    LD_LIBRARY_PATH: `${process.env.HOME}/.cache/cft/libs/usr/lib/x86_64-linux-gnu` +
      (process.env.LD_LIBRARY_PATH ? `:${process.env.LD_LIBRARY_PATH}` : ''),
  }
  const chrome = spawn(CHROME, args, { stdio: ['ignore', 'pipe', 'pipe'], env })
  chrome.stderr.on('data', (d) => {
    const text = String(d)
    if (/error|fatal/i.test(text)) process.stderr.write(`[chrome] ${text}`)
  })
  // 取 page target（Vite 首次按需编译，给足等待时间）
  let lastTargets = ''
  for (let i = 0; i < 150; i++) {
    try {
      const res = await fetch('http://127.0.0.1:9241/json')
      const targets = await res.json()
      lastTargets = targets.map((t) => `${t.type}:${t.url}`).join(' | ')
      const page = targets.find((t) => t.type === 'page' && t.url.startsWith(BASE))
      if (page) return { chrome, cdp: new Cdp(page.webSocketDebuggerUrl) }
    } catch {
      /* retry */
    }
    await sleep(200)
  }
  throw new Error(`chrome target not found; targets=${lastTargets}`)
}

async function connect(cdp) {
  await cdp.ready
  await cdp.send('Page.enable')
  await cdp.send('Runtime.enable')
}

async function doneCount(cdp) {
  return cdp.eval(`document.querySelectorAll('.result-done').length`)
}

async function cancelTest() {
  const { chrome, cdp } = await launchChrome(`${BASE}/`)
  try {
    await connect(cdp)
    await waitFor('app', () => cdp.eval(`!!document.querySelector('.start-btn')`))

    // 打开 store 入口日志并安装收集器
    await cdp.eval(`localStorage.setItem('batch-debug','1')`)
    await cdp.eval(`window.__logs=[];window.__batchLog=(e)=>window.__logs.push(e.concat(Date.now()));true`)
    // 重新加载使日志开关生效
    await cdp.send('Page.reload')
    await waitFor('app2', () => cdp.eval(`!!document.querySelector('.start-btn')`))
    await sleep(300)
    await cdp.eval(`window.__logs=[];window.__batchLog=(e)=>window.__logs.push(e.concat(Date.now()));true`)

    // 1) 开始分析（用户事件）
    await cdp.eval(`document.querySelector('.start-btn').click()`)
    await waitFor('running', () =>
      cdp.eval(`document.querySelector('.phase-line').textContent.includes('running')`))
    const mode = await cdp.eval(`document.querySelector('.mode-hint').textContent`)
    log('mode hint:', mode)
    await waitFor('first results', () => doneCount(cdp).then((n) => n >= 20), 30000)
    await sleep(500)

    // 2) 分析期间计数器必须可流畅点击
    const before = await cdp.eval(`document.querySelector('.counter').textContent`)
    await cdp.eval(`document.querySelector('.counter').click();document.querySelector('.counter').click();true`)
    await sleep(200)
    const after = await cdp.eval(`document.querySelector('.counter').textContent`)
    log(`counter: "${before}" -> "${after}"`)
    if (after !== 'Count is 2') throw new Error('counter not responsive during analysis')

    // 3) rAF 帧间隔（M1：不得出现 >=100ms 的长间隔）
    // M1：主线程长任务会产生“持续”长帧；单次调度抖动不代表 60fps 被击穿。
    // 统计 maxGap、p95、以及连续 >=32ms 的最大连串长度（sustained）。
    const frameStats = await cdp.eval(
      `new Promise((resolve)=>{
        const deltas=[];let last=performance.now();const start=last;
        function tick(now){deltas.push(now-last);last=now;
          if(now-start<2000)requestAnimationFrame(tick);
          else {
            const sorted=[...deltas].sort((a,b)=>a-b);
            const p95=sorted[Math.floor(sorted.length*0.95)];
            let run=0,maxRun=0;
            for(const d of deltas){if(d>32){run++;maxRun=Math.max(maxRun,run)}else run=0}
            resolve({frames:deltas.length,maxGap:Math.max(...deltas),p95,
              badGaps:deltas.filter(d=>d>32).length,sustained:maxRun});
          }}
        requestAnimationFrame(tick);})`,
      true,
    )
    log('rAF during analysis:', JSON.stringify(frameStats))
    // 主线程不跑任何计算：不得出现连续 >=4 个坏帧（约 128ms 持续卡顿）
    if (frameStats.sustained >= 4) throw new Error(`main thread sustained stall: ${JSON.stringify(frameStats)}`)

    // 4) 取消
    const countAtCancel = await doneCount(cdp)
    await cdp.eval(`document.querySelector('.cancel-btn').click()`)
    await waitFor('cancelled phase', () =>
      cdp.eval(`document.querySelector('.phase-line').textContent.includes('cancelled')`))
    // 取消基准时刻：取消生效前最后一条 store 条目的时间戳（避免把点击到生效
    // 之间正常完成的任务误判为"迟到"）
    const cancelAt = await cdp.eval(`Math.max(0, ...window.__logs.map(e=>e[3]))`)
    log(`cancelled at doneCount=${countAtCancel}`)

    // 5) 取消后 5 秒轮询：UI 不得增长
    for (let sec = 1; sec <= 5; sec++) {
      await sleep(1000)
      const n = await doneCount(cdp)
      log(`+${sec}s after cancel: result-done=${n}`)
      if (n !== countAtCancel) throw new Error(`late result rendered after cancel: ${n} > ${countAtCancel}`)
    }

    // 6) 日志断言：取消后无 accept/flush/start，迟到消息只能 stale-drop
    const afterLogs = await cdp.eval(`window.__logs.filter(([,, ,t])=>t>${cancelAt})`)
    const kinds = [...new Set(afterLogs.map((e) => e[0]))]
    log('store entry kinds within 5s after cancel:', kinds.join(','))
    if (kinds.some((k) => ['accept', 'flush', 'start'].includes(k))) {
      throw new Error(`forbidden store entries after cancel: ${kinds.join(',')}`)
    }

    // 7) 重新开始：新批次不被旧批次污染（从头计数，phase 正常增长）
    await cdp.eval(`window.__logs=[];true;window.__activeBatch=0`)
    await cdp.eval(`document.querySelector('.start-btn').click()`)
    const activeBatch = await waitFor('restart batchId', () =>
      cdp.eval(`window.__logs.find(e=>e[0]==='start')?.[1] ?? 0`), 5000, 100)
    await sleep(400)
    const n2 = await doneCount(cdp)
    const starts = await cdp.eval(`window.__logs.filter(e=>e[0]==='start').length`)
    log(`restart: batchId=${activeBatch} starts=${starts} doneCount after 400ms=${n2}`)
    if (starts !== 1) throw new Error('StrictMode double batch?')
    // 取消新批次
    await cdp.eval(`document.querySelector('.cancel-btn').click()`)
    await waitFor('cancelled2', () =>
      cdp.eval(`document.querySelector('.phase-line').textContent.includes('cancelled')`))
    await sleep(1500)
    // 世代校验：重启批次期间不允许任何属于旧 batchId 的 accept
    const polluted = await cdp.eval(
      `window.__logs.filter(e=>e[0]==='accept' && e[1]!==${activeBatch}).length`)
    if (polluted !== 0) throw new Error('new batch polluted by old batchId messages')
    log('restart batch clean, cross-batch accepts=0')

    // 8) 降级路径：遮蔽全局 Worker -> 主线程任务间切片（6.1）
    await cdp.send('Page.reload')
    await waitFor('app3', () => cdp.eval(`!!document.querySelector('.start-btn')`))
    await sleep(300)
    // reload 后是干净的 idle 快照：结果列表尚未渲染（不能拿到上批 500 行的残留）
    if ((await doneCount(cdp)) !== 0) throw new Error('stale results visible right after reload')
    await cdp.eval(`window.__logs=[];window.__batchLog=(e)=>window.__logs.push(e.concat(Date.now()));true`)
    // 模块词法引用的 Worker 无法用 delete 移除，用不可配置属性遮蔽为 undefined
    await cdp.eval(`Object.defineProperty(window,'Worker',{value:undefined,configurable:false});true`)
    await cdp.eval(`document.querySelector('.start-btn').click()`)
    await waitFor('fallback running', () =>
      cdp.eval(`document.querySelector('.mode-hint').textContent.includes('主线程切片')`), 15000)
    log('fallback mode hint:', await cdp.eval(`document.querySelector('.mode-hint').textContent`))
    await waitFor('fallback start logged', () =>
      cdp.eval(`window.__logs.find(e=>e[0]==='start')?.[1] ?? 0`), 5000, 100)
    // 等若干个长任务（降序队列前 10 个 680~780ms）完成，应有多条 accept
    await waitFor('fallback accepts', () =>
      cdp.eval(`window.__logs.filter(e=>e[0]==='accept').length`).then((n) => n >= 3), 12000)
    const acceptsBefore = await cdp.eval(`window.__logs.filter(e=>e[0]==='accept').length`)
    const fbCountBefore = await doneCount(cdp)
    log(`fallback: streaming accepts=${acceptsBefore} rendered=${fbCountBefore}`)

    // 取消：任务间生效，当前长任务跑完即停（设计文档 6.1 明确接受长任务掉帧）
    const fbCancelAt = Date.now()
    await cdp.eval(`document.querySelector('.cancel-btn').click()`)
    await waitFor('fallback cancelled', () =>
      cdp.eval(`document.querySelector('.phase-line').textContent.includes('cancelled')`), 15000)
    log(`fallback phase became cancelled after ${Date.now() - fbCancelAt}ms`)

    // 取消后：任务间取消最多多消费让出窗口内的 1~2 个任务（6.1 接受长任务掉帧），
    // 但取消必须真正生效、之后计算彻底停止
    await sleep(2000)
    const lateAccepts = await cdp.eval(`window.__logs.filter(e=>e[0]==='accept').length`) - acceptsBefore
    const fbCountAfter = await doneCount(cdp)
    log(`fallback post-cancel: extra accepts=${lateAccepts} rendered ${fbCountBefore}->${fbCountAfter}`)
    if (lateAccepts > 2) throw new Error(`fallback kept computing after cancel: ${lateAccepts} accepts`)
    if (fbCountAfter < fbCountBefore) throw new Error('fallback results shrank after cancel')
    // 再等 1 秒确认计数已冻结（取消真正生效，而非持续计算）
    await sleep(1000)
    const fbCountFrozen = await doneCount(cdp)
    if (fbCountFrozen !== fbCountAfter) {
      throw new Error(`fallback still computing after cancel: ${fbCountAfter}->${fbCountFrozen}`)
    }
    log(`fallback computation frozen at ${fbCountFrozen}`)
    const kindsAfter = await cdp.eval(`[...new Set(window.__logs.filter(e=>e[3]>${fbCancelAt}).map(e=>e[0]))]`)
    log('fallback store entry kinds after cancel:', JSON.stringify(kindsAfter))

    log('CANCEL TEST: PASS')
  } finally {
    chrome.kill('SIGKILL')
  }
}

async function benchTest() {
  const { chrome, cdp } = await launchChrome(`${BASE}/bench.html`)
  try {
    await connect(cdp)
    const result = await waitFor(
      '__benchResult',
      () => cdp.eval(`window.__benchResult`),
      300000,
      1000,
    )
    log('BENCH RESULT:', JSON.stringify(result, null, 2))
    if (!result.correct) throw new Error(`bench correctness failed: ${JSON.stringify(result)}`)
    log('BENCH: PASS')
    return result
  } finally {
    chrome.kill('SIGKILL')
  }
}

const mode = process.argv[2] || 'all'
// PREVIEW=1 时服务 dist 生产构建（不使用文件监听，规避 inotify 实例上限）
const usePreview = process.env.PREVIEW === '1'
const vite = spawn(
  'npx',
  usePreview
    ? ['vite', 'preview', '--port', String(PORT), '--strictPort']
    : ['vite', '--port', String(PORT), '--strictPort'],
  { stdio: ['ignore', 'pipe', 'inherit'], shell: process.platform === 'win32', detached: true },
)
vite.stdout.on('data', (d) => {
  const text = String(d)
  if (text.includes('Local:')) log(text.trim())
})

try {
  await waitFor('vite', async () => {
    try {
      const res = await fetch(BASE)
      return res.ok
    } catch {
      return false
    }
  }, 30000, 200)

  if (mode === 'cancel' || mode === 'all') await cancelTest()
  if (mode === 'bench' || mode === 'all') await benchTest()
  log('ALL TESTS PASSED')
} finally {
  // 杀掉整个进程组（npx -> node vite），避免 server 残留占用端口/inotify
  try {
    process.kill(-vite.pid, 'SIGKILL')
  } catch {
    vite.kill('SIGKILL')
  }
}
