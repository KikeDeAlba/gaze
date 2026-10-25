import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { errorChain } from './envelope.js'
import * as paths from './paths.js'
import { exists, isFile } from './paths.js'
import { lastJsonLine, runSync } from './proc.js'
import * as project from './project.js'
import { GLOBAL } from './store.js'
import * as text from './text.js'
import { compareBytes, field, str } from './text.js'

const MOVING = 'inkwell-moving:'
const I64 = /^[+-]?\d+$/

const int = (value) => (typeof value === 'number' && Number.isInteger(value) ? value : null)
const isWindows = () => process.platform === 'win32'

function parseI64(value) {
  if (typeof value !== 'string' || !I64.test(value)) return null
  const n = BigInt(value)
  if (n < -9223372036854775808n || n > 9223372036854775807n) return null
  return Number(n)
}

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory()
  } catch {
    return false
  }
}

function isAbsolute(p) {
  if (isWindows()) return /^[A-Za-z]:[\\/]/.test(p) || /^[\\/]{2}/.test(p)
  return p.startsWith('/')
}

function components(p) {
  const windows = isWindows()
  let rest = p
  let prefix = ''
  if (windows) {
    const unc = /^[\\/]{2}[^\\/]+[\\/][^\\/]+/.exec(rest)
    const drive = /^[A-Za-z]:/.exec(rest)
    const found = unc ?? drive
    if (found) {
      prefix = found[0]
      rest = rest.slice(found[0].length)
    }
  }
  const separator = windows ? /[\\/]/ : /\//
  const rooted = separator.test(rest.charAt(0))
  const raw = rest.split(separator)
  const parts = []
  raw.forEach((part, index) => {
    if (part === '') return
    if (part === '.' && !(index === 0 && !rooted && prefix === '')) return
    parts.push(part)
  })
  return { prefix, rooted, parts }
}

function stripPrefix(root, p) {
  const a = components(root)
  const b = components(p)
  if (a.prefix !== b.prefix || a.rooted !== b.rooted || a.parts.length > b.parts.length) return null
  if (!a.parts.every((part, i) => part === b.parts[i])) return null
  return b.parts.slice(a.parts.length)
}

function comparePaths(a, b) {
  const x = components(a)
  const y = components(b)
  const head = compareBytes(`${x.prefix}${x.rooted ? '/' : ''}`, `${y.prefix}${y.rooted ? '/' : ''}`)
  if (head !== 0) return head
  for (let i = 0; i < Math.min(x.parts.length, y.parts.length); i++) {
    const c = compareBytes(x.parts[i], y.parts[i])
    if (c !== 0) return c
  }
  return x.parts.length - y.parts.length
}

function fileStem(p) {
  return path.parse(p).name
}

export function mtime(p) {
  try {
    const stat = fs.statSync(p, { bigint: true })
    if (stat.mtimeNs < 0n) return 0
    return Number(stat.mtimeNs / 1000000000n)
  } catch {
    return 0
  }
}

function unchanged(store, key, modified) {
  let row
  try {
    row = store.db.prepare('SELECT mtime FROM ingest_files WHERE path = ?1').get(key)
  } catch {
    return false
  }
  if (!row || Number(row.mtime) !== modified) return false
  try {
    return store.bySourceRef(key) !== null
  } catch {
    return false
  }
}

function mark(store, key, modified, nodeId) {
  store.db
    .prepare('INSERT INTO ingest_files (path, mtime, node_id) VALUES (?1, ?2, ?3) ON CONFLICT(path) DO UPDATE SET mtime = excluded.mtime, node_id = excluded.node_id')
    .run(key, modified, nodeId ?? null)
}

function walkMd(dir, out) {
  let entries
  try {
    entries = fs.readdirSync(dir)
  } catch {
    return
  }
  for (const name of entries) {
    const full = path.join(dir, name)
    if (name.startsWith('.') || name.endsWith('.assets')) continue
    if (isDir(full)) walkMd(full, out)
    else if (name.endsWith('.md')) out.push(full)
  }
}

function stripEmptySections(body) {
  const meaningful = text.lines(body).some((l) => {
    const t = text.trim(l)
    return t !== '' && !t.startsWith('#')
  })
  return meaningful ? text.trim(body) : ''
}

function splitList(value) {
  let start = 0
  let end = value.length
  while (start < end && (value[start] === '[' || value[start] === ']')) start++
  while (end > start && (value[end - 1] === '[' || value[end - 1] === ']')) end--
  return value
    .slice(start, end)
    .split(/[, ]/)
    .map(text.trim)
    .filter((s) => s !== '')
}

