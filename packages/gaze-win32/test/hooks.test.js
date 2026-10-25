import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { FakeEmbedder } from '../src/embed.js'
import {
  BRAIN_LINE,
  Gate,
  HARVEST_ENV,
  disabled,
  gatePasses,
  harvest,
  harvestPrompt,
  harvestRun,
  harvestTarget,
  hookOutput,
  knownProjects,
  needsBackgroundRefresh,
  parseLearnings,
  pointerLine,
  privateDir,
  projectDir,
  prompt,
  readInput,
  resolveForHook,
  ruleLine,
  selectPointers,
  sessionContext,
  sessionStart,
  stripTags,
  transcriptText,
  trivialPrompt,
} from '../src/hooks.js'
import { canonical, selfCommand } from '../src/paths.js'
import { globalProject, nowSecs } from '../src/project.js'
import { GLOBAL, Store } from '../src/store.js'
import { estimateTokens } from '../src/text.js'

const VARS = [
  'GAZE_DATA_DIR',
  'GAZE_EMBEDDER',
  'GAZE_CONFIG',
  'GAZE_SOCKET',
  'KIT_REGISTRY_DIR',
  'GAZE_BITA_BIN',
  'GAZE_PROJECT',
  'GAZE_HARVEST',
  'KIT_HEADLESS',
  'CLAUDE_PROJECT_DIR',
  'GEMINI_PROJECT_DIR',
  'BITA_CONFIG_PATH',
]
const TRANSCRIPT = new URL('./fixtures/transcript/session.jsonl', import.meta.url)
const e = new FakeEmbedder()
let saved
let dir

beforeEach(() => {
  saved = Object.fromEntries(VARS.map((name) => [name, process.env[name]]))
  dir = canonical(fs.mkdtempSync(path.join(os.tmpdir(), 'gaze-hooks-')))
  process.env.GAZE_DATA_DIR = path.join(dir, 'data')
  process.env.GAZE_EMBEDDER = 'fake'
  process.env.GAZE_CONFIG = path.join(dir, 'config.toml')
  process.env.GAZE_SOCKET = path.join(dir, 'gaze.sock')
  process.env.KIT_REGISTRY_DIR = path.join(dir, 'tools.d')
  process.env.GAZE_BITA_BIN = '/nonexistent/bita'
  process.env.BITA_CONFIG_PATH = path.join(dir, 'missing-bita.json')
  for (const name of ['GAZE_PROJECT', 'GAZE_HARVEST', 'KIT_HEADLESS', 'CLAUDE_PROJECT_DIR', 'GEMINI_PROJECT_DIR']) delete process.env[name]
})

afterEach(() => {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  fs.rmSync(dir, { recursive: true, force: true })
})

const rule = (project, title, body, pinned) => ({ project, kind: 'rule', title, body, source: 'user', pinned })

function cachedCwd(store, slug = 'den') {
  const work = path.join(dir, 'work')
  fs.mkdirSync(work, { recursive: true })
  const cwd = canonical(work)
  store.db.prepare("INSERT INTO project_cache (cwd, project, source, resolved_at) VALUES (?1, ?2, 'test', ?3)").run(cwd, slug, nowSecs())
  return cwd
}

test('session context is capped', async () => {
  const store = Store.inMemory()
  for (let i = 0; i < 40; i++) {
    await store.remember(e, rule(GLOBAL, `Regla ${i}`, `Regla ${i}: siempre hacer la cosa número ${i} con mucho cuidado y detalle`, false), false)
  }
  const rules = store.activeRules('den')
  const context = sessionContext(rules, 300)
  assert.ok(estimateTokens(context) <= 300 + estimateTokens(BRAIN_LINE) + 15, String(estimateTokens(context)))
  assert.ok(context.includes('reglas más: gaze rule ls'))
  assert.ok(context.startsWith(BRAIN_LINE))
  assert.equal(sessionContext([], 300), BRAIN_LINE)
})

