import fs from 'node:fs'
import { performance } from 'node:perf_hooks'
import * as agents from './agents.js'
import * as daemon from './daemon.js'
import { DaemonEmbedder, FakeEmbedder, fakeRequested } from './embed.js'
import * as ipc from './ipc.js'
import * as paths from './paths.js'
import { spawnDetached } from './proc.js'
import * as project from './project.js'
import { GLOBAL } from './store.js'
import * as text from './text.js'

export const HARVEST_ENV = 'GAZE_HARVEST'

export const BRAIN_LINE =
  'gaze: este proyecto tiene cerebro. Antes de preguntarle al usuario datos del proyecto, búscalos con gaze_search; guarda con gaze_remember decisiones, correcciones, convenciones y datos del cliente o de infra como notas atómicas con [[enlaces]].'

export const TRIVIAL = [
  'ok',
  'okay',
  'sí',
  'si',
  'no',
  'gracias',
  'dale',
  'va',
  'listo',
  'continua',
  'continúa',
  'sigue',
  'perfecto',
  'excelente',
  'yes',
  'thanks',
  'continue',
  'go',
  'go ahead',
  'hazlo',
  'adelante',
  'commit',
  'push',
  'y',
]

export const FILLER = [
  'continua',
  'sigue',
  'favor',
  'porfa',
  'gracias',
  'perfecto',
  'dale',
  'listo',
  'okay',
  'bien',
  'hazlo',
  'adelante',
  'procede',
  'thanks',
  'continue',
  'please',
  'great',
  'good',
  'vale',
  'va',
  'excelente',
  'sale',
]

const POINTER_HEADER = 'gaze: notas quizá útiles (léelas con gaze_search "<id>"):'
const TAGS = ['system-reminder', 'local-command-stdout', 'local-command-stderr', 'command-message', 'command-args', 'task-notification']
const LEARNING_KINDS = ['decision', 'fact', 'rule']
const TITLE_COVERAGE = Math.fround(0.2)
const SEMANTIC_COVERAGE = Math.fround(0.25)

const field = (value, key) => (value !== null && typeof value === 'object' && !Array.isArray(value) ? value[key] : undefined)
const str = (value) => (typeof value === 'string' ? value : null)
const elapsedMs = (started) => Math.floor(performance.now() - started)
const charCount = (s) => {
  let n = 0
  for (const _ of s) n++
  return n
}

function trimEndChars(s, set) {
  let end = s.length
  while (end > 0 && set.includes(s[end - 1])) end--
  return s.slice(0, end)
}

export function disabled() {
  const value = process.env[HARVEST_ENV]
  return (value !== undefined && value !== '' && value !== '0') || agents.headless()
}

export async function readInput(stdin = process.stdin) {
  const chunks = []
  try {
    for await (const chunk of stdin) chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
  } catch {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    return null
  }
}

export function projectDir(agent) {
  const names = [agents.projectDirVar(agent), 'CLAUDE_PROJECT_DIR', 'GEMINI_PROJECT_DIR'].filter((name) => name !== null)
  for (const name of names) {
    const value = process.env[name]
    if (value !== undefined && value !== '') return value
  }
  return null
}

function currentDir() {
  try {
    return process.cwd()
  } catch {
    return '/'
  }
}

function inputCwd(input, agent) {
  const cwd = str(field(input, 'cwd'))
  if (cwd !== null && cwd !== '') return cwd
  return projectDir(agent) ?? currentDir()
}

function sessionId(input) {
  return str(field(input, 'session_id')) ?? 'unknown'
}

export function hookOutput(event, context) {
  return { hookSpecificOutput: { hookEventName: event, additionalContext: context } }
}

export function ruleLine(rule) {
  const body = text.oneLine(rule.body)
  const line = text.fold(body).startsWith(text.fold(trimEndChars(rule.title, ['…']))) || rule.title === '' ? body : `${rule.title}: ${body}`
  return `- ${text.truncate(line, 220)}`
}

export function sessionContext(rules, budget) {
  let out = BRAIN_LINE
  if (rules.length === 0) return out
  out += '\nReglas activas:'
  let used = 0
  let shown = 0
  for (const rule of rules) {
    const line = ruleLine(rule)
    const cost = text.estimateTokens(line) + 1
    if (used + cost > budget) break
    out += `\n${line}`
    used += cost
    shown++
  }
  const rest = rules.length - shown
  if (rest > 0) out += `\n${rest} reglas más: gaze rule ls`
  return out
}

