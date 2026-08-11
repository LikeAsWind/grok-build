// Probe: 复现浏览器 session/load hang —— 同一连接先 session/new 再 session/load。
// 用法: node scripts/probe-load-hang.mjs <targetSessionId> [cwd] [--no-new]
const TARGET = process.argv[2]
const CWD = process.argv[3] || 'C:/Program Files/Development/AI_Projects/grok-build'
const SKIP_NEW = process.argv.includes('--no-new')
const TIMEOUT_MS = 8000

const ws = new WebSocket('ws://127.0.0.1:2420/ws?server-key=dev123')
let nextId = 1
const pending = new Map()

function req(method, params) {
  return new Promise((resolve, reject) => {
    const id = nextId++
    pending.set(id, { resolve, reject })
    const timer = setTimeout(() => {
      if (pending.has(id)) { pending.delete(id); reject(new Error(`TIMEOUT ${method} (${TIMEOUT_MS}ms 无响应)`)) }
    }, TIMEOUT_MS)
    pending.get(id).timer = timer
    ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
  })
}

ws.addEventListener('message', ev => {
  const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString())
  if (msg.id !== undefined && pending.has(msg.id)) {
    const { resolve, reject, timer } = pending.get(msg.id)
    clearTimeout(timer)
    pending.delete(msg.id)
    msg.error ? reject(new Error(`${msg.error.message ?? JSON.stringify(msg.error)}`)) : resolve(msg.result)
    return
  }
  if (msg.method === 'session/update') {
    const u = msg.params?.update
    if (u?.sessionUpdate && u.sessionUpdate !== 'agent_message_chunk' && u.sessionUpdate !== 'agent_thought_chunk') {
      console.log('  [update]', u.sessionUpdate)
    }
  }
})

function log(...a) { console.log(new Date().toISOString().slice(11, 23), ...a) }

ws.addEventListener('open', async () => {
  try {
    const init = await req('initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      _meta: { clientType: 'web', clientVersion: '0.1.0' },
    })
    log('initialize OK')
    const method = init?.authMethods?.[0]
    if (method) await req('authenticate', { methodId: method.id }).catch(e => log('auth warn:', e.message))
    log('authenticate OK')

    if (!SKIP_NEW) {
      log('>>> session/new ...')
      const created = await req('session/new', { cwd: CWD, mcpServers: [] })
      log('session/new OK →', created?.sessionId)
    }

    log('>>> session/load', TARGET, '...')
    const t0 = Date.now()
    try {
      await req('session/load', { sessionId: TARGET, cwd: CWD, mcpServers: [] })
      log(`session/load 返回 ✓ (${Date.now() - t0}ms)`)
    } catch (e) {
      log(`session/load 失败 ✗ (${Date.now() - t0}ms):`, e.message)
    }
    ws.close()
    process.exit(0)
  } catch (e) {
    log('ERROR', e.message)
    process.exit(1)
  }
})
ws.addEventListener('error', e => { console.error('WS ERROR', e.message); process.exit(1) })
