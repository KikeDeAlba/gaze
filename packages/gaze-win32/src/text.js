import crypto from 'node:crypto'

export const CHUNK_TOKENS = 400

export const ISSUE_DENYLIST = ['UTF', 'SHA', 'AES', 'ISO', 'RFC', 'HTTP', 'TLS', 'ES', 'X', 'MD', 'P', 'T', 'GPT', 'CVE']

export const STOPWORDS = [
  'a', 'al', 'algo', 'ante', 'como', 'con', 'cual', 'cuando', 'de', 'del', 'desde', 'donde', 'el', 'ella', 'en', 'entre', 'es', 'esa', 'ese', 'eso', 'esta',
  'este', 'esto', 'estos', 'fue', 'ha', 'hay', 'la', 'las', 'le', 'lo', 'los', 'mas', 'me', 'mi', 'muy', 'no', 'nos', 'o', 'otra', 'otro', 'para', 'pero',
  'por', 'que', 'se', 'si', 'sin', 'sobre', 'su', 'sus', 'tambien', 'te', 'tu', 'un', 'una', 'uno', 'y', 'ya', 'yo', 'puedes', 'hacer', 'haz', 'dame',
  'quiero', 'the', 'and', 'for', 'with', 'this', 'that', 'from', 'into', 'what', 'how', 'why', 'is', 'are', 'was', 'be', 'to', 'of', 'in', 'on', 'it', 'an',
  'or', 'as', 'at', 'by', 'we', 'you', 'can', 'do', 'please',
]

