import readline from 'node:readline'
import { errorChain, usage } from './envelope.js'
import { VERSION } from './paths.js'
import * as project from './project.js'
import * as text from './text.js'
import { field } from './text.js'

export const PROTOCOL = '2025-06-18'

const WHITESPACE = /\p{White_Space}/u


export function tools() {
  return [
    {
      name: 'gaze_search',
      description: 'Busca en el cerebro del proyecto; pasa un id para leer la nota completa.',
      inputSchema: { type: 'object', properties: { query: { type: 'string' }, project: { type: 'string' }, limit: { type: 'integer' } }, required: ['query'] },
    },
    {
      name: 'gaze_remember',
      description: 'Guarda una nota atómica durable; enlaza con [[Título]].',
      inputSchema: {
        type: 'object',
        properties: { body: { type: 'string' }, title: { type: 'string' }, kind: { type: 'string', enum: ['fact', 'decision', 'rule', 'memory'] }, project: { type: 'string' } },
        required: ['body'],
      },
    },
    {
      name: 'gaze_rule_add',
      description: 'Agrega una regla que se inyecta al iniciar cada sesión.',
      inputSchema: { type: 'object', properties: { text: { type: 'string' }, project: { type: 'string' }, until: { type: 'string' } }, required: ['text'] },
    },
    {
      name: 'gaze_link',
      description: 'Enlaza dos notas por id.',
      inputSchema: { type: 'object', properties: { a: { type: 'string' }, b: { type: 'string' } }, required: ['a', 'b'] },
    },
  ]
}

function arg(args, key) {
  const value = field(args, key)
  if (typeof value !== 'string') return null
  const trimmed = text.trim(value)
  return trimmed === '' ? null : trimmed
}

function limitOf(args) {
  const value = field(args, 'limit')
  const n = Number.isSafeInteger(value) && value >= 0 ? value : 5
  return Math.min(Math.max(n, 1), 20)
}

export class McpServer {
  constructor({ store, embedder, cwd }) {
    this.store = store
    this.embedder = embedder
    this.cwd = cwd
  }

  project(explicit) {
    return project.explicitOrCwd(this.store, explicit, this.cwd)
  }

  async call(name, args) {
    switch (name) {
      case 'gaze_search': {
        const query = arg(args, 'query')
        if (query === null) throw usage('Falta query')
        if (!WHITESPACE.test(query)) {
          const found = this.store.get(query)
          if (found) {
            const { node, neighbors } = this.store.show(found.id)
            let out = `[${node.id}] ${node.title} (${node.kind} · ${node.project})\n${node.body}`
            if (neighbors.length > 0) {
              const list = neighbors.slice(0, 8).map((n) => `[${n.id}] ${n.title} (${n.edgeKind})`)
              out += `\nRelacionadas: ${list.join('; ')}`
            }
            return out
          }
        }
        const slug = this.project(arg(args, 'project'))
        const hits = await this.store.search(this.embedder, query, { kind: 'project', project: slug }, { limit: limitOf(args) })
        if (hits.length === 0) return 'Sin resultados.'
        this.store.bumpHits(hits.map((h) => h.id))
        return hits.map((h) => `[${h.id}] ${h.title} (${h.kind}) — ${text.truncate(h.snippet, 160)}`).join('\n')
      }
      case 'gaze_remember': {
        const body = arg(args, 'body')
        if (body === null) throw usage('Falta body')
        const kind = arg(args, 'kind') ?? 'fact'
        const outcome = await this.store.remember(
          this.embedder,
          { project: this.project(arg(args, 'project')), kind, title: arg(args, 'title'), body, source: 'claude' },
          true,
        )
        return `${outcome.action} [${outcome.id}] ${outcome.title}`
      }
      case 'gaze_rule_add': {
        const body = arg(args, 'text')
        if (body === null) throw usage('Falta text')
        const outcome = await this.store.remember(
          this.embedder,
          { project: this.project(arg(args, 'project')), kind: 'rule', body, source: 'claude', until: arg(args, 'until') },
          true,
        )
        return `${outcome.action} [${outcome.id}] regla en ${outcome.project}`
      }
      case 'gaze_link': {
        const [first, second] = this.store.link(arg(args, 'a') ?? '', arg(args, 'b') ?? '')
        return `enlazadas [${first.id}] → [${second.id}]`
      }
      default:
        throw usage(`Herramienta desconocida: ${name}`)
    }
  }

  async handle(message) {
    if (message === null || typeof message !== 'object' || Array.isArray(message) || !Object.hasOwn(message, 'id')) return null
    const id = message.id
    const rawMethod = field(message, 'method')
    const method = typeof rawMethod === 'string' ? rawMethod : ''
    const params = field(message, 'params')
    let result
    let error
    switch (method) {
      case 'initialize': {
        const version = field(params, 'protocolVersion')
        result = { protocolVersion: typeof version === 'string' ? version : PROTOCOL, capabilities: { tools: {} }, serverInfo: { name: 'gaze', version: VERSION } }
        break
      }
      case 'ping':
        result = {}
        break
      case 'tools/list':
        result = { tools: tools() }
        break
      case 'tools/call': {
        const rawName = field(params, 'name')
        const name = typeof rawName === 'string' ? rawName : ''
        const args = field(params, 'arguments') ?? null
        try {
          result = { content: [{ type: 'text', text: await this.call(name, args) }] }
        } catch (failure) {
          result = { content: [{ type: 'text', text: errorChain(failure) }], isError: true }
        }
        break
      }
      default:
        error = { code: -32601, message: `Method not found: ${method}` }
    }
    return error === undefined ? { jsonrpc: '2.0', id, result } : { jsonrpc: '2.0', id, error }
  }

  async run(input = process.stdin, output = process.stdout) {
    const lines = readline.createInterface({ input, crlfDelay: Infinity, terminal: false })
    for await (const line of lines) {
      if (text.trim(line) === '') continue
      let message
      let parsed = true
      try {
        message = JSON.parse(line)
      } catch {
        parsed = false
      }
      const response = parsed ? await this.handle(message) : { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }
      if (response !== null) output.write(`${JSON.stringify(response)}\n`)
    }
  }
}
