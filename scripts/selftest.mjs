/**
 * 零依赖无头自测驱动（Node >= 24：内置 WebSocket / fetch）。
 * 1) 启动 vite dev server
 * 2) 启动 chrome-headless-shell（远程调试端口）
 * 3) CDP 打开 /?selftest=1，收集 console 日志，轮询 window.__batchTestResult
 * 4) 打印断言结果；全部通过退出码 0，否则 1
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'

function pickFreePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.unref()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address()
      srv.close(() => resolve(port))
    })
  })
}
const CHROME =
  process.env.CHROME_BIN ||
  `${process.env.HOME}/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome`
const CHROME_LIBS =
  process.env.CHROME_LIB_DIR || '/tmp/deps/usr/lib/x86_64-linux-gnu'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let idSeq = 0

function wsSend(ws, method, params = {}) {
  const id = ++idSeq
  ws.send(JSON.stringify({ id, method, params }))
  return id
}

async function wsEval(ws, expression) {
  const id = wsSend(ws, 'Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: false,
  })
  return new Promise((resolve, reject) => {
    const onMsg = (event) => {
      const msg = JSON.parse(event.data.toString())
      if (msg.id !== id) return
      ws.removeEventListener('message', onMsg)
      if (msg.error) return reject(new Error(JSON.stringify(msg.error)))
      resolve(msg.result?.result?.value)
    }
    ws.addEventListener('message', onMsg)
  })
}

async function waitForHttp(url, timeoutMs = 20000, init) {
  const t0 = Date.now()
  for (;;) {
    try {
      const res = await fetch(url, init)
      if (res.ok) return res
    } catch {
      /* retry */
    }
    if (Date.now() - t0 > timeoutMs) throw new Error(`server not ready: ${url}`)
    await sleep(200)
  }
}

