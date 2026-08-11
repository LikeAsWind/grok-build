// Probe: connect to grok web WS, session/load a session, dump replayed tool_call updates.
// Uses Node >=22 built-in WebSocket.

const SESSION = process.argv[2]
const CWD = process.argv[3] || 'C:/Program Files/Development/AI_Projects/grok-build'
const ws = new WebSocket('ws://127.0.0.1:2420/ws?server-key=dev123')
let nextId = 1
const pending = new Map()

function req(method, params) {
  return new Promise((resolve, reject) => {
    const id = nextId++
    pending.set(id, { resolve, reject })
    ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
  })
}

const toolEvents = []
ws.addEventListener('message', ev => {
  const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString())
  if (msg.id !== undefined && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id)
    pending.delete(msg.id)
    msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result)
    return
  }
  if (msg.method === 'session/update') {
    const u = msg.params?.update
    if (u?.sessionUpdate === 'tool_call' || u?.sessionUpdate === 'tool_call_update') {
      toolEvents.push({
        type: u.sessionUpdate, id: u.toolCallId, status: u.status, title: u.title,
        kind: u.kind, hasRawInput: u.rawInput !== undefined, rawInput: u.rawInput,
        hasContent: Array.isArray(u.content) && u.content.length > 0,
        hasRawOutput: u.rawOutput !== undefined,
        metaName: u._meta?.['x.ai/tool']?.name,
      })
    }
  }
})

ws.addEventListener('open', async () => {
  try {
    const init = await req('initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      _meta: { clientType: 'web', clientVersion: '0.1.0' },
    })
    const method = init?.authMethods?.[0]
    if (method) await req('authenticate', { methodId: method.id }).catch(e => console.error('auth failed:', e.message))
    if (SESSION === 'list') {
      const res = await req('_x.ai/session/list', {})
      console.log(JSON.stringify(res, null, 1).slice(0, 3000))
      process.exit(0)
    }
    await req('session/load', { sessionId: SESSION, cwd: CWD, mcpServers: [] })
    await new Promise(r => setTimeout(r, 1500))
    console.log(JSON.stringify(toolEvents, null, 1))
    ws.close()
    process.exit(0)
  } catch (e) {
    console.error('ERROR', e.message)
    process.exit(1)
  }
})
ws.addEventListener('error', e => { console.error('WS ERROR', e.message); process.exit(1) })
