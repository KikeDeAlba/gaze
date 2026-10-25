import { GLOBAL, KINDS, NOTE_KINDS, SOURCES, openDb, openMemory } from './db.js'
import { defaultConfig, loadConfig } from './config.js'
import { dbPath } from './paths.js'
import * as text from './text.js'
import { cosine, fromBlob, toBlob } from './vector.js'
import { GazeError, notFound, usage } from './envelope.js'

export { GLOBAL } from './db.js'

const RRF_K = 60
const ATTR_EDGE_LIMIT = 10
const NODE_COLUMNS = 'id, project, kind, title, body, source, source_ref, pinned, until, created_at, updated_at, hits'
const LEADING_WS = /^\p{White_Space}+/u
const DATE = /^\p{White_Space}*([+-]\d+|\d{1,4})-\p{White_Space}*(\d{1,2})-\p{White_Space}*(\d{1,2})$/u

const charCount = (s) => {
  let n = 0
  for (const _ of s) n++
  return n
}

const takeChars = (s, n) => [...s].slice(0, n).join('')

const probeFor = (term) => {
  const n = charCount(term)
  return n >= 6 ? takeChars(term, Math.max(5, Math.floor((n * 3) / 4))) : term
}

const compareIds = (a, b) => (a < b ? -1 : a > b ? 1 : 0)

function rowNode(r) {
  return {
    id: r.id,
    project: r.project,
    kind: r.kind,
    title: r.title,
    body: r.body,
    source: r.source,
    sourceRef: r.source_ref ?? null,
    pinned: Number(r.pinned) !== 0,
    until: r.until ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    hits: Number(r.hits),
  }
}

function canonicalPair(a, b) {
  return a <= b ? [a, b] : [b, a]
}

function fileStem(ref) {
  const segments = ref.split('/')
  const file = segments[segments.length - 1]
  return file.endsWith('.md') ? file.slice(0, -3) : null
}

export function contentHash(parts) {
  let h = 0xcbf29ce484222325n
  for (const part of parts) {
    for (const b of [...Buffer.from(part, 'utf8'), 0]) {
      h ^= BigInt(b)
      h = (h * 0x100000001b3n) & 0xffffffffffffffffn
    }
  }
  return h.toString(16).padStart(16, '0')
}

export function validateKind(kind) {
  if (!KINDS.includes(kind)) throw usage(`Tipo inválido: ${kind}. Usa uno de: ${KINDS.join(', ')}`)
}

function validDate(value) {
  const m = DATE.exec(value)
  if (!m) return false
  const year = Number(m[1])
  const month = Number(m[2])
  const day = Number(m[3])
  if (!Number.isSafeInteger(year) || year < -262143 || year > 262142) return false
  if (month < 1 || month > 12 || day < 1) return false
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]
  return day <= days
}

export function validateUntil(until) {
  if (until !== undefined && until !== null && !validDate(until)) throw usage(`Fecha inválida: ${until}. Usa AAAA-MM-DD`)
}

export function ftsQuery(query) {
  const terms = text.terms(query)
  if (terms.length === 0) return null
  return terms.map((t) => (charCount(t) >= 6 ? `"${probeFor(t)}"*` : `"${t}"`)).join(' OR ')
}

export function coverage(terms, haystack) {
  if (terms.length === 0) return 0
  const folded = text.fold(haystack)
  const found = terms.filter((t) => folded.includes(probeFor(t))).length
  return Math.fround(found / terms.length)
}

export async function embedOrLog(emb, chunks) {
  try {
    return await emb.embed(chunks, 'passage')
  } catch (error) {
    process.stderr.write(`${text.nowIso()} gaze: embedding failed, saving without vectors (gaze reindex fixes it): ${describeError(error)}\n`)
    return null
  }
}

function describeError(error) {
  const parts = []
  let current = error
  const seen = new Set()
  while (current !== undefined && current !== null && !seen.has(current)) {
    seen.add(current)
    parts.push(current instanceof Error ? current.message : String(current))
    current = current instanceof Error ? current.cause : undefined
  }
  return parts.join(': ')
}