function newReport(source) {
  return { source, scanned: 0, created: 0, updated: 0, unchanged: 0, removed: 0, failed: 0 }
}

function count(report, action) {
  if (action === 'created') report.created++
  else if (action === 'updated' || action === 'merged') report.updated++
  else report.unchanged++
}

let spaces = null

function inkwellSpaces() {
  spaces ??= readInkwellSpaces(paths.inkwellDb()) ?? new Map()
  return spaces
}

function openReadOnly(file) {
  if (!isFile(file)) return null
  try {
    return new DatabaseSync(file, { readOnly: true })
  } catch {
    return null
  }
}

export function readInkwellSpaces(dbPath) {
  const db = openReadOnly(dbPath)
  if (db === null) return null
  try {
    const rows = db.prepare("SELECT name, external_ref FROM spaces WHERE external_ref LIKE 'bita:project:%'").all()
    const out = new Map()
    for (const row of rows) {
      if (typeof row.name !== 'string' || typeof row.external_ref !== 'string' || !row.external_ref.startsWith('bita:project:')) continue
      const id = parseI64(row.external_ref.slice('bita:project:'.length))
      if (id !== null) out.set(text.slugify(row.name), id)
    }
    return out
  } catch {
    return null
  } finally {
    db.close()
  }
}

function knownProject(store, slug) {
  if (slug === GLOBAL) return true
  try {
    return store.db.prepare('SELECT 1 AS found FROM projects WHERE slug = ?1 UNION ALL SELECT 1 FROM project_groups WHERE name = ?1 LIMIT 1').get(slug) !== undefined
  } catch {
    return false
  }
}

function startsWithTokens(target, tokens) {
  return tokens.length <= target.length && tokens.every((t, i) => target[i] === t)
}

function prefixProject(store, folder) {
  const target = project.nameTokens(folder)
  let rows
  try {
    rows = store.db.prepare('SELECT slug, COALESCE(name, slug) AS name FROM projects WHERE slug != ?1').all(GLOBAL)
  } catch {
    return null
  }
  const matches = []
  for (const { slug, name } of rows) {
    const tokens = project.nameTokens(name)
    const length = [...project.normalizeName(name)].length
    if (length >= 4 && tokens.length > 0 && startsWithTokens(target, tokens)) matches.push([length, slug])
  }
  if (matches.length === 0) return null
  const longest = Math.max(...matches.map(([length]) => length))
  const best = [...new Set(matches.filter(([length]) => length === longest).map(([, slug]) => slug))].sort(compareBytes)
  return best.length === 1 ? best[0] : null
}

export function folderProject(store, known, folder) {
  const id = known.get(folder)
  if (id !== undefined) {
    const slug = project.projectForBitaId(store, id)
    if (slug !== null) return slug
  }
  const named = project.projectForName(store, folder)
  if (knownProject(store, named)) return named
  return prefixProject(store, folder) ?? GLOBAL
}

function frontmatterProject(store, meta) {
  const id = parseI64(meta.get('projectId'))
  if (id !== null) {
    const slug = project.projectForBitaId(store, id)
    if (slug !== null) return slug
  }
  const name = meta.get('project')
  if (name === undefined) return null
  const slug = project.projectForName(store, name)
  return slug !== GLOBAL && knownProject(store, slug) ? slug : null
}

export function slashRel(root, p) {
  const stripped = stripPrefix(root, p)
  if (stripped !== null) return stripped.join('/')
  const { prefix, rooted, parts } = components(paths.simplify(p))
  return `${prefix}${rooted ? '/' : ''}${parts.join('/')}`
}

export async function inkwellNote(store, emb, root, p) {
  const rel = slashRel(root, p)
  const key = `inkwell:${rel}`
  const modified = mtime(p)
  const raw = paths.readUtf8Strict(p)
  const { meta, body } = text.frontmatter(raw)
  const folder = rel.split('/')[0]
  const fromFolder = folderProject(store, inkwellSpaces(), folder)
  const slug = fromFolder === GLOBAL ? frontmatterProject(store, meta) ?? fromFolder : fromFolder
  const title = meta.get('title') ?? fileStem(p)
  const attrs = []
  let kind
  let content
  const entry = meta.get('entryId')
  if (entry !== undefined) {
    attrs.push(['entry', entry])
    const header = [`Entrada de bita #${entry}`, meta.get('day'), meta.get('duration'), meta.get('repo'), meta.get('branch')]
      .filter((part) => part !== undefined)
      .join(' · ')
    const stripped = stripEmptySections(body)
    kind = 'entry'
    content = stripped === '' ? header : `${header}\n\n${stripped}`
  } else {
    const trimmed = text.trim(body)
    kind = 'doc'
    content = trimmed === '' ? title : trimmed
  }
  for (const name of ['issues', 'jira']) {
    const value = meta.get(name)
    if (value !== undefined) for (const issue of splitList(value)) attrs.push(['issue', issue])
  }
  const outcome = await store.remember(emb, { project: slug, kind, title, body: content, source: 'inkwell', sourceRef: key, attrs }, false)
  mark(store, key, modified, outcome.id)
  return { id: outcome.id, action: outcome.action }
}