test('only fresh global resolutions with a slug refresh in background', () => {
  const fresh = { ...globalProject('default'), repo: 'github.com/kikedealba' }
  assert.ok(needsBackgroundRefresh(fresh))
  assert.ok(!needsBackgroundRefresh({ ...fresh, source: 'cache:default' }))
  assert.ok(!needsBackgroundRefresh({ ...fresh, repo: null }))
  assert.ok(!needsBackgroundRefresh({ ...fresh, slug: 'gaze' }))
  assert.ok(!needsBackgroundRefresh({ ...fresh, source: 'env' }))
})

test('harvest dir is private', { skip: process.platform === 'win32' }, () => {
  const target = privateDir(path.join(dir, 'harvest'))
  assert.equal(fs.statSync(target).mode & 0o777, 0o700)
})

test('hook output shape', () => {
  const out = hookOutput('SessionStart', 'x')
  assert.equal(out.hookSpecificOutput.hookEventName, 'SessionStart')
  assert.equal(out.hookSpecificOutput.additionalContext, 'x')
  assert.equal(Object.keys(out).length, 1)
})

test('trivial prompts are skipped', () => {
  assert.ok(trivialPrompt('ok', 20))
  assert.ok(trivialPrompt('/compact algo largo de verdad aquí', 20))
  assert.ok(trivialPrompt('continúa por favor....', 20))
  assert.ok(!trivialPrompt('¿cómo desplegamos la api de pagos a producción?', 20))
  assert.ok(trivialPrompt('!ls -la de todo el directorio actual', 20))
  assert.ok(trivialPrompt('   go ahead!!!   ', 1))
  assert.ok(trivialPrompt('gracias, perfecto, adelante', 5))
})

test('prompt hook respects budget threshold and session', async () => {
  const store = Store.inMemory()
  store.cfg.hooks.prompt_threshold = Math.fround(0.3)
  store.cfg.hooks.prompt_margin = 0
  const cwd = cachedCwd(store)
  for (let i = 0; i < 6; i++) {
    await store.remember(
      e,
      {
        project: 'den',
        kind: 'fact',
        title: `Despliegue api pagos ${i}`,
        body: `El despliegue de la api de pagos usa github actions y aws lambda variante ${i} con detalles adicionales largos para ocupar espacio en el contexto`,
        source: 'user',
      },
      false,
    )
  }
  await store.remember(e, { project: 'den', kind: 'fact', body: 'Las facturas se mandan los viernes', source: 'user' }, false)
  const input = { session_id: 's1', prompt: '¿cómo es el despliegue de la api de pagos en aws lambda?', cwd }
  const out = await prompt(store, input, 'claude')
  assert.ok(out, 'should inject')
  const context = out.hookSpecificOutput.additionalContext
  assert.equal(out.hookSpecificOutput.hookEventName, 'UserPromptSubmit')
  assert.ok(estimateTokens(context) <= 150, String(estimateTokens(context)))
  const lines = context.split('\n').length - 1
  assert.ok(lines >= 1 && lines <= 3)
  assert.ok(!context.includes('facturas'))
  const again = await prompt(store, input, 'claude')
  if (again) {
    const second = again.hookSpecificOutput.additionalContext
    for (const line of context.split('\n').slice(1)) assert.ok(!second.includes(line))
  }
  const unrelated = { session_id: 's2', prompt: 'escribe un poema sobre gatos y la luna llena', cwd }
  assert.equal(await prompt(store, unrelated, 'claude'), null)
  const gemini = await prompt(store, { session_id: 's3', prompt: '¿cómo es el despliegue de la api de pagos en aws lambda?', cwd }, 'gemini')
  assert.ok(gemini, 'gemini should inject')
  assert.equal(gemini.hookSpecificOutput.hookEventName, 'BeforeAgent')
  const stats = store.stats().injection.hooks.prompt
  assert.equal(stats.runs, 4)
})