export function hitJson(hit, explain = false) {
  const out = { id: hit.id, title: hit.title, kind: hit.kind, project: hit.project, snippet: hit.snippet, score: hit.score }
  if (explain) {
    out.similarity = hit.similarity
    out.coverage = hit.coverage
  }
  return out
}

export function ensureFound(found, what) {
  if (!found) throw new GazeError('NOT_FOUND', `No existe: ${what}`)
}

export class Store {
  constructor(db, cfg) {
    this.db = db
    this.cfg = cfg
  }

  static openDefault() {
    return new Store(openDb(dbPath()), loadConfig())
  }

  static inMemory() {
    return new Store(openMemory(), defaultConfig())
  }

  close() {
    if (this.db.isOpen) this.db.close()
  }

  tx(fn) {
    this.db.exec('BEGIN IMMEDIATE')
    let value
    try {
      value = fn()
    } catch (error) {
      try {
        this.db.exec('ROLLBACK')
      } catch {}
      throw error
    }
    this.db.exec('COMMIT')
    return value
  }

  run(sql, ...params) {
    return this.db.prepare(sql).run(...params)
  }

  one(sql, ...params) {
    return this.db.prepare(sql).get(...params)
  }

  all(sql, ...params) {
    return this.db.prepare(sql).all(...params)
  }

  get(id) {
    const exact = this.one(`SELECT ${NODE_COLUMNS} FROM nodes WHERE id = ?`, id)
    if (exact) return rowNode(exact)
    if (Buffer.byteLength(id, 'utf8') < 4) return null
    const found = this.all(`SELECT ${NODE_COLUMNS} FROM nodes WHERE id LIKE ? || '%' LIMIT 2`, id)
    return found.length === 1 ? rowNode(found[0]) : null
  }

  require(id) {
    const node = this.get(id)
    if (!node) throw notFound(id)
    return node
  }

  bySourceRef(sourceRef) {
    const row = this.one(`SELECT ${NODE_COLUMNS} FROM nodes WHERE source_ref = ?`, sourceRef)
    return row ? rowNode(row) : null
  }

