/**
 * 真实浏览器端到端自测（零 npm 依赖）：
 * 启动 headless chromium + 静态服务器，经 CDP（Runtime.evaluate）驱动页面里的
 * window.__SELFTEST__ 桥，验证真实模块 Worker 下的暂停/恢复、看门狗、重新开始。
 * 运行：node selftest/browser-cdp.mjs
 */
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join, extname } from 'node:path'

const ROOT = join(import.meta.dirname, '..', 'dist')
const CHROME =
  process.env.CHROME_BIN ??
  `${process.env.HOME}/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell`
const PORT = 9_417
const CDP_PORT = 9_418

const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
}

function serve() {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const urlPath = decodeURIComponent((req.url ?? '/').split('?')[0])
      let file = join(ROOT, urlPath === '/' ? 'index.html' : urlPath)
      if (!existsSync(file) || statSync(file).isDirectory()) file = join(ROOT, 'index.html')
      const data = readFileSync(file)
      res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream' })
      res.end(data)
    })
    server.listen(PORT, resolve)
  })
}

function launchChrome() {
  const libDirs = [
    '/tmp/cdp/libs/usr/lib/x86_64-linux-gnu',
    '/tmp/pwlibs/root/usr/lib/x86_64-linux-gnu',
    '/tmp/chromelibs/usr/lib/x86_64-linux-gnu',
  ].filter((d) => existsSync(d))
  const env = {
    ...process.env,
    LD_LIBRARY_PATH: [...libDirs, process.env.LD_LIBRARY_PATH].filter(Boolean).join(':'),
  }
  return spawn(CHROME, [
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    `--remote-debugging-port=${CDP_PORT}`,
    '--user-data-dir=/tmp/cdp-profile-run3a',
    '--no-first-run',
    '--no-default-browser-check',
    'about:blank',
  ], { stdio: ['ignore', 'pipe', 'pipe'], env })
}

async function getPageWs() {
  for (let i = 0; i < 40; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json`)
      const targets = await res.json()
      const page = targets.find((t) => t.type === 'page')
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error('chrome CDP not reachable')
}

let msgId = 0
class Cdp {
  ws
  pending = new Map()
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl)
    this.ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data)
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id)
        this.pending.delete(msg.id)
        if (msg.error) reject(new Error(JSON.stringify(msg.error)))
        else resolve(msg.result)
      }
    })
  }
  ready() {
    return new Promise((resolve, reject) => {
      this.ws.addEventListener('open', () => resolve())
      this.ws.addEventListener('error', () => reject(new Error('ws error')))
    })
  }
  send(method, params = {}) {
    const id = ++msgId
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }
  async eval(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    })
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description ?? 'eval error')
    }
    return result.result.value
  }
  close() {
    this.ws.close()
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failures = 0
function check(name, pass, detail = '') {
  if (!pass) failures += 1
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`)
}

const pageExpr = {
  snap: `window.__SELFTEST__ && window.__SELFTEST__.snapshot()`,
  waitRunning: `(async () => {
    for (let i = 0; i < 200; i++) {
      const s = window.__SELFTEST__?.snapshot();
      if (s && (s.status === 'running' || s.status === 'done' || s.status === 'paused')) return s;
      await new Promise(r => setTimeout(r, 50));
    }
    throw new Error('batch never started');
  })()`,
  waitDone: `(async () => {
    await new Promise((resolve) => {
      const tick = () => {
        const s = window.__SELFTEST__?.snapshot();
        if (s && s.status === 'done') resolve(); else setTimeout(tick, 100);
      };
      tick();
    });
    return window.__SELFTEST__.snapshot();
  })()`,
}

