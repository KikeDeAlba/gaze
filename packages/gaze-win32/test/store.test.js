import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { GLOBAL, Store, contentHash, coverage, embedOrLog, ensureFound, ftsQuery, hitJson, validateKind, validateUntil } from '../src/store.js'
import { SCHEMA, openDb } from '../src/db.js'
import { GazeError } from '../src/envelope.js'
import { terms } from '../src/text.js'
import { DIMS, normalize } from '../src/vector.js'

const fake = {
  async embed(texts) {
    return texts.map((t) => {
      const v = new Float32Array(DIMS)
      for (const term of terms(t)) {
        let h = 1469598103934665603n
        for (const b of Buffer.from(term, 'utf8')) {
          h ^= BigInt(b)
          h = (h * 1099511628211n) & 0xffffffffffffffffn
        }
        v[Number(h % BigInt(DIMS))] += 1
      }
      v[DIMS - 1] = v[DIMS - 1] + Math.fround(0.01)
      return normalize(v)
    })
  },
}

const broken = {
  async embed() {
    throw new Error('daemon down')
  },
}

const note = (project, kind, title, body, extra = {}) => ({ project, kind, title, body, source: 'user', ...extra })
const opts = (extra = {}) => ({ limit: 5, ...extra })
const projectScope = (project) => ({ kind: 'project', project })
const ALL = { kind: 'all' }

let stderrWrite
before(() => {
  stderrWrite = process.stderr.write
})
after(() => {
  process.stderr.write = stderrWrite
})

function silenced(fn) {
  const lines = []
  process.stderr.write = (chunk) => {
    lines.push(String(chunk))
    return true
  }
  return Promise.resolve(fn()).finally(() => {
    process.stderr.write = stderrWrite
  }).then((value) => ({ value, lines }))
}