  async remember(emb, input, dedupe) {
    const until = input.until ?? null
    const pinnedInput = Boolean(input.pinned)
    const attrs = input.attrs ?? []
    const sourceRef = input.sourceRef ?? null
    validateKind(input.kind)
    validateUntil(until)
    if (!SOURCES.includes(input.source)) throw usage(`Fuente inválida: ${input.source}`)
    const body = text.trim(input.body ?? '')
    if (body === '') throw usage('La nota está vacía')
    const project = text.trim(input.project ?? '') === '' ? GLOBAL : text.trim(input.project)
    const trimmedTitle = input.title === undefined || input.title === null ? '' : text.trim(input.title)
    const explicitTitle = trimmedTitle === '' ? null : trimmedTitle
    const title = explicitTitle ?? text.deriveTitle(body)
    const hash = contentHash([project, input.kind, title, body, pinnedInput ? '1' : '0', until ?? ''])

    if (sourceRef !== null) {
      const existing = this.bySourceRef(sourceRef)
      if (existing) {
        const old = this.one('SELECT content_hash FROM nodes WHERE id = ?', existing.id)
        if ((old?.content_hash ?? null) === hash) return { id: existing.id, action: 'unchanged', title, project, kind: input.kind }
        const chunks = text.chunk(title, body)
        const vectors = await embedOrLog(emb, chunks)
        const id = existing.id
        this.tx(() => {
          this.run(
            'UPDATE nodes SET project=?2, kind=?3, title=?4, body=?5, pinned=?6, until=?7, updated_at=?8, content_hash=?9 WHERE id=?1',
            id, project, input.kind, title, body, pinnedInput ? 1 : 0, until, text.nowIso(), hash,
          )
          this.writeContent(id, project, title, body, chunks, vectors)
          this.afterWrite(id, project, title, body, attrs, vectors?.[0] ?? null)
        })
        return { id, action: 'updated', title, project, kind: input.kind }
      }
    }

    const chunks = text.chunk(title, body)
    const vectors = await embedOrLog(emb, chunks)
    const head = vectors?.[0]

    if (dedupe && NOTE_KINDS.includes(input.kind) && head) {
      const nearest = this.nearestNote(project, head, null)
      if (nearest && nearest[1] >= this.cfg.search.dedupe_threshold) {
        const [existingId, similarity] = nearest
        const existing = this.require(existingId)
        let mergedBody
        if (similarity >= this.cfg.search.replace_threshold || text.fold(body).includes(text.fold(existing.body))) mergedBody = body
        else if (text.fold(existing.body).includes(text.fold(body))) mergedBody = existing.body
        else mergedBody = `${body}\n\n${existing.body}`
        const mergedTitle = explicitTitle ?? existing.title
        const pinned = existing.pinned || pinnedInput
        const mergedUntil = until ?? existing.until
        const mergedChunks = text.chunk(mergedTitle, mergedBody)
        const mergedVectors = mergedTitle === title ? vectors : await embedOrLog(emb, mergedChunks)
        const mergedHash = contentHash([project, existing.kind, mergedTitle, mergedBody, pinned ? '1' : '0', mergedUntil ?? ''])
        this.tx(() => {
          this.run(
            'UPDATE nodes SET title=?2, body=?3, pinned=?4, until=?5, updated_at=?6, content_hash=?7 WHERE id=?1',
            existingId, mergedTitle, mergedBody, pinned ? 1 : 0, mergedUntil, text.nowIso(), mergedHash,
          )
          this.writeContent(existingId, project, mergedTitle, mergedBody, mergedChunks, mergedVectors)
          this.afterWrite(existingId, project, mergedTitle, mergedBody, attrs, mergedVectors?.[0] ?? null)
        })
        return { id: existingId, action: 'merged', title: mergedTitle, project, kind: existing.kind }
      }
    }

    const id = this.freshId()
    const now = text.nowIso()
    this.tx(() => {
      this.run(
        `INSERT INTO nodes (id, project, kind, title, body, source, source_ref, pinned, until, created_at, updated_at, hits, content_hash)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10, 0, ?11)`,
        id, project, input.kind, title, body, input.source, sourceRef, pinnedInput ? 1 : 0, until, now, hash,
      )
      this.writeContent(id, project, title, body, chunks, vectors)
      this.afterWrite(id, project, title, body, attrs, vectors?.[0] ?? null)
    })
    return { id, action: 'created', title, project, kind: input.kind }
  }

  freshId() {
    for (;;) {
      const id = text.shortId()
      if (!this.one('SELECT 1 AS taken FROM nodes WHERE id = ?', id)) return id
    }
  }

  deleteContent(id) {
    this.run('DELETE FROM chunk_vectors WHERE chunk_id IN (SELECT id FROM chunks WHERE node_id = ?1)', id)
    this.run('DELETE FROM chunks WHERE node_id = ?1', id)
    this.run('DELETE FROM fts_nodes WHERE node_id = ?1', id)
  }

  writeContent(id, project, title, body, chunks, vectors) {
    this.deleteContent(id)
    this.run('INSERT INTO fts_nodes (node_id, project, title, body) VALUES (?1, ?2, ?3, ?4)', id, project, title, body)
    const insertChunk = this.db.prepare('INSERT INTO chunks (node_id, ord, text) VALUES (?1, ?2, ?3)')
    const insertVector = this.db.prepare('INSERT INTO chunk_vectors (chunk_id, project, embedding) VALUES (?1, ?2, ?3)')
    chunks.forEach((chunk, ord) => {
      const { lastInsertRowid } = insertChunk.run(id, ord, chunk)
      const vector = vectors?.[ord]
      if (vector) insertVector.run(lastInsertRowid, project, toBlob(vector))
    })
    this.run('UPDATE nodes SET embedded = ?2 WHERE id = ?1', id, vectors ? 1 : 0)
  }

