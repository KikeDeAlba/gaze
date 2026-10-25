import { parseArgs } from 'node:util'
import * as agents from './agents.js'
import { loadConfig } from './config.js'
import * as daemon from './daemon.js'
import { HOOK_WAIT_MS, needsReindex, openDb } from './db.js'
import { AutoEmbedder } from './embed.js'
import { GazeError, errorChain, failure, success, usage } from './envelope.js'
import * as hooks from './hooks.js'
import * as importer from './import.js'
import * as ingest from './ingest.js'
import { McpServer } from './mcp.js'
import * as paths from './paths.js'
import { currentDir, decodeStrict } from './paths.js'
import * as project from './project.js'
import * as setup from './setup.js'
import { GLOBAL, Store, hitJson } from './store.js'
import * as text from './text.js'

const ABOUT = 'El cerebro de cada proyecto: notas, reglas y búsqueda híbrida para agentes'
const JSON_HELP = 'Salida JSON (sobre de kit)'

const str = (help) => ({ type: 'string', help })
const flag = (help) => ({ type: 'boolean', help })

const COMMANDS = {
  remember: {
    about: 'Guarda una nota (texto, @archivo o - para stdin)',
    positionals: [{ name: 'body', required: true }],
    options: { project: str(), kind: { ...str(), default: 'fact' }, title: str(), pin: flag(), until: str() },
  },
  search: {
    about: 'Búsqueda híbrida (texto + vectores)',
    positionals: [{ name: 'query', required: true }],
    options: { project: str(), all: flag(), kind: str(), limit: { ...str(), default: '5', number: true }, explain: { ...flag(), hidden: true } },
    conflicts: [['project', 'all']],
  },
  show: { about: 'Muestra una nota y sus vecinos', positionals: [{ name: 'id', required: true }] },
  rule: {
    about: 'Reglas activas que se inyectan al iniciar sesión',
    sub: {
      add: { positionals: [{ name: 'text', required: true }], options: { project: str(), until: str(), pin: flag(), global: flag() } },
      ls: { options: { project: str(), all: flag() } },
      rm: { positionals: [{ name: 'id', required: true }] },
    },
  },
  link: { about: 'Enlaza dos notas', positionals: [{ name: 'a', required: true }, { name: 'b', required: true }] },
  forget: { about: 'Borra una nota', positionals: [{ name: 'id', required: true }] },
  move: {
    about: 'Mueve una nota o regla a otro proyecto o grupo',
    positionals: [{ name: 'id', required: true }],
    options: { project: { ...str(), required: true } },
  },
  group: {
    about: 'Grupos de proyectos que comparten reglas y notas',
    sub: {
      set: { positionals: [{ name: 'name', required: true }, { name: 'projects', many: true }] },
      ls: {},
      rm: { positionals: [{ name: 'name', required: true }] },
    },
  },
  graph: { about: 'Grafo de notas y aristas', options: { project: str() } },
  ingest: { about: 'Ingesta desde inkwell, recap o bita', options: { source: { ...str(), default: 'all' } } },
  import: {
    about: 'Importa memorias de otras herramientas',
    sub: { 'claude-memory': { options: { 'dry-run': flag(), root: str() } } },
  },
  project: { about: 'Proyecto resuelto para un directorio', options: { cwd: str(), refresh: flag() } },
  stats: { about: 'Estadísticas del cerebro y de lo inyectado' },
  capabilities: { about: 'Capacidades para kit' },
  setup: { about: 'Registra gaze en kit y crea la configuración; desde npm también integra los agentes (--agents, --remove)' },
  uninstall: { about: 'Quita el registro de kit (conserva los datos); desde npm también quita las integraciones' },
  mcp: { about: 'Servidor MCP por stdio' },
  serve: {
    about: 'Daemon que mantiene el modelo cargado',
    options: {
      'idle-minutes': { ...str(), number: true },
      log: str('Escribe el log del daemon en esta ruta (con --detach, por omisión serve.log del directorio de datos)'),
      detach: flag('Se relanza en segundo plano sin consola y sale'),
    },
  },
  daemon: {
    about: 'Activa o quita el daemon bajo demanda (arranca con el primer hook o búsqueda y se apaga solo al quedar inactivo)',
    sub: { install: {}, uninstall: {}, status: {} },
  },
  hook: {
    about: 'Hooks de los agentes (session-start, prompt, harvest)',
    positionals: [{ name: 'event', required: true }],
    options: { harness: str('claude, codex, gemini, antigravity u opencode; si falta, se detecta por el entorno') },
  },
  'bita-hook': { about: 'Recibe eventos de bita por stdin' },
  'inkwell-hook': { about: 'Recibe eventos de inkwell por stdin' },
  reindex: { about: 'Vuelve a calcular embeddings', options: { all: flag() } },
  'harvest-run': {
    hidden: true,
    options: { transcript: { ...str(), required: true }, session: { ...str(), required: true }, cwd: { ...str(), required: true } },
  },
}