async function main() {
  const PORT = process.env.SELFTEST_PORT ? Number(process.env.SELFTEST_PORT) : await pickFreePort()
  const cdpPort = await pickFreePort()
  const userDataDir = mkdtempSync(join(tmpdir(), 'batch-selftest-'))
  const children = []
  let failed = false
  try {
    const viteBin = join(process.cwd(), 'node_modules', '.bin', 'vite')
    const vite = spawn(viteBin, ['--port', String(PORT), '--strictPort'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    children.push(vite)
    vite.stdout.on('data', (d) => process.stdout.write(`[vite] ${d}`))
    vite.stderr.on('data', (d) => process.stderr.write(`[vite] ${d}`))

    const chrome = spawn(
      CHROME,
      [
        '--headless=new',
        '--no-sandbox',
        '--disable-gpu',
        `--remote-debugging-port=${cdpPort}`,
        `--user-data-dir=${userDataDir}`,
        'about:blank',
      ],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          LD_LIBRARY_PATH: [CHROME_LIBS, process.env.LD_LIBRARY_PATH].filter(Boolean).join(':'),
        },
      },
    )
    children.push(chrome)
    chrome.stderr.on('data', (d) => {
      const line = d.toString()
      if (/DevTools listening|worker/i.test(line)) process.stdout.write(`[chrome] ${line}`)
    })

    await waitForHttp(`http://localhost:${PORT}/`)
    await waitForHttp(`http://127.0.0.1:${cdpPort}/json/version`)

    // PUT /json/new 先建空白页（新版 Chrome 要求 PUT），连上 CDP enable 域后再导航，
    // 确保 console / 异常日志一条不丢
    const targetRes = await fetch(
      `http://127.0.0.1:${cdpPort}/json/new?${encodeURIComponent('about:blank')}`,
      { method: 'PUT' },
    )
    if (!targetRes.ok) throw new Error(`create target failed: ${targetRes.status}`)
    const target = await targetRes.json()

    const ws = new WebSocket(target.webSocketDebuggerUrl)
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true })
      ws.addEventListener('error', reject, { once: true })
    })

    const consoleLines = []
    wsSend(ws, 'Runtime.enable')
    wsSend(ws, 'Log.enable')
    wsSend(ws, 'Page.enable')
    wsSend(ws, 'Network.enable')
    await sleep(200)
    const pageUrl = `http://localhost:${PORT}/`
    wsSend(ws, 'Page.navigate', { url: pageUrl })

    const methods = new Set()
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data.toString())
      if (msg.method) methods.add(msg.method)
      if (msg.method === 'Runtime.consoleAPICalled') {
        const text = (msg.params.args || [])
          .map((a) => (a.value !== undefined ? String(a.value) : a.description || ''))
          .join(' ')
        consoleLines.push(text)
        if (text.startsWith('[selftest]') || text.startsWith('[runner]')) console.log(text)
      }
      if (msg.method === 'Runtime.exceptionThrown') {
        const detail = msg.params.exceptionDetails
        console.log('[page-exception]', detail?.exception?.description || detail?.text)
      }
      if (msg.method === 'Network.loadingFailed') {
        console.log('[net-fail]', JSON.stringify(msg.params))
      }
      if (msg.method === 'Log.entryAdded') {
        console.log('[browser-log]', msg.params.entry?.level, msg.params.entry?.text, msg.params.entry?.url)
      }
    })

    // 等首屏渲染与自测 API 就绪，再由 CDP 显式触发自测
    const readyDeadline = Date.now() + 30000
    let ready = false
    while (Date.now() < readyDeadline) {
      const readyRaw = await wsEval(
        ws,
        'JSON.stringify({api: !!window.__batchTest, run: typeof window.__runBatchSelfTest, panel: !!document.querySelector(".analysis-panel")})',
      )
      if (readyRaw) {
        const r = JSON.parse(readyRaw)
        if (r.api && r.run === 'function' && r.panel) {
          ready = true
          break
        }
      }
      await sleep(300)
    }
    if (!ready) {
      console.log('SELFTEST ABORT: page/self-test API not ready')
      throw new Error('not-ready')
    }
    console.log('[selftest] page ready; invoking __runBatchSelfTest()')
    const invokeId = wsSend(ws, 'Runtime.evaluate', {
      expression: 'window.__runBatchSelfTest()',
      awaitPromise: true,
      returnByValue: true,
    })
    const invokeResult = await new Promise((resolve) => {
      const onMsg = (event) => {
        const msg = JSON.parse(event.data.toString())
        if (msg.id !== invokeId) return
        ws.removeEventListener('message', onMsg)
        resolve(msg)
      }
      ws.addEventListener('message', onMsg)
    })
    console.log('[selftest] invoke returned:', JSON.stringify(invokeResult.result || invokeResult.error || {}).slice(0, 200))

    const deadline = Date.now() + 120000
    let result = null
    while (Date.now() < deadline) {
      const raw = await wsEval(ws, 'JSON.stringify(window.__batchTestResult || null)')
      if (raw) {
        result = JSON.parse(raw)
        break
      }
      await sleep(500)
    }
    if (!result) {
      console.log('SELFTEST TIMEOUT: no __batchTestResult')
      const diag = await wsEval(
        ws,
        'JSON.stringify({url: location.href, hasApi: !!window.__batchTest, ready: document.readyState, rootHtml: (document.getElementById("root")||{}).innerHTML, scripts: [...document.scripts].map(s=>s.src||"inline")})',
      )
      console.log('[diag]', diag)
      console.log('[diag] observed CDP events:', [...methods].join(','))
      failed = true
    } else {
      console.log('\n================ 自测断言结果 ================')
      for (const check of result.checks) {
        console.log(`${check.pass ? 'PASS' : 'FAIL'}  ${check.name}`)
        console.log(`      ${check.detail}`)
      }
      console.log('==============================================')
      console.log(`总计 ${result.checks.filter((c) => c.pass).length}/${result.checks.length} 通过`)
      failed = !result.ok
    }

    ws.close()
  } finally {
    for (const child of children) child.kill('SIGTERM')
    await sleep(300)
    for (const child of children) {
      if (!child.killed) child.kill('SIGKILL')
    }
    rmSync(userDataDir, { recursive: true, force: true })
  }
  process.exit(failed ? 1 : 0)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
