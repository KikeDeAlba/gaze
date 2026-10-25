import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { GLOBAL, openMemory } from '../src/db.js'
import { canonical } from '../src/paths.js'
import {
  explicitOrCwd,
  gitRoot,
  matchScope,
  nowSecs,
  pathSlug,
  projectForBitaId,
  projectForName,
  refreshProjectsWith,
  remoteSlug,
  resolve,
  resolveEnv,
  resolveFast,
  resolveUncached,
  resolveWith,
  suggestScope,
} from '../src/project.js'

const VARS = ['GAZE_BITA_BIN', 'GAZE_PROJECT', 'GAZE_DATA_DIR', 'BITA_CONFIG_PATH', 'HOME', 'USERPROFILE']
const SHIM = new URL('./fixtures/cmd-shims/npm11/bita.cmd', import.meta.url)
let saved
let dir

beforeEach(() => {
  saved = Object.fromEntries(VARS.map((name) => [name, process.env[name]]))
  dir = canonical(fs.mkdtempSync(path.join(os.tmpdir(), 'gaze-project-')))
  process.env.GAZE_BITA_BIN = '/nonexistent/bita'
  process.env.GAZE_DATA_DIR = path.join(dir, 'data')
  process.env.BITA_CONFIG_PATH = path.join(dir, 'missing-bita.json')
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

const memoryStore = () => ({ db: openMemory() })

function fakeHome() {
  const home = path.join(dir, 'home')
  const folder = path.join(home, 'dev', 'github.com', 'KikeDeAlba')
  fs.mkdirSync(path.join(folder, 'gaze', '.git'), { recursive: true })
  return { home, folder }
}

function fakeBita(projects, { logAll = true } = {}) {
  const calls = path.join(dir, 'calls')
  const source = [
    "const fs = require('node:fs')",
    'const args = process.argv.slice(2)',
    logAll ? `fs.appendFileSync(${JSON.stringify(calls)}, args.join(' ') + '\\n')` : '',
    `if (args[0] === 'projects') console.log(JSON.stringify({ ok: true, data: ${projects} }))`,
    `if (args[0] === 'scope') { ${logAll ? '' : `fs.writeFileSync(${JSON.stringify(calls)}, args.join(' ') + '\\n');`} console.log('{"ok":true}') }`,
  ].join('\n')
  let script
  if (process.platform === 'win32') {
    fs.writeFileSync(path.join(dir, 'bita.js'), source)
    script = path.join(dir, 'bita.cmd')
    fs.writeFileSync(script, fs.readFileSync(SHIM, 'utf8').replace('node_modules\\@kikedealba\\bita\\dist\\bin\\bita.js', 'bita.js'))
  } else {
    script = path.join(dir, 'bita')
    fs.writeFileSync(script, `#!/usr/bin/env node\n${source}\n`)
    fs.chmodSync(script, 0o755)
  }
  return { script, calls }
}

const callsOf = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '')
const resolver = (home, extra) => ({ home, bita: '/nonexistent/bita', bitaConfig: path.join(dir, 'missing.json'), auto: true, log: null, ...extra })
const projects = (list) => list.map(([id, name]) => [id, name])

test('a group name wins over a project key', () => {
  const store = memoryStore()
  store.db.exec("INSERT INTO projects (slug, bita_id, name, key) VALUES ('app-dp-v2', 1, 'App DP v2', 'DP')")
  assert.equal(projectForName(store, 'dp'), 'app-dp-v2')
  store.db.exec("INSERT INTO project_groups (name, project) VALUES ('dp', 'app-dp-v2'), ('dp', 'dportenis')")
  assert.equal(projectForName(store, 'dp'), 'dp')
  assert.equal(projectForName(store, 'App DP v2'), 'app-dp-v2')
  assert.equal(projectForName(store, '  '), GLOBAL)
  assert.equal(projectForName(store, '_no-project'), GLOBAL)
  assert.equal(projectForName(store, 'Nuevo Cliente'), 'nuevo-cliente')
  assert.equal(projectForBitaId(store, 1), 'app-dp-v2')
  assert.equal(projectForBitaId(store, 99), null)
  assert.equal(explicitOrCwd(store, ' DP ', dir), 'dp')
})

test('remote slugs normalize', () => {
  assert.equal(remoteSlug('git@github.com:KikeDeAlba/bita-cli.git'), 'github.com/kikedealba/bita-cli')
  assert.equal(remoteSlug('https://user@gitlab.com/vivaaerobus/vb_solemti/doters-sso.git'), 'gitlab.com/vivaaerobus/vb_solemti/doters-sso')
  assert.equal(remoteSlug('ssh://git@git.solemti.net:2222/dportenis/recommendation'), 'git.solemti.net/dportenis/recommendation')
  assert.equal(remoteSlug('https://github.com/a/b/'), 'github.com/a/b')
  assert.equal(remoteSlug('nothing'), null)
  assert.equal(remoteSlug('https://host-only'), null)
})

test('scope mapping matches longest prefix on segments', () => {
  const map = {
    'gitlab.com/vivaaerobus': { projectId: 1, projectName: 'Viva' },
    'gitlab.com/vivaaerobus/vb_solemti/doters-sso': { projectId: 2, projectName: 'SSO' },
    'github.com/kike': { projectId: 3, projectName: 'Nope' },
  }
  assert.equal(matchScope('gitlab.com/vivaaerobus/vb_solemti/doters-sso', map).projectId, 2)
  assert.equal(matchScope('gitlab.com/vivaaerobus/other', map).projectId, 1)
  assert.equal(matchScope('github.com/kikedealba/gaze', map), null)
})

test('resolver uses gaze toml then global and caches', () => {
  const store = memoryStore()
  const repo = path.join(dir, 'repo')
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true })
  fs.mkdirSync(path.join(repo, 'sub'), { recursive: true })
  const plain = resolveUncached(store, path.join(repo, 'sub'))
  assert.equal(plain.slug, GLOBAL)
  fs.writeFileSync(path.join(repo, 'gaze.toml'), 'project = "Mi Proyecto"\n')
  const resolved = resolve(store, path.join(repo, 'sub'), true)
  assert.equal(resolved.slug, 'mi-proyecto')
  assert.equal(resolved.source, 'gaze.toml')
  assert.deepEqual(Object.keys(resolved), ['slug', 'name', 'bitaId', 'key', 'source', 'repo'])
  const cached = resolve(store, path.join(repo, 'sub'), false)
  assert.equal(cached.slug, 'mi-proyecto')
  assert.ok(cached.source.startsWith('cache:'))
  assert.equal(resolveFast(store, path.join(repo, 'sub')).source, 'cache:gaze.toml')
  const outside = resolveUncached(store, dir)
  assert.equal(outside.slug, GLOBAL)
  assert.equal(gitRoot(path.join(repo, 'sub')), repo)
})