const ENVELOPE_NAMES = {
  'import claude-memory': 'import claude-memory',
  'daemon install': 'daemon',
  'daemon uninstall': 'daemon',
  'daemon status': 'daemon',
}

class ParseError extends Error {}

const pad = (s, n) => s + ' '.repeat(Math.max(n - s.length, 0))
const upper = (name) => name.toUpperCase().replaceAll('-', '_')

function table(rows) {
  const width = Math.max(...rows.map(([left]) => left.length))
  return rows.map(([left, right]) => (right ? `  ${pad(left, width)}  ${right}` : `  ${left}`).trimEnd()).join('\n')
}

function topHelp() {
  const rows = Object.entries(COMMANDS).filter(([, spec]) => !spec.hidden).map(([name, spec]) => [name, spec.about])
  rows.push(['help', 'Print this message or the help of the given subcommand(s)'])
  return [
    ABOUT,
    '',
    'Usage: gaze [OPTIONS] <COMMAND>',
    '',
    'Commands:',
    table(rows),
    '',
    'Options:',
    table([['    --json', JSON_HELP], ['-h, --help', 'Print help'], ['-V, --version', 'Print version']]),
  ].join('\n')
}

function groupHelp(name, spec) {
  const rows = Object.keys(spec.sub).map((action) => [action, ''])
  rows.push(['help', 'Print this message or the help of the given subcommand(s)'])
  return [
    spec.about,
    '',
    `Usage: gaze ${name} [OPTIONS] <COMMAND>`,
    '',
    'Commands:',
    table(rows),
    '',
    'Options:',
    table([['    --json', JSON_HELP], ['-h, --help', 'Print help']]),
  ].join('\n')
}

function leafHelp(route, spec) {
  const positionals = spec.positionals ?? []
  const shown = positionals.map((p) => (p.many ? `[${upper(p.name)}]...` : `<${upper(p.name)}>`))
  const lines = []
  if (spec.about) lines.push(spec.about, '')
  lines.push(`Usage: gaze ${route} [OPTIONS]${shown.length > 0 ? ` ${shown.join(' ')}` : ''}`)
  if (positionals.length > 0) lines.push('', 'Arguments:', table(positionals.map((p, i) => [shown[i], ''])))
  const options = Object.entries(spec.options ?? {})
    .filter(([, o]) => !o.hidden)
    .map(([name, o]) => [`    --${name}${o.type === 'string' ? ` <${upper(name)}>` : ''}`, `${o.help ?? ''}${o.default !== undefined ? ` [default: ${o.default}]` : ''}`.trim()])
  options.push(['    --json', JSON_HELP], ['-h, --help', 'Print help'])
  lines.push('', 'Options:', table(options))
  return lines.join('\n')
}