  afterWrite(id, project, title, body, attrs, head) {
    for (const target of text.wikilinks(body)) {
      const dst = this.resolveTitle(project, target)
      if (dst === null) this.run('INSERT OR IGNORE INTO pending_links (src, title) VALUES (?1, ?2)', id, text.fold(target))
      else if (dst !== id) this.addEdge(id, dst, 'link', 1, false)
    }
    const sourceRef = this.one('SELECT source_ref FROM nodes WHERE id = ?1', id)?.source_ref ?? null
    const names = [text.fold(title)]
    const stem = sourceRef === null ? null : fileStem(sourceRef)
    if (stem !== null) names.push(text.fold(stem))
    for (const name of names) this.claimPending(id, name)

    this.run('DELETE FROM attrs WHERE node_id = ?1', id)
    const allAttrs = [...attrs]
    for (const key of text.issueKeys(`${title}\n${body}`)) allAttrs.push(['issue', key])
    const seen = new Set()
    for (const [key, value] of allAttrs) {
      const marker = JSON.stringify([key, value])
      if (seen.has(marker)) continue
      seen.add(marker)
      this.run('INSERT OR IGNORE INTO attrs (node_id, key, value) VALUES (?1, ?2, ?3)', id, key, value)
      const edgeKind = key === 'issue' ? 'same-issue' : key === 'entry' ? 'same-entry' : null
      if (edgeKind === null) continue
      const others = this.all(
        'SELECT a.node_id FROM attrs a JOIN nodes n ON n.id = a.node_id WHERE a.key = ?1 AND a.value = ?2 AND a.node_id != ?3 ORDER BY n.updated_at DESC LIMIT ?4',
        key, value, id, ATTR_EDGE_LIMIT,
      )
      for (const other of others) this.addEdge(id, other.node_id, edgeKind, 1, true)
    }

    if (head) this.refreshSimilar(id, project, head)
  }

  claimPending(id, name) {
    const waiting = this.all('SELECT src FROM pending_links WHERE title = ?1 AND src != ?2', name, id)
    for (const { src } of waiting) this.addEdge(src, id, 'link', 1, false)
    this.run('DELETE FROM pending_links WHERE title = ?1 AND src != ?2', name, id)
  }

  addEdge(src, dst, kind, weight, undirected) {
    const [a, b] = undirected ? canonicalPair(src, dst) : [src, dst]
    this.run(
      'INSERT INTO edges (src, dst, kind, weight) VALUES (?1, ?2, ?3, ?4) ON CONFLICT(src, dst, kind) DO UPDATE SET weight = excluded.weight',
      a, b, kind, weight,
    )
  }

  resolveTitle(project, title) {
    const trimmed = text.trim(title)
    const folded = text.fold(trimmed)
    const candidates = this.all(
      "SELECT id, project, title FROM nodes WHERE lower(title) = lower(?1) OR title = ?1 OR source_ref LIKE '%' || ?2",
      trimmed, `/${trimmed}.md`,
    )
    const matches = candidates.filter((c) => text.fold(c.title) === folded)
    const pick = (p) => matches.find((c) => c.project === p)?.id ?? null
    return pick(project) ?? pick(GLOBAL) ?? candidates.find((c) => c.project === project || c.project === GLOBAL)?.id ?? null
  }

  knn(vector, project, k) {
    const rows = this.all(
      'SELECT cv.chunk_id, cv.embedding, c.node_id, c.ord, c.text FROM chunk_vectors cv JOIN chunks c ON c.id = cv.chunk_id WHERE (?1 IS NULL OR cv.project = ?1)',
      project ?? null,
    )
    const scored = rows.map((r) => ({ chunkId: Number(r.chunk_id), nodeId: r.node_id, ord: Number(r.ord), text: r.text, similarity: Math.fround(cosine(vector, fromBlob(r.embedding))) }))
    scored.sort((a, b) => b.similarity - a.similarity || a.chunkId - b.chunkId)
    return scored.slice(0, k).map((r) => [r.nodeId, r.ord, r.similarity, r.text])
  }