export async function ingestInkwell(store, emb, root, progress, bita) {
  try {
    project.refreshProjectsWith(store, root, bita)
  } catch {}
  const report = newReport('inkwell')
  let stranded
  try {
    stranded = recoverMoving(store, root)
  } catch (error) {
    process.stderr.write(`inkwell: recover moving keys: ${errorChain(error)}\n`)
    stranded = 0
  }
  const files = []
  walkMd(root, files)
  files.sort(comparePaths)
  const present = new Set()
  for (const [index, file] of files.entries()) {
    const rel = slashRel(root, file)
    const key = `inkwell:${rel}`
    present.add(key)
    report.scanned++
    if (unchanged(store, key, mtime(file))) {
      report.unchanged++
      continue
    }
    try {
      const outcome = await inkwellNote(store, emb, root, file)
      if (outcome !== null) count(report, outcome.action)
    } catch (error) {
      report.failed++
      process.stderr.write(`inkwell ${rel}: ${errorChain(error)}\n`)
    }
    if (progress && (index + 1) % 100 === 0) process.stderr.write(`inkwell: ${index + 1}/${files.length}\n`)
  }
  report.removed = stranded + removeMissing(store, 'inkwell:', present)
  return report
}

function recoverMoving(store, root) {
  const staged = store.db.prepare("SELECT id, source_ref FROM nodes WHERE source_ref LIKE ?1 || '%'").all(MOVING)
  let forgotten = 0
  for (const { id, source_ref: staging } of staged) {
    let from = null
    if (staging.startsWith(MOVING)) {
      const rest = staging.slice(MOVING.length)
      const colon = rest.indexOf(':')
      if (colon !== -1) {
        const tail = rest.slice(colon + 1)
        if (tail.endsWith('#')) from = inkwellRel(tail.slice(0, -1))
      }
    }
    const restore = from !== null && isFile(path.join(root, from)) && store.bySourceRef(`inkwell:${from}`) === null ? from : null
    if (restore !== null) store.renameSourceRef(staging, `inkwell:${restore}`)
    else {
      store.forget(id)
      forgotten++
    }
  }
  store.db.prepare("DELETE FROM ingest_files WHERE path LIKE ?1 || '%'").run(MOVING)
  return forgotten
}

function removeMissing(store, prefix, present) {
  const refs = store.db.prepare("SELECT id, source_ref FROM nodes WHERE source_ref LIKE ?1 || '%'").all(prefix)
  let removed = 0
  for (const { id, source_ref: sourceRef } of refs) {
    if (present.has(sourceRef)) continue
    store.forget(id)
    store.db.prepare('DELETE FROM ingest_files WHERE path = ?1').run(sourceRef)
    removed++
  }
  return removed
}

function runJson(program, args) {
  const result = runSync(program, args, {})
  if (result.error) return null
  const value = lastJsonLine(result.stdout)
  return field(value, 'ok') === true ? value : null
}

function prefixBytes(s, n) {
  const bytes = Buffer.from(s, 'utf8')
  if (bytes.length < n) return null
  if (bytes.length > n && (bytes[n] & 0xc0) === 0x80) return null
  return bytes.subarray(0, n).toString('utf8')
}