export function needsBackgroundRefresh(p) {
  return p.slug === GLOBAL && p.repo !== null && p.repo !== undefined && !p.source.startsWith('cache:') && p.source !== 'env'
}

export function resolveForHook(store, cwd, { spawn = spawnDetached } = {}) {
  const resolved = project.resolveFast(store, cwd)
  if (needsBackgroundRefresh(resolved)) spawn([...paths.selfCommand(), 'project', '--refresh', '--cwd', cwd], {})
  return resolved
}

export function sessionStart(store, input, agent, options = {}) {
  const started = performance.now()
  const cwd = inputCwd(input, agent)
  const resolved = resolveForHook(store, cwd, options)
  const rules = store.activeRules(resolved.slug)
  const context = sessionContext(rules, store.cfg.hooks.rules_tokens)
  const ids = rules.map((r) => r.id)
  try {
    store.recordInjection(sessionId(input), 'session-start', ids, text.estimateTokens(context), elapsedMs(started))
  } catch {}
  return hookOutput('SessionStart', context)
}

export function trivialPrompt(prompt, minChars) {
  const trimmed = text.trim(prompt)
  if (charCount(trimmed) < minChars || trimmed.startsWith('/') || trimmed.startsWith('!')) return true
  const folded = text.fold(trimEndChars(trimmed, ['.', '!', '?']))
  if (TRIVIAL.some((t) => text.fold(t) === folded)) return true
  const found = text.terms(trimmed)
  return found.length < 2 || found.every((t) => FILLER.includes(t))
}

export function pointerLine(hit) {
  const summary = text.firstLineSummary(hit.body, hit.title, 90)
  const title = text.truncate(hit.title, 70)
  return summary === '' ? `[${hit.id}] ${title}` : `[${hit.id}] ${title} — ${summary}`
}

export class Gate {
  constructor({ semantic, threshold, margin, lexicalThreshold, floor }) {
    this.semantic = semantic
    this.threshold = threshold
    this.margin = margin
    this.lexicalThreshold = lexicalThreshold
    this.floor = floor
  }

  static floorOf(hits) {
    const sims = hits.map((h) => h.similarity).filter((s) => s !== null && s !== undefined)
    if (sims.length < 3) return 0
    sims.sort((a, b) => b - a)
    const top = sims.slice(0, 10)
    return top[Math.floor(top.length / 2)]
  }

  passes(hit) {
    return gatePasses(this, hit)
  }
}

export function gatePasses(gate, hit) {
  if (gate.semantic) {
    const similarity = hit.similarity ?? 0
    return similarity >= gate.threshold && Math.fround(similarity - gate.floor) >= gate.margin && hit.coverage >= SEMANTIC_COVERAGE
  }
  return hit.coverage >= gate.lexicalThreshold && hit.titleCoverage >= TITLE_COVERAGE
}

export function selectPointers(hits, gate, max, budget) {
  let used = text.estimateTokens(POINTER_HEADER)
  const lines = []
  const ids = []
  for (const hit of hits) {
    if (!gatePasses(gate, hit)) continue
    const line = pointerLine(hit)
    const cost = text.estimateTokens(line) + 1
    if (used + cost > budget) break
    used += cost
    lines.push(line)
    ids.push(hit.id)
    if (lines.length >= max) break
  }
  if (lines.length === 0) return { context: '', ids }
  return { context: `${POINTER_HEADER}\n${lines.join('\n')}`, ids }
}

export async function prompt(store, input, agent, { alive = ipc.alive, spawnOnDemand = daemon.spawnOnDemand, spawn } = {}) {
  const started = performance.now()
  const raw = str(field(input, 'prompt')) ?? ''
  const cfg = store.cfg.hooks
  if (trivialPrompt(raw, cfg.prompt_min_chars)) return null
  const cwd = inputCwd(input, agent)
  const resolved = resolveForHook(store, cwd, spawn ? { spawn } : {})
  const session = sessionId(input)
  const already = store.injected(session)

  const endpoint = ipc.endpointFor(paths.socketPath())
  const fake = fakeRequested()
  const semantic = fake || (await alive(endpoint, 200))
  let embedder
  if (fake) embedder = new FakeEmbedder()
  else if (semantic) embedder = new DaemonEmbedder({ endpoint, timeoutMs: 1500 })
  else {
    spawnOnDemand()
    embedder = null
  }
  const query = text.truncate(raw, 1500)
  const found = await store.search(embedder, query, { kind: 'project', project: resolved.slug }, { limit: 10, excludeKinds: ['rule'] })
  const gate = new Gate({
    semantic,
    threshold: cfg.prompt_threshold,
    margin: cfg.prompt_margin,
    lexicalThreshold: cfg.prompt_lexical_threshold,
    floor: Gate.floorOf(found),
  })
  const hits = found.filter((h) => !already.has(h.id))
  if (semantic) hits.sort((a, b) => (b.similarity ?? 0) - (a.similarity ?? 0))
  const { context, ids } = selectPointers(hits, gate, cfg.prompt_max, cfg.prompt_tokens)
  if (ids.length === 0) {
    try {
      store.recordInjection(session, 'prompt', [], 0, elapsedMs(started))
    } catch {}
    return null
  }
  store.recordInjection(session, 'prompt', ids, text.estimateTokens(context), elapsedMs(started))
  return hookOutput(agents.promptEvent(agent), context)
}