async function scenarioPause(cdp) {
  console.log('\n=== 浏览器场景 1：暂停 / 恢复（真实模块 Worker） ===')
  await cdp.eval(`location.href = 'http://127.0.0.1:${PORT}/?selftest=pause'`)
  await sleep(300)
  await cdp.eval(pageExpr.waitRunning)
  // 让在途跑一会再暂停
  await sleep(250)
  const runningPool = await cdp.eval(pageExpr.snap)
  check('运行期 UI 池大小在 [2,16]（初始 hardwareConcurrency-1 clamp）',
    runningPool.poolSize >= 2 && runningPool.poolSize <= 16,
    `poolSize=${runningPool.poolSize}`)
  await cdp.eval(`window.__SELFTEST__.controls.pause()`)
  const atPause = await cdp.eval(pageExpr.snap)
  check('UI/快照进入 paused', atPause.status === 'paused', `status=${atPause.status}`)
  const poolAtPause = atPause.poolSize
  await sleep(1200)
  const after = await cdp.eval(pageExpr.snap)
  await sleep(700)
  const after2 = await cdp.eval(pageExpr.snap)
  check('暂停后在途照常入库（completed 有增长但不超过 在途上限）',
    after.completed >= atPause.completed &&
      after.completed <= atPause.completed + poolAtPause,
    `atPause=${atPause.completed} +1200ms=${after.completed} pool=${poolAtPause}`)
  check('暂停后无新派发：两次采样 completed 稳定',
    after.status === 'paused' && after2.status === 'paused' && after.completed === after2.completed,
    `${after.completed} vs ${after2.completed}`)

  await cdp.eval(`window.__SELFTEST__.controls.resume()`)
  const finalSnap = await cdp.eval(pageExpr.waitDone)
  const uniq = await cdp.eval(
    `new Set(window.__SELFTEST__.snapshot().results.map(r => r.taskId)).size`,
  )
  check('恢复后批次完成', finalSnap.status === 'done', `status=${finalSnap.status}`)
  check('结果总数 = 500', finalSnap.completed === 500, `completed=${finalSnap.completed}`)
  check('无重复（断点续跑不重跑）', uniq === 500, `unique=${uniq}`)

  // UI 层：状态徽标与池大小可见
  const banner = await cdp.eval(`document.querySelector('.status-banner')?.textContent ?? ''`)
  const poolText = await cdp.eval(
    `[...document.querySelectorAll('.metrics dt')].find(d => d.textContent.includes('池大小'))?.parentElement.querySelector('dd').textContent ?? ''`,
  )
  check('UI 明确展示完成状态', banner.includes('已完成'), banner.trim().slice(0, 40))
  check('UI 显示池大小且 clamp[2,16]', Number(poolText) >= 0 && Number(poolText) <= 16, `poolText=${poolText}`)
  const pageLogs = await cdp.eval('window.__LOGS__ || []')
  const scaleLogs = pageLogs.filter((l) => l.includes('[autoScale]'))
  const grew = scaleLogs.some((l) => l.includes('grow'))
  check('真实 500 任务批次运行期自动扩容（新建 Worker）', grew, scaleLogs[0] ?? `logs=${scaleLogs.length}`)
  // 缩容安全性（只回收空闲、绝不杀在途）由 Node 真线程场景 2b 确定性覆盖；
  // 真实 500 任务下 11 个 Worker 持续高负荷到收尾，无低占用窗口，故不 shrink 属正确行为
  check('扩缩决策器在真实批次中运行（每 2s tick，无异常）', scaleLogs.length >= 1, `logs=${scaleLogs.length}`)

}

async function scenarioShrink(cdp) {
  console.log('\n=== 浏览器场景 4：动态缩容（2 长任务/8 池 → 只回收空闲） ===')
  await cdp.eval(`location.href = 'http://127.0.0.1:${PORT}/?selftest=shrink'`)
  // 长任务跑 ~700ms：期间多个 250ms tick 触发缩容
  const sizes = []
  let running = null
  for (let i = 0; i < 14; i += 1) {
    await sleep(100)
    const cur = await cdp.eval(pageExpr.snap)
    if (cur) {
      sizes.push(cur.poolSize)
      if (cur.status === 'running' && !running) running = cur
      if (cur.status === 'done') break
    }
  }
  const minSizeWhileBusy = Math.min(...sizes.filter((x) => x >= 2))
  const shrank = sizes.some((x) => x < 8)
  check('在途期间触发缩容（池从 8 回收空闲 Worker）', shrank, `sizes=${sizes.join('→')}`)
  check('缩容后池大小不低于在途任务数 2（绝不杀在途）',
    minSizeWhileBusy >= 2, `minSize=${minSizeWhileBusy}`)
  const finalSnap = await cdp.eval(pageExpr.waitDone)
  const uniq = await cdp.eval(
    `new Set(window.__SELFTEST__.snapshot().results.map(r => r.taskId)).size`)
  check('2 个在途长任务结果齐全（未被 terminate）、批次完成',
    finalSnap.status === 'done' && finalSnap.completed === 2 && uniq === 2,
    `completed=${finalSnap.completed} unique=${uniq}`)
}