test('prompt hook without a daemon spawns it and falls back to text search', async () => {
  delete process.env.GAZE_EMBEDDER
  const store = Store.inMemory()
  const cwd = cachedCwd(store)
  await store.remember(e, { project: 'den', kind: 'fact', title: 'Despliegue api pagos lambda', body: 'El despliegue de la api de pagos usa aws lambda', source: 'user' }, false)
  let spawned = 0
  let probed = null
  const out = await prompt(store, { session_id: 's1', prompt: 'despliegue de la api de pagos en aws lambda', cwd }, 'claude', {
    alive: async (endpoint, ms) => {
      probed = [endpoint, ms]
      return false
    },
    spawnOnDemand: () => {
      spawned++
      return true
    },
  })
  assert.equal(spawned, 1)
  assert.equal(probed[1], 200)
  assert.equal(probed[0], process.env.GAZE_SOCKET)
  assert.ok(out, 'lexical gate should pass')
  assert.ok(out.hookSpecificOutput.additionalContext.includes('Despliegue api pagos'))
})

test('prompt hook ignores trivial prompts before touching the store', async () => {
  const store = Store.inMemory()
  assert.equal(await prompt(store, { prompt: 'ok' }, 'claude'), null)
  assert.equal(await prompt(store, null, 'claude'), null)
  assert.equal(store.stats().injection.sessions, 0)
})

test('session start injects active rules and records them', async () => {
  const store = Store.inMemory()
  const cwd = cachedCwd(store)
  const saved = await store.remember(e, rule('den', 'Nunca uses npm', 'Nunca uses npm, usa pnpm', true), false)
  await store.remember(e, rule('otro', 'Ajena', 'Regla de otro proyecto', false), false)
  const out = sessionStart(store, { session_id: 't', cwd }, 'gemini')
  const context = out.hookSpecificOutput.additionalContext
  assert.equal(out.hookSpecificOutput.hookEventName, 'SessionStart')
  assert.ok(context.startsWith(`${BRAIN_LINE}\nReglas activas:\n- Nunca uses npm, usa pnpm`))
  assert.ok(!context.includes('otro proyecto'))
  assert.ok(store.injected('t').has(saved.id))
  const plain = sessionStart(store, { cwd: path.join(dir, 'missing') }, 'claude')
  assert.equal(plain.hookSpecificOutput.additionalContext, BRAIN_LINE)
  assert.ok(store.injected('unknown').size === 0)
})

test('rule lines skip a title already in the body', () => {
  assert.equal(ruleLine({ title: 'Nunca npm', body: 'Nunca npm,\n  usa pnpm' }), '- Nunca npm, usa pnpm')
  assert.equal(ruleLine({ title: 'Paquetes', body: 'usa pnpm' }), '- Paquetes: usa pnpm')
  assert.equal(ruleLine({ title: 'Nunca uses…', body: 'Nunca uses npm' }), '- Nunca uses npm')
  assert.equal(ruleLine({ title: '', body: 'x' }), '- x')
  assert.ok(ruleLine({ title: 'T', body: 'palabra '.repeat(60) }).endsWith('…'))
})

test('pointers follow the gate and the budget', () => {
  const hit = (id, similarity, coverage, titleCoverage) => ({ id, title: `Nota ${id}`, body: `Nota ${id}\nResumen de ${id}`, similarity, coverage, titleCoverage })
  assert.equal(pointerLine(hit('a', 1, 1, 1)), '[a] Nota a — Resumen de a')
  assert.equal(pointerLine({ id: 'b', title: 'Solo', body: 'Solo' }), '[b] Solo')
  const hits = [hit('a', 0.9, 0.5, 0.5), hit('b', 0.5, 1, 1), hit('c', 0.95, 0.1, 1), hit('d', 0.91, 0.3, 0)]
  assert.equal(Gate.floorOf(hits.slice(0, 2)), 0)
  assert.equal(Gate.floorOf(hits), 0.9)
  const semantic = new Gate({ semantic: true, threshold: Math.fround(0.84), margin: 0, lexicalThreshold: Math.fround(0.75), floor: 0 })
  assert.deepEqual(selectPointers(hits, semantic, 3, 150).ids, ['a', 'd'])
  assert.ok(semantic.passes(hits[0]))
  const strict = new Gate({ ...semantic, floor: Gate.floorOf(hits), margin: Math.fround(0.03) })
  assert.deepEqual(selectPointers(hits, strict, 3, 150).ids, [])
  const lexical = new Gate({ ...semantic, semantic: false })
  assert.ok(gatePasses(lexical, hits[1]))
  assert.ok(!gatePasses(lexical, hits[3]))
  const picked = selectPointers(hits, semantic, 1, 150)
  assert.equal(picked.context, 'gaze: notas quizá útiles (léelas con gaze_search "<id>"):\n[a] Nota a — Resumen de a')
  assert.deepEqual(selectPointers(hits, semantic, 3, 20), { context: '', ids: [] })
})

