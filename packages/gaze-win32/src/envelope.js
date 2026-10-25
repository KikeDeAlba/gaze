export const SCHEMA_VERSION = 1

export class GazeError extends Error {
  constructor(code, message, hint) {
    super(message)
    this.name = 'GazeError'
    this.code = code
    if (hint !== undefined) this.hint = hint
  }
}

export function notFound(what) {
  return new GazeError('NOT_FOUND', `No existe: ${what}`)
}

export function usage(message) {
  return new GazeError('USAGE_ERROR', message)
}

function now() {
  return new Date().toISOString()
}

export function success(command, data, meta) {
  const envelope = { schemaVersion: SCHEMA_VERSION, ok: true, command, generatedAt: now() }
  if (meta !== undefined) envelope.meta = meta
  envelope.data = data
  return envelope
}

export function failure(command, error) {
  const err = error instanceof GazeError
    ? { code: error.code, message: error.message }
    : { code: 'INTERNAL_ERROR', message: errorChain(error) }
  if (error instanceof GazeError && error.hint !== undefined && error.hint !== null) err.hint = error.hint
  return { schemaVersion: SCHEMA_VERSION, ok: false, command, generatedAt: now(), error: err }
}

function describe(value) {
  if (value instanceof Error) return value.message
  return String(value)
}

export function errorChain(error) {
  const parts = []
  const seen = new Set()
  let current = error
  while (current !== undefined && current !== null && !seen.has(current)) {
    seen.add(current)
    parts.push(describe(current))
    current = current instanceof Error ? current.cause : undefined
  }
  return parts.join(': ')
}