describe('ported from store.rs', () => {
  test('a failed embedding still saves the note without vectors', async () => {
    const { value: none, lines } = await silenced(() => embedOrLog(broken, ['x']))
    assert.equal(none, null)
    assert.match(lines[0], /^\d{4}-\d{2}-\d{2}T\S+Z gaze: embedding failed, saving without vectors \(gaze reindex fixes it\): daemon down\n$/)
    const store = Store.inMemory()
    const { value: outcome } = await silenced(() => store.remember(broken, { project: 'den', kind: 'fact', body: 'Sin vectores pero guardada', source: 'user' }, true))
    assert.equal(outcome.action, 'created')
    assert.ok(store.get(outcome.id))
    assert.equal(store.stats().unembedded, 1)
  })

  test('remember and search hybrid', async () => {
    const store = Store.inMemory()
    await store.remember(fake, note('den', 'fact', 'Base de datos', 'La base de datos de den usa sqlite con WAL'), true)
    await store.remember(fake, note('den', 'decision', 'Despliegue', 'Desplegamos con GitHub Actions a producción'), true)
    await store.remember(fake, note('otro', 'fact', 'Otra base', 'La base de datos de otro usa postgres'), true)
    const hits = await store.search(fake, 'qué base de datos usa', projectScope('den'), opts())
    assert.equal(hits[0].title, 'Base de datos')
    assert.ok(hits.every((h) => h.project !== 'otro'))
    assert.ok([...hits[0].snippet].length <= 200)
    const all = await store.search(fake, 'base de datos postgres', ALL, opts())
    assert.ok(all.some((h) => h.project === 'otro'))
    const lexicalOnly = await store.search(null, 'sqlite', projectScope('den'), opts())
    assert.equal(lexicalOnly.length, 1)
  })

  test('groups share rules and search across their projects', async () => {
    const store = Store.inMemory()
    const rule = await store.remember(fake, note('dportenis', 'rule', 'Commits', 'En DP los commits llevan la clave de Jira al inicio'), true)
    await store.remember(fake, note('dpsuites', 'fact', 'Pipeline', 'El pipeline de dpsuites corre en GitHub Actions'), true)
    await store.remember(fake, note('apartados', 'rule', 'VM', 'No mencionar la VM en apartados'), true)
    assert.deepEqual(store.activeRules('dpsuites'), [])

    store.setGroup('dp', ['dportenis', 'dpsuites'])
    const rules = store.activeRules('dpsuites')
    assert.equal(rules.length, 1)
    assert.equal(rules[0].project, 'dportenis')
    const hits = await store.search(null, 'pipeline', projectScope('dportenis'), opts())
    assert.equal(hits.length, 1)

    const moved = await store.moveNode(fake, rule.id, 'dp')
    assert.equal(moved.project, 'dp')
    assert.equal(store.activeRules('dportenis')[0].project, 'dp')
    assert.ok(store.activeRules('apartados').every((r) => r.project !== 'dp'))
    assert.equal(store.rules('dpsuites', false).length, 1)
    assert.equal(store.removeGroup('dp'), true)
    assert.deepEqual(store.activeRules('dpsuites'), [])
  })

  test('dedupe merges near duplicates', async () => {
    const store = Store.inMemory()
    const first = await store.remember(fake, note('den', 'fact', 'Puerto', 'El servidor de den escucha en el puerto 8080 local'), true)
    const second = await store.remember(fake, note('den', 'fact', undefined, 'El servidor de den escucha en el puerto 8080 local'), true)
    assert.equal(second.action, 'merged')
    assert.equal(second.id, first.id)
    const third = await store.remember(fake, note('den', 'fact', 'Otra cosa', 'Las facturas se mandan los viernes al cliente'), true)
    assert.equal(third.action, 'created')
    const otherProject = await store.remember(fake, note('x', 'fact', 'Puerto', 'El servidor de den escucha en el puerto 8080 local'), true)
    assert.equal(otherProject.action, 'created')
  })

  test('merge keeps both facts unless nearly identical', async () => {
    const store = Store.inMemory()
    store.cfg.search.dedupe_threshold = Math.fround(0.9)
    const first = await store.remember(fake, note('den', 'fact', 'Puerto', 'El servidor de den escucha en el puerto 8080 local'), true)
    const second = await store.remember(fake, note('den', 'fact', 'Puerto', 'El servidor den escucha siempre en puerto 8080 local'), true)
    assert.deepEqual([second.action, second.id], ['merged', first.id])
    const body = store.require(first.id).body
    assert.ok(body.startsWith('El servidor den escucha siempre en puerto 8080 local'))
    assert.ok(body.endsWith('El servidor de den escucha en el puerto 8080 local'))
  })

  test('wikilinks become edges even when target arrives later', async () => {
    const store = Store.inMemory()
    const a = await store.remember(fake, note('den', 'fact', 'Auth', 'Usa tokens, ver [[Sesiones]] y [[Global rule]]'), false)
    const g = await store.remember(fake, note(GLOBAL, 'rule', 'Global rule', 'Siempre en inglés'), false)
    const b = await store.remember(fake, note('den', 'fact', 'Sesiones', 'Duran 8 horas'), false)
    const neighbors = store.neighbors(a.id)
    assert.ok(neighbors.some((n) => n.id === b.id && n.edgeKind === 'link'))
    assert.ok(neighbors.some((n) => n.id === g.id && n.edgeKind === 'link'))
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM pending_links').get().n, 0)
  })

  test('source ref upserts and issue edges', async () => {
    const store = Store.inMemory()
    const doc = note('dp', 'doc', 'Infra', 'Cuenta AWS, ver DD-1905', { source: 'inkwell', sourceRef: 'inkwell:dp/infra.md' })
    const first = await store.remember(fake, doc, true)
    assert.equal((await store.remember(fake, doc, true)).action, 'unchanged')
    const updated = await store.remember(fake, { ...doc, body: 'Cuenta AWS actualizada, ver DD-1905' }, true)
    assert.deepEqual([updated.action, updated.id], ['updated', first.id])
    const entry = await store.remember(fake, note('dp', 'entry', 'Trabajo', 'Arreglé DD-1905'), false)
    assert.ok(store.neighbors(entry.id).some((n) => n.id === first.id && n.edgeKind === 'same-issue'))
  })

  test('rename source ref keeps the id and claims links to the new name', async () => {
    const store = Store.inMemory()
    const moved = await store.remember(fake, note('dp', 'doc', 'Infra', 'Cuenta AWS', { source: 'inkwell', sourceRef: 'inkwell:dp/infra.md' }), false)
    store.db.prepare("INSERT INTO ingest_files (path, mtime, node_id) VALUES ('inkwell:dp/infra.md', 1, ?)").run(moved.id)
    const waiting = await store.remember(fake, note('dp', 'fact', 'Pendiente', 'Ver [[ops-guide]]'), false)
    assert.deepEqual(store.neighbors(moved.id), [])
    const renamed = store.renameSourceRef('inkwell:dp/infra.md', 'inkwell:dp/ops-guide.md')
    assert.deepEqual(renamed, { id: moved.id, displaced: null })
    assert.equal(store.bySourceRef('inkwell:dp/ops-guide.md').id, moved.id)
    assert.ok(store.neighbors(moved.id).some((n) => n.id === waiting.id && n.edgeKind === 'link'))
    const { path: stored } = store.db.prepare('SELECT path FROM ingest_files WHERE node_id = ?').get(moved.id)
    assert.equal(stored, 'inkwell:dp/ops-guide.md')
    assert.equal(store.renameSourceRef('inkwell:dp/missing.md', 'inkwell:dp/other.md'), null)
  })

  test('graph contract shape', async () => {
    const store = Store.inMemory()
    const a = await store.remember(fake, note('den', 'fact', 'A', 'uno [[B]]'), false)
    await store.remember(fake, note('den', 'fact', 'B', 'dos'), false)
    await store.remember(fake, note('x', 'fact', 'C', 'tres'), false)
    const graph = store.graph('den')
    assert.equal(graph.nodes.length, 2)
    for (const n of graph.nodes) assert.deepEqual(Object.keys(n), ['id', 'project', 'kind', 'title', 'degree', 'pinned', 'updatedAt'])
    assert.equal(graph.edges.length, 1)
    assert.equal(graph.edges[0].src, a.id)
    assert.deepEqual(Object.keys(graph.edges[0]), ['src', 'dst', 'kind', 'weight'])
    assert.ok(graph.nodes.every((n) => n.degree === 1))
    assert.equal(store.graph(null).nodes.length, 3)
  })

  test('forget removes everything', async () => {
    const store = Store.inMemory()
    const a = await store.remember(fake, note('den', 'fact', 'A', 'uno [[B]]'), false)
    const b = await store.remember(fake, note('den', 'fact', 'B', 'dos'), false)
    const removed = store.forget(a.id)
    assert.equal(removed.id, a.id)
    assert.equal(store.get(a.id), null)
    assert.deepEqual(store.neighbors(b.id), [])
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM chunks WHERE node_id = ?').get(a.id).n, 0)
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM chunk_vectors').get().n, 1)
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM fts_nodes WHERE node_id = ?').get(a.id).n, 0)
  })

  test('rules order and expiry', async () => {
    const store = Store.inMemory()
    await store.remember(fake, note(GLOBAL, 'rule', 'g', 'Regla global'), false)
    await store.remember(fake, note(GLOBAL, 'rule', 'p', 'Regla fijada', { pinned: true }), false)
    await store.remember(fake, note('den', 'rule', 'd', 'Regla de den'), false)
    await store.remember(fake, note('den', 'rule', 'old', 'Vencida', { until: '2000-01-01' }), false)
    await store.remember(fake, note('x', 'rule', 'x', 'Regla de x'), false)
    assert.deepEqual(store.activeRules('den').map((r) => r.title), ['p', 'd', 'g'])
    assert.equal(store.rules('den', false).length, 3)
    assert.equal(store.rules('den', true).length, 4)
    assert.equal(store.rules(null, false).length, 4)
  })
})