test('transcript filter keeps only text', () => {
  const file = path.join(dir, 't.jsonl')
  const lines = [
    { type: 'user', message: { role: 'user', content: 'Usa pnpm, nunca npm <system-reminder>secreto</system-reminder>' } },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Entendido' }, { type: 'tool_use', name: 'Bash', input: {} }] } },
    { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'salida enorme' }] } },
    { type: 'summary', summary: 'x' },
  ]
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n'))
  const { text, count } = transcriptText(file, 0)
  assert.equal(count, 4)
  assert.ok(text.includes('USER: Usa pnpm, nunca npm'))
  assert.ok(text.includes('ASSISTANT: Entendido'))
  assert.ok(!text.includes('secreto'))
  assert.ok(!text.includes('salida enorme'))
  assert.equal(transcriptText(file, 2).text, '')
})

test('transcript fixture drops sidechains, meta, unclosed tags and junk lines', () => {
  const { text, count } = transcriptText(TRANSCRIPT, 0)
  assert.equal(count, 9)
  assert.equal(text, 'USER: Usa pnpm, nunca npm\n\nASSISTANT: Entendido\n\nASSISTANT: Las facturas del cliente se mandan los viernes por correo.\n\n')
  assert.throws(() => transcriptText(path.join(dir, 'missing.jsonl'), 0), /^Error: open /)
})

test('strip tags removes every closed block and truncates at an unclosed one', () => {
  assert.equal(stripTags('a<command-args>x</command-args>b<command-args>y</command-args>c'), 'abc')
  assert.equal(stripTags('  hola <local-command-stdout>resto'), 'hola')
})

test('learnings parse from claude json', () => {
  const raw = JSON.stringify({ type: 'result', result: 'Aquí:\n```json\n[{"kind":"decision","title":"T","body":"B"}]\n```' })
  const items = parseLearnings(raw)
  assert.equal(items.length, 1)
  assert.equal(items[0].kind, 'decision')
  assert.equal(parseLearnings('{"result":"nada"}').length, 0)
  assert.deepEqual(parseLearnings('] y luego ['), [])
  assert.deepEqual(parseLearnings('texto [1, 2]'), [1, 2])
  assert.deepEqual(parseLearnings('[no es json]'), [])
})

function storeWithProjects() {
  const store = Store.inMemory()
  store.db.exec("INSERT INTO projects (slug, bita_id, name, key) VALUES ('kikedealba-modules', 1, 'Kike Modules', 'KM')")
  store.db.exec("INSERT INTO projects (slug, bita_id, name, key) VALUES ('bare', 2, NULL, NULL)")
  store.db.exec("INSERT INTO projects (slug, bita_id, name, key) VALUES ('global', 3, 'Global', 'GL')")
  store.setGroup('dp', ['app-dp-v2', 'dportenis'])
  return store
}

test('harvest target accepts only known projects', () => {
  const store = storeWithProjects()
  assert.equal(harvestTarget(store, null, 'den'), 'den')
  assert.equal(harvestTarget(store, '  ', 'den'), 'den')
  assert.equal(harvestTarget(store, 'global', 'den'), GLOBAL)
  assert.equal(harvestTarget(store, 'kikedealba-modules', 'den'), 'kikedealba-modules')
  assert.equal(harvestTarget(store, 'KM', 'den'), 'kikedealba-modules')
  assert.equal(harvestTarget(store, 'km', 'den'), 'kikedealba-modules')
  assert.equal(harvestTarget(store, 'Km', 'den'), 'kikedealba-modules')
  assert.equal(harvestTarget(store, 'DP', 'den'), 'dp')
  assert.equal(harvestTarget(store, 'Kike Modules', 'den'), 'kikedealba-modules')
  assert.equal(harvestTarget(store, 'dp', 'den'), 'dp')
  assert.equal(harvestTarget(store, 'invented-project', 'den'), 'den')
})