export function harvest(input, agent, { spawn = spawnDetached } = {}) {
  if (agent !== 'claude') return
  const transcript = str(field(input, 'transcript_path'))
  if (transcript === null) return
  try {
    fs.mkdirSync(paths.dataDir(), { recursive: true })
  } catch {}
  const log = paths.harvestLog()
  fs.closeSync(fs.openSync(log, 'a'))
  const argv = [...paths.selfCommand(), 'harvest-run', '--transcript', transcript, '--session', sessionId(input), '--cwd', inputCwd(input, agent)]
  const pid = spawn(argv, { env: { ...process.env, [HARVEST_ENV]: '1' }, logFile: log })
  if (pid === null || pid === undefined) throw new Error(`spawn ${argv[0]}`)
}

export function stripTags(input) {
  let out = input
  for (const tag of TAGS) {
    const open = `<${tag}>`
    const close = `</${tag}>`
    for (let start = out.indexOf(open); start !== -1; start = out.indexOf(open)) {
      const end = out.indexOf(close, start)
      if (end === -1) {
        out = out.slice(0, start)
        break
      }
      out = out.slice(0, start) + out.slice(end + close.length)
    }
  }
  return text.trim(out)
}

export function transcriptText(file, skipLines) {
  let raw
  try {
    raw = paths.readUtf8Strict(file)
  } catch (error) {
    throw new Error(`open ${file}`, { cause: error })
  }
  let out = ''
  let count = 0
  for (const line of text.lines(raw)) {
    count++
    if (count <= skipLines) continue
    let entry
    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }
    const role = str(field(entry, 'type')) ?? ''
    if (!(role === 'user' || role === 'assistant') || field(entry, 'isSidechain') === true || field(entry, 'isMeta') === true) continue
    const content = field(field(entry, 'message'), 'content')
    const parts = []
    if (typeof content === 'string') parts.push(content)
    else if (Array.isArray(content)) {
      for (const item of content) {
        const t = field(item, 'text')
        if (field(item, 'type') === 'text' && typeof t === 'string') parts.push(t)
      }
    }
    const joined = stripTags(parts.join('\n'))
    if (joined === '') continue
    out += `${role === 'user' ? 'USER' : 'ASSISTANT'}: ${joined}\n\n`
  }
  return { text: out, count }
}

export function knownProjects(store) {
  const out = []
  try {
    for (const row of store.db.prepare('SELECT slug, name, key FROM projects WHERE slug != ?1 ORDER BY slug').all(GLOBAL)) {
      const parts = [row.slug, row.name, row.key].filter((p) => typeof p === 'string').map(text.trim).filter((p) => p !== '')
      out.push(parts.join(' · '))
    }
  } catch {}
  try {
    for (const row of store.db.prepare('SELECT DISTINCT name FROM project_groups WHERE name != ?1 ORDER BY name').all(GLOBAL)) {
      out.push(`${row.name} (grupo)`)
    }
  } catch {}
  return out
}

export function harvestPrompt(slug, known, transcript) {
  const knownBlock = known.length === 0 ? '' : `Proyectos conocidos:\n${known.map((k) => `- ${k}`).join('\n')}\n\n`
  return (
    `Extrae aprendizajes DURADEROS de esta conversación de trabajo (proyecto: ${slug}). ` +
    'Solo: decisiones tomadas, correcciones del usuario, convenciones del proyecto, datos del cliente o de infraestructura. ' +
    'Nada efímero (estado de la tarea, pasos ya hechos, errores resueltos sin lección, saludos). ' +
    'Cada nota atómica: un solo hecho, autocontenida, en el idioma de la conversación, título corto, cuerpo de 1 a 3 frases; usa [[Título]] para enlazar notas relacionadas. ' +
    'kind: decision | fact | rule (rule solo si el usuario dio una instrucción permanente). ' +
    'project: omítelo salvo que el hecho sea claramente de otro proyecto de la lista de proyectos conocidos (usa su slug) o general del usuario (usa "global"). ' +
    'Responde SOLO un arreglo JSON: [{"kind":"...","title":"...","body":"...","project":"..."}]. Si no hay nada durable, responde [].\n\n' +
    `${knownBlock}<conversation>\n${transcript}\n</conversation>`
  )
}