describe('helpers', () => {
  test('contentHash is FNV-1a 64 over the parts with a zero byte after each', () => {
    assert.equal(contentHash([]), 'cbf29ce484222325')
    assert.equal(contentHash(['']), 'af63bd4c8601b7df')
    assert.equal(contentHash(['a']), '089be207b544f1e4')
    assert.match(contentHash(['den', 'fact', 'título', 'cuerpo', '0', '']), /^[0-9a-f]{16}$/)
    assert.notEqual(contentHash(['ab', 'c']), contentHash(['a', 'bc']))
  })

  test('ftsQuery joins terms with OR and turns long terms into prefixes', () => {
    assert.equal(ftsQuery('qué es la base de datos'), '"base" OR "datos"')
    assert.equal(ftsQuery('despliegue configuración'), '"desplie"* OR "configura"*')
    assert.equal(ftsQuery('docker'), '"docke"*')
    assert.equal(ftsQuery('de la y'), null)
  })

  test('coverage counts folded probes', () => {
    assert.equal(coverage([], 'x'), 0)
    assert.equal(coverage(terms('despliegue base'), 'Desplegamos la BASE'), 0.5)
    assert.equal(coverage(terms('configuracion'), 'Configuración del sistema'), 1)
  })

  test('validation messages are copied from Rust', () => {
    assert.throws(() => validateKind('nope'), (e) => e instanceof GazeError && e.code === 'USAGE_ERROR' && e.message === 'Tipo inválido: nope. Usa uno de: rule, fact, decision, doc, entry, issue, meeting, memory')
    for (const ok of ['2026-01-05', '2026-1-5', ' 2026-01-05', '2026- 01-05', '+2026-01-05', '+12026-01-05', '026-01-05', '2024-02-29', null, undefined]) validateUntil(ok)
    for (const bad of ['2026-02-29', '12026-01-05', '2026-01-05 ', '2026-001-05', '2026-00-05', '2026-01-00', '2026-01-5x', 'mañana']) {
      assert.throws(() => validateUntil(bad), { code: 'USAGE_ERROR', message: `Fecha inválida: ${bad}. Usa AAAA-MM-DD` })
    }
    assert.throws(() => ensureFound(false, 'grupo x'), { code: 'NOT_FOUND', message: 'No existe: grupo x' })
    ensureFound(true, 'x')
  })

  test('remember rejects bad input with the Rust messages', async () => {
    const store = Store.inMemory()
    await assert.rejects(store.remember(fake, note('den', 'fact', 't', '   '), true), { code: 'USAGE_ERROR', message: 'La nota está vacía' })
    await assert.rejects(store.remember(fake, { ...note('den', 'fact', 't', 'x'), source: 'web' }, true), { code: 'USAGE_ERROR', message: 'Fuente inválida: web' })
    await assert.rejects(store.remember(fake, note('den', 'wat', 't', 'x'), true), { code: 'USAGE_ERROR' })
    await assert.rejects(store.remember(fake, note('den', 'fact', 't', 'x', { until: '2026-13-01' }), true), { message: 'Fecha inválida: 2026-13-01. Usa AAAA-MM-DD' })
    const blank = await store.remember(fake, note('  ', 'fact', '  ', '  # Primera línea. Y más\nresto  '), false)
    assert.equal(blank.project, GLOBAL)
    assert.equal(blank.title, 'Primera línea')
    assert.equal(store.require(blank.id).body, '# Primera línea. Y más\nresto')
  })

  test('hitJson keeps the public fields and adds explain fields on demand', () => {
    const hit = { id: 'a', title: 't', kind: 'fact', project: 'p', snippet: 's', score: 0.0328, similarity: 0.5, coverage: 1, titleCoverage: 0, body: 'b' }
    assert.deepEqual(Object.keys(hitJson(hit)), ['id', 'title', 'kind', 'project', 'snippet', 'score'])
    assert.deepEqual(hitJson(hit, true), { id: 'a', title: 't', kind: 'fact', project: 'p', snippet: 's', score: 0.0328, similarity: 0.5, coverage: 1 })
  })
})

