import fs from 'node:fs'
import path from 'node:path'
import { GLOBAL } from './db.js'
import * as paths from './paths.js'
import * as project from './project.js'
import { frontmatter, trim, truncate } from './text.js'

const compareBytes = (a, b) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'))
const charCount = (s) => [...s].length

function errorChain(error) {
  const parts = []
  let current = error
  while (current !== undefined && current !== null && parts.length < 32) {
    parts.push(current instanceof Error ? current.message : String(current))
    current = current instanceof Error ? current.cause : undefined
  }
  return parts.join(': ')
}

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory()
  } catch {
    return false
  }
}

function entries(dir) {
  try {
    return fs.readdirSync(dir)
  } catch {
    return null
  }
}

export function encode(name) {
  return [...name].map((c) => (/^[A-Za-z0-9]$/.test(c) ? c : '-')).join('')
}

const stripDash = (s) => (s.startsWith('-') ? s.slice(1) : s)

function decodeFrom(dir, rest, depth) {
  if (rest === '') return dir
  if (depth > 40) return null
  const names = entries(dir)
  if (names === null) return null
  const candidates = []
  for (const name of names) {
    const full = path.join(dir, name)
    if (!isDir(full)) continue
    const encoded = encode(name)
    if (rest === encoded || rest.startsWith(`${encoded}-`)) candidates.push([encoded.length, full])
  }
  candidates.sort((a, b) => b[0] - a[0])
  for (const [len, full] of candidates) {
    const found = decodeFrom(full, stripDash(rest.slice(len)), depth + 1)
    if (found !== null) return found
  }
  return null
}

export function splitRoot(name, windows) {
  if (windows && name.length >= 3 && /^[A-Za-z]$/.test(name[0]) && name[1] === '-' && name[2] === '-') {
    return [`${name[0].toUpperCase()}:\\`, name.slice(3)]
  }
  return ['/', stripDash(name)]
}

function decodePrefix(root, rest) {
  let best = root
  let current = root
  let remaining = rest
  for (;;) {
    const names = entries(current)
    if (names === null) break
    let next = null
    for (const name of names) {
      const full = path.join(current, name)
      if (!isDir(full)) continue
      const encoded = encode(name)
      if ((remaining === encoded || remaining.startsWith(`${encoded}-`)) && (next === null || encoded.length > next[0])) next = [encoded.length, full]
    }
    if (next === null) break
    remaining = stripDash(remaining.slice(next[0]))
    current = next[1]
    best = next[1]
    if (remaining === '') break
  }
  return best
}

export function decodeDirNameExact(name, { windows = process.platform === 'win32' } = {}) {
  const [root, rest] = splitRoot(name, windows)
  const found = decodeFrom(root, rest, 0)
  if (found !== null) return [found, true]
  return [decodePrefix(root, rest), false]
}

export function decodeDirName(name, options) {
  return decodeDirNameExact(name, options)[0]
}

export function guessProject(name, slugs) {
  const tokens = name
    .toLowerCase()
    .split('-')
    .filter((t) => t !== '')
  let best = null
  for (const slug of slugs) {
    if (slug === GLOBAL || slug === '') continue
    const parts = slug.split('-')
    let hit = false
    for (let i = 0; i + parts.length <= tokens.length && !hit; i++) hit = parts.every((part, j) => tokens[i + j] === part)
    if (hit && (best === null || Buffer.byteLength(slug, 'utf8') >= Buffer.byteLength(best, 'utf8'))) best = slug
  }
  return best
}

function knownSlugs(store) {
  project.refreshBitaProjects(store, '/')
  let slugs = []
  try {
    slugs = store.db
      .prepare('SELECT slug FROM projects')
      .all()
      .map((row) => row.slug)
  } catch {}
  const docs = paths.inkwellDocs()
  for (const name of entries(docs) ?? []) {
    if (isDir(path.join(docs, name)) && !name.startsWith('.') && !name.startsWith('_')) slugs.push(name)
  }
  slugs.sort(compareBytes)
  return slugs.filter((slug, i) => i === 0 || slugs[i - 1] !== slug)
}

export function skipDir(name) {
  return name.startsWith('-private-tmp-') || name.startsWith('-tmp-') || name.includes('-Recap-') || name.endsWith('-Recap')
}

export function kindFor(memoryType, projectSlug) {
  return memoryType === 'feedback' && projectSlug !== GLOBAL ? 'rule' : 'fact'
}

export function collect(store, root) {
  const out = []
  const names = entries(root)
  if (names === null) return out
  let slugs = null
  names.sort(compareBytes)
  for (const name of names) {
    if (skipDir(name)) continue
    const memoryDir = path.join(root, name, 'memory')
    const listed = entries(memoryDir)
    if (listed === null) continue
    const files = listed
      .filter((file) => path.extname(file) === '.md' && file !== 'MEMORY.md')
      .map((file) => path.join(memoryDir, file))
      .sort(compareBytes)
    if (files.length === 0) continue
    const [decoded, exact] = decodeDirNameExact(name)
    const resolved = project.resolve(store, decoded, false)
    let slug = resolved.slug
    if (slug === GLOBAL && (!exact || project.gitRoot(decoded) === null)) {
      slugs ??= knownSlugs(store)
      const guess = guessProject(name, slugs)
      if (guess !== null) slug = guess
    }
    for (const file of files) {
      const raw = paths.readUtf8Strict(file)
      const { meta, body } = frontmatter(raw)
      const memoryType = meta.get('type') ?? 'project'
      const target = memoryType === 'user' ? GLOBAL : slug
      const stem = path.parse(file).name
      const nameField = meta.get('name') ?? stem
      const description = meta.get('description') ?? ''
      const title = description === '' ? nameField : truncate(description, 90)
      const fullBody = description === '' || charCount(description) <= 90 ? trim(body) : `${description}\n\n${trim(body)}`
      out.push({
        path: file,
        sourceRef: `claude-memory:${name}/${stem}.md`,
        project: target,
        kind: kindFor(memoryType, target),
        title,
        body: fullBody === '' ? description : fullBody,
      })
    }
  }
  return out
}

const sorted = (map) => Object.fromEntries([...map.entries()].sort(([a], [b]) => compareBytes(a, b)))

export async function run(store, emb, root, dryRun) {
  const memories = collect(store, root)
  const perProject = new Map()
  for (const memory of memories) {
    const kinds = perProject.get(memory.project) ?? new Map()
    kinds.set(memory.kind, (kinds.get(memory.kind) ?? 0) + 1)
    perProject.set(memory.project, kinds)
  }
  const actions = new Map()
  const bump = (action) => actions.set(action, (actions.get(action) ?? 0) + 1)
  if (!dryRun && emb !== null && emb !== undefined) {
    for (const memory of memories) {
      if (trim(memory.body) === '') continue
      try {
        const outcome = await store.remember(
          emb,
          { project: memory.project, kind: memory.kind, title: memory.title, body: memory.body, source: 'import', sourceRef: memory.sourceRef },
          false,
        )
        bump(outcome.action)
      } catch (error) {
        bump('failed')
        process.stderr.write(`${memory.path}: ${errorChain(error)}\n`)
      }
    }
  }
  const projects = Object.fromEntries([...perProject.entries()].sort(([a], [b]) => compareBytes(a, b)).map(([p, kinds]) => [p, sorted(kinds)]))
  return { dryRun, total: memories.length, projects, actions: sorted(actions) }
}