const STOPWORD_SET = new Set(STOPWORDS)
const WIKILINK = /\[\[([^\[\]|#]+)(?:#[^\[\]|]*)?(?:\|[^\[\]]*)?\]\]/g
const WORD_CHAR = '[\\p{Alphabetic}\\p{M}\\p{Nd}\\p{Pc}\\p{Join_Control}]'
const ISSUE = new RegExp(`(?<!${WORD_CHAR})([A-Z][A-Z0-9]+-\\p{Nd}+)(?!${WORD_CHAR})`, 'gu')
const WORD = /[\p{L}\p{N}_]+/gu
const WHITESPACE_RUN = /\p{White_Space}+/u
const LEADING_WS = /^\p{White_Space}+/u
const TRAILING_WS = /\p{White_Space}+$/u
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

const chars = (s) => [...s]
const charCount = (s) => {
  let n = 0
  for (const _ of s) n++
  return n
}

export function trim(s) {
  return s.replace(LEADING_WS, '').replace(TRAILING_WS, '')
}

function trimStartChars(s, set) {
  let i = 0
  while (i < s.length && set.includes(s[i])) i++
  return s.slice(i)
}

function trimMatches(s, c) {
  let start = 0
  let end = s.length
  while (start < end && s[start] === c) start++
  while (end > start && s[end - 1] === c) end--
  return s.slice(start, end)
}

export function lines(s) {
  if (s === '') return []
  const parts = s.split('\n')
  if (parts[parts.length - 1] === '') parts.pop()
  return parts.map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line))
}

export function estimateTokens(s) {
  return Math.ceil((charCount(s) * 2) / 7)
}

export function fold(s) {
  return s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
}

export function slugify(value) {
  let out = ''
  let dash = false
  for (const c of fold(value)) {
    if (/^[a-z0-9A-Z]$/.test(c)) {
      out += c
      dash = false
    } else if (!dash && out !== '') {
      out += '-'
      dash = true
    }
  }
  while (out.endsWith('-')) out = out.slice(0, -1)
  return out
}

export function wikilinks(body) {
  const seen = new Set()
  const out = []
  for (const match of body.matchAll(WIKILINK)) {
    const title = trim(match[1])
    if (title === '') continue
    const key = title.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(title)
  }
  return out
}

function compareBytes(a, b) {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'))
}

export function issueKeys(text) {
  const keys = new Set()
  for (const match of text.matchAll(ISSUE)) {
    const key = match[1]
    if (!ISSUE_DENYLIST.includes(key.split('-')[0])) keys.add(key)
  }
  return [...keys].sort(compareBytes)
}

export function terms(text) {
  const seen = new Set()
  const out = []
  for (const [word] of fold(text).matchAll(WORD)) {
    if (charCount(word) < 3 || STOPWORD_SET.has(word) || seen.has(word)) continue
    seen.add(word)
    out.push(word)
  }
  return out
}

export function oneLine(text) {
  return text.split(WHITESPACE_RUN).filter((part) => part !== '').join(' ')
}

export function truncate(text, max) {
  const all = chars(text)
  if (all.length <= max) return text
  let out = all.slice(0, Math.max(max - 1, 0)).join('')
  const space = out.lastIndexOf(' ')
  if (space !== -1 && Buffer.byteLength(out.slice(0, space), 'utf8') > Math.floor(max / 2)) out = out.slice(0, space)
  return `${out}…`
}

export function stripMarkdownLine(line) {
  const cut = trimStartChars(trimStartChars(trim(line), ['#']), ['-', '*', '>'])
  return trim(cut).replaceAll('**', '').replaceAll('`', '')
}

export function deriveTitle(body) {
  const line = lines(body).map(stripMarkdownLine).find((l) => l !== '') ?? ''
  const sentence = line.split('. ')[0]
  return truncate(sentence, 80)
}

export function firstLineSummary(body, title, max) {
  const foldedTitle = fold(title)
  const usable = (raw) => {
    const t = trim(raw)
    return t !== '' && !t.startsWith('#') && !t.startsWith('|') && !t.startsWith('---') && !t.startsWith('```')
  }
  const line = lines(body).filter(usable).map(stripMarkdownLine).find((l) => l !== '' && fold(l) !== foldedTitle) ?? ''
  return truncate(oneLine(line), max)
}

function splitInclusive(s, separators) {
  const out = []
  let current = ''
  for (const c of s) {
    current += c
    if (separators.includes(c)) {
      out.push(current)
      current = ''
    }
  }
  if (current !== '') out.push(current)
  return out
}

export function chunk(title, body) {
  const maxChars = Math.floor((CHUNK_TOKENS * 7) / 2)
  const pieces = []
  for (const paragraph of body.split('\n\n').map(trim).filter((p) => p !== '')) {
    if (charCount(paragraph) <= maxChars) {
      pieces.push(paragraph)
      continue
    }
    let current = ''
    let currentChars = 0
    for (const sentence of splitInclusive(paragraph, ['.', '\n'])) {
      const sentenceChars = charCount(sentence)
      if (currentChars + sentenceChars > maxChars && current !== '') {
        pieces.push(current)
        current = ''
        currentChars = 0
      }
      if (sentenceChars > maxChars) {
        const all = chars(sentence)
        for (let i = 0; i < all.length; i += maxChars) pieces.push(all.slice(i, i + maxChars).join(''))
      } else {
        current += sentence
        currentChars += sentenceChars
      }
    }
    if (trim(current) !== '') pieces.push(current)
  }
  const chunks = []
  let current = `${trim(title)}\n\n`
  let hasBody = false
  for (const piece of pieces) {
    if (hasBody && charCount(current) + charCount(piece) + 2 > maxChars) {
      chunks.push(trim(current))
      current = ''
      hasBody = false
    }
    if (hasBody) current += '\n\n'
    current += trim(piece)
    hasBody = true
  }
  if (trim(current) !== '') chunks.push(trim(current))
  return chunks
}

export function snippet(text, queryTerms, max) {
  const flat = oneLine(text)
  const folded = fold(flat)
  const flatChars = chars(flat)
  const foldedCount = charCount(folded)
  let hit = null
  for (const term of queryTerms) {
    const index = folded.indexOf(term)
    if (index === -1) continue
    const position = charCount(folded.slice(0, index))
    if (hit === null || position < hit) hit = position
  }
  const quarter = Math.floor(max / 4)
  const start = hit !== null && foldedCount === flatChars.length && hit > quarter ? hit - quarter : 0
  const window = flatChars.slice(start).join('')
  const prefix = start > 0 ? '…' : ''
  return truncate(`${prefix}${window}`, max)
}

const pad = (n) => String(n).padStart(2, '0')

export function today() {
  const d = new Date()
  return `${String(d.getFullYear()).padStart(4, '0')}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

export function nowIso() {
  return new Date().toISOString()
}

export function ulid(time = Date.now(), random = crypto.randomBytes(10)) {
  let t = BigInt(time)
  let timePart = ''
  for (let i = 0; i < 10; i++) {
    timePart = CROCKFORD[Number(t & 31n)] + timePart
    t >>= 5n
  }
  let r = BigInt(`0x${Buffer.from(random).toString('hex') || '0'}`)
  let randomPart = ''
  for (let i = 0; i < 16; i++) {
    randomPart = CROCKFORD[Number(r & 31n)] + randomPart
    r >>= 5n
  }
  return timePart + randomPart
}

export function shortId() {
  return ulid().toLowerCase().slice(4, 14)
}

export function frontmatter(raw) {
  const meta = new Map()
  const normalized = trimStartChars(raw, ['﻿'])
  let rest
  if (normalized.startsWith('---\n')) rest = normalized.slice(4)
  else if (normalized.startsWith('---\r\n')) rest = normalized.slice(5)
  else return { meta, body: normalized }
  const end = rest.indexOf('\n---')
  if (end === -1) return { meta, body: normalized }
  const found = []
  for (const line of lines(rest.slice(0, end))) {
    const trimmed = trim(line)
    const colon = trimmed.indexOf(':')
    if (colon === -1) continue
    const key = trim(trimmed.slice(0, colon))
    const value = trimMatches(trimMatches(trim(trimmed.slice(colon + 1)), '"'), "'")
    if (value !== '' && !found.some(([k]) => k === key)) found.push([key, value])
  }
  found.sort(([a], [b]) => compareBytes(a, b))
  for (const [key, value] of found) meta.set(key, value)
  const body = trimStartChars(trimStartChars(rest.slice(end + 4), ['-']), ['\r', '\n'])
  return { meta, body }
}