function helpFor(words) {
  if (words.length === 0) return topHelp()
  const spec = COMMANDS[words[0]]
  if (!spec) throw new ParseError(`unrecognized subcommand '${words[0]}'`)
  if (!spec.sub) return leafHelp(words[0], spec)
  if (words.length === 1) return groupHelp(words[0], spec)
  const leaf = spec.sub[words[1]]
  if (!leaf) throw new ParseError(`unrecognized subcommand '${words[1]}'`)
  return leafHelp(`${words[0]} ${words[1]}`, leaf)
}

function takeJson(argv) {
  const stop = argv.indexOf('--')
  const head = stop === -1 ? argv : argv.slice(0, stop)
  const tail = stop === -1 ? [] : argv.slice(stop)
  const rest = head.filter((arg) => arg !== '--json')
  return { json: rest.length !== head.length, args: [...rest, ...tail] }
}

function isFlag(arg) {
  return arg.startsWith('-') && arg !== '-'
}

function nextWord(args, context) {
  while (args.length > 0 && isFlag(args[0])) {
    const arg = args.shift()
    if (arg === '-h' || arg === '--help') return { help: true }
    if (context === null && (arg === '-V' || arg === '--version')) return { version: true }
    if (arg === '--') break
    throw new ParseError(`unexpected argument '${arg}' found`)
  }
  if (args.length === 0) return { missing: true }
  return { word: args.shift() }
}

function parseLeaf(route, spec, args) {
  const options = { help: { type: 'boolean', short: 'h' } }
  for (const [name, o] of Object.entries(spec.options ?? {})) options[name] = { type: o.type }
  let parsed
  try {
    parsed = parseArgs({ args, options, allowPositionals: true, strict: true, tokens: true })
  } catch (error) {
    throw new ParseError(error.message)
  }
  if (parsed.values.help) return { help: leafHelp(route, spec) }
  const seen = new Map()
  for (const token of parsed.tokens) {
    if (token.kind !== 'option') continue
    seen.set(token.name, (seen.get(token.name) ?? 0) + 1)
    if (seen.get(token.name) > 1) throw new ParseError(`the argument '--${token.name}' cannot be used multiple times`)
  }
  const values = {}
  for (const [name, o] of Object.entries(spec.options ?? {})) {
    let value = parsed.values[name]
    if (value === undefined) {
      if (o.required) throw new ParseError(`the following required arguments were not provided:\n  --${name} <${upper(name)}>`)
      value = o.default ?? (o.type === 'boolean' ? false : undefined)
    }
    if (o.number && value !== undefined) {
      if (!/^\+?\d+$/.test(value)) throw new ParseError(`invalid value '${value}' for '--${name} <${upper(name)}>': invalid digit found in string`)
      value = Number(value)
    }
    values[name] = value
  }
  for (const [a, b] of spec.conflicts ?? []) {
    if (seen.has(a) && seen.has(b)) throw new ParseError(`the argument '--${a} <${upper(a)}>' cannot be used with '--${b}'`)
  }
  const given = [...parsed.positionals]
  for (const p of spec.positionals ?? []) {
    if (p.many) {
      values[p.name] = given.splice(0)
      continue
    }
    if (given.length === 0) {
      if (p.required) throw new ParseError(`the following required arguments were not provided:\n  <${upper(p.name)}>`)
      values[p.name] = undefined
      continue
    }
    values[p.name] = given.shift()
  }
  if (given.length > 0) throw new ParseError(`unexpected argument '${given[0]}' found`)
  return { values }
}

export function installSummary(result) {
  const manager = asText(result.manager)
  if (result.ready === true) return `Daemon cargado en ${manager} con pid ${display(result.pid)} y respondiendo en ${asText(result.socket)}`
  return `Daemon cargado en ${manager} con pid ${display(result.pid)}, pero aún no responde en ${asText(result.socket)} (puede estar descargando el modelo); revisa ${asText(result.log)} y gaze daemon status`
}