test('gaze project env forces the project', () => {
  const store = memoryStore()
  process.env.GAZE_PROJECT = 'Mi App'
  assert.deepEqual(resolve(store, dir, false), { slug: 'mi-app', name: null, bitaId: null, key: null, source: 'env', repo: null })
  process.env.GAZE_PROJECT = GLOBAL
  assert.equal(resolve(store, dir, false).slug, GLOBAL)
  process.env.GAZE_PROJECT = '  '
  assert.equal(resolve(store, dir, false).source, 'default')
})

test('path slugs are relative to dev and lowercased', { skip: process.platform === 'win32' }, () => {
  const home = '/Users/me'
  assert.equal(pathSlug('/Users/me/dev/github.com/KikeDeAlba', home), 'github.com/kikedealba')
  assert.equal(pathSlug('/Users/me/dev/GitLab.com/Viva/SSO', home), 'gitlab.com/viva/sso')
  assert.equal(pathSlug('/Users/me/dev', home), null)
  assert.equal(pathSlug('/Users/me/Documents/x', home), null)
  assert.equal(pathSlug('/Users/me/devtools/x', home), null)
})

test('path slugs work with windows paths', { skip: process.platform !== 'win32' }, () => {
  const home = 'C:\\Users\\me'
  assert.equal(pathSlug('C:\\Users\\me\\dev\\github.com\\KikeDeAlba', home), 'github.com/kikedealba')
  assert.equal(pathSlug('C:\\Users\\me\\dev', home), null)
  assert.equal(pathSlug('C:\\Users\\me\\devtools\\x', home), null)
  assert.equal(pathSlug('D:\\dev\\x', home), null)
})

