import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { GLOBAL, openMemory } from '../src/db.js'
import { canonical } from '../src/paths.js'
import { collect, decodeDirName, decodeDirNameExact, encode, guessProject, kindFor, run, skipDir, splitRoot } from '../src/import.js'

const VARS = ['GAZE_BITA_BIN', 'GAZE_PROJECT', 'GAZE_DATA_DIR', 'BITA_CONFIG_PATH', 'INKWELL_DOCS_DIR', 'HOME', 'USERPROFILE']
let saved
let dir

const tempBase = () => (process.platform === 'win32' ? os.tmpdir() : '/var/tmp')

beforeEach(() => {
  saved = Object.fromEntries(VARS.map((name) => [name, process.env[name]]))
  dir = canonical(fs.mkdtempSync(path.join(tempBase(), 'gaze-import-')))
  process.env.GAZE_BITA_BIN = '/nonexistent/bita'
  process.env.GAZE_DATA_DIR = path.join(dir, 'data')
  process.env.BITA_CONFIG_PATH = path.join(dir, 'missing-bita.json')
  process.env.INKWELL_DOCS_DIR = path.join(dir, 'docs')
  process.env.HOME = path.join(dir, 'nohome')
  process.env.USERPROFILE = path.join(dir, 'nohome')
  delete process.env.GAZE_PROJECT
})

afterEach(() => {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  fs.rmSync(dir, { recursive: true, force: true })
})

class FakeStore {
  constructor() {
    this.db = openMemory()
    this.saved = new Map()
    this.calls = []
  }

  async remember(emb, input, dedupe) {
    this.calls.push({ emb, input, dedupe })
    if (input.body.includes('FAIL')) throw new Error('outer', { cause: new Error('inner') })
    const previous = this.saved.get(input.sourceRef)
    const value = JSON.stringify(input)
    this.saved.set(input.sourceRef, value)
    return { id: input.sourceRef, action: previous === undefined ? 'created' : previous === value ? 'unchanged' : 'updated', title: input.title, project: input.project, kind: input.kind }
  }
}

test('decodes dir names against the filesystem', () => {
  const target = path.join(dir, 'dev', 'github.com', 'my-org', 'repo.v2', '.claude', 'worktrees', 'x')
  fs.mkdirSync(target, { recursive: true })
  fs.mkdirSync(path.join(dir, 'dev', 'github'), { recursive: true })
  const name = encode(target)
  assert.equal(decodeDirName(name), target)
  assert.deepEqual(decodeDirNameExact(name), [target, true])
  const missing = encode(path.join(dir, 'dev', 'github.com', 'my-org', 'gone'))
  assert.deepEqual(decodeDirNameExact(missing), [path.join(dir, 'dev', 'github.com', 'my-org'), false])
})

test('encode replaces every non ascii alphanumeric char with a dash', () => {
  assert.equal(encode('/Users/kike/dev/repo.v2'), '-Users-kike-dev-repo-v2')
  assert.equal(encode('C:\\Users\\kike\\dev'), 'C--Users-kike-dev')
  assert.equal(encode('/a/ñandú'), '-a--and-')
})

test('splits windows drive roots from encoded names', () => {
  assert.deepEqual(splitRoot('C--Users-kike-dev', true), ['C:\\', 'Users-kike-dev'])
  assert.deepEqual(splitRoot('d--work', true), ['D:\\', 'work'])
  assert.deepEqual(splitRoot('-Users-kike-dev', true), ['/', 'Users-kike-dev'])
  assert.deepEqual(splitRoot('C--Users', false), ['/', 'C--Users'])
})

test('windows names decode from the drive root when the tree exists', { skip: process.platform !== 'win32' }, () => {
  const target = path.join(dir, 'proj')
  fs.mkdirSync(target, { recursive: true })
  assert.equal(decodeDirName(encode(target)).toLowerCase(), target.toLowerCase())
})