export function statusSummary(status) {
  if (status.state === 'running') return `Corriendo (pid ${display(status.pid)})`
  if (status.state === 'idle') return 'Bajo demanda, apagado; arranca con el primer hook o búsqueda'
  return 'Apagado'
}

export function parse(argv) {
  const { json, args } = takeJson(argv)
  const first = nextWord(args, null)
  if (first.help) return { help: topHelp() }
  if (first.version) return { version: true }
  if (first.missing) return { usageHelp: topHelp() }
  const name = first.word
  if (name === 'help') return { help: helpFor(args) }
  const spec = COMMANDS[name]
  if (!spec) throw new ParseError(`unrecognized subcommand '${name}'`)
  if (!spec.sub) {
    const leaf = parseLeaf(name, spec, args)
    return leaf.help ? leaf : { route: name, values: leaf.values, json }
  }
  const second = nextWord(args, name)
  if (second.help) return { help: groupHelp(name, spec) }
  if (second.missing) return { usageHelp: groupHelp(name, spec) }
  if (second.word === 'help') return { help: helpFor([name, ...args]) }
  const leafSpec = spec.sub[second.word]
  if (!leafSpec) throw new ParseError(`unrecognized subcommand '${second.word}'`)
  const route = `${name} ${second.word}`
  const leaf = parseLeaf(route, leafSpec, args)
  return leaf.help ? leaf : { route, values: leaf.values, json }
}

async function readAll(stream) {
  const chunks = []
  for await (const chunk of stream) chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
  return Buffer.concat(chunks)
}

async function readBody(ctx, body) {
  if (body === '-') return decodeStrict(await readAll(ctx.io.stdin))
  if (body.startsWith('@')) {
    const file = body.slice(1)
    try {
      return paths.readUtf8Strict(file)
    } catch (error) {
      throw new Error(`leer ${file}`, { cause: error })
    }
  }
  return body
}

function display(value) {
  return value === undefined ? 'null' : JSON.stringify(value)
}

function displayFloat(value) {
  return typeof value === 'number' && Number.isInteger(value) ? `${value}.0` : display(value)
}

function asText(value) {
  return typeof value === 'string' ? value : ''
}

class Context {
  constructor(self, io) {
    this.self = self
    this.io = io
    this.cached = null
    this.opened = []
  }

  close() {
    for (const store of this.opened.splice(0)) store.close()
  }

  out(line) {
    this.io.stdout.write(`${line}\n`)
  }

  err(line) {
    this.io.stderr.write(`${line}\n`)
  }

  embedder() {
    this.cached ??= new AutoEmbedder({ allowLocal: true, onDaemonDown: () => daemon.spawnOnDemand({ command: this.self }) })
    return this.cached
  }

  async store({ hook = false, reindex = true } = {}) {
    const file = paths.dbPath()
    const db = openDb(file, { log: (message) => this.err(message), ...(hook ? { waitMs: HOOK_WAIT_MS } : {}) })
    const store = new Store(db, loadConfig())
    this.opened.push(store)
    if (reindex && needsReindex(db, file)) {
      if (hook) hooks.spawnReindex(this.self)
      else {
        try {
          const done = await store.reindex(this.embedder(), false)
          this.err(`gaze: ${done} notas con embeddings nuevos.`)
        } catch (error) {
          this.err(`gaze: no se pudieron regenerar los vectores (${errorChain(error)}); corre \`gaze reindex\``)
        }
      }
    }
    return store
  }
}

function output(data, human, meta) {
  return { data, human, meta }
}

const VERBS = { created: 'Guardada', merged: 'Fusionada con una nota parecida', updated: 'Actualizada' }