test('suggest scope matches exact and long prefixes', () => {
  const list = projects([[7, 'KikeDeAlba Modules'], [8, 'Gaze'], [9, 'Doters SSO']])
  assert.deepEqual(suggestScope('github.com/kikedealba', list), ['github.com/kikedealba', 7, 'KikeDeAlba Modules'])
  assert.deepEqual(suggestScope('github.com/kikedealba/gaze', list), ['github.com/kikedealba/gaze', 8, 'Gaze'])
  assert.deepEqual(suggestScope('gitlab.com/viva/doters_sso', list), ['gitlab.com/viva/doters_sso', 9, 'Doters SSO'])
  assert.equal(suggestScope('github.com/kikedealba/other', list)?.[1], 7)
  assert.equal(suggestScope('gaze', list), null)
})

test('suggest scope folds accents and rejects short or ambiguous', () => {
  const list = projects([[1, 'Logística Norte'], [2, 'App One'], [3, 'App Two'], [4, 'Zip']])
  assert.equal(suggestScope('gitlab.com/acme/logistica-norte', list)?.[1], 1)
  assert.equal(suggestScope('gitlab.com/acme/appone', list)?.[1], 2)
  assert.equal(suggestScope('gitlab.com/acme/app', list), null)
  assert.equal(suggestScope('gitlab.com/zip/x', list), null)
  assert.equal(suggestScope('gitlab.com/log/x', list), null)
  const twins = projects([[5, 'Apartados Web'], [6, 'Apartados Api']])
  assert.equal(suggestScope('gitlab.com/zip/apartados', [...twins, ...list]), null)
})

test('suggest scope ignores generic segments', () => {
  const generic = projects([[1, 'DevOps Platform'], [3, 'Api Gateway']])
  assert.equal(suggestScope('gitlab.com/acme/devops', generic), null)
  assert.equal(suggestScope('gitlab.com/acme/api', generic), null)
  assert.equal(suggestScope('gitlab.com/acme/platform', generic), null)
  const list = projects([[1, 'DevOps Platform'], [2, 'Acme Infra'], [3, 'Api Gateway']])
  assert.deepEqual(suggestScope('gitlab.com/acme/devops/x', list)?.slice(0, 2), ['gitlab.com/acme', 2])
})

test('suggest scope ignores short exact names', () => {
  const list = projects([[1, 'Den'], [2, 'DP']])
  assert.equal(suggestScope('gitlab.com/den', list), null)
  assert.equal(suggestScope('gitlab.com/dp/x', list), null)
})

test('suggest scope prefixes stop at word boundaries', () => {
  const list = projects([[1, 'Vivaaerobus'], [2, 'Viva Aerobus Ops'], [3, 'Doters SSO Legacy']])
  const glued = projects([[1, 'Vivaaerobus']])
  assert.equal(suggestScope('gitlab.com/acme/viva', glued), null)
  assert.equal(suggestScope('gitlab.com/acme/vivaaero', list), null)
  assert.equal(suggestScope('gitlab.com/acme/viva', list)?.[1], 2)
  assert.equal(suggestScope('gitlab.com/acme/vivaaerobus', list)?.[1], 1)
  assert.equal(suggestScope('gitlab.com/acme/doters-sso', list)?.[1], 3)
  assert.equal(suggestScope('gitlab.com/acme/doters-ss', list), null)
  const single = projects([[2, 'Viva Aerobus Ops']])
  assert.equal(suggestScope('gitlab.com/acme/vivaaerobus', single)?.[1], 2)
})