test('guesses project from moved dir names', () => {
  const slugs = ['apartados', 'sso', 'dportenis', 'zipp', 'can-doo-with-pet', 'global']
  assert.equal(guessProject('-Users-x-dev-vivaaerobus-vb-solemti-apartados', slugs), 'apartados')
  assert.equal(guessProject('-Users-x-dev-vivaaerobus-vb-solemti-doters-sso-adm-panel', slugs), 'sso')
  assert.equal(guessProject('-Users-x-dev-celula-ecommerce-accrual-engine-zipp-infra', slugs), 'zipp')
  assert.equal(guessProject('-Users-x-dev-can-doo-pet-waste-site', slugs), null)
  assert.equal(guessProject('-Users-x-dev-global', slugs), null)
})

test('skips temp and recap dirs and picks kinds', () => {
  assert.ok(skipDir('-private-tmp-x'))
  assert.ok(skipDir('-tmp-y'))
  assert.ok(skipDir('-Users-x-Recap-2026'))
  assert.ok(skipDir('-Users-x-Recap'))
  assert.ok(!skipDir('-Users-x-dev'))
  assert.equal(kindFor('feedback', 'app'), 'rule')
  assert.equal(kindFor('feedback', GLOBAL), 'fact')
  assert.equal(kindFor('project', 'app'), 'fact')
})

function fixture() {
  assert.ok(!skipDir(encode(dir)), 'the fixture must live outside a skipped temp dir')
  const root = path.join(dir, 'projects')
  const work = path.join(dir, 'work', 'app')
  fs.mkdirSync(path.join(work, '.git'), { recursive: true })
  fs.writeFileSync(path.join(work, 'gaze.toml'), 'project = "App"\n')
  const mem = path.join(root, encode(work), 'memory')
  fs.mkdirSync(mem, { recursive: true })
  fs.mkdirSync(path.join(root, '-private-tmp-x', 'memory'), { recursive: true })
  fs.writeFileSync(path.join(root, '-private-tmp-x', 'memory', 'a.md'), '---\nname: a\n---\nignorar')
  fs.writeFileSync(path.join(mem, 'MEMORY.md'), '- index')
  fs.writeFileSync(path.join(mem, 'auth.md'), '---\nname: auth\ndescription: Cómo funciona la auth\nmetadata:\n  type: project\n---\nUsa JWT, ver [[sessions]]')
  fs.writeFileSync(path.join(mem, 'sessions.md'), '---\nname: sessions\ndescription: Sesiones de 8 horas\nmetadata:\n  type: project\n---\nDuran 8 horas')
  fs.writeFileSync(path.join(mem, 'style.md'), '---\nname: style\ndescription: Nada de comentarios\nmetadata:\n  type: feedback\n---\nSin comentarios en código')
  fs.writeFileSync(path.join(mem, 'me.md'), '---\nname: me\ndescription: El usuario habla español\nmetadata:\n  type: user\n---\nPrefiere español')
  return { root, work, mem }
}

test('imports memories with kinds and stable outcomes', async () => {
  const store = new FakeStore()
  const { root, work } = fixture()
  const dry = await run(store, null, root, true)
  assert.deepEqual(dry, { dryRun: true, total: 4, projects: { app: { fact: 2, rule: 1 }, global: { fact: 1 } }, actions: {} })
  assert.deepEqual(Object.keys(dry), ['dryRun', 'total', 'projects', 'actions'])
  assert.equal(store.calls.length, 0)
  const emb = { embed: async () => [] }
  const done = await run(store, emb, root, false)
  assert.deepEqual(done.actions, { created: 4 })
  const auth = store.calls.find((c) => c.input.sourceRef === `claude-memory:${encode(work)}/auth.md`)
  assert.deepEqual(auth.input, { project: 'app', kind: 'fact', title: 'Cómo funciona la auth', body: 'Usa JWT, ver [[sessions]]', source: 'import', sourceRef: `claude-memory:${encode(work)}/auth.md` })
  assert.equal(auth.dedupe, false)
  assert.equal(auth.emb, emb)
  assert.equal(store.calls.find((c) => c.input.title === 'El usuario habla español').input.project, GLOBAL)
  assert.equal(store.calls.find((c) => c.input.title === 'Nada de comentarios').input.kind, 'rule')
  assert.deepEqual((await run(store, emb, root, false)).actions, { unchanged: 4 })
})

