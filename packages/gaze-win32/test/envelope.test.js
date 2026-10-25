import { test } from 'node:test'
import assert from 'node:assert/strict'
import { GazeError, SCHEMA_VERSION, errorChain, failure, notFound, success, usage } from '../src/envelope.js'

const ISO_MILLIS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

test('success keeps the documented key order and omits missing meta', () => {
  const plain = success('show', { id: 'x' })
  assert.deepEqual(Object.keys(plain), ['schemaVersion', 'ok', 'command', 'generatedAt', 'data'])
  assert.equal(plain.schemaVersion, SCHEMA_VERSION)
  assert.equal(plain.ok, true)
  assert.match(plain.generatedAt, ISO_MILLIS)
  const withMeta = success('search', [], { count: 0 })
  assert.deepEqual(Object.keys(withMeta), ['schemaVersion', 'ok', 'command', 'generatedAt', 'meta', 'data'])
  assert.deepEqual(withMeta.meta, { count: 0 })
})

test('failure reports gaze errors with their code and hint', () => {
  const missing = failure('show', notFound('zzzz'))
  assert.deepEqual(Object.keys(missing), ['schemaVersion', 'ok', 'command', 'generatedAt', 'error'])
  assert.deepEqual(missing.error, { code: 'NOT_FOUND', message: 'No existe: zzzz' })
  assert.equal(missing.ok, false)
  assert.deepEqual(failure('x', usage('falta el id')).error, { code: 'USAGE_ERROR', message: 'falta el id' })
  assert.deepEqual(failure('x', new GazeError('INTERNAL_ERROR', 'm', 'h')).error, { code: 'INTERNAL_ERROR', message: 'm', hint: 'h' })
})

test('other errors become INTERNAL_ERROR with the whole cause chain', () => {
  const error = new Error('open db', { cause: new Error('permission denied', { cause: 'EACCES' }) })
  assert.equal(errorChain(error), 'open db: permission denied: EACCES')
  assert.deepEqual(failure('stats', error).error, { code: 'INTERNAL_ERROR', message: 'open db: permission denied: EACCES' })
  assert.equal(errorChain('plain'), 'plain')
})

test('gaze errors are real errors', () => {
  const error = notFound('a')
  assert.ok(error instanceof Error)
  assert.equal(error.code, 'NOT_FOUND')
  assert.equal(error.hint, undefined)
})
