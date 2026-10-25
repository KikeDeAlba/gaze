import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { PassThrough, Readable } from 'node:stream'
import { FakeEmbedder } from '../src/embed.js'
import { McpServer, PROTOCOL, tools } from '../src/mcp.js'
import { VERSION } from '../src/paths.js'
import { Store } from '../src/store.js'

let saved

beforeEach(() => {
  saved = process.env.GAZE_PROJECT
  delete process.env.GAZE_PROJECT
})

afterEach(() => {
  if (saved === undefined) delete process.env.GAZE_PROJECT
  else process.env.GAZE_PROJECT = saved
})

const server = () => new McpServer({ store: Store.inMemory(), embedder: new FakeEmbedder(), cwd: '/' })
const call = (name, args, id = 1) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } })
const textOf = (response) => response.result.content[0].text

test('tools are minimal', () => {
  const list = tools()
  assert.equal(list.length, 4)
  const bytes = Buffer.byteLength(JSON.stringify(list), 'utf8')
  assert.ok(bytes < 1400, `tool schemas too large: ${bytes}`)
  assert.deepEqual(list.map((t) => t.name), ['gaze_search', 'gaze_remember', 'gaze_rule_add', 'gaze_link'])
  assert.deepEqual(list[1].inputSchema.properties.kind.enum, ['fact', 'decision', 'rule', 'memory'])
  assert.deepEqual(list[3].inputSchema.required, ['a', 'b'])
})

test('json rpc round trip', async () => {
  const s = server()
  const init = await s.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } })
  assert.equal(init.result.protocolVersion, '2025-03-26')
  assert.equal(await s.handle({ jsonrpc: '2.0', method: 'notifications/initialized' }), null)
  const saved = await s.handle(call('gaze_remember', { body: 'El cliente paga en dólares', project: 'global' }, 2))
  const text = textOf(saved)
  assert.ok(text.startsWith('created ['))
  const id = text.slice(9, 19)
  const found = await s.handle(call('gaze_search', { query: 'cliente dólares', project: 'global' }, 3))
  assert.ok(textOf(found).includes(id))
  const read = await s.handle(call('gaze_search', { query: id }, 4))
  assert.ok(textOf(read).includes('El cliente paga en dólares'))
  const missing = await s.handle({ jsonrpc: '2.0', id: 5, method: 'nope' })
  assert.equal(missing.error.code, -32601)
  assert.equal(missing.error.message, 'Method not found: nope')
})

test('initialize defaults and ping', async () => {
  const s = server()
  const init = await s.handle({ jsonrpc: '2.0', id: 'a', method: 'initialize' })
  assert.deepEqual(init, {
    jsonrpc: '2.0',
    id: 'a',
    result: { protocolVersion: PROTOCOL, capabilities: { tools: {} }, serverInfo: { name: 'gaze', version: VERSION } },
  })
  assert.deepEqual(await s.handle({ jsonrpc: '2.0', id: null, method: 'ping' }), { jsonrpc: '2.0', id: null, result: {} })
  assert.equal((await s.handle({ jsonrpc: '2.0', id: 7, method: 'tools/list' })).result.tools.length, 4)
  assert.equal(await s.handle([1, 2]), null)
  assert.equal(await s.handle('x'), null)
  assert.equal((await s.handle({ id: 8 })).error.message, 'Method not found: ')
})

test('tool errors come back as text with isError', async () => {
  const s = server()
  const cases = [
    [call('gaze_search', { query: '   ' }), 'Falta query'],
    [call('gaze_search', null), 'Falta query'],
    [call('gaze_remember', {}), 'Falta body'],
    [call('gaze_rule_add', { text: 7 }), 'Falta text'],
    [call('gaze_nope', {}), 'Herramienta desconocida: gaze_nope'],
    [call('gaze_link', {}), 'No existe: '],
    [call('gaze_remember', { body: 'x', kind: 'raro', project: 'global' }), 'Tipo inválido: raro. Usa uno de: rule, fact, decision, doc, entry, issue, meeting, memory'],
    [call('gaze_rule_add', { text: 'x', until: 'mañana', project: 'global' }), 'Fecha inválida: mañana. Usa AAAA-MM-DD'],
  ]
  for (const [message, expected] of cases) {
    const response = await s.handle(message)
    assert.deepEqual(response.result, { content: [{ type: 'text', text: expected }], isError: true }, expected)
  }
})

test('rules, links, neighbors and empty searches use the rust texts', async () => {
  const s = server()
  const rule = textOf(await s.handle(call('gaze_rule_add', { text: 'Siempre usa pnpm', project: 'den', until: '2999-01-01' })))
  assert.match(rule, /^created \[\w{10}\] regla en den$/)
  const a = textOf(await s.handle(call('gaze_remember', { body: 'Primera nota sobre facturas', title: 'Facturas', kind: 'decision', project: 'den' }))).slice(9, 19)
  const b = textOf(await s.handle(call('gaze_remember', { body: 'Segunda nota sobre despliegues', project: 'den' }))).slice(9, 19)
  assert.equal(textOf(await s.handle(call('gaze_link', { a, b }))), `enlazadas [${a}] → [${b}]`)
  const shown = textOf(await s.handle(call('gaze_search', { query: a })))
  assert.equal(shown, `[${a}] Facturas (decision · den)\nPrimera nota sobre facturas\nRelacionadas: [${b}] Segunda nota sobre despliegues (link)`)
  assert.equal(textOf(await s.handle(call('gaze_search', { query: 'inexistente totalmente', project: 'vacio' }))), 'Sin resultados.')
  const hits = textOf(await s.handle(call('gaze_search', { query: 'facturas nota', project: 'den', limit: 1 })))
  assert.equal(hits, `[${a}] Facturas (decision) — Primera nota sobre facturas`)
  const node = s.store.get(a)
  assert.ok(node.hits >= 2)
})

async function session(lines) {
  const s = server()
  const output = new PassThrough()
  const chunks = []
  output.on('data', (c) => chunks.push(c))
  await s.run(Readable.from(lines.map((l) => `${l}\n`)), output)
  return Buffer.concat(chunks).toString('utf8').split('\n').filter((l) => l !== '').map((l) => JSON.parse(l))
}

test('run answers line by line, skips blanks and notifications and reports parse errors', async () => {
  const responses = await session([
    JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    '',
    '   ',
    JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    '{not json',
    JSON.stringify(call('gaze_remember', { body: 'El cliente paga en dólares', project: 'global' }, 2)),
    JSON.stringify(call('gaze_search', { query: 'dólares', project: 'global' }, 3)),
  ])
  assert.equal(responses.length, 4)
  assert.equal(responses[0].id, 1)
  assert.deepEqual(responses[1], { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })
  assert.match(responses[2].result.content[0].text, /^created \[/)
  assert.match(responses[3].result.content[0].text, /El cliente paga en dólares/)
})