describe('store behaviour', () => {
  test('get resolves unique prefixes of four or more bytes', async () => {
    const store = Store.inMemory()
    const a = await store.remember(fake, note('den', 'fact', 'A', 'uno'), false)
    assert.equal(store.get(a.id.slice(0, 6)).id, a.id)
    assert.equal(store.get(a.id.slice(0, 3)), null)
    assert.throws(() => store.require('zzzzzz'), { code: 'NOT_FOUND', message: 'No existe: zzzzzz' })
  })

  test('show bumps hits after reading and lists neighbors', async () => {
    const store = Store.inMemory()
    const a = await store.remember(fake, note('den', 'fact', 'A', 'uno [[B]]'), false)
    const b = await store.remember(fake, note('den', 'fact', 'B', 'dos'), false)
    const first = store.show(a.id)
    assert.equal(first.node.hits, 0)
    assert.deepEqual(first.neighbors, [{ id: b.id, title: 'B', kind: 'fact', edgeKind: 'link' }])
    assert.equal(store.show(a.id).node.hits, 1)
    assert.deepEqual(Object.keys(first.node), ['id', 'project', 'kind', 'title', 'body', 'source', 'sourceRef', 'pinned', 'until', 'createdAt', 'updatedAt', 'hits'])
  })

  test('link rejects self links', async () => {
    const store = Store.inMemory()
    const a = await store.remember(fake, note('den', 'fact', 'A', 'uno'), false)
    const b = await store.remember(fake, note('den', 'fact', 'B', 'dos'), false)
    assert.throws(() => store.link(a.id, a.id), { code: 'USAGE_ERROR', message: 'No se puede enlazar una nota consigo misma' })
    const [x, y] = store.link(a.id, b.id)
    assert.deepEqual([x.id, y.id], [a.id, b.id])
    assert.equal(store.neighbors(b.id)[0].edgeKind, 'link')
  })

  test('similar edges link near notes in the same project', async () => {
    const store = Store.inMemory()
    const a = await store.remember(fake, note('den', 'doc', 'Puerto', 'El servidor escucha en el puerto 8080 local'), false)
    const b = await store.remember(fake, note('den', 'doc', 'Puerto', 'El servidor escucha en el puerto 8080 local'), false)
    const edge = store.db.prepare("SELECT src, dst, weight FROM edges WHERE kind = 'similar'").get()
    assert.deepEqual([edge.src, edge.dst], [a.id, b.id].sort())
    assert.ok(edge.weight >= 0.91 && edge.weight <= 1)
  })

  test('search filters by kind, excluded kinds and expiry, and rounds the score', async () => {
    const store = Store.inMemory()
    await store.remember(fake, note('den', 'fact', 'Kafka hecho', 'kafka brokers corren en tres nodos'), false)
    await store.remember(fake, note('den', 'decision', 'Kafka decisión', 'kafka elegido para eventos'), false)
    await store.remember(fake, note('den', 'rule', 'Kafka vencida', 'kafka viejo', { until: '2000-01-01' }), false)
    const all = await store.search(fake, 'kafka', projectScope('den'), opts())
    assert.deepEqual(all.map((h) => h.kind).sort(), ['decision', 'fact'])
    for (const h of all) assert.equal(h.score, Math.round(h.score * 1e4) / 1e4)
    assert.deepEqual((await store.search(fake, 'kafka', projectScope('den'), opts({ kind: 'decision' }))).map((h) => h.kind), ['decision'])
    assert.deepEqual((await store.search(fake, 'kafka', projectScope('den'), opts({ excludeKinds: ['decision'] }))).map((h) => h.kind), ['fact'])
    assert.equal((await store.search(fake, 'kafka', projectScope('den'), opts({ limit: 1 }))).length, 1)
    assert.equal((await store.search(fake, 'kafka', projectScope('den'), opts({ limit: 0 }))).length, 1)
  })

  test('search falls back to text when the query embedding fails', async () => {
    const store = Store.inMemory()
    await store.remember(fake, note('den', 'fact', 'Redis', 'redis guarda sesiones'), false)
    const hits = await store.search(broken, 'redis', projectScope('den'), opts())
    assert.equal(hits.length, 1)
    assert.equal(hits[0].similarity, null)
    assert.equal(hits[0].snippet, 'redis guarda sesiones')
  })

  test('search breaks score ties by id ascending', async () => {
    const store = Store.inMemory()
    const ids = []
    for (const word of ['alfa', 'bravo', 'charlie', 'delta']) ids.push((await store.remember(fake, note('den', 'fact', word, `${word} único`), false)).id)
    const hits = await store.search(null, 'alfa bravo charlie delta', projectScope('den'), opts({ limit: 10 }))
    assert.equal(hits.length, 4)
    const scores = new Set(hits.map((h) => h.score))
    assert.equal(scores.size, 4)
    const semantic = await store.search(fake, 'zzzqqq', projectScope('den'), opts({ limit: 10 }))
    assert.deepEqual(semantic.map((h) => h.id), [...ids].sort())
  })

  test('snippet skips the title and blank lines from the best chunk', async () => {
    const store = Store.inMemory()
    await store.remember(fake, note('den', 'doc', 'Guía de despliegue', '# Guía de despliegue\n\nSe despliega con make deploy'), false)
    const [hit] = await store.search(fake, 'despliegue', projectScope('den'), opts())
    assert.equal(hit.snippet, 'Se despliega con make deploy')
    assert.equal(hit.titleCoverage, 1)
  })

  test('moveSourceRefs stages renames and deletes', async () => {
    const store = Store.inMemory()
    const a = await store.remember(fake, note('dp', 'doc', 'A', 'uno', { source: 'inkwell', sourceRef: 'inkwell:dp/a.md' }), false)
    const b = await store.remember(fake, note('dp', 'doc', 'B', 'dos', { source: 'inkwell', sourceRef: 'inkwell:dp/b.md' }), false)
    const c = await store.remember(fake, note('dp', 'doc', 'C', 'tres', { source: 'inkwell', sourceRef: 'inkwell:dp/c.md' }), false)
    const out = store.moveSourceRefs([
      { from: 'inkwell:dp/a.md', staging: 's:a', to: 'inkwell:dp/b.md' },
      { from: 'inkwell:dp/b.md', staging: 's:b', to: 'inkwell:dp/a.md' },
      { from: 'inkwell:dp/c.md', staging: 's:c', to: null },
      { from: 'inkwell:dp/none.md', staging: 's:n', to: 'x' },
    ])
    assert.deepEqual(out, [{ id: a.id, displaced: null }, { id: b.id, displaced: null }, { id: c.id, displaced: null }, null])
    assert.equal(store.bySourceRef('inkwell:dp/b.md').id, a.id)
    assert.equal(store.bySourceRef('inkwell:dp/a.md').id, b.id)
    assert.equal(store.get(c.id), null)
  })

  test('renaming onto an existing source ref displaces it and keeps its links', async () => {
    const store = Store.inMemory()
    const a = await store.remember(fake, note('dp', 'doc', 'A', 'uno', { source: 'inkwell', sourceRef: 'inkwell:dp/a.md' }), false)
    const b = await store.remember(fake, note('dp', 'doc', 'B', 'dos', { source: 'inkwell', sourceRef: 'inkwell:dp/b.md' }), false)
    const linker = await store.remember(fake, note('dp', 'fact', 'L', 'ver [[B]]'), false)
    assert.deepEqual(store.renameSourceRef('inkwell:dp/a.md', 'inkwell:dp/b.md'), { id: a.id, displaced: b.id })
    assert.equal(store.get(b.id), null)
    assert.ok(store.neighbors(linker.id).some((n) => n.id === a.id))
  })

  test('groups, scope and known projects', () => {
    const store = Store.inMemory()
    store.setGroup('dp', ['b', 'a', 'a'])
    store.setGroup('z', ['a'])
    assert.deepEqual(store.groups(), [['dp', ['a', 'b']], ['z', ['a']]])
    assert.deepEqual(store.scopeProjects('a').slice(0, 2), ['a', GLOBAL])
    assert.deepEqual(new Set(store.scopeProjects('a')), new Set(['a', GLOBAL, 'dp', 'b', 'z']))
    assert.deepEqual(store.scopeProjects(GLOBAL), [GLOBAL])
    assert.equal(store.removeGroup('nope'), false)
    assert.equal(store.knownProject(GLOBAL), true)
    assert.equal(store.knownProject('a'), false)
    store.db.prepare("INSERT INTO projects (slug) VALUES ('a')").run()
    assert.equal(store.knownProject('a'), true)
  })

  test('injections and stats', async () => {
    const store = Store.inMemory()
    const a = await store.remember(fake, note('den', 'fact', 'A', 'uno'), false)
    const b = await store.remember(fake, note('x', 'rule', 'B', 'dos'), false)
    store.recordInjection('s1', 'prompt', [a.id, b.id], 10, 4)
    store.recordInjection('s1', 'prompt', [a.id], 5, 3)
    store.recordInjection('s2', 'session', [], 0, 1)
    assert.deepEqual(store.injected('s1'), new Set([a.id, b.id]))
    assert.equal(store.get(a.id).hits, 2)
    assert.deepEqual(store.stats(), {
      nodes: 2,
      edges: 0,
      chunks: 2,
      unembedded: 0,
      byKind: { fact: 1, rule: 1 },
      byProject: { den: 1, x: 1 },
      injection: {
        sessions: 2,
        tokens: 15,
        avgTokensPerSession: 8,
        hooks: {
          prompt: { runs: 2, sessions: 1, tokens: 15, avgTokens: 8, maxTokens: 10, avgMs: 4 },
          session: { runs: 1, sessions: 1, tokens: 0, avgTokens: 0, maxTokens: 0, avgMs: 1 },
        },
      },
    })
  })

  test('reindex embeds the pending notes, or all of them', async () => {
    const store = Store.inMemory()
    await silenced(async () => {
      await store.remember(broken, note('den', 'fact', 'A', 'kubernetes cluster'), false)
      await store.remember(broken, note('den', 'fact', 'B', 'otra cosa'), false)
    })
    assert.equal((await store.search(fake, 'zzzqqq', projectScope('den'), opts())).length, 0)
    assert.equal(await store.reindex(fake, false), 2)
    assert.equal(await store.reindex(fake, false), 0)
    assert.equal(await store.reindex(fake, true), 2)
    assert.equal(store.stats().unembedded, 0)
    assert.equal((await store.search(fake, 'zzzqqq', projectScope('den'), opts())).length, 2)
    await assert.rejects(store.reindex(broken, true), /daemon down/)
  })

  test('a failing transaction rolls back', async () => {
    const store = Store.inMemory()
    assert.throws(() => store.tx(() => {
      store.db.prepare("INSERT INTO projects (slug) VALUES ('r')").run()
      throw new Error('boom')
    }), /boom/)
    assert.equal(store.knownProject('r'), false)
  })
})