async function execute(ctx, route, v) {
  switch (route) {
    case 'remember': {
      const store = await ctx.store()
      const slug = project.explicitOrCwd(store, v.project ?? null, currentDir())
      const body = await readBody(ctx, v.body)
      const outcome = await store.remember(
        ctx.embedder(),
        { project: slug, kind: v.kind, title: v.title ?? null, body, source: 'user', pinned: v.pin, until: v.until ?? null },
        true,
      )
      const verb = VERBS[outcome.action] ?? 'Sin cambios'
      return output(outcome, `${verb}: [${outcome.id}] ${outcome.title} (${outcome.kind} · ${outcome.project})`)
    }
    case 'search': {
      const store = await ctx.store()
      const scope = v.all ? { kind: 'all' } : { kind: 'project', project: project.explicitOrCwd(store, v.project ?? null, currentDir()) }
      const hits = await store.search(ctx.embedder(), v.query, scope, { kind: v.kind ?? null, limit: v.limit })
      const human = hits.length === 0
        ? 'Sin resultados.'
        : hits.map((h) => `[${h.id}] ${h.title} (${h.kind} · ${h.project})\n    ${h.snippet}`).join('\n')
      const data = hits.map((h) => hitJson(h, v.explain))
      return output(data, human, { scope: scope.kind === 'all' ? 'all' : scope.project, count: hits.length })
    }
    case 'show': {
      const store = await ctx.store()
      const { node, neighbors } = store.show(v.id)
      let human = `[${node.id}] ${node.title}\n${node.kind} · ${node.project} · ${node.source}${node.pinned ? ' · fijada' : ''}\n\n${node.body}`
      if (neighbors.length > 0) {
        human += '\n\nVecinos:'
        for (const n of neighbors) human += `\n  [${n.id}] ${n.title} (${n.kind}, ${n.edgeKind})`
      }
      return output({ ...node, neighbors }, human)
    }
    case 'rule add': {
      const store = await ctx.store()
      const slug = v.global ? GLOBAL : project.explicitOrCwd(store, v.project ?? null, currentDir())
      const body = await readBody(ctx, v.text)
      const outcome = await store.remember(ctx.embedder(), { project: slug, kind: 'rule', body, source: 'user', pinned: v.pin, until: v.until ?? null }, true)
      return output(outcome, `Regla ${outcome.action === 'created' ? 'agregada' : 'actualizada'}: [${outcome.id}] en ${outcome.project}`)
    }
    case 'rule ls': {
      const store = await ctx.store()
      const rules = v.all ? store.rules(null, true) : store.rules(project.explicitOrCwd(store, v.project ?? null, currentDir()), false)
      const human = rules.length === 0
        ? 'Sin reglas.'
        : rules
          .map((r) => `[${r.id}] ${r.project}${r.pinned ? ' · fijada' : ''}${r.until !== null ? ` · hasta ${r.until}` : ''} — ${text.oneLine(r.body)}`)
          .join('\n')
      const data = rules.map((r) => ({ id: r.id, project: r.project, text: r.body, pinned: r.pinned, until: r.until, updatedAt: r.updatedAt }))
      return output(data, human)
    }
    case 'rule rm': {
      const store = await ctx.store()
      const node = store.require(v.id)
      if (node.kind !== 'rule') throw usage(`[${node.id}] no es una regla, es ${node.kind}`)
      store.forget(node.id)
      return output({ id: node.id, removed: true }, `Regla [${node.id}] borrada.`)
    }
    case 'link': {
      const store = await ctx.store()
      const [first, second] = store.link(v.a, v.b)
      return output({ src: first.id, dst: second.id, kind: 'link' }, `Enlazadas: [${first.id}] ${first.title} → [${second.id}] ${second.title}`)
    }
    case 'forget': {
      const store = await ctx.store()
      const node = store.forget(v.id)
      return output({ id: node.id, removed: true }, `Borrada: [${node.id}] ${node.title}`)
    }
    case 'move': {
      const store = await ctx.store()
      const target = project.projectForName(store, v.project)
      const node = await store.moveNode(ctx.embedder(), v.id, target)
      return output({ id: node.id, project: node.project }, `[${node.id}] ahora está en ${node.project}`)
    }
    case 'group set': {
      const store = await ctx.store()
      const name = text.slugify(v.name)
      if (name === '' || name === GLOBAL || v.projects.length === 0) throw usage('Uso: gaze group set <nombre> <proyecto>...')
      const members = v.projects.map((p) => project.projectForName(store, p)).filter((p) => p !== GLOBAL)
      store.setGroup(name, members)
      return output({ name, projects: members }, `Grupo ${name}: ${members.join(', ')}`)
    }
    case 'group ls': {
      const store = await ctx.store()
      const groups = store.groups()
      const human = groups.length === 0 ? 'Sin grupos.' : groups.map(([n, m]) => `${n}: ${m.join(', ')}`).join('\n')
      return output(groups.map(([n, m]) => ({ name: n, projects: m })), human)
    }
    case 'group rm': {
      const store = await ctx.store()
      const name = text.slugify(v.name)
      const removed = store.removeGroup(name)
      return output({ name, removed }, removed ? `Grupo ${name} borrado.` : `No existe el grupo ${name}.`)
    }
    case 'graph': {
      const store = await ctx.store()
      const graph = store.graph(v.project ?? null)
      return output(graph, `${graph.nodes.length} nodos, ${graph.edges.length} aristas`)
    }
    case 'ingest': {
      const store = await ctx.store()
      const emb = ctx.embedder()
      const reports = []
      const started = Date.now()
      if (!['all', 'inkwell', 'recap', 'bita'].includes(v.source)) throw usage('--source debe ser inkwell, recap, bita o all')
      if (v.source === 'all' || v.source === 'inkwell') reports.push(await ingest.ingestInkwell(store, emb, paths.inkwellDocs(), true, project.bitaBin()))
      if (v.source === 'all' || v.source === 'recap') reports.push(await ingest.ingestRecap(store, emb))
      if (v.source === 'bita') reports.push({ source: 'bita', note: 'bita llega por eventos: gaze bita-hook (stop, amend, delete)' })
      const human = reports
        .map((r) => {
          if (typeof r.note === 'string') return `${asText(r.source)}: ${r.note}`
          return `${asText(r.source)}: ${display(r.scanned)} revisados, ${display(r.created)} nuevos, ${display(r.updated)} actualizados, ${display(r.unchanged)} sin cambios, ${display(r.removed)} quitados, ${display(r.failed)} con error`
        })
        .join('\n')
      return output(reports, human, { ms: Date.now() - started })
    }
    case 'import claude-memory': {
      const store = await ctx.store()
      const root = v.root ?? paths.claudeProjects()
      const result = await importer.run(store, v['dry-run'] ? null : ctx.embedder(), root, v['dry-run'])
      let human = `${display(result.total)} memorias${v['dry-run'] ? ' (simulación)' : ''}`
      for (const [slug, kinds] of Object.entries(result.projects ?? {})) {
        human += `\n  ${slug}: ${Object.entries(kinds).map(([k, n]) => `${display(n)} ${k}`).join(', ')}`
      }
      const actions = Object.entries(result.actions ?? {})
      if (actions.length > 0) human += `\nResultado: ${actions.map(([k, n]) => `${display(n)} ${k}`).join(', ')}`
      return output(result, human)
    }
    case 'project': {
      const store = await ctx.store()
      const resolved = project.resolve(store, v.cwd ?? currentDir(), v.refresh)
      const human = `${resolved.slug}${resolved.name !== null ? ` · ${resolved.name}` : ''}${resolved.key !== null ? ` · ${resolved.key}` : ''} (fuente: ${resolved.source})`
      return output(resolved, human)
    }
    case 'stats': {
      const store = await ctx.store()
      const stats = store.stats()
      stats.daemon = await daemon.status()
      const human = [
        `${display(stats.nodes)} notas, ${display(stats.edges)} aristas, ${display(stats.chunks)} fragmentos (${display(stats.unembedded)} sin embedding)`,
        `Inyectado: ${display(stats.injection.tokens)} tokens en ${display(stats.injection.sessions)} sesiones (promedio ${displayFloat(stats.injection.avgTokensPerSession)} por sesión)`,
        `Daemon: ${stats.daemon.running === true ? 'corriendo' : 'apagado'}`,
      ].join('\n')
      return output(stats, human)
    }
    case 'capabilities':
      return output(setup.capabilities(), `gaze ${paths.VERSION}: ${setup.CAPABILITIES.join(', ')}`)
    case 'setup': {
      const result = await setup.setup({ self: ctx.self, open: () => ctx.store() })
      const next = result.next.map((step) => `  ${step}`).join('\n')
      const human = `Registrado en kit: ${result.manifest}\nConfiguración: ${result.config}\nBase: ${result.database}\n\n${setup.INTEGRATIONS_NOTE}\n\nFalta (no lo hago yo):\n${next}`
      return output(result, human)
    }
    case 'uninstall': {
      const result = setup.uninstall()
      const human = `Registro de kit ${result.removed === true ? 'borrado' : 'no existía'}.\nLos datos se quedan en ${result.kept}.\nPara terminar: gaze daemon uninstall (las integraciones con cada agente las quita el paquete npm)`
      return output(result, human)
    }
    case 'daemon install': {
      const result = await daemon.install({ self: ctx.self })
      return output(result, installSummary(result))
    }
    case 'daemon uninstall': {
      const result = await daemon.uninstall()
      return output(result, `Daemon quitado de ${asText(result.manager)}.`)
    }
    case 'daemon status': {
      const status = await daemon.status()
      return output(status, statusSummary(status))
    }
    case 'reindex': {
      const store = await ctx.store({ reindex: false })
      const done = await store.reindex(ctx.embedder(), v.all)
      return output({ reindexed: done }, `${done} notas con embeddings nuevos.`)
    }
    default:
      throw new GazeError('INTERNAL_ERROR', `unknown command ${route}`)
  }
}

