import fs from 'node:fs'
import path from 'node:path'
import { parse as parseToml } from 'smol-toml'
import { GLOBAL } from './db.js'
import * as paths from './paths.js'
import { lastJsonLine, runSync } from './proc.js'
import { fold, nowIso, slugify, trim } from './text.js'

export const CACHE_SECONDS = 24 * 3600
export const GLOBAL_CACHE_SECONDS = 3600
export const RUN_TIMEOUT_MS = 5000

export const GENERIC_SEGMENTS = [
  'api',
  'apis',
  'app',
  'apps',
  'web',
  'core',
  'common',
  'shared',
  'libs',
  'lib',
  'packages',
  'services',
  'service',
  'microservices',
  'public',
  'private',
  'admin',
  'devops',
  'infra',
  'infrastructure',
  'platform',
  'docs',
  'frontend',
  'backend',
  'mobile',
  'src',
  'tools',
  'jobs',
  'workers',
  'cronjobs',
  'lambdas',
  'modules',
  'dev',
  'test',
  'qa',
]

const WHITESPACE = /^\p{White_Space}$/u

export function makeProject({ slug, name = null, bitaId = null, key = null, source, repo = null }) {
  return { slug, name, bitaId, key, source, repo }
}

export function globalProject(source) {
  return makeProject({ slug: GLOBAL, source })
}

export function nowSecs() {
  return Math.floor(Date.now() / 1000)
}

function exists(p) {
  try {
    fs.statSync(p)
    return true
  } catch {
    return false
  }
}

function ancestors(start) {
  const out = []
  let current = start
  for (;;) {
    out.push(current)
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }
  return out
}

function within(child, parent) {
  const rel = path.relative(parent, child)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel))
}

export function gitRoot(start) {
  for (const dir of ancestors(start)) if (exists(path.join(dir, '.git'))) return dir
  return null
}

export function originUrl(root) {
  const result = runSync('git', ['-C', root, 'remote', 'get-url', 'origin'], { timeoutMs: RUN_TIMEOUT_MS })
  if (result.error || result.status !== 0) return null
  const url = result.stdout.trim()
  return url === '' ? null : url
}

function trimEndAll(s, suffix) {
  let out = s
  while (suffix !== '' && out.endsWith(suffix)) out = out.slice(0, -suffix.length)
  return out
}

export function remoteSlug(url) {
  const raw = trim(url)
  let rest
  const scheme = raw.indexOf('://')
  if (scheme !== -1) {
    let after = raw.slice(scheme + 3)
    const at = after.indexOf('@')
    if (at !== -1) after = after.slice(at + 1)
    const slash = after.indexOf('/')
    if (slash === -1) return null
    const host = after.slice(0, slash).split(':')[0]
    rest = `${host}/${after.slice(slash + 1)}`
  } else {
    const colon = raw.indexOf(':')
    if (colon === -1) return null
    const userHost = raw.slice(0, colon)
    const at = userHost.indexOf('@')
    const host = at === -1 ? userHost : userHost.slice(at + 1)
    rest = `${host}/${raw.slice(colon + 1)}`
  }
  const trimmed = trimEndAll(trimEndAll(rest, '/'), '.git').toLowerCase()
  return trimmed === '' ? null : trimmed
}

const compareBytes = (a, b) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'))

export function matchScope(slug, mapping) {
  const lower = slug.toLowerCase()
  let best = null
  let bestLen = -1
  for (const key of Object.keys(mapping).sort(compareBytes)) {
    const normalized = trimEndAll(key.toLowerCase(), '/')
    if (lower !== normalized && !lower.startsWith(`${normalized}/`)) continue
    const len = Buffer.byteLength(key, 'utf8')
    if (len >= bestLen) {
      best = mapping[key]
      bestLen = len
    }
  }
  return best
}

function runJson(program, args, cwd) {
  const result = runSync(program, args, { cwd, env: { ...process.env, BITA_NO_HOOKS: '1' }, timeoutMs: RUN_TIMEOUT_MS })
  if (result.error) return null
  return lastJsonLine(result.stdout)
}