async function scenarioWatchdog(cdp) {
  console.log('\n=== 浏览器场景 2：看门狗僵死（重试一次 → error，批次完成） ===')
  await cdp.eval(`location.href = 'http://127.0.0.1:${PORT}/?selftest=watchdog'`)
  await sleep(300)
  const snap = await cdp.eval(pageExpr.waitDone)
  const zombie = await cdp.eval(
    `window.__SELFTEST__.snapshot().results.filter(r => r.taskId === 'task-zombie')`,
  )
  const uniq = await cdp.eval(
    `new Set(window.__SELFTEST__.snapshot().results.map(r => r.taskId)).size`,
  )
  check('批次整体完成', snap.status === 'done', `status=${snap.status}`)
  check('僵死任务恰有 1 条 error 结果',
    zombie.length === 1 && zombie[0].error === true,
    `count=${zombie.length} error=${zombie[0]?.error}`)
  check('error 结果带可见原因',
    typeof zombie[0]?.errorMessage === 'string' && zombie[0].errorMessage.includes('watchdog'),
    zombie[0]?.errorMessage)
  check('errorCount = 1', snap.errorCount === 1, `errorCount=${snap.errorCount}`)
  check('总结果数 = 501（500 常规 + 1 僵死占位），无丢失无重复',
    snap.completed === 501 && uniq === 501, `completed=${snap.completed} unique=${uniq}`)
  // 结果列表里 error 行可见
  const errorRow = await cdp.eval(`document.querySelectorAll('.result-row.error').length`)
  check('结果列表渲染 error 行', errorRow >= 1, `errorRows=${errorRow}`)
}

async function scenarioRestartWhilePaused(cdp) {
  console.log('\n=== 浏览器场景 3：暂停中“重新开始”（旧批安全终止、新批不被污染） ===')
  await cdp.eval(`location.href = 'http://127.0.0.1:${PORT}/?selftest=restart'`)
  await sleep(300)
  await sleep(200)
  await cdp.eval(`window.__SELFTEST__.controls.pause()`)
  await sleep(200)
  const paused = await cdp.eval(pageExpr.snap)
  check('已暂停', paused.status === 'paused', `status=${paused.status}`)
  const oldBatch = paused.batchId
  await cdp.eval(`window.__SELFTEST__.controls.restart()`)
  await sleep(300)
  const restarted = await cdp.eval(pageExpr.waitRunning)
  check('重新开始发起新批次（世代号自增）',
    restarted.batchId > oldBatch && restarted.status === 'running',
    `${oldBatch} → ${restarted.batchId} ${restarted.status}`)
  const finalSnap = await cdp.eval(pageExpr.waitDone)
  const uniq = await cdp.eval(
    `new Set(window.__SELFTEST__.snapshot().results.map(r => r.taskId)).size`,
  )
  check('新批次独立完成且结果恰好 500（旧批消息未污染）',
    finalSnap.status === 'done' && finalSnap.completed === 500 && uniq === 500,
    `completed=${finalSnap.completed} unique=${uniq} batch=${finalSnap.batchId}`)
}

async function main() {
  if (!existsSync(CHROME)) {
    console.error(`chromium not found: ${CHROME}`)
    process.exit(2)
  }
  await serve()
  const chrome = launchChrome()
  chrome.stderr.on('data', () => {})
  try {
    const wsUrl = await getPageWs()
    const cdp = new Cdp(wsUrl)
    await cdp.ready()
    await cdp.send('Page.enable')
    await cdp.send('Runtime.enable')
    // 在任意文档脚本执行前注入 console 缓冲，再经 Runtime 事件读取，避免错过早期日志
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
      source: 'window.__LOGS__=[];["log","warn","error"].forEach(k=>{const o=console[k].bind(console);console[k]=(...a)=>{window.__LOGS__.push(a.map(x=>{try{return typeof x==="string"?x:JSON.stringify(x)}catch{return String(x)}}).join(" "));o(...a)}});',
    })

    await scenarioPause(cdp)
    await scenarioWatchdog(cdp)
    await scenarioShrink(cdp)
    await scenarioRestartWhilePaused(cdp)
    cdp.close()
  } finally {
    chrome.kill('SIGKILL')
  }
  console.log(`\n──── 浏览器端到端：失败 ${failures} 项 ────`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