async function runHook(ctx, event, harness) {
  if (hooks.disabled()) return 0
  const agent = agents.detectFromEnv(harness ?? null)
  const input = await hooks.readInput(ctx.io.stdin)
  try {
    let result = null
    if (event === 'harvest') hooks.harvest(input, agent)
    else if (event === 'session-start' || event === 'prompt') {
      const store = await ctx.store({ hook: true })
      result = event === 'session-start'
        ? hooks.sessionStart(store, input, agent)
        : await hooks.prompt(store, input, agent, { spawnOnDemand: () => daemon.spawnOnDemand({ command: ctx.self }) })
    }
    if (result !== null && result !== undefined) ctx.out(JSON.stringify(result))
  } catch (error) {
    ctx.err(`gaze hook ${event}: ${errorChain(error)}`)
  }
  return 0
}

async function runMcp(ctx) {
  try {
    const store = await ctx.store()
    const cwd = hooks.projectDir(agents.detectFromEnv(null)) ?? currentDir()
    await new McpServer({ store, embedder: ctx.embedder(), cwd }).run(ctx.io.stdin, ctx.io.stdout)
    return 0
  } catch (error) {
    ctx.err(`gaze mcp: ${errorChain(error)}`)
    return 1
  }
}

async function runServe(ctx, v) {
  const idleMinutes = v['idle-minutes']
  if (v.detach) {
    const log = v.log ?? paths.serveLog()
    try {
      const pid = await daemon.spawnDetached({ idleMinutes, log, command: ctx.self })
      ctx.out(`gaze serve en segundo plano con pid ${pid}; log en ${log}`)
      return 0
    } catch (error) {
      ctx.err(`gaze serve --detach: ${errorChain(error)}`)
      return 1
    }
  }
  try {
    await daemon.serve({ idleMinutes, log: new daemon.ServeLog(v.log) })
    return 0
  } catch (error) {
    ctx.err(`gaze serve: ${errorChain(error)}`)
    return 1
  }
}