test('known projects lists rows and groups without global', () => {
  assert.deepEqual(knownProjects(storeWithProjects()), ['bare', 'kikedealba-modules · Kike Modules · KM', 'dp (grupo)'])
})

test('harvest prompt includes known projects and transcript', () => {
  const known = ['kikedealba-modules · Kike Modules · KM', 'dp (grupo)']
  const request = harvestPrompt('den', known, 'USER: hola')
  assert.ok(request.includes('Proyectos conocidos:\n- kikedealba-modules · Kike Modules · KM\n- dp (grupo)'))
  assert.ok(request.includes('<conversation>\nUSER: hola\n</conversation>'))
  assert.ok(request.startsWith('Extrae aprendizajes DURADEROS de esta conversación de trabajo (proyecto: den). Solo: decisiones'))
  assert.ok(request.includes('(usa "global"). Responde SOLO un arreglo JSON: [{"kind":"...","title":"...","body":"...","project":"..."}]. Si no hay nada durable, responde [].\n\nProyectos'))
  const bare = harvestPrompt('den', [], 'USER: hola')
  assert.ok(!bare.includes('Proyectos conocidos'))
  assert.ok(bare.includes('responde [].\n\n<conversation>\nUSER: hola\n</conversation>'))
})

test('hooks are disabled during harvest and headless runs', () => {
  assert.ok(!disabled())
  process.env[HARVEST_ENV] = '0'
  assert.ok(!disabled())
  process.env[HARVEST_ENV] = ''
  assert.ok(!disabled())
  process.env[HARVEST_ENV] = '1'
  assert.ok(disabled())
  delete process.env[HARVEST_ENV]
  process.env.KIT_HEADLESS = '1'
  assert.ok(disabled())
})

test('project dir prefers the agent variable', () => {
  assert.equal(projectDir('codex'), null)
  process.env.GEMINI_PROJECT_DIR = '/g'
  assert.equal(projectDir('claude'), '/g')
  process.env.CLAUDE_PROJECT_DIR = '/c'
  assert.equal(projectDir('gemini'), '/g')
  assert.equal(projectDir('codex'), '/c')
  process.env.CLAUDE_PROJECT_DIR = ''
  assert.equal(projectDir('claude'), '/g')
})

test('read input parses json or returns null', async () => {
  assert.deepEqual(await readInput(Readable.from([Buffer.from('{"a":'), Buffer.from('1}')])), { a: 1 })
  assert.equal(await readInput(Readable.from([Buffer.from('nope')])), null)
  assert.equal(await readInput(Readable.from([])), null)
})

test('harvest relaunches harvest-run detached with the harvest env', () => {
  const calls = []
  const spawn = (argv, options) => {
    calls.push([argv, options])
    return 42
  }
  harvest({ transcript_path: '/t.jsonl', session_id: 's9', cwd: '/w' }, 'gemini', { spawn })
  harvest({ session_id: 's9' }, 'claude', { spawn })
  assert.equal(calls.length, 0)
  harvest({ transcript_path: '/t.jsonl', session_id: 's9', cwd: '/w' }, 'claude', { spawn })
  assert.equal(calls.length, 1)
  const [argv, options] = calls[0]
  assert.deepEqual(argv, [...selfCommand(), 'harvest-run', '--transcript', '/t.jsonl', '--session', 's9', '--cwd', '/w'])
  assert.equal(options.env[HARVEST_ENV], '1')
  assert.equal(options.logFile, path.join(process.env.GAZE_DATA_DIR, 'harvest.log'))
  assert.ok(fs.existsSync(options.logFile))
  assert.throws(() => harvest({ transcript_path: '/t.jsonl' }, 'claude', { spawn: () => null }))
})