  nearestNote(project, head, exclude) {
    for (const [nodeId, , similarity] of this.knn(head, project, 20)) {
      if (nodeId === exclude) continue
      const row = this.one('SELECT kind, source_ref FROM nodes WHERE id = ?1', nodeId)
      if (NOTE_KINDS.includes(row.kind) && (row.source_ref ?? null) === null) return [nodeId, similarity]
    }
    return null
  }

  refreshSimilar(id, project, head) {
    this.run("DELETE FROM edges WHERE kind = 'similar' AND (src = ?1 OR dst = ?1)", id)
    const best = new Map()
    for (const [nodeId, , similarity] of this.knn(head, project, 40)) {
      if (nodeId === id || similarity < this.cfg.search.similar_threshold) continue
      if (!best.has(nodeId) || similarity > best.get(nodeId)) best.set(nodeId, similarity)
    }
    const ranked = [...best].sort((a, b) => b[1] - a[1] || compareIds(a[0], b[0]))
    for (const [other, similarity] of ranked.slice(0, this.cfg.search.similar_neighbors)) {
      this.addEdge(id, other, 'similar', Math.round(similarity * 1000) / 1000, true)
    }
  }

  async reindex(emb, all) {
    const ids = this.all(all ? 'SELECT id FROM nodes' : 'SELECT id FROM nodes WHERE embedded = 0').map((r) => r.id)
    let done = 0
    for (const id of ids) {
      const node = this.require(id)
      const chunks = text.chunk(node.title, node.body)
      const vectors = await emb.embed(chunks, 'passage')
      this.tx(() => {
        this.writeContent(id, node.project, node.title, node.body, chunks, vectors)
        this.refreshSimilar(id, node.project, vectors[0])
      })
      done++
    }
    return done
  }

  forget(id) {
    const node = this.require(id)
    this.tx(() => this.deleteNode(node.id))
    return node
  }

  deleteNode(id) {
    this.deleteContent(id)
    this.run('DELETE FROM edges WHERE src = ?1 OR dst = ?1', id)
    this.run('DELETE FROM attrs WHERE node_id = ?1', id)
    this.run('DELETE FROM pending_links WHERE src = ?1', id)
    this.run('DELETE FROM injections WHERE node_id = ?1', id)
    this.run('DELETE FROM ingest_files WHERE node_id = ?1', id)
    this.run('DELETE FROM nodes WHERE id = ?1', id)
  }

  renameSourceRef(from, to) {
    return this.tx(() => this.renameSourceRefInner(from, to))
  }

  moveSourceRefs(moves) {
    return this.tx(() => {
      const staged = moves.map((step) => this.renameSourceRefInner(step.from, step.staging) !== null)
      return moves.map((step, i) => {
        if (!staged[i]) return null
        if (step.to !== undefined && step.to !== null) return this.renameSourceRefInner(step.staging, step.to)
        const { id } = this.one('SELECT id FROM nodes WHERE source_ref = ?1', step.staging)
        this.deleteNode(id)
        this.run('DELETE FROM ingest_files WHERE path = ?1', step.staging)
        return { id, displaced: null }
      })
    })
  }

  renameSourceRefInner(from, to) {
    const node = this.bySourceRef(from)
    if (!node) {
      this.run('DELETE FROM ingest_files WHERE path = ?1', from)
      return null
    }
    if (from === to) return { id: node.id, displaced: null }
    const other = this.bySourceRef(to)?.id ?? null
    const displaced = other !== null && other !== node.id ? other : null
    if (displaced !== null) {
      this.run("UPDATE OR IGNORE edges SET dst = ?1 WHERE dst = ?2 AND kind = 'link' AND src != ?1", node.id, displaced)
      this.deleteNode(displaced)
    }
    this.run('DELETE FROM ingest_files WHERE path = ?1', to)
    this.run('UPDATE nodes SET source_ref = ?2, updated_at = ?3 WHERE id = ?1', node.id, to, text.nowIso())
    this.run('UPDATE ingest_files SET path = ?2 WHERE path = ?1', from, to)
    const stem = fileStem(to)
    if (stem !== null) this.claimPending(node.id, text.fold(stem))
    return { id: node.id, displaced }
  }