export async function ingestRecap(store, emb) {
  const report = newReport('recap')
  const recap = process.env.GAZE_RECAP_BIN ?? 'recap'
  const list = runJson(recap, ['list', '--limit', '10000', '--json'])
  if (list === null) return report
  const meetings = field(list, 'data')
  for (const meeting of Array.isArray(meetings) ? meetings : []) {
    const id = str(field(meeting, 'id'))
    if (id === null) continue
    if (field(meeting, 'status') !== 'processed') continue
    report.scanned++
    const key = `recap:${id}`
    const summary = str(field(meeting, 'summary')) ?? str(field(field(runJson(recap, ['show', id, '--json']), 'data'), 'summary'))
    if (summary === null || !exists(summary)) continue
    const modified = mtime(summary)
    if (unchanged(store, key, modified)) {
      report.unchanged++
      continue
    }
    const raw = paths.readUtf8Strict(summary)
    const { body } = text.frontmatter(raw)
    const projectName = str(field(field(meeting, 'bitaEntry'), 'projectName')) ?? GLOBAL
    const attrs = []
    const entry = int(field(meeting, 'bitaEntryId'))
    if (entry !== null) attrs.push(['entry', String(entry)])
    const day = prefixBytes(str(field(meeting, 'startedAt')) ?? '', 10) ?? ''
    const title = `${str(field(meeting, 'title')) ?? id} (${day})`
    let outcome
    try {
      outcome = await store.remember(
        emb,
        { project: project.projectForName(store, projectName), kind: 'meeting', title, body, source: 'recap', sourceRef: key, attrs },
        false,
      )
    } catch (error) {
      report.failed++
      process.stderr.write(`recap ${id}: ${errorChain(error)}\n`)
      continue
    }
    mark(store, key, modified, outcome.id)
    count(report, outcome.action)
  }
  return report
}

export function touchedFiles(dbPath, entry) {
  const db = openReadOnly(dbPath)
  if (db === null) return []
  try {
    return db
      .prepare('SELECT path FROM entry_touches WHERE entry_id = ?1 ORDER BY first_seen_at, path LIMIT 40')
      .all(entry)
      .map((r) => r.path)
      .filter((p) => typeof p === 'string')
  } catch {
    return []
  } finally {
    db.close()
  }
}

export async function bitaEvent(store, emb, event, bita) {
  const name = str(field(event, 'event')) ?? ''
  const entry = field(event, 'entry')
  const id = int(field(entry, 'id'))
  if (id === null) return { skipped: 'no entry' }
  const key = `bita:entry:${id}`
  if (name === 'delete' || name === 'cancel') {
    const node = store.bySourceRef(key)
    if (node !== null) store.forget(node.id)
    return { event: name, entry: id, removed: node !== null }
  }
  if (!(name === 'stop' || name === 'amend') || field(entry, 'running') === true) return { event: name, entry: id, skipped: true }
  const pid = int(field(entry, 'projectId'))
  if (pid !== null && project.projectForBitaId(store, pid) === null) {
    try {
      project.refreshProjectsWith(store, '/', bita)
    } catch {}
  }
  const projectName = str(field(entry, 'projectName'))
  const slug = (pid === null ? null : project.projectForBitaId(store, pid)) ?? (projectName === null ? null : project.projectForName(store, projectName)) ?? GLOBAL
  const description = str(field(entry, 'description'))
  const title = description !== null && text.trim(description) !== '' ? description : 'Entrada sin título'
  const header = [`Entrada de bita #${id}`, str(field(entry, 'localDay')), str(field(entry, 'durationHuman')), str(field(entry, 'kind'))]
    .filter((part) => part !== null)
    .join(' · ')
  const lines = [header]
  const database = str(field(event, 'databasePath'))
  if (database !== null) {
    const files = touchedFiles(database, id)
    if (files.length > 0) lines.push(`Archivos tocados:\n${files.map((f) => `- ${f}`).join('\n')}`)
  }
  const outcome = await store.remember(
    emb,
    { project: slug, kind: 'entry', title, body: lines.join('\n\n'), source: 'bita', sourceRef: key, attrs: [['entry', String(id)]] },
    false,
  )
  let note = null
  const doc = str(field(event, 'docPath'))
  if (doc !== null) {
    const root = str(field(event, 'docsRoot')) ?? paths.inkwellDocs()
    const file = isAbsolute(doc) ? doc : path.join(root, doc)
    if (exists(file)) {
      try {
        note = await inkwellNote(store, emb, root, file)
      } catch {}
    }
  }
  return { event: name, entry: id, node: outcome, note }
}

