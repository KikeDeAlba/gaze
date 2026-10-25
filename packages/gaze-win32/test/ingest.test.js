import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { FakeEmbedder } from '../src/embed.js'
import {
  bitaEvent,
  folderProject,
  ingestInkwell,
  ingestRecap,
  inkwellEvent,
  inkwellNote,
  inkwellRel,
  mtime,
  readInkwellSpaces,
  slashRel,
  touchedFiles,
} from '../src/ingest.js'
import { canonical } from '../src/paths.js'
import { projectForBitaId } from '../src/project.js'
import { GLOBAL, Store } from '../src/store.js'
import { frontmatter } from '../src/text.js'

const VARS = ['GAZE_DATA_DIR', 'GAZE_EMBEDDER', 'GAZE_CONFIG', 'GAZE_SOCKET', 'KIT_REGISTRY_DIR', 'GAZE_BITA_BIN', 'GAZE_RECAP_BIN', 'INKWELL_DB_PATH', 'INKWELL_DOCS_DIR']
const DOCS = new URL('./fixtures/docs/', import.meta.url)
const NO_BITA = '/nonexistent/bita'
const unix = { skip: process.platform === 'win32' }
const e = new FakeEmbedder()
let saved
let dir

beforeEach(() => {
  saved = Object.fromEntries(VARS.map((name) => [name, process.env[name]]))
  dir = canonical(fs.mkdtempSync(path.join(os.tmpdir(), 'gaze-ingest-')))
  process.env.GAZE_DATA_DIR = path.join(dir, 'data')
  process.env.GAZE_EMBEDDER = 'fake'
  process.env.GAZE_CONFIG = path.join(dir, 'config.toml')
  process.env.GAZE_SOCKET = path.join(dir, 'gaze.sock')
  process.env.KIT_REGISTRY_DIR = path.join(dir, 'tools.d')
  process.env.GAZE_BITA_BIN = NO_BITA
  process.env.INKWELL_DB_PATH = '/nonexistent/inkwell.db'
  process.env.INKWELL_DOCS_DIR = '/nonexistent/docs'
  delete process.env.GAZE_RECAP_BIN
})

afterEach(() => {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  fs.rmSync(dir, { recursive: true, force: true })
})

const write = (file, content) => {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content)
}
const docsChanged = (store, event) => inkwellEvent(store, e, event, '/nonexistent/docs', NO_BITA)
const docsEvent = (root, changes) => ({ docsRoot: root, commit: null, kind: 'page', changes, event: 'docs.changed', source: 'inkwell', firedAt: '2026-10-18T00:00:00Z' })
const scalar = (store, sql, ...params) => Number(Object.values(store.db.prepare(sql).get(...params))[0])
const inkwellCount = (store) => scalar(store, "SELECT COUNT(*) FROM nodes WHERE source = 'inkwell'")
const stagedCount = (store) => scalar(store, "SELECT COUNT(*) FROM nodes WHERE source_ref LIKE 'inkwell-moving:%'")
const idOf = (store, rel) => store.bySourceRef(`inkwell:${rel}`)?.id ?? null