async function runBitaHook(ctx) {
  const input = await hooks.readInput(ctx.io.stdin)
  try {
    const store = await ctx.store()
    const value = await ingest.bitaEvent(store, ctx.embedder(), input, project.bitaBin())
    ctx.out(`${text.nowIso()} bita-hook ${JSON.stringify(value)}`)
    return 0
  } catch (error) {
    ctx.err(`${text.nowIso()} bita-hook: ${errorChain(error)}`)
    return 1
  }
}

async function runInkwellHook(ctx) {
  const input = await hooks.readInput(ctx.io.stdin)
  try {
    const store = await ctx.store()
    const value = await ingest.inkwellEvent(store, ctx.embedder(), input, paths.inkwellDocs(), project.bitaBin())
    ctx.out(`${text.nowIso()} inkwell-hook ${JSON.stringify(value)}`)
    return Number(value?.failed ?? 0) > 0 ? 1 : 0
  } catch (error) {
    ctx.err(`${text.nowIso()} inkwell-hook: ${errorChain(error)}`)
    return 1
  }
}

async function runHarvest(ctx, v) {
  try {
    const store = await ctx.store({ hook: true })
    await hooks.harvestRun(store, ctx.embedder(), v.transcript, v.session, v.cwd, { out: ctx.io.stdout })
  } catch (error) {
    ctx.out(`${text.nowIso()} harvest ${v.session}: ${errorChain(error)}`)
  }
  return 0
}