export function bitaBin() {
  return process.env.GAZE_BITA_BIN ?? 'bita'
}

export function resolverFromEnv(auto) {
  return { home: paths.home(), bita: bitaBin(), bitaConfig: paths.bitaConfig(), auto, log: paths.harvestLog() }
}

export function pathSlug(dir, home) {
  const rel = path.relative(path.join(home, 'dev'), dir)
  if (rel === '' || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return null
  const segments = rel.split(path.sep).filter((s) => s !== '').map((s) => s.toLowerCase())
  return segments.length === 0 ? null : segments.join('/')
}

export function normalizeName(value) {
  return [...fold(value)].filter((c) => !WHITESPACE.test(c) && c !== '-' && c !== '_').join('')
}

export function nameTokens(value) {
  return fold(value)
    .split(/[\p{White_Space}_-]/u)
    .filter((t) => t !== '')
}

function startsOnBoundary(name, segment) {
  if (segment.length > 1) return name.length >= segment.length && segment.every((s, i) => name[i] === s)
  const target = segment[0]
  if (target === undefined) return false
  let joined = ''
  for (const token of name) {
    joined += token
    if (joined === target) return true
    if (!target.startsWith(joined)) return false
  }
  return false
}

export function suggestScope(slug, projects) {
  const segments = slug.split('/')
  const normalized = projects.map(([id, name]) => ({ id, name, n: normalizeName(name), t: nameTokens(name) }))
  for (let depth = segments.length - 1; depth >= 1; depth--) {
    const segment = normalizeName(segments[depth])
    if ([...segment].length < 4 || GENERIC_SEGMENTS.includes(segment)) continue
    const tokens = nameTokens(segments[depth])
    const pick = (matches) => {
      const found = normalized.filter((p) => matches(p.n, p.t)).map((p) => [p.id, p.name])
      found.sort((a, b) => a[0] - b[0])
      return found.filter((entry, i) => i === 0 || found[i - 1][0] !== entry[0])
    }
    const exact = pick((n) => n === segment)
    const candidates = exact.length > 0 ? exact : pick((_, t) => startsOnBoundary(t, tokens))
    if (candidates.length === 0) continue
    if (candidates.length === 1) return [segments.slice(0, depth + 1).join('/'), candidates[0][0], candidates[0][1]]
    return null
  }
  return null
}

const asInt = (value) => (typeof value === 'number' && Number.isInteger(value) ? value : null)
const asStr = (value) => (typeof value === 'string' ? value : null)
const get = (value, key) => (value !== null && typeof value === 'object' && !Array.isArray(value) ? value[key] ?? null : null)

function fromBitaWhich(bin, cwd) {
  const value = runJson(bin, ['repo', 'which', '--json'], cwd)
  if (get(value, 'ok') !== true) return null
  const data = get(value, 'data')
  const id = asInt(get(data, 'projectId')) ?? asInt(get(get(data, 'project'), 'id'))
  if (id === null) return null
  const name = asStr(get(data, 'projectName')) ?? asStr(get(get(data, 'project'), 'name'))
  if (name === null) return null
  return [id, name]
}

function fromScopeMapping(config, slug) {
  let parsed
  try {
    parsed = JSON.parse(fs.readFileSync(config, 'utf8'))
  } catch {
    return null
  }
  const mapping = get(parsed, 'scopeMapping')
  if (mapping === null || typeof mapping !== 'object' || Array.isArray(mapping)) return null
  const entry = matchScope(slug, mapping)
  const id = asInt(get(entry, 'projectId'))
  const name = asStr(get(entry, 'projectName'))
  return id === null || name === null ? null : [id, name]
}

export function refreshBitaProjects(store, cwd) {
  return refreshProjectsWith(store, cwd, bitaBin())
}

export function refreshProjectsWith(store, cwd, bin) {
  const value = runJson(bin, ['projects', '--all', '--json'], cwd)
  const list = get(value, 'data')
  if (!Array.isArray(list)) return null
  for (const project of list) {
    const pid = asInt(get(project, 'id'))
    const name = asStr(get(project, 'name'))
    if (pid === null || name === null || slugify(name) === GLOBAL) continue
    const key = asStr(get(project, 'key'))
    try {
      store.db
        .prepare('INSERT INTO projects (slug, bita_id, name, key) VALUES (?1, ?2, ?3, ?4) ON CONFLICT(slug) DO UPDATE SET bita_id = excluded.bita_id, name = excluded.name, key = COALESCE(excluded.key, projects.key)')
        .run(slugify(name), pid, name, key)
    } catch {}
  }
  return list
}

function bitaKey(store, id, cwd, bin, refresh) {
  try {
    const row = store.db.prepare('SELECT key FROM projects WHERE bita_id = ?1 AND key IS NOT NULL').get(id)
    if (row) return row.key
  } catch {}
  if (!refresh) return null
  const list = refreshProjectsWith(store, cwd, bin)
  if (list === null) return null
  const found = list.find((p) => asInt(get(p, 'id')) === id)
  return found === undefined ? null : asStr(get(found, 'key'))
}

function fromGazeToml(root) {
  let value
  try {
    value = parseToml(paths.readUtf8Strict(path.join(root, 'gaze.toml')))
  } catch {
    return null
  }
  const project = asStr(get(value, 'project'))
  if (project === null) return null
  const slug = slugify(project)
  return slug === '' ? null : slug
}

function knownProjects(store) {
  try {
    return store.db
      .prepare('SELECT bita_id, name FROM projects WHERE bita_id IS NOT NULL AND name IS NOT NULL ORDER BY bita_id')
      .all()
      .map((row) => [Number(row.bita_id), row.name])
  } catch {
    return []
  }
}

function autoScope(store, cwd, slug, env) {
  const list = refreshProjectsWith(store, cwd, env.bita)
  const candidates =
    list === null
      ? knownProjects(store)
      : list
          .map((p) => [asInt(get(p, 'id')), asStr(get(p, 'name'))])
          .filter(([id, name]) => id !== null && name !== null && slugify(name) !== GLOBAL)
  const suggestion = suggestScope(slug, candidates)
  if (suggestion === null) return null
  const [prefix, id, name] = suggestion
  const saved = get(runJson(env.bita, ['scope', 'set', prefix, String(id), '--json'], cwd), 'ok') === true
  const source = saved ? 'auto-scope' : 'suggestion'
  if (env.log) {
    try {
      fs.appendFileSync(env.log, `${nowIso()} ${source} ${prefix} -> ${name} (${id})\n`)
    } catch {}
  }
  return [[id, name], source]
}

function gazeTomlUpward(cwd, home) {
  const dev = path.join(home, 'dev')
  if (!within(cwd, dev)) return fromGazeToml(cwd)
  for (const dir of ancestors(cwd)) {
    if (!within(dir, dev)) break
    const found = fromGazeToml(dir)
    if (found !== null) return found
  }
  return null
}

export function rememberProject(store, project) {
  if (project.slug === GLOBAL) return
  try {
    store.db
      .prepare(
        'INSERT INTO projects (slug, bita_id, name, key) VALUES (?1, ?2, ?3, ?4) ON CONFLICT(slug) DO UPDATE SET bita_id = COALESCE(excluded.bita_id, projects.bita_id), name = COALESCE(excluded.name, projects.name), key = COALESCE(excluded.key, projects.key)',
      )
      .run(project.slug, project.bitaId, project.name, project.key)
  } catch {}
}

export function resolveUncached(store, cwd) {
  return resolveWith(store, cwd, resolverFromEnv(true))
}

export function resolveWith(store, cwd, env) {
  const root = gitRoot(cwd)
  let slug
  if (root !== null) {
    const url = originUrl(root)
    slug = (url === null ? null : remoteSlug(url)) ?? pathSlug(root, env.home)
  } else {
    slug = pathSlug(cwd, env.home)
  }
  const bitaProject = ([[id, name], source]) =>
    makeProject({ slug: slugify(name), name, bitaId: id, key: bitaKey(store, id, cwd, env.bita, env.auto), source, repo: slug })
  let configured = null
  if (root !== null) {
    const found = fromBitaWhich(env.bita, cwd)
    if (found !== null) configured = [found, 'bita']
  }
  if (configured === null && slug !== null) {
    const found = fromScopeMapping(env.bitaConfig, slug)
    if (found !== null) configured = [found, 'scope-mapping']
  }
  if (configured !== null) return bitaProject(configured)
  const toml = root !== null ? fromGazeToml(root) : gazeTomlUpward(cwd, env.home)
  if (toml !== null) return makeProject({ slug: toml, source: 'gaze.toml', repo: slug })
  if (env.auto && slug !== null) {
    const found = autoScope(store, cwd, slug, env)
    if (found !== null) return bitaProject(found)
  }
  return makeProject({ slug: GLOBAL, source: 'default', repo: slug })
}

export function resolve(store, cwd, refresh) {
  return resolveEnv(store, cwd, refresh, resolverFromEnv(true))
}

export function resolveFast(store, cwd) {
  return resolveEnv(store, cwd, false, resolverFromEnv(false))
}

export function resolveEnv(store, cwd, refresh, env) {
  const forced = process.env.GAZE_PROJECT
  if (forced !== undefined && trim(forced) !== '') {
    const slug = forced === GLOBAL ? forced : slugify(forced)
    return makeProject({ slug, source: 'env' })
  }
  const dir = paths.canonical(cwd)
  const key = dir
  if (!refresh) {
    const cached = store.db.prepare('SELECT project, source, resolved_at FROM project_cache WHERE cwd = ?1').get(key)
    if (cached && nowSecs() - Number(cached.resolved_at) < (cached.project === GLOBAL ? GLOBAL_CACHE_SECONDS : CACHE_SECONDS)) {
      const meta = store.db.prepare('SELECT bita_id, name, key FROM projects WHERE slug = ?1').get(cached.project)
      return makeProject({
        slug: cached.project,
        name: meta?.name ?? null,
        bitaId: meta?.bita_id === undefined || meta?.bita_id === null ? null : Number(meta.bita_id),
        key: meta?.key ?? null,
        source: `cache:${cached.source}`,
      })
    }
  }
  const project = resolveWith(store, dir, env)
  rememberProject(store, project)
  store.db
    .prepare(
      'INSERT INTO project_cache (cwd, project, source, resolved_at) VALUES (?1, ?2, ?3, ?4) ON CONFLICT(cwd) DO UPDATE SET project = excluded.project, source = excluded.source, resolved_at = excluded.resolved_at',
    )
    .run(key, project.slug, project.source, nowSecs())
  return project
}

export function projectForName(store, name) {
  const trimmed = trim(name)
  if (trimmed === '' || trimmed === GLOBAL || trimmed === '_no-project') return GLOBAL
  const group = slugify(trimmed)
  try {
    if (store.db.prepare('SELECT 1 FROM project_groups WHERE name = ?1 LIMIT 1').get(group)) return group
  } catch {}
  try {
    const row = store.db.prepare('SELECT slug FROM projects WHERE upper(key) = upper(?1) OR lower(name) = lower(?1)').get(trimmed)
    if (row) return row.slug
  } catch {}
  return slugify(trimmed)
}

export function projectForBitaId(store, id) {
  try {
    return store.db.prepare('SELECT slug FROM projects WHERE bita_id = ?1').get(id)?.slug ?? null
  } catch {
    return null
  }
}

export function explicitOrCwd(store, explicit, cwd) {
  const chosen = explicit === undefined || explicit === null ? '' : trim(explicit)
  if (chosen !== '') return projectForName(store, chosen)
  return resolve(store, cwd, false).slug
}