function fakeBita(output) {
  const calls = path.join(dir, 'calls')
  const script = path.join(dir, 'bita')
  fs.writeFileSync(script, `#!/bin/sh\necho "$@" >> '${calls}'\necho '${JSON.stringify(output)}'\n`)
  fs.chmodSync(script, 0o755)
  const count = () => (fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').split('\n').filter((l) => l !== '').length : 0)
  return { bin: script, count }
}

test('inkwell docs events write, delete and move notes', async () => {
  const store = Store.inMemory()
  const root = dir
  write(path.join(root, 'dp/infra.md'), '---\ntitle: Infra\n---\n\nCuenta AWS de producción.\n')
  const written = await docsChanged(store, docsEvent(root, [{ action: 'written', relPath: 'dp/infra.md' }]))
  assert.equal(written.changes[0].result, 'created')
  const node = store.bySourceRef('inkwell:dp/infra.md')
  assert.ok(node.body.includes('Cuenta AWS'))
  write(path.join(root, 'dp/infra.md'), '---\ntitle: Infra\n---\n\nCuenta AWS de staging.\n')
  const updated = await docsChanged(store, docsEvent(root, [{ action: 'written', relPath: 'dp/infra.md' }]))
  assert.equal(updated.changes[0].result, 'updated')
  assert.ok(store.bySourceRef('inkwell:dp/infra.md').body.includes('staging'))

  fs.renameSync(path.join(root, 'dp/infra.md'), path.join(root, 'dp/aws.md'))
  const moved = await docsChanged(store, docsEvent(root, [{ action: 'moved', relPath: 'dp/aws.md', from: 'dp/infra.md' }]))
  assert.equal(moved.changes[0].renamed, true)
  assert.equal(moved.changes[0].from, 'dp/infra.md')
  assert.equal(store.bySourceRef('inkwell:dp/infra.md'), null)
  const renamed = store.bySourceRef('inkwell:dp/aws.md')
  assert.equal(renamed.id, node.id)
  assert.ok(renamed.body.includes('staging'))

  fs.rmSync(path.join(root, 'dp/aws.md'))
  const deleted = await docsChanged(store, docsEvent(root, [{ action: 'deleted', relPath: 'dp/aws.md' }]))
  assert.equal(deleted.changes[0].result, 'removed')
  assert.equal(store.bySourceRef('inkwell:dp/aws.md'), null)
  const again = await docsChanged(store, docsEvent(root, [{ action: 'deleted', relPath: 'dp/aws.md' }]))
  assert.equal(again.changes[0].result, 'absent')
})

test('inkwell written events for missing files forget the note', async () => {
  const store = Store.inMemory()
  write(path.join(dir, 'dp/old.md'), '# Old\n\nTexto viejo.\n')
  await docsChanged(store, docsEvent(dir, [{ action: 'written', relPath: 'dp/old.md' }]))
  fs.rmSync(path.join(dir, 'dp/old.md'))
  const result = await docsChanged(store, docsEvent(dir, [{ action: 'written', relPath: 'dp/old.md' }]))
  assert.equal(result.changes[0].result, 'removed')
  assert.equal(store.bySourceRef('inkwell:dp/old.md'), null)
})

test('inkwell events ignore invalid paths and keep going after errors', async () => {
  const store = Store.inMemory()
  const root = path.join(dir, 'docs')
  fs.mkdirSync(path.join(root, 'dp/page.assets'), { recursive: true })
  write(path.join(dir, 'secret.md'), '# Secret\n\nFuera.\n')
  write(path.join(root, 'dp/page.assets/a.md'), '# Asset\n')
  write(path.join(root, 'dp/img.png'), 'png')
  write(path.join(root, 'dp/bad.md'), Buffer.from([0xff, 0xfe, 0x00]))
  write(path.join(root, 'dp/ok.md'), '# Ok\n\nBien.\n')
  const changes = [
    { action: 'written', relPath: '../secret.md' },
    { action: 'written', relPath: path.join(dir, 'secret.md') },
    { action: 'written', relPath: 'dp/../../secret.md' },
    { action: 'written', relPath: 'dp/page.assets/a.md' },
    { action: 'written', relPath: 'dp/img.png' },
    { action: 'deleted', relPath: null },
    { action: 'renamed', relPath: 'dp/ok.md' },
    { action: 'written', relPath: 'dp/bad.md' },
    { action: 'written', relPath: 'dp/ok.md' },
  ]
  const result = await docsChanged(store, docsEvent(root, changes))
  assert.deepEqual(result.changes.map((c) => c.result), ['ignored', 'ignored', 'ignored', 'ignored', 'ignored', 'ignored', 'ignored', 'error', 'created'])
  assert.equal(result.changes[7].error, 'stream did not contain valid UTF-8')
  assert.equal(inkwellCount(store), 1)
  assert.equal(inkwellRel('./dp/x.md'), 'dp/x.md')
  assert.equal(result.failed, 1)
})

test('inkwell folders follow the bita project of their space', () => {
  const store = Store.inMemory()
  const file = path.join(dir, 'inkwell.db')
  const db = new DatabaseSync(file)
  db.exec("CREATE TABLE spaces (id INTEGER PRIMARY KEY, name TEXT NOT NULL, external_ref TEXT); INSERT INTO spaces VALUES (1, 'Global', 'bita:project:218978619'), (2, 'Notas sueltas', NULL), (3, 'Roto', 'bita:project:x');")
  db.close()
  store.db.exec("INSERT INTO projects (slug, bita_id, name) VALUES ('vivaglobal', 218978619, 'VivaGlobal')")
  const spaces = readInkwellSpaces(file)
  assert.deepEqual([...spaces], [['global', 218978619]])
  assert.equal(folderProject(store, spaces, 'global'), 'vivaglobal')
  assert.equal(folderProject(store, spaces, 'notas-sueltas'), GLOBAL)
  assert.equal(folderProject(store, spaces, '_no-project'), GLOBAL)
  assert.equal(readInkwellSpaces(path.join(dir, 'missing.db')), null)
  assert.ok(!fs.existsSync(path.join(dir, 'missing.db')))
})

function storeWithProjects() {
  const store = Store.inMemory()
  store.db.exec(
    "INSERT INTO projects (slug, bita_id, name) VALUES ('apartados', 1, 'Apartados'), ('dp-personalization', 2, 'DP Personalization'), ('dp', 3, 'DP'), ('global', 4, 'Global'), ('cliente-uno', 5, 'Cliente Uno'), ('cliente-uno-bis', 6, 'Cliente-Uno');" +
      "INSERT INTO project_groups (name, project) VALUES ('equipo', 'dp');",
  )
  return store
}

test('unlinked folders use known projects and never invent one', () => {
  const store = storeWithProjects()
  const spaces = new Map()
  assert.equal(folderProject(store, spaces, 'apartados-remediacion-de-seguridad-2026'), 'apartados')
  assert.equal(folderProject(store, spaces, 'dp-personalization-notas'), 'dp-personalization')
  assert.equal(folderProject(store, spaces, 'dp-personalization'), 'dp-personalization')
  assert.equal(folderProject(store, spaces, 'equipo'), 'equipo')
  assert.equal(folderProject(store, spaces, 'cliente-uno-2026'), GLOBAL)
  assert.equal(folderProject(store, spaces, 'dpx-otra-cosa'), GLOBAL)
  assert.equal(folderProject(store, spaces, 'remediacion-de-seguridad'), GLOBAL)
  assert.equal(folderProject(store, spaces, 'global-notas'), GLOBAL)
  assert.equal(folderProject(store, spaces, '_no-project'), GLOBAL)
  assert.equal(scalar(store, 'SELECT COUNT(*) FROM projects'), 6)
})

test('folder prefixes match only on word boundaries', () => {
  const store = storeWithProjects()
  store.db.exec("INSERT INTO projects (slug, bita_id, name) VALUES ('viva', 7, 'Viva')")
  const spaces = new Map()
  assert.equal(folderProject(store, spaces, 'vivalavida'), GLOBAL)
  assert.equal(folderProject(store, spaces, 'viva-la-vida'), 'viva')
  assert.equal(folderProject(store, spaces, 'apartados-remediacion'), 'apartados')
  assert.equal(folderProject(store, spaces, 'apartadosremediacion'), GLOBAL)
  assert.equal(folderProject(store, spaces, 'dp-personalizationx'), GLOBAL)
})

test('bita events refresh projects when the entry project is unknown', unix, async () => {
  const store = Store.inMemory()
  const bita = fakeBita({ ok: true, data: [{ id: 77, name: 'Nuevo Cliente' }] })
  const event = { event: 'stop', entry: { id: 5, description: 'Arranque', projectId: 77, projectName: 'Nuevo Cliente' } }
  const result = await bitaEvent(store, e, event, bita.bin)
  assert.equal(store.get(result.node.id).project, 'nuevo-cliente')
  assert.equal(projectForBitaId(store, 77), 'nuevo-cliente')
  await bitaEvent(store, e, { event: 'stop', entry: { id: 6, description: 'Otra', projectId: 77 } }, bita.bin)
  assert.equal(bita.count(), 1)
})

test('inkwell ingest refreshes bita projects first', unix, async () => {
  const store = Store.inMemory()
  const bita = fakeBita({ ok: true, data: [{ id: 42, name: 'Linked Space', key: 'LS' }] })
  const root = path.join(dir, 'docs')
  fs.mkdirSync(root, { recursive: true })
  await ingestInkwell(store, e, root, false, bita.bin)
  assert.equal(projectForBitaId(store, 42), 'linked-space')
})

test('inkwell entries without a folder project follow their frontmatter', async () => {
  const store = storeWithProjects()
  const root = dir
  const note = async (rel, projectLine) => {
    write(path.join(root, rel), `---\nentryId: 1\ntitle: T\n${projectLine}\n---\n\n# T\n\nAlgo.\n`)
    assert.ok(await inkwellNote(store, e, root, path.join(root, rel)))
    return store.bySourceRef(`inkwell:${rel}`).project
  }
  assert.equal(await note('_no-project/2026/10/a.md', 'project: DP Personalization'), 'dp-personalization')
  assert.equal(await note('_no-project/2026/10/b.md', 'projectId: 1'), 'apartados')
  assert.equal(await note('_no-project/2026/10/c.md', 'project: Proyecto Inexistente'), GLOBAL)
  assert.equal(await note('apartados/2026/10/d.md', 'project: DP Personalization'), 'apartados')
  assert.equal(await note('_no-project/2026/10/e.md', ''), GLOBAL)
  assert.equal(scalar(store, 'SELECT COUNT(*) FROM projects'), 6)
})

test('frontmatter parses nested and body', () => {
  const { meta, body } = frontmatter('---\nname: x-note\nmetadata: \n  type: feedback\n  modified: 2026\n---\n\nCuerpo [[otra]]\n')
  assert.equal(meta.get('name'), 'x-note')
  assert.equal(meta.get('type'), 'feedback')
  assert.equal(body.trim(), 'Cuerpo [[otra]]')
  const plain = frontmatter('sin frontmatter')
  assert.equal(plain.meta.size, 0)
  assert.equal(plain.body, 'sin frontmatter')
})

test('inkwell ingest builds entry and issue edges', async () => {
  const store = Store.inMemory()
  store.db.exec("INSERT INTO projects (slug, bita_id, name) VALUES ('dp-personalization', 2, 'DP Personalization')")
  const root = path.join(dir, 'docs')
  fs.cpSync(DOCS, root, { recursive: true })
  const report = await ingestInkwell(store, e, root, false, NO_BITA)
  assert.deepEqual(report, { source: 'inkwell', scanned: 2, created: 2, updated: 0, unchanged: 0, removed: 0, failed: 0 })
  assert.deepEqual(Object.keys(report), ['source', 'scanned', 'created', 'updated', 'unchanged', 'removed', 'failed'])
  const again = await ingestInkwell(store, e, root, false, NO_BITA)
  assert.equal(again.unchanged, 2)
  const entry = store.bySourceRef('inkwell:dp-personalization/2026/10/16-914-tc.md')
  assert.equal(entry.kind, 'entry')
  assert.equal(entry.project, 'dp-personalization')
  assert.equal(entry.body, 'Entrada de bita #914 · 2026-10-16 · 1h')
  const page = store.bySourceRef('inkwell:dp-personalization/infra.md')
  assert.equal(page.title, 'Infraestructura')
  assert.ok(store.neighbors(entry.id).some((n) => n.id === page.id && n.edgeKind === 'same-issue'))
  const event = {
    event: 'stop',
    entry: { id: 914, description: 'TC 07', projectName: 'DP Personalization', localDay: '2026-10-16', durationHuman: '1h' },
    docPath: 'dp-personalization/2026/10/16-914-tc.md',
    docsRoot: root,
  }
  const result = await bitaEvent(store, e, event, NO_BITA)
  assert.deepEqual(result.note, { id: entry.id, action: 'unchanged' })
  assert.deepEqual(Object.keys(result.node), ['id', 'action', 'title', 'project', 'kind'])
  assert.ok(store.neighbors(result.node.id).some((n) => n.id === entry.id && n.edgeKind === 'same-entry'))
  fs.rmSync(path.join(root, 'dp-personalization/infra.md'))
  assert.equal((await ingestInkwell(store, e, root, false, NO_BITA)).removed, 1)
  const deleted = await bitaEvent(store, e, { event: 'delete', entry: { id: 914 } }, NO_BITA)
  assert.deepEqual(deleted, { event: 'delete', entry: 914, removed: true })
})

test('inkwell large batches with moved and written of the same file settle on the final path', async () => {
  const store = Store.inMemory()
  const root = dir
  fs.mkdirSync(path.join(root, 'dp'))
  const changes = []
  for (let i = 0; i < 150; i++) {
    write(path.join(root, `dp/page-${i}.md`), `# Page ${i}\n\nContenido numero ${i}.\n`)
    changes.push({ action: 'written', relPath: `dp/page-${i}.md` })
  }
  await docsChanged(store, docsEvent(root, changes))
  assert.equal(inkwellCount(store), 150)
  const batch = []
  for (let i = 0; i < 150; i++) {
    fs.renameSync(path.join(root, `dp/page-${i}.md`), path.join(root, `dp/renamed-${i}.md`))
    batch.push({ action: 'written', relPath: `dp/page-${i}.md` })
    batch.push({ action: 'moved', relPath: `dp/renamed-${i}.md`, from: `dp/page-${i}.md` })
    batch.push({ action: 'written', relPath: `dp/renamed-${i}.md` })
  }
  const result = await docsChanged(store, docsEvent(root, batch))
  assert.equal(result.failed, 0)
  assert.equal(result.changes.length, 450)
  assert.equal(inkwellCount(store), 150)
  for (let i = 0; i < 150; i++) {
    assert.equal(idOf(store, `dp/page-${i}.md`), null)
    assert.ok(idOf(store, `dp/renamed-${i}.md`))
  }
})

test('inkwell moved then written in either order and a move onto itself keep one note', async () => {
  const store = Store.inMemory()
  const root = dir
  write(path.join(root, 'dp/a.md'), '# A\n\nTexto.\n')
  await docsChanged(store, docsEvent(root, [{ action: 'written', relPath: 'dp/a.md' }]))
  fs.renameSync(path.join(root, 'dp/a.md'), path.join(root, 'dp/b.md'))
  await docsChanged(store, docsEvent(root, [{ action: 'written', relPath: 'dp/b.md' }, { action: 'moved', relPath: 'dp/b.md', from: 'dp/a.md' }]))
  assert.equal(idOf(store, 'dp/a.md'), null)
  assert.ok(idOf(store, 'dp/b.md'))
  const own = await docsChanged(store, docsEvent(root, [{ action: 'moved', relPath: 'dp/b.md', from: 'dp/b.md' }]))
  assert.equal(own.failed, 0)
  assert.ok(idOf(store, 'dp/b.md'))
  const invalidFrom = await docsChanged(store, docsEvent(root, [{ action: 'moved', relPath: 'dp/b.md', from: '../a.md' }]))
  assert.equal(invalidFrom.changes[0].renamed, false)
  assert.ok(idOf(store, 'dp/b.md'))
  assert.equal(inkwellCount(store), 1)
})

test('inkwell events without changes or with malformed shapes do nothing', async () => {
  const store = Store.inMemory()
  const root = dir
  for (const event of [
    { docsRoot: root, event: 'docs.changed' },
    { docsRoot: root, event: 'docs.changed', changes: null },
    { docsRoot: root, event: 'docs.changed', changes: [] },
    { docsRoot: root, event: 'docs.changed', changes: 'dp/a.md' },
    { docsRoot: root, event: 'docs.changed', changes: { action: 'written' } },
    { docsRoot: root, event: 'docs.changed', changes: [null, 7, 'x', [], {}] },
    { docsRoot: 7, event: 'docs.changed', changes: [] },
  ]) {
    const result = await docsChanged(store, event)
    assert.equal(result.failed, 0)
    assert.ok(result.changes.every((c) => c.result === 'ignored'))
  }
  const other = await docsChanged(store, { event: 'page.opened', docsRoot: root, changes: [{ action: 'written', relPath: 'dp/a.md' }] })
  assert.deepEqual(other, { event: 'page.opened', skipped: true })
  assert.equal(inkwellCount(store), 0)
})

test('inkwell and bita events survive garbage payloads', async () => {
  const store = Store.inMemory()
  for (const payload of [null, [], 'texto', 7, { event: 7 }]) {
    const docs = await inkwellEvent(store, e, payload, dir, NO_BITA)
    assert.equal(docs.event, 'docs.changed')
    assert.equal(docs.failed, 0)
    assert.deepEqual(docs.changes, [])
    assert.deepEqual(await bitaEvent(store, e, payload, NO_BITA), { skipped: 'no entry' })
  }
  assert.deepEqual(await bitaEvent(store, e, { event: 'start', entry: { id: 3 } }, NO_BITA), { event: 'start', entry: 3, skipped: true })
  assert.deepEqual(await bitaEvent(store, e, { event: 'stop', entry: { id: 3, running: true } }, NO_BITA), { event: 'stop', entry: 3, skipped: true })
  assert.deepEqual(await bitaEvent(store, e, { event: 'cancel', entry: { id: 3 } }, NO_BITA), { event: 'cancel', entry: 3, removed: false })
})

test('inkwell moves to ignored paths forget the origin', async () => {
  const store = Store.inMemory()
  const root = dir
  fs.mkdirSync(path.join(root, 'dp/page.assets'), { recursive: true })
  for (const name of ['a', 'b', 'c']) {
    write(path.join(root, `dp/${name}.md`), `# ${name}\n\nTexto ${name}.\n`)
    await docsChanged(store, docsEvent(root, [{ action: 'written', relPath: `dp/${name}.md` }]))
  }
  assert.equal(inkwellCount(store), 3)
  fs.renameSync(path.join(root, 'dp/a.md'), path.join(root, 'dp/a.txt'))
  fs.renameSync(path.join(root, 'dp/b.md'), path.join(root, 'dp/.b.md'))
  fs.renameSync(path.join(root, 'dp/c.md'), path.join(root, 'dp/page.assets/c.md'))
  const result = await docsChanged(
    store,
    docsEvent(root, [
      { action: 'moved', relPath: 'dp/a.txt', from: 'dp/a.md' },
      { action: 'moved', relPath: 'dp/.b.md', from: 'dp/b.md' },
      { action: 'moved', relPath: 'dp/page.assets/c.md', from: 'dp/c.md' },
      { action: 'moved', relPath: 'dp/x.txt', from: '../a.md' },
    ]),
  )
  assert.deepEqual(result.changes.map((c) => [c.result, c.fromRemoved]), [['removed', true], ['removed', true], ['removed', true], ['ignored', false]])
  assert.equal(inkwellCount(store), 0)
  assert.equal(scalar(store, 'SELECT COUNT(*) FROM ingest_files'), 0)
})

test('inkwell moves keep the node id, edges, hits and injections', async () => {
  const store = Store.inMemory()
  const root = dir
  write(path.join(root, 'dp/infra.md'), '---\ntitle: Infra\n---\n\nCuenta AWS de producción.\n')
  write(path.join(root, 'dp/index.md'), '# Indice\n\nVer [[Infra]].\n')
  write(path.join(root, 'dp/later.md'), '# Luego\n\nVer [[aws]].\n')
  write(path.join(root, 'dp/aws.md'), '# Viejo\n\nDocumento anterior.\n')
  await docsChanged(store, docsEvent(root, ['infra', 'index', 'later', 'aws'].map((n) => ({ action: 'written', relPath: `dp/${n}.md` }))))
  const infra = store.bySourceRef('inkwell:dp/infra.md')
  const index = store.bySourceRef('inkwell:dp/index.md')
  const later = store.bySourceRef('inkwell:dp/later.md')
  const oldAws = store.bySourceRef('inkwell:dp/aws.md')
  const manual = await store.remember(e, { project: GLOBAL, kind: 'fact', body: 'Nota manual', source: 'claude' }, false)
  store.link(manual.id, infra.id)
  store.recordInjection('s1', 'prompt', [infra.id], 10, 1)
  const hits = store.get(infra.id).hits
  assert.ok(hits >= 1)

  fs.renameSync(path.join(root, 'dp/infra.md'), path.join(root, 'dp/aws.md'))
  const moved = await docsChanged(store, docsEvent(root, [{ action: 'moved', relPath: 'dp/aws.md', from: 'dp/infra.md' }]))
  assert.equal(moved.failed, 0)
  assert.equal(moved.changes[0].renamed, true)
  assert.equal(moved.changes[0].displaced, oldAws.id)
  assert.equal(moved.changes[0].id, infra.id)
  assert.equal(store.get(oldAws.id), null)
  assert.equal(store.bySourceRef('inkwell:dp/infra.md'), null)
  const node = store.bySourceRef('inkwell:dp/aws.md')
  assert.equal(node.id, infra.id)
  assert.equal(node.hits, hits)
  assert.ok(store.injected('s1').has(infra.id))
  const neighbors = store.neighbors(infra.id).map((n) => [n.id, n.edgeKind])
  for (const other of [index.id, manual.id, later.id]) {
    assert.ok(neighbors.some(([id, kind]) => id === other && kind === 'link'), `missing link from ${other}: ${JSON.stringify(neighbors)}`)
  }
  assert.equal(inkwellCount(store), 3)
  assert.equal(store.db.prepare('SELECT path FROM ingest_files WHERE node_id = ?1').get(infra.id).path, 'inkwell:dp/aws.md')

  const report = await ingestInkwell(store, e, root, false, NO_BITA)
  assert.deepEqual([report.scanned, report.unchanged, report.created, report.updated, report.removed], [3, 3, 0, 0, 0])
  assert.equal(inkwellCount(store), 3)
  assert.equal(idOf(store, 'dp/aws.md'), infra.id)

  const own = await docsChanged(store, docsEvent(root, [{ action: 'moved', relPath: 'dp/aws.md', from: 'dp/aws.md' }]))
  assert.equal(own.changes[0].renamed, false)
  assert.equal(own.changes[0].result, 'unchanged')
  assert.equal(idOf(store, 'dp/aws.md'), infra.id)
})

test('inkwell events only trust absolute docs roots and flag mismatches', async () => {
  const store = Store.inMemory()
  const configured = path.join(dir, 'docs')
  const other = path.join(dir, 'other')
  write(path.join(configured, 'dp/a.md'), '# A\n\nConfigurada.\n')
  write(path.join(other, 'dp/b.md'), '# B\n\nOtra raiz.\n')
  const run = (root, rel) => inkwellEvent(store, e, { event: 'docs.changed', docsRoot: root, changes: [{ action: 'written', relPath: rel }] }, configured, NO_BITA)
  for (const root of ['docs', '', null, 7]) {
    const result = await run(root, 'dp/a.md')
    assert.equal(result.docsRoot, configured, `root ${root}`)
    assert.equal(result.rootMismatch, false)
    assert.notEqual(result.changes[0].result, 'absent')
  }
  const same = await run(path.join(dir, 'docs', '..', 'docs'), 'dp/a.md')
  assert.equal(same.rootMismatch, false)
  const mismatch = await run(other, 'dp/b.md')
  assert.equal(mismatch.rootMismatch, true)
  assert.equal(mismatch.changes[0].result, 'created')
  assert.ok(store.bySourceRef('inkwell:dp/b.md'))
})

test('inkwell events refresh projects once when a folder is unknown', unix, async () => {
  const store = Store.inMemory()
  const bita = fakeBita({ ok: true, data: [{ id: 88, name: 'Cliente Nuevo' }] })
  const root = path.join(dir, 'docs')
  write(path.join(root, 'cliente-nuevo/a.md'), '# A\n\nUno.\n')
  write(path.join(root, 'suelto/b.md'), '# B\n\nDos.\n')
  const event = { event: 'docs.changed', docsRoot: root, changes: [{ action: 'written', relPath: 'cliente-nuevo/a.md' }, { action: 'written', relPath: 'suelto/b.md' }] }
  const result = await inkwellEvent(store, e, event, root, bita.bin)
  assert.equal(result.failed, 0)
  assert.equal(store.bySourceRef('inkwell:cliente-nuevo/a.md').project, 'cliente-nuevo')
  assert.equal(store.bySourceRef('inkwell:suelto/b.md').project, GLOBAL)
  assert.equal(bita.count(), 1)
  await inkwellEvent(store, e, { event: 'docs.changed', docsRoot: root, changes: [{ action: 'written', relPath: 'cliente-nuevo/a.md' }] }, root, bita.bin)
  assert.equal(bita.count(), 1)
  write(path.join(root, '_no-project/2026/10/c.md'), '# C\n\nTres.\n')
  const orphan = await inkwellEvent(store, e, { event: 'docs.changed', docsRoot: root, changes: [{ action: 'written', relPath: '_no-project/2026/10/c.md' }] }, root, bita.bin)
  assert.equal(orphan.changes[0].result, 'created')
  assert.equal(bita.count(), 1)
})

test('inkwell moves without a string rel path keep the origin', async () => {
  const store = Store.inMemory()
  write(path.join(dir, 'dp/a.md'), '# A\n\nTexto.\n')
  await docsChanged(store, docsEvent(dir, [{ action: 'written', relPath: 'dp/a.md' }]))
  const result = await docsChanged(
    store,
    docsEvent(dir, [{ action: 'moved', from: 'dp/a.md' }, { action: 'moved', relPath: 7, from: 'dp/a.md' }, { action: 'moved', relPath: null, from: 'dp/a.md' }]),
  )
  assert.ok(result.changes.every((c) => c.result === 'ignored' && !('fromRemoved' in c)))
  assert.ok(idOf(store, 'dp/a.md'))
})

test('inkwell chained and swapped moves keep every node', async () => {
  const store = Store.inMemory()
  const root = dir
  for (const name of ['a', 'b', 'x', 'y']) {
    write(path.join(root, `dp/${name}.md`), `# ${name}\n\nContenido ${name}.\n`)
    await docsChanged(store, docsEvent(root, [{ action: 'written', relPath: `dp/${name}.md` }]))
  }
  const [a, b, x, y] = ['a', 'b', 'x', 'y'].map((n) => idOf(store, `dp/${n}.md`))
  fs.renameSync(path.join(root, 'dp/b.md'), path.join(root, 'dp/c.md'))
  fs.renameSync(path.join(root, 'dp/a.md'), path.join(root, 'dp/b.md'))
  fs.renameSync(path.join(root, 'dp/x.md'), path.join(root, 'dp/tmp'))
  fs.renameSync(path.join(root, 'dp/y.md'), path.join(root, 'dp/x.md'))
  fs.renameSync(path.join(root, 'dp/tmp'), path.join(root, 'dp/y.md'))
  const result = await docsChanged(
    store,
    docsEvent(root, [
      { action: 'moved', relPath: 'dp/b.md', from: 'dp/a.md' },
      { action: 'moved', relPath: 'dp/c.md', from: 'dp/b.md' },
      { action: 'moved', relPath: 'dp/y.md', from: 'dp/x.md' },
      { action: 'moved', relPath: 'dp/x.md', from: 'dp/y.md' },
    ]),
  )
  assert.equal(result.failed, 0)
  assert.ok(result.changes.every((c) => c.renamed === true && !('displaced' in c)), JSON.stringify(result))
  assert.equal(inkwellCount(store), 4)
  assert.equal(idOf(store, 'dp/a.md'), null)
  assert.equal(idOf(store, 'dp/b.md'), a)
  assert.equal(idOf(store, 'dp/c.md'), b)
  assert.equal(idOf(store, 'dp/y.md'), x)
  assert.equal(idOf(store, 'dp/x.md'), y)
  assert.ok(store.get(y).body.includes('Contenido y'))
  assert.equal(stagedCount(store), 0)

  const stale = await docsChanged(store, docsEvent(root, [{ action: 'deleted', relPath: 'dp/b.md' }]))
  assert.equal(stale.changes[0].result, 'unchanged')
  assert.equal(idOf(store, 'dp/b.md'), a)
})

async function seed(store, root, names) {
  fs.mkdirSync(path.join(root, 'dp/page.assets'), { recursive: true })
  const ids = []
  for (const name of names) {
    write(path.join(root, `dp/${name}.md`), `# ${name}\n\nContenido ${name}.\n`)
    await docsChanged(store, docsEvent(root, [{ action: 'written', relPath: `dp/${name}.md` }]))
    ids.push(idOf(store, `dp/${name}.md`))
  }
  return ids
}

test('inkwell moves roll back together when one fails', async () => {
  const store = Store.inMemory()
  const root = dir
  const ids = await seed(store, root, ['a', 'b'])
  store.db.exec("CREATE TRIGGER boom BEFORE UPDATE OF source_ref ON nodes WHEN NEW.source_ref = 'inkwell:dp/c.md' BEGIN SELECT RAISE(ABORT, 'boom'); END;")
  fs.renameSync(path.join(root, 'dp/b.md'), path.join(root, 'dp/c.md'))
  fs.renameSync(path.join(root, 'dp/a.md'), path.join(root, 'dp/b.md'))
  const result = await docsChanged(store, docsEvent(root, [{ action: 'moved', relPath: 'dp/b.md', from: 'dp/a.md' }, { action: 'moved', relPath: 'dp/c.md', from: 'dp/b.md' }]))
  assert.equal(result.failed, 2)
  assert.ok(result.changes.every((c) => c.result === 'error' && c.error.includes('boom')))
  assert.equal(idOf(store, 'dp/a.md'), ids[0])
  assert.equal(idOf(store, 'dp/b.md'), ids[1])
  assert.equal(idOf(store, 'dp/c.md'), null)
  assert.equal(stagedCount(store), 0)
  assert.equal(inkwellCount(store), 2)
  assert.deepEqual(store.db.prepare('SELECT path FROM ingest_files ORDER BY path').all().map((r) => r.path), ['inkwell:dp/a.md', 'inkwell:dp/b.md'])
})

test('inkwell moves out of the docs tree run with the other moves', async () => {
  for (const order of [[0, 1], [1, 0]]) {
    const store = Store.inMemory()
    const root = fs.mkdtempSync(path.join(dir, 'order-'))
    const ids = await seed(store, root, ['a', 'b'])
    fs.renameSync(path.join(root, 'dp/b.md'), path.join(root, 'dp/page.assets/x.md'))
    fs.renameSync(path.join(root, 'dp/a.md'), path.join(root, 'dp/b.md'))
    const moves = [{ action: 'moved', relPath: 'dp/b.md', from: 'dp/a.md' }, { action: 'moved', relPath: 'dp/page.assets/x.md', from: 'dp/b.md' }]
    const result = await docsChanged(store, docsEvent(root, order.map((i) => moves[i])))
    assert.equal(result.failed, 0, `${order}: ${JSON.stringify(result)}`)
    assert.equal(idOf(store, 'dp/b.md'), ids[0])
    assert.equal(store.get(ids[1]), null)
    assert.equal(idOf(store, 'dp/a.md'), null)
    assert.equal(inkwellCount(store), 1)
    assert.equal(stagedCount(store), 0)
  }
})

test('slash rel keeps paths outside the root single rooted', () => {
  if (process.platform === 'win32') {
    assert.equal(slashRel('C:\\docs', 'C:\\docs\\dp\\a.md'), 'dp/a.md')
    assert.equal(slashRel('C:\\docs', 'C:\\tmp\\x.md'), 'C:/tmp/x.md')
    assert.equal(slashRel('C:\\docs', '\\\\?\\D:\\tmp\\x.md'), 'D:/tmp/x.md')
    return
  }
  assert.equal(slashRel('/docs', '/docs/dp/a.md'), 'dp/a.md')
  assert.equal(slashRel('/docs', 'dp/a.md'), 'dp/a.md')
  assert.equal(slashRel('/docs', '/tmp/x.md'), '/tmp/x.md')
  assert.equal(slashRel('/docs/', '/docs//dp/./a.md'), 'dp/a.md')
  assert.equal(slashRel('/doc', '/docs/a.md'), '/docs/a.md')
})

test('inkwell rel accepts only clean relative markdown paths', () => {
  assert.equal(inkwellRel('dp//x.md'), 'dp/x.md')
  assert.equal(inkwellRel('dp/./x.md'), 'dp/x.md')
  for (const raw of ['', 'dp/x.txt', '/dp/x.md', 'dp/../x.md', 'dp/.x.md', 'dp/a.assets/x.md', null, 7]) assert.equal(inkwellRel(raw), null, String(raw))
})

test('inkwell ingest recovers stranded moving keys', unix, async () => {
  const store = Store.inMemory()
  const root = dir
  const names = ['a:b#c', 'gone', 'taken']
  const ids = await seed(store, root, names)
  fs.rmSync(path.join(root, 'dp/gone.md'))
  ids.forEach((id, i) => {
    const staging = `inkwell-moving:3:dp/${names[i]}.md#`
    store.db.prepare('UPDATE nodes SET source_ref = ?2 WHERE id = ?1').run(id, staging)
    store.db.prepare('UPDATE ingest_files SET path = ?2 WHERE node_id = ?1').run(id, staging)
  })
  const [squatter] = await seed(store, root, ['taken'])
  const report = await ingestInkwell(store, e, root, false, NO_BITA)
  assert.deepEqual([report.created, report.removed], [0, 2])
  assert.equal(idOf(store, 'dp/a:b#c.md'), ids[0])
  assert.equal(report.unchanged, 2)
  assert.equal(idOf(store, 'dp/taken.md'), squatter)
  assert.equal(store.get(ids[1]), null)
  assert.equal(store.get(ids[2]), null)
  assert.equal(stagedCount(store), 0)
  assert.equal(scalar(store, "SELECT COUNT(*) FROM ingest_files WHERE path LIKE 'inkwell-moving:%'"), 0)
})

test('inkwell ingest keeps going when staging recovery fails', async () => {
  const store = Store.inMemory()
  const root = dir
  const ids = await seed(store, root, ['a', 'b'])
  store.db.prepare("UPDATE nodes SET source_ref = 'inkwell-moving:0:dp/a.md#' WHERE id = ?1").run(ids[0])
  store.db.exec("CREATE TRIGGER boom BEFORE UPDATE OF source_ref ON nodes WHEN OLD.source_ref LIKE 'inkwell-moving:%' BEGIN SELECT RAISE(ABORT, 'boom'); END;")
  const report = await ingestInkwell(store, e, root, false, NO_BITA)
  assert.deepEqual([report.scanned, report.created, report.unchanged, report.failed], [2, 1, 1, 0])
  assert.equal(idOf(store, 'dp/b.md'), ids[1])
})

test('bita events list the touched files from a read-only database', async () => {
  const store = Store.inMemory()
  const file = path.join(dir, 'bita.db')
  const db = new DatabaseSync(file)
  db.exec('CREATE TABLE entry_touches (entry_id INTEGER, path TEXT, first_seen_at TEXT)')
  const insert = db.prepare('INSERT INTO entry_touches VALUES (?, ?, ?)')
  insert.run(9, 'src/b.rs', '2026-10-01')
  insert.run(9, 'src/a.rs', '2026-10-01')
  insert.run(9, 'README.md', '2026-09-30')
  insert.run(8, 'otro.rs', '2026-09-30')
  for (let i = 0; i < 45; i++) insert.run(7, `f${String(i).padStart(2, '0')}`, '2026-10-02')
  db.close()
  const before = fs.statSync(file).mtimeMs
  assert.deepEqual(touchedFiles(file, 9), ['README.md', 'src/a.rs', 'src/b.rs'])
  assert.equal(touchedFiles(file, 7).length, 40)
  assert.deepEqual(touchedFiles(path.join(dir, 'missing.db'), 9), [])
  assert.deepEqual(touchedFiles(path.join(dir, 'data'), 9), [])
  const result = await bitaEvent(
    store,
    e,
    { event: 'amend', entry: { id: 9, description: '  ', localDay: '2026-10-01', durationHuman: '2h', kind: 'work' }, databasePath: file },
    NO_BITA,
  )
  const node = store.get(result.node.id)
  assert.equal(node.title, 'Entrada sin título')
  assert.equal(node.project, GLOBAL)
  assert.equal(node.body, 'Entrada de bita #9 · 2026-10-01 · 2h · work\n\nArchivos tocados:\n- README.md\n- src/a.rs\n- src/b.rs')
  assert.equal(node.sourceRef, 'bita:entry:9')
  assert.equal(result.note, null)
  assert.equal(fs.statSync(file).mtimeMs, before)
})

test('recap meetings are ingested once with their summary', unix, async () => {
  const store = Store.inMemory()
  store.db.exec("INSERT INTO projects (slug, bita_id, name) VALUES ('dp', 3, 'DP')")
  const summary = path.join(dir, 'm1.md')
  write(summary, '---\ntitle: Sync\n---\n\nAcordamos migrar a pnpm.\n')
  const shown = path.join(dir, 'm2.md')
  write(shown, 'Sin frontmatter.\n')
  const list = {
    ok: true,
    data: [
      { id: 'm1', status: 'processed', title: 'Sync semanal', startedAt: '2026-10-20T10:00:00Z', summary, bitaEntryId: 12, bitaEntry: { projectName: 'DP' } },
      { id: 'm2', status: 'processed', startedAt: '2026' },
      { id: 'm3', status: 'recording' },
      { id: 'm4', status: 'processed', summary: path.join(dir, 'missing.md') },
      { status: 'processed' },
    ],
  }
  const script = path.join(dir, 'recap')
  fs.writeFileSync(
    script,
    `#!/bin/sh\nif [ "$1" = "list" ]; then echo 'log'; echo '${JSON.stringify(list)}'; else echo '${JSON.stringify({ ok: true, data: { summary: shown } })}'; fi\n`,
  )
  fs.chmodSync(script, 0o755)
  process.env.GAZE_RECAP_BIN = script
  const report = await ingestRecap(store, e)
  assert.deepEqual(report, { source: 'recap', scanned: 3, created: 2, updated: 0, unchanged: 0, removed: 0, failed: 0 })
  const first = store.bySourceRef('recap:m1')
  assert.equal(first.title, 'Sync semanal (2026-10-20)')
  assert.equal(first.project, 'dp')
  assert.equal(first.kind, 'meeting')
  assert.equal(first.body, 'Acordamos migrar a pnpm.')
  assert.equal(store.db.prepare("SELECT value FROM attrs WHERE node_id = ?1 AND key = 'entry'").get(first.id).value, '12')
  assert.equal(store.bySourceRef('recap:m2').title, 'm2 ()')
  assert.equal((await ingestRecap(store, e)).unchanged, 2)
  process.env.GAZE_RECAP_BIN = path.join(dir, 'no-recap')
  assert.deepEqual(await ingestRecap(store, e), { source: 'recap', scanned: 0, created: 0, updated: 0, unchanged: 0, removed: 0, failed: 0 })
})

test('mtime is whole seconds and zero for missing files', () => {
  const file = path.join(dir, 'x.md')
  write(file, 'x')
  fs.utimesSync(file, 1700000000.9, 1700000000.9)
  assert.equal(mtime(file), 1700000000)
  assert.equal(mtime(path.join(dir, 'missing')), 0)
})