export async function main(argv, options = {}) {
  const io = {
    stdin: options.io?.stdin ?? process.stdin,
    stdout: options.io?.stdout ?? process.stdout,
    stderr: options.io?.stderr ?? process.stderr,
  }
  const self = Array.isArray(options.self) && options.self.length > 0 ? [...options.self] : paths.selfCommand()
  const ctx = new Context(self, io)
  try {
    return await run(ctx, argv)
  } finally {
    ctx.close()
  }
}

async function run(ctx, argv) {
  let parsed
  try {
    parsed = parse(argv)
  } catch (error) {
    if (!(error instanceof ParseError)) throw error
    ctx.err(`error: ${error.message}\n\nUsage: gaze <COMMAND>\n\nFor more information, try '--help'.`)
    return 2
  }
  if (parsed.version) {
    ctx.out(`gaze ${paths.VERSION}`)
    return 0
  }
  if (parsed.help !== undefined) {
    ctx.out(parsed.help)
    return 0
  }
  if (parsed.usageHelp !== undefined) {
    ctx.err(parsed.usageHelp)
    return 2
  }
  const { route, values, json } = parsed
  switch (route) {
    case 'hook':
      return runHook(ctx, values.event, values.harness)
    case 'mcp':
      return runMcp(ctx)
    case 'serve':
      return runServe(ctx, values)
    case 'bita-hook':
      return runBitaHook(ctx)
    case 'inkwell-hook':
      return runInkwellHook(ctx)
    case 'harvest-run':
      return runHarvest(ctx, values)
  }
  const name = ENVELOPE_NAMES[route] ?? route
  try {
    const result = await execute(ctx, route, values)
    if (json) ctx.out(JSON.stringify(success(name, result.data, result.meta)))
    else ctx.out(result.human)
    return 0
  } catch (error) {
    if (json) ctx.out(JSON.stringify(failure(name, error)))
    else {
      ctx.err(`error: ${errorChain(error)}`)
      if (error instanceof GazeError && error.hint !== undefined && error.hint !== null) ctx.err(`sugerencia: ${error.hint}`)
    }
    return 1
  }
}