const JS_VECTORS = 'CREATE TABLE IF NOT EXISTS chunk_vectors (\n  chunk_id INTEGER PRIMARY KEY,\n  project TEXT NOT NULL,\n  embedding BLOB NOT NULL\n);\nCREATE INDEX IF NOT EXISTS chunk_vectors_project ON chunk_vectors(project);'

test('reindex restores vectors after migrating a vec0 database', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gaze-store-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const file = path.join(dir, 'gaze.db')
  const native = new DatabaseSync(file)
  if (typeof native.enableDefensive !== 'function') {
    native.close()
    t.skip('node:sqlite without enableDefensive')
    return
  }
  native.exec(SCHEMA.replace(JS_VECTORS, ''))
  native.exec("INSERT INTO nodes (id, project, kind, title, body, source, created_at, updated_at, embedded) VALUES ('n1', 'demo', 'fact', 'Postgres', 'La base usa postgres', 'claude', 'x', 'x', 1)")
  native.exec("INSERT INTO chunks (id, node_id, ord, text) VALUES (10, 'n1', 0, 'Postgres\n\nLa base usa postgres')")
  native.exec("INSERT INTO fts_nodes (node_id, project, title, body) VALUES ('n1', 'demo', 'Postgres', 'La base usa postgres')")
  native.exec('PRAGMA user_version = 2')
  native.enableDefensive(false)
  native.exec('PRAGMA writable_schema = ON')
  native.prepare("INSERT INTO sqlite_master (type, name, tbl_name, rootpage, sql) VALUES ('table', 'vec_chunks', 'vec_chunks', 0, 'CREATE VIRTUAL TABLE vec_chunks USING vec0(chunk_id INTEGER PRIMARY KEY, embedding float[384] distance_metric=cosine, project TEXT partition key)')").run()
  native.exec('PRAGMA writable_schema = OFF')
  native.close()

  const db = openDb(file, { migrate: true, log: () => {} })
  t.after(() => db.close())
  const store = new Store(db, Store.inMemory().cfg)
  assert.equal(store.stats().unembedded, 1)
  assert.equal(await store.reindex(fake, false), 1)
  const [hit] = await store.search(fake, 'postgres', projectScope('demo'), opts())
  assert.equal(hit.id, 'n1')
  assert.ok(hit.similarity > 0)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM chunk_vectors').get().n, 1)
})