  link(a, b) {
    const first = this.require(a)
    const second = this.require(b)
    if (first.id === second.id) throw usage('No se puede enlazar una nota consigo misma')
    this.addEdge(first.id, second.id, 'link', 1, false)
    return [first, second]
  }

  neighbors(id) {
    return this.all(
      `SELECT n.id, n.title, n.kind, e.kind AS edge_kind, e.weight FROM edges e JOIN nodes n ON n.id = CASE WHEN e.src = ?1 THEN e.dst ELSE e.src END
       WHERE e.src = ?1 OR e.dst = ?1 ORDER BY CASE e.kind WHEN 'link' THEN 0 WHEN 'same-entry' THEN 1 WHEN 'same-issue' THEN 2 ELSE 3 END, e.weight DESC LIMIT 50`,
      id,
    ).map((r) => ({ id: r.id, title: r.title, kind: r.kind, edgeKind: r.edge_kind }))
  }

  show(id) {
    const node = this.require(id)
    this.run('UPDATE nodes SET hits = hits + 1 WHERE id = ?1', node.id)
    return { node, neighbors: this.neighbors(node.id) }
  }

  bumpHits(ids) {
    const stmt = this.db.prepare('UPDATE nodes SET hits = hits + 1 WHERE id = ?1')
    for (const id of ids) stmt.run(id)
  }

  scopeProjects(project) {
    if (project === GLOBAL) return [GLOBAL]
    const related = this.all(
      `SELECT name FROM project_groups WHERE project = ?1
       UNION SELECT g.project FROM project_groups g JOIN project_groups m ON m.name = g.name WHERE m.project = ?1`,
      project,
    ).map((r) => r.name)
    const projects = [project, GLOBAL]
    for (const name of related) if (!projects.includes(name)) projects.push(name)
    return projects
  }

  projectsFor(scope) {
    return scope.kind === 'all' ? [null] : this.scopeProjects(scope.project)
  }

  groups() {
    const groups = []
    for (const { name, project } of this.all('SELECT name, project FROM project_groups ORDER BY name, project')) {
      const last = groups[groups.length - 1]
      if (last && last[0] === name) last[1].push(project)
      else groups.push([name, [project]])
    }
    return groups
  }

  setGroup(name, projects) {
    this.tx(() => {
      this.run('DELETE FROM project_groups WHERE name = ?1', name)
      for (const project of projects) this.run('INSERT OR IGNORE INTO project_groups (name, project) VALUES (?1, ?2)', name, project)
    })
  }

  removeGroup(name) {
    return Number(this.run('DELETE FROM project_groups WHERE name = ?1', name).changes) > 0
  }

  async moveNode(emb, id, project) {
    const node = this.require(id)
    const chunks = text.chunk(node.title, node.body)
    const vectors = await emb.embed(chunks, 'passage')
    this.tx(() => {
      this.run('UPDATE nodes SET project = ?2 WHERE id = ?1', node.id, project)
      this.run("DELETE FROM edges WHERE kind = 'similar' AND (src = ?1 OR dst = ?1)", node.id)
      this.writeContent(node.id, project, node.title, node.body, chunks, vectors)
      this.refreshSimilar(node.id, project, vectors[0])
    })
    return this.require(node.id)
  }