export function inkwellRel(raw) {
  if (typeof raw !== 'string' || raw === '' || !raw.endsWith('.md')) return null
  const windows = isWindows()
  if (raw.startsWith('/') || (windows && (raw.startsWith('\\') || /^[A-Za-z]:/.test(raw)))) return null
  const parts = []
  for (const part of raw.split(windows ? /[\\/]/ : /\//)) {
    if (part === '' || part === '.') continue
    if (part === '..') return null
    if (part.startsWith('.') || part.endsWith('.assets')) return null
    parts.push(part)
  }
  return parts.join('/')
}

function forgetInkwell(store, rel) {
  const key = `inkwell:${rel}`
  store.db.prepare('DELETE FROM ingest_files WHERE path = ?1').run(key)
  const node = store.bySourceRef(key)
  if (node === null) return false
  store.forget(node.id)
  return true
}

class DocsBatch {
  constructor(store, emb, root, bita) {
    this.store = store
    this.emb = emb
    this.root = root
    this.bita = bita
    this.refreshed = false
  }

  refreshProjectsFor(rel) {
    if (this.refreshed) return
    const folder = rel.split('/')[0]
    if (folder !== '_no-project' && folderProject(this.store, inkwellSpaces(), folder) === GLOBAL) {
      this.refreshed = true
      try {
        project.refreshProjectsWith(this.store, '/', this.bita)
      } catch {}
    }
  }

  async write(rel) {
    const file = path.join(this.root, rel)
    if (!isFile(file)) return { result: forgetInkwell(this.store, rel) ? 'removed' : 'absent' }
    this.refreshProjectsFor(rel)
    const outcome = await inkwellNote(this.store, this.emb, this.root, file)
    return outcome === null ? { result: 'skipped' } : { result: outcome.action, id: outcome.id }
  }

  static moves(changes) {
    const out = []
    changes.forEach((change, index) => {
      if (field(change, 'action') !== 'moved') return
      const raw = str(field(change, 'relPath'))
      if (raw === null) return
      const from = inkwellRel(str(field(change, 'from')))
      if (from === null) return
      const to = inkwellRel(raw)
      if (to === from) return
      out.push([index, { staging: `${MOVING}${index}:${from}#`, from: `inkwell:${from}`, to: to === null ? null : `inkwell:${to}` }])
    })
    return out
  }

  applyMoves(changes) {
    const planned = DocsBatch.moves(changes)
    const out = new Map()
    try {
      const outcomes = this.store.moveSourceRefs(planned.map(([, step]) => step))
      planned.forEach(([index], i) => out.set(index, { ok: outcomes[i] ?? null }))
    } catch (error) {
      const message = errorChain(error)
      for (const [index] of planned) out.set(index, { error: new Error(message) })
    }
    return out
  }

  async change(change, moved) {
    const action = str(field(change, 'action')) ?? ''
    const raw = str(field(change, 'relPath'))
    if (raw === null) return { result: 'ignored' }
    const rel = inkwellRel(raw)
    const renamedOf = () => {
      if (moved === undefined) return null
      if (moved.error) throw moved.error
      return moved.ok ?? null
    }
    if (rel !== null && action === 'written') return this.write(rel)
    if (rel !== null && action === 'deleted') {
      if (isFile(path.join(this.root, rel))) return this.write(rel)
      return { result: forgetInkwell(this.store, rel) ? 'removed' : 'absent' }
    }
    if (action === 'moved' && rel !== null) {
      const renamed = renamedOf()
      const written = await this.write(rel)
      written.renamed = renamed !== null
      if (renamed !== null && renamed.displaced !== null && renamed.displaced !== undefined) written.displaced = renamed.displaced
      return written
    }
    if (action === 'moved') {
      const removed = renamedOf() !== null
      return { result: removed ? 'removed' : 'ignored', fromRemoved: removed }
    }
    return { result: 'ignored' }
  }
}

export async function inkwellEvent(store, emb, event, docs, bita) {
  const name = str(field(event, 'event')) ?? 'docs.changed'
  if (name !== 'docs.changed') return { event: name, skipped: true }
  const given = str(field(event, 'docsRoot'))
  const root = given !== null && isAbsolute(given) ? given : docs
  const rootMismatch = paths.canonical(root) !== paths.canonical(docs)
  const batch = new DocsBatch(store, emb, root, bita)
  let failed = 0
  const rawChanges = field(event, 'changes')
  const changes = Array.isArray(rawChanges) ? rawChanges : []
  const moved = batch.applyMoves(changes)
  const results = []
  for (const [index, change] of changes.entries()) {
    const summary = { action: field(change, 'action') ?? null, relPath: field(change, 'relPath') ?? null }
    const from = field(change, 'from')
    if (from !== undefined && from !== null) summary.from = from
    try {
      const fields = await batch.change(change, moved.get(index))
      Object.assign(summary, fields)
    } catch (error) {
      failed++
      summary.result = 'error'
      summary.error = errorChain(error)
    }
    results.push(summary)
  }
  return { event: name, docsRoot: root, rootMismatch, commit: field(event, 'commit') ?? null, failed, changes: results }
}