test('long descriptions go in the body and failures go to stderr', async (t) => {
  const store = new FakeStore()
  const { root, mem } = fixture()
  const long = 'D'.repeat(120)
  fs.writeFileSync(path.join(mem, 'long.md'), `---\nname: long\ndescription: ${long}\n---\nCuerpo`)
  fs.writeFileSync(path.join(mem, 'empty.md'), '---\nname: empty\n---\n  ')
  fs.writeFileSync(path.join(mem, 'bad.md'), '---\nname: bad\n---\nFAIL here')
  const lines = []
  t.mock.method(process.stderr, 'write', (chunk) => {
    lines.push(String(chunk))
    return true
  })
  const memories = collect(store, root)
  const longMemory = memories.find((m) => m.sourceRef.endsWith('/long.md'))
  assert.equal(longMemory.body, `${long}\n\nCuerpo`)
  assert.equal([...longMemory.title].length, 90)
  assert.ok(longMemory.title.endsWith('…'))
  assert.equal(memories.find((m) => m.sourceRef.endsWith('/empty.md')).title, 'empty')
  const done = await run(store, { embed: async () => [] }, root, false)
  t.mock.restoreAll()
  assert.deepEqual(done.actions, { created: 5, failed: 1 })
  assert.deepEqual(lines, [`${path.join(mem, 'bad.md')}: outer: inner\n`])
})

test('unresolved dirs fall back to a guessed project', async () => {
  const store = new FakeStore()
  store.db.exec("INSERT INTO projects (slug, bita_id, name) VALUES ('apartados', 3, 'Apartados')")
  const root = path.join(dir, 'projects')
  const name = '-Users-x-dev-vivaaerobus-vb-solemti-apartados'
  fs.mkdirSync(path.join(root, name, 'memory'), { recursive: true })
  fs.mkdirSync(path.join(dir, 'docs', 'inkwell-only'), { recursive: true })
  fs.writeFileSync(path.join(root, name, 'memory', 'n.md'), '---\nname: n\n---\nnota')
  const memories = collect(store, root)
  assert.equal(memories[0].project, 'apartados')
  assert.equal(memories[0].sourceRef, `claude-memory:${name}/n.md`)
  assert.equal(memories[0].title, 'n')
})

test('invalid utf-8 memories fail the import', () => {
  const store = new FakeStore()
  const { root, mem } = fixture()
  fs.writeFileSync(path.join(mem, 'broken.md'), Buffer.from([0x2d, 0xff, 0xfe]))
  assert.throws(() => collect(store, root), /valid UTF-8/)
})

test('imports through the real store when it is available', async (t) => {
  const storeModule = await import('../src/store.js').catch(() => null)
  const embedModule = await import('../src/embed.js').catch(() => null)
  if (storeModule === null || embedModule === null) {
    t.skip('store.js or embed.js not present yet')
    return
  }
  const store = storeModule.Store.inMemory()
  const { root, work } = fixture()
  const e = typeof embedModule.FakeEmbedder === 'function' ? new embedModule.FakeEmbedder() : embedModule.FakeEmbedder
  const done = await run(store, e, root, false)
  assert.equal(done.actions.created, 4)
  const auth = store.bySourceRef(`claude-memory:${encode(work)}/auth.md`)
  assert.equal(auth.title, 'Cómo funciona la auth')
  assert.ok(store.neighbors(auth.id).some((n) => n.title === 'Sesiones de 8 horas' && n.edgeKind === 'link'))
  assert.equal((await run(store, e, root, false)).actions.unchanged, 4)
})