  async search(emb, query, scope, options = {}) {
    const limit = Math.max(options.limit ?? 0, 1)
    const pool = Math.max(limit * 8, 40)
    const terms = text.terms(query)
    const today = text.today()
    const excludeKinds = options.excludeKinds ?? []

    let lexical = []
    const expr = ftsQuery(query)
    if (expr !== null) {
      lexical = scope.kind === 'all'
        ? this.all('SELECT node_id FROM fts_nodes WHERE fts_nodes MATCH ?1 ORDER BY bm25(fts_nodes, 0, 0, 3.0, 1.0) LIMIT ?2', expr, pool)
        : this.all(
          'SELECT node_id FROM fts_nodes WHERE fts_nodes MATCH ?1 AND project IN (SELECT value FROM json_each(?3)) ORDER BY bm25(fts_nodes, 0, 0, 3.0, 1.0) LIMIT ?2',
          expr, pool, JSON.stringify(this.scopeProjects(scope.project)),
        )
      lexical = lexical.map((r) => r.node_id)
    }

    let semantic = []
    if (emb) {
      let vector
      try {
        vector = (await emb.embed([query], 'query'))[0]
      } catch {
        vector = undefined
      }
      if (vector) {
        const best = new Map()
        for (const project of this.projectsFor(scope)) {
          for (const [nodeId, , similarity, chunk] of this.knn(vector, project, pool)) {
            const slot = best.get(nodeId)
            if (!slot || similarity > slot[0]) best.set(nodeId, [similarity, chunk])
          }
        }
        semantic = [...best].map(([id, [similarity, chunk]]) => [id, similarity, chunk])
        semantic.sort((a, b) => b[1] - a[1] || compareIds(a[0], b[0]))
      }
    }

    const scores = new Map()
    lexical.forEach((id, rank) => scores.set(id, (scores.get(id) ?? 0) + 1 / (RRF_K + rank + 1)))
    const sims = new Map()
    semantic.forEach(([id, similarity, chunk], rank) => {
      scores.set(id, (scores.get(id) ?? 0) + 1 / (RRF_K + rank + 1))
      sims.set(id, [similarity, chunk])
    })
    const ranked = [...scores].sort((a, b) => b[1] - a[1] || compareIds(a[0], b[0]))

    const hits = []
    for (const [id, score] of ranked) {
      const node = this.get(id)
      if (!node) continue
      if (options.kind !== undefined && options.kind !== null && node.kind !== options.kind) continue
      if (excludeKinds.includes(node.kind)) continue
      if (node.until !== null && node.until < today) continue
      const sim = sims.get(id)
      const similarity = sim ? sim[0] : null
      const sourceText = sim ? sim[1] : node.body
      const trimmedTitle = text.trim(node.title)
      const foldedTitle = text.fold(trimmedTitle)
      const stripped = sourceText.startsWith(trimmedTitle) ? sourceText.slice(trimmedTitle.length).replace(LEADING_WS, '') : sourceText
      const all = text.lines(stripped)
      let start = 0
      while (start < all.length) {
        const line = text.stripMarkdownLine(all[start])
        if (line !== '' && text.fold(line) !== foldedTitle) break
        start++
      }
      const snippetText = all.slice(start).join('\n')
      hits.push({
        id: node.id,
        title: node.title,
        kind: node.kind,
        project: node.project,
        snippet: text.snippet(snippetText, terms, 200),
        score: Math.round(score * 10000) / 10000,
        similarity,
        coverage: coverage(terms, `${node.title} ${node.body}`),
        titleCoverage: coverage(terms, node.title),
        body: node.body,
      })
      if (hits.length >= limit) break
    }
    return hits
  }

  activeRules(project) {
    return this.all(
      `SELECT ${NODE_COLUMNS} FROM nodes WHERE kind = 'rule' AND project IN (SELECT value FROM json_each(?3)) AND (until IS NULL OR until >= ?2)
       ORDER BY pinned DESC, (project = ?1) DESC, (project = 'global') ASC, updated_at DESC`,
      project, text.today(), JSON.stringify(this.scopeProjects(project)),
    ).map(rowNode)
  }

  rules(project, includeExpired) {
    const today = text.today()
    const rows = this.all(`SELECT ${NODE_COLUMNS} FROM nodes WHERE kind = 'rule' ORDER BY project, pinned DESC, updated_at DESC`).map(rowNode)
    const scope = project === undefined || project === null ? null : this.scopeProjects(project)
    return rows
      .filter((n) => scope === null || scope.includes(n.project))
      .filter((n) => includeExpired || n.until === null || n.until >= today)
  }