test('suggest scope never matches the host segment', () => {
  const list = projects([[1, 'Github Com'], [2, 'Github']])
  assert.equal(suggestScope('github.com/zzzz', list), null)
  assert.equal(suggestScope('github/zzzz', list), null)
})

const KIKE_MODULES = '[{"id":7,"name":"KikeDeAlba Modules","key":"KM"}]'

test('automatic scope uses the fresh bita list over a partial table', () => {
  const store = memoryStore()
  store.db.exec("INSERT INTO projects (slug, bita_id, name) VALUES ('apartados-web', 5, 'Apartados Web')")
  const { home } = fakeHome()
  const folder = path.join(home, 'dev', 'gitlab.com', 'acme', 'apartados')
  fs.mkdirSync(folder, { recursive: true })
  const { script, calls } = fakeBita('[{"id":5,"name":"Apartados Web"},{"id":6,"name":"Apartados Api"}]')
  const resolved = resolveWith(store, folder, resolver(home, { bita: script }))
  assert.equal(resolved.slug, GLOBAL)
  const logged = callsOf(calls)
  assert.ok(logged.includes('projects'), logged)
  assert.ok(!logged.includes('scope set'), logged)
})

test('gaze toml wins over the automatic scope', () => {
  const store = memoryStore()
  const { home, folder } = fakeHome()
  const { script, calls } = fakeBita(KIKE_MODULES)
  fs.writeFileSync(path.join(folder, 'gaze.toml'), 'project = "Mi Carpeta"\n')
  const resolved = resolveWith(store, folder, resolver(home, { bita: script }))
  assert.equal(resolved.slug, 'mi-carpeta')
  assert.equal(resolved.source, 'gaze.toml')
  assert.ok(!callsOf(calls).includes('scope set'))
})

test('fast resolution skips bita projects and scope set but caches', () => {
  const store = memoryStore()
  const { home, folder } = fakeHome()
  const { script, calls } = fakeBita(KIKE_MODULES)
  const env = resolver(home, { bita: script, auto: false })
  const fast = resolveEnv(store, folder, false, env)
  assert.equal(fast.slug, GLOBAL)
  assert.equal(fast.repo, 'github.com/kikedealba')
  const logged = callsOf(calls)
  assert.ok(!logged.includes('projects'), logged)
  assert.ok(!logged.includes('scope'), logged)
  assert.equal(resolveEnv(store, folder, false, env).source, 'cache:default')
  const full = { ...env, auto: true }
  const refreshed = resolveEnv(store, folder, true, full)
  assert.equal(refreshed.slug, 'kikedealba-modules')
  assert.equal(resolveEnv(store, folder, false, full).slug, 'kikedealba-modules')
})

test('repo without remote resolves from nested directories', () => {
  const store = memoryStore()
  const { home, folder } = fakeHome()
  const nested = path.join(folder, 'gaze', 'src', 'deep', 'er')
  fs.mkdirSync(nested, { recursive: true })
  const config = path.join(dir, 'config.json')
  fs.writeFileSync(config, JSON.stringify({ scopeMapping: { 'github.com/kikedealba/gaze': { projectId: 8, projectName: 'Gaze' } } }))
  const resolved = resolveWith(store, nested, resolver(home, { bitaConfig: config }))
  assert.equal(resolved.slug, 'gaze')
  assert.equal(resolved.source, 'scope-mapping')
  assert.equal(resolved.repo, 'github.com/kikedealba/gaze')
})