const rustBin = process.env.GAZE_PARITY_RUST
const rustReady = rustBin && fs.existsSync(rustBin)

describe('search parity with the Rust binary', { skip: rustReady ? false : 'GAZE_PARITY_RUST is not set' }, () => {
  const NOTES = [
    ['den', 'fact', 'Base de datos', 'La base de datos de den usa sqlite con WAL y respaldos diarios', null],
    ['den', 'decision', 'Despliegue', 'Desplegamos con GitHub Actions a producción cada viernes', null],
    ['den', 'doc', 'Guía de despliegue', '# Guía de despliegue\n\nEl despliegue usa make deploy y luego GitHub Actions valida la base', null],
    ['otro', 'fact', 'Otra base', 'La base de datos de otro usa postgres en producción con réplicas', null],
    [GLOBAL, 'rule', 'Commits', 'Los commits del despliegue llevan la clave de Jira siempre al inicio del mensaje', null],
    ['den', 'fact', 'Vieja', 'La base de datos vieja era mysql', '2000-01-01'],
    ['den', 'issue', 'Caída', 'La base de datos se cayó en producción durante el despliegue nocturno de marzo', null],
  ]
  const QUERIES = [
    ['qué base de datos usa den', ['--project', 'den']],
    ['despliegue producción', ['--all', '--limit', '3']],
    ['base de datos', ['--project', 'den', '--kind', 'fact']],
  ]

  function rust(dir, args) {
    const env = {
      ...process.env,
      GAZE_DATA_DIR: dir,
      GAZE_CONFIG: path.join(dir, 'config.toml'),
      GAZE_SOCKET: path.join(dir, 's.sock'),
      KIT_REGISTRY_DIR: path.join(dir, 'tools.d'),
      GAZE_EMBEDDER: 'fake',
      GAZE_BITA_BIN: path.join(dir, 'no-bita'),
    }
    const out = spawnSync(rustBin, [...args, '--json'], { env, encoding: 'utf8', cwd: dir, timeout: 60000 })
    assert.equal(out.status, 0, out.stderr || out.stdout)
    return JSON.parse(out.stdout).data
  }

  const pick = (h) => ({ title: h.title, kind: h.kind, project: h.project, snippet: h.snippet, score: h.score, similarity: h.similarity, coverage: h.coverage })

  test('remember dedupe takes the same actions and keeps the same bodies', async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gaze-store-rust-'))
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
    const store = Store.inMemory()
    const steps = [
      ['El servidor de den escucha en el puerto 8080 local', 'Puerto'],
      ['El servidor de den escucha en el puerto 8080 local', null],
      ['El servidor den escucha siempre en puerto 8080 local', 'Puerto'],
      ['Las facturas se mandan los viernes al cliente', 'Facturas'],
    ]
    for (const [body, title] of steps) {
      const args = ['remember', body, '--project', 'den']
      if (title) args.push('--title', title)
      const expected = rust(dir, args)
      const actual = await store.remember(fake, note('den', 'fact', title ?? undefined, body), true)
      assert.deepEqual({ ...actual, id: null }, { ...expected, id: null })
    }
    const rustDb = new DatabaseSync(path.join(dir, 'gaze.db'), { readOnly: true })
    const bodies = rustDb.prepare('SELECT title, body, content_hash FROM nodes ORDER BY title').all()
    rustDb.close()
    assert.deepEqual(store.db.prepare('SELECT title, body, content_hash FROM nodes ORDER BY title').all(), bodies)
  })

  for (const [query, flags] of QUERIES) {
    test(`search "${query}" ${flags.join(' ')}`, async (t) => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gaze-store-rust-'))
      t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
      const store = Store.inMemory()
      for (const [project, kind, title, body, until] of NOTES) {
        const args = ['remember', body, '--project', project, '--kind', kind, '--title', title]
        if (until) args.push('--until', until)
        rust(dir, args)
        await store.remember(fake, note(project, kind, title, body, until ? { until } : {}), true)
      }
      const expected = rust(dir, ['search', query, ...flags, '--explain']).map(pick)
      const scope = flags.includes('--all') ? ALL : projectScope(flags[flags.indexOf('--project') + 1])
      const limit = flags.includes('--limit') ? Number(flags[flags.indexOf('--limit') + 1]) : 5
      const kind = flags.includes('--kind') ? flags[flags.indexOf('--kind') + 1] : undefined
      const actual = (await store.search(fake, query, scope, { limit, kind })).map((h) => pick(hitJson(h, true)))
      assert.ok(expected.length > 0)
      assert.deepEqual(actual.map((h) => h.score), expected.map((h) => h.score))
      const byTitle = (list) => new Map(list.map((h) => [h.title, h]))
      const want = byTitle(expected)
      assert.deepEqual([...byTitle(actual).keys()].sort(), [...want.keys()].sort())
      for (const h of actual) {
        const r = want.get(h.title)
        assert.deepEqual({ ...h, similarity: null }, { ...r, similarity: null })
        assert.ok(Math.abs(h.similarity - r.similarity) < 1e-6, `${h.title}: ${h.similarity} vs ${r.similarity}`)
      }
      const rustDb = new DatabaseSync(path.join(dir, 'gaze.db'), { readOnly: true })
      const hashes = rustDb.prepare('SELECT title, content_hash FROM nodes ORDER BY title').all()
      rustDb.close()
      const ours = store.db.prepare('SELECT title, content_hash FROM nodes ORDER BY title').all()
      assert.deepEqual(ours.map((r) => [r.title, r.content_hash]), hashes.map((r) => [r.title, r.content_hash]))
    })
  }
})