  graph(project) {
    const nodes = this.all(
      'SELECT id, project, kind, title, pinned, updated_at FROM nodes WHERE (?1 IS NULL OR project = ?1) ORDER BY updated_at DESC',
      project ?? null,
    )
    const ids = new Set(nodes.map((n) => n.id))
    const edges = this.all('SELECT src, dst, kind, weight FROM edges ORDER BY src, dst, kind').filter((e) => ids.has(e.src) && ids.has(e.dst))
    const degree = new Map()
    for (const e of edges) {
      degree.set(e.src, (degree.get(e.src) ?? 0) + 1)
      degree.set(e.dst, (degree.get(e.dst) ?? 0) + 1)
    }
    return {
      nodes: nodes.map((n) => ({
        id: n.id,
        project: n.project,
        kind: n.kind,
        title: n.title,
        degree: degree.get(n.id) ?? 0,
        pinned: Number(n.pinned) !== 0,
        updatedAt: n.updated_at,
      })),
      edges: edges.map((e) => ({ src: e.src, dst: e.dst, kind: e.kind, weight: Number(e.weight) })),
    }
  }

  injected(sessionId) {
    return new Set(this.all('SELECT node_id FROM injections WHERE session_id = ?1', sessionId).map((r) => r.node_id))
  }

  recordInjection(sessionId, hook, ids, tokens, ms) {
    const now = text.nowIso()
    const insert = this.db.prepare('INSERT OR IGNORE INTO injections (session_id, node_id, at) VALUES (?1, ?2, ?3)')
    for (const id of ids) insert.run(sessionId, id, now)
    this.run(
      'INSERT INTO stats (session_id, hook, tokens, nodes, ms, at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)',
      sessionId, hook, Math.trunc(Number(tokens)), ids.length, Math.trunc(Number(ms)), now,
    )
    this.bumpHits(ids)
  }

  stats() {
    const count = (sql) => Number(Object.values(this.one(sql))[0])
    const byKind = {}
    for (const r of this.all('SELECT kind, COUNT(*) AS n FROM nodes GROUP BY kind ORDER BY kind')) byKind[r.kind] = Number(r.n)
    const byProject = {}
    for (const r of this.all('SELECT project, COUNT(*) AS n FROM nodes GROUP BY project ORDER BY COUNT(*) DESC')) byProject[r.project] = Number(r.n)
    const hooks = {}
    const rows = this.all(
      'SELECT hook, COUNT(*) AS runs, COALESCE(SUM(tokens),0) AS total, COALESCE(AVG(tokens),0) AS avg, COALESCE(MAX(tokens),0) AS max, COALESCE(AVG(ms),0) AS ms, COUNT(DISTINCT session_id) AS sessions FROM stats GROUP BY hook',
    )
    for (const r of rows) {
      hooks[r.hook] = {
        runs: Number(r.runs),
        sessions: Number(r.sessions),
        tokens: Number(r.total),
        avgTokens: Math.round(Number(r.avg)),
        maxTokens: Number(r.max),
        avgMs: Math.round(Number(r.ms)),
      }
    }
    const sessions = count('SELECT COUNT(DISTINCT session_id) FROM stats')
    const injected = count('SELECT COALESCE(SUM(tokens),0) FROM stats')
    return {
      nodes: count('SELECT COUNT(*) FROM nodes'),
      edges: count('SELECT COUNT(*) FROM edges'),
      chunks: count('SELECT COUNT(*) FROM chunks'),
      unembedded: count('SELECT COUNT(*) FROM nodes WHERE embedded = 0'),
      byKind,
      byProject,
      injection: {
        sessions,
        tokens: injected,
        avgTokensPerSession: sessions > 0 ? Math.round(injected / sessions) : 0,
        hooks,
      },
    }
  }

  knownProject(slug) {
    const inNodes = this.one('SELECT EXISTS(SELECT 1 FROM nodes WHERE project = ?1) AS found', slug).found
    const inProjects = this.one('SELECT EXISTS(SELECT 1 FROM projects WHERE slug = ?1) AS found', slug).found
    return Number(inNodes) !== 0 || Number(inProjects) !== 0 || slug === GLOBAL
  }
}