test('folder outside a repo uses the scope mapping', () => {
  const store = memoryStore()
  const { home, folder } = fakeHome()
  const config = path.join(dir, 'config.json')
  fs.writeFileSync(config, JSON.stringify({ scopeMapping: { 'github.com/kikedealba': { projectId: 7, projectName: 'KikeDeAlba Modules' } } }))
  const resolved = resolveWith(store, folder, resolver(home, { bitaConfig: config }))
  assert.equal(resolved.slug, 'kikedealba-modules')
  assert.equal(resolved.source, 'scope-mapping')
  assert.equal(resolved.bitaId, 7)
  assert.equal(resolved.repo, 'github.com/kikedealba')
})

test('folder outside a repo creates the scope automatically', () => {
  const store = memoryStore()
  const { home, folder } = fakeHome()
  const { script, calls } = fakeBita('[{"id":7,"name":"KikeDeAlba Modules","key":"KM"}]', { logAll: false })
  const log = path.join(dir, 'harvest.log')
  const resolved = resolveWith(store, folder, resolver(home, { bita: script, log }))
  assert.equal(resolved.slug, 'kikedealba-modules')
  assert.equal(resolved.source, 'auto-scope')
  assert.equal(resolved.key, 'KM')
  assert.equal(fs.readFileSync(calls, 'utf8').trim(), 'scope set github.com/kikedealba 7 --json')
  assert.match(fs.readFileSync(log, 'utf8'), / auto-scope github\.com\/kikedealba -> KikeDeAlba Modules \(7\)\n$/)
})

test('folder outside a repo finds gaze toml upward within dev', () => {
  const store = memoryStore()
  const { home, folder } = fakeHome()
  fs.mkdirSync(path.join(folder, 'notes'), { recursive: true })
  fs.writeFileSync(path.join(home, 'dev', 'gaze.toml'), 'project = "Dev Wide"\n')
  const env = resolver(home)
  const resolved = resolveWith(store, path.join(folder, 'notes'), env)
  assert.equal(resolved.slug, 'dev-wide')
  assert.equal(resolved.source, 'gaze.toml')
  fs.writeFileSync(path.join(home, 'gaze.toml'), 'project = "Too High"\n')
  fs.rmSync(path.join(home, 'dev', 'gaze.toml'))
  assert.equal(resolveWith(store, folder, env).slug, GLOBAL)
})

test('global cache entries expire after an hour', () => {
  const store = memoryStore()
  const cwd = canonical(dir)
  const insert = (project, age) =>
    store.db
      .prepare(
        "INSERT INTO project_cache (cwd, project, source, resolved_at) VALUES (?1, ?2, 'test', ?3) ON CONFLICT(cwd) DO UPDATE SET project = excluded.project, source = excluded.source, resolved_at = excluded.resolved_at",
      )
      .run(cwd, project, nowSecs() - age)
  insert(GLOBAL, 2 * 3600)
  assert.ok(!resolve(store, cwd, false).source.startsWith('cache:'))
  insert('den', 2 * 3600)
  assert.equal(resolve(store, cwd, false).source, 'cache:test')
  insert(GLOBAL, 60)
  assert.equal(resolve(store, cwd, false).source, 'cache:test')
})

test('refresh projects upserts bita projects but never global', () => {
  const store = memoryStore()
  const { script } = fakeBita('[{"id":1,"name":"Global"},{"id":2,"name":"Nuevo Cliente","key":"NC"},{"id":"x","name":"Bad"}]')
  const list = refreshProjectsWith(store, dir, script)
  assert.equal(list.length, 3)
  assert.deepEqual(store.db.prepare('SELECT slug, bita_id, name, key FROM projects ORDER BY slug').all().map((r) => ({ ...r })), [{ slug: 'nuevo-cliente', bita_id: 2, name: 'Nuevo Cliente', key: 'NC' }])
  assert.equal(refreshProjectsWith(store, dir, '/nonexistent/bita'), null)
})