export function harvestTarget(store, itemProject, fallback) {
  const name = typeof itemProject === 'string' ? text.trim(itemProject) : ''
  if (name === '') return fallback
  if (name === GLOBAL) return GLOBAL
  const slug = project.projectForName(store, name)
  let known = false
  try {
    known = store.db.prepare('SELECT 1 AS found FROM projects WHERE slug = ?1 UNION SELECT 1 FROM project_groups WHERE name = ?1 LIMIT 1').get(slug) !== undefined
  } catch {}
  return known ? slug : fallback
}

export function parseLearnings(raw) {
  let source = raw
  try {
    const result = field(JSON.parse(raw), 'result')
    if (typeof result === 'string') source = result
  } catch {}
  const start = source.indexOf('[')
  const end = source.lastIndexOf(']')
  if (start === -1 || end === -1 || end < start) return []
  try {
    const parsed = JSON.parse(source.slice(start, end + 1))
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

export function privateDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true })
  } catch (error) {
    throw new Error(`create ${dir}`, { cause: error })
  }
  if (process.platform !== 'win32') fs.chmodSync(dir, 0o700)
  return dir
}

export async function harvestRun(store, emb, transcript, session, cwd, { out = process.stdout, run = agents.run } = {}) {
  const log = (message) => out.write(`${text.nowIso()} ${message}\n`)
  const cfg = store.cfg.harvest
  if (!cfg.enabled) return
  const row = store.db.prepare('SELECT lines FROM harvests WHERE session_id = ?1').get(session)
  const done = row ? Number(row.lines) : 0
  const { text: conversation, count: total } = transcriptText(transcript, done)
  const chars = [...conversation]
  if (chars.length < cfg.min_chars) {
    log(`harvest ${session}: nothing new (${chars.length} chars)`)
    return
  }
  const tail = chars.slice(Math.max(chars.length - cfg.max_chars, 0)).join('')
  const resolved = project.resolve(store, cwd, false)
  const request = harvestPrompt(resolved.slug, knownProjects(store), tail)
  const agent = agents.parseAgent(cfg.agent)
  if (agent === null) {
    log(`harvest ${session}: unknown harvest agent ${JSON.stringify(cfg.agent)}`)
    return
  }
  const env = [[HARVEST_ENV, '1'], ['BITA_NO_HOOKS', '1'], ['KIT_NO_EVENTS', '1']]
  const outcome = await run(agent, request, cfg.model ?? null, privateDir(paths.harvestDir()), cfg.timeout_seconds * 1000, env)
  if (outcome.type === 'timeout') {
    log(`harvest ${session}: ${agent} timed out`)
    return
  }
  if (outcome.type === 'failed') {
    log(`harvest ${session}: ${agent} failed: ${text.truncate(outcome.stderr, 300)}`)
    return
  }
  const saved = []
  for (const item of parseLearnings(outcome.text).slice(0, cfg.max_items)) {
    const rawKind = str(field(item, 'kind')) ?? 'fact'
    const kind = LEARNING_KINDS.includes(rawKind) ? rawKind : 'fact'
    const body = str(field(item, 'body'))
    if (body === null || Buffer.byteLength(text.trim(body), 'utf8') <= 10) continue
    const target = harvestTarget(store, str(field(item, 'project')), resolved.slug)
    const written = await store.remember(emb, { project: target, kind, title: str(field(item, 'title')), body, source: 'harvest' }, true)
    saved.push(`${written.action}:${written.id}`)
  }
  store.db
    .prepare('INSERT INTO harvests (session_id, lines, at) VALUES (?1, ?2, ?3) ON CONFLICT(session_id) DO UPDATE SET lines = excluded.lines, at = excluded.at')
    .run(session, total, text.nowIso())
  log(`harvest ${session} [${resolved.slug}] ${charCount(tail)} chars -> ${saved.length === 0 ? 'nothing' : saved.join(', ')}`)
}