test('hook resolution refreshes fresh global projects in the background', () => {
  const store = Store.inMemory()
  const calls = []
  const cwd = cachedCwd(store, GLOBAL)
  const resolved = resolveForHook(store, cwd, { spawn: (argv) => calls.push(argv) })
  assert.equal(resolved.source, 'cache:test')
  assert.equal(calls.length, 0)
})

test('harvest run saves learnings once per transcript line', async () => {
  process.env.GAZE_PROJECT = 'den'
  const store = Store.inMemory()
  store.cfg.harvest.min_chars = 10
  const transcript = path.join(dir, 'session.jsonl')
  fs.copyFileSync(TRANSCRIPT, transcript)
  const written = []
  const out = { write: (s) => written.push(s) }
  const requests = []
  const run = async (agent, request, model, cwd, timeoutMs, env) => {
    requests.push({ agent, request, model, cwd, timeoutMs, env })
    return {
      type: 'text',
      text: 'Notas:\n[{"kind":"decision","title":"Gestor de paquetes","body":"El proyecto usa pnpm y nunca npm."},{"kind":"otro","body":"corto"},{"kind":"weird","title":"Facturas","body":"Las facturas del cliente se mandan los viernes.","project":"global"}]',
    }
  }
  await harvestRun(store, e, transcript, 's1', dir, { out, run })
  assert.equal(requests.length, 1)
  assert.equal(requests[0].agent, 'claude')
  assert.equal(requests[0].model, null)
  assert.equal(requests[0].timeoutMs, 240000)
  assert.deepEqual(requests[0].env, [['GAZE_HARVEST', '1'], ['BITA_NO_HOOKS', '1'], ['KIT_NO_EVENTS', '1']])
  assert.equal(requests[0].cwd, path.join(process.env.GAZE_DATA_DIR, 'harvest'))
  assert.ok(requests[0].request.includes('(proyecto: den)'))
  assert.ok(requests[0].request.includes('USER: Usa pnpm, nunca npm'))
  const nodes = store.db.prepare("SELECT project, kind, title, source FROM nodes WHERE source = 'harvest' ORDER BY title").all()
  assert.deepEqual(nodes.map((n) => [n.project, n.kind, n.title]), [['global', 'fact', 'Facturas'], ['den', 'decision', 'Gestor de paquetes']])
  assert.equal(Number(store.db.prepare('SELECT lines FROM harvests WHERE session_id = ?').get('s1').lines), 9)
  assert.match(written.at(-1), /^\S+ harvest s1 \[den\] \d+ chars -> created:\w{10}, created:\w{10}\n$/)
  await harvestRun(store, e, transcript, 's1', dir, { out, run })
  assert.equal(requests.length, 1)
  assert.match(written.at(-1), /harvest s1: nothing new \(0 chars\)\n$/)
})

test('harvest run reports timeouts, failures and unknown agents', async () => {
  process.env.GAZE_PROJECT = 'den'
  const store = Store.inMemory()
  store.cfg.harvest.min_chars = 10
  const written = []
  const out = { write: (s) => written.push(s) }
  await harvestRun(store, e, TRANSCRIPT, 'a', dir, { out, run: async () => ({ type: 'timeout' }) })
  assert.match(written.at(-1), /harvest a: claude timed out\n$/)
  await harvestRun(store, e, TRANSCRIPT, 'b', dir, { out, run: async () => ({ type: 'failed', stderr: 'boom' }) })
  assert.match(written.at(-1), /harvest b: claude failed: boom\n$/)
  store.cfg.harvest.agent = 'nadie'
  await harvestRun(store, e, TRANSCRIPT, 'c', dir, { out })
  assert.match(written.at(-1), /harvest c: unknown harvest agent "nadie"\n$/)
  store.cfg.harvest.enabled = false
  await harvestRun(store, e, TRANSCRIPT, 'd', dir, { out })
  assert.equal(written.length, 3)
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM harvests').get().n, 0)
})
