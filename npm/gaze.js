#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { ensureBinary } from './install.js'

const FORWARDED = ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT']

let binary
try {
  binary = await ensureBinary()
} catch (error) {
  process.stderr.write(`gaze: ${error.message}\n`)
  process.exit(1)
}

const child = spawn(binary, process.argv.slice(2), { stdio: 'inherit' })
const relays = FORWARDED.map((signal) => {
  const relay = () => child.kill(signal)
  process.on(signal, relay)
  return [signal, relay]
})

child.on('error', (error) => {
  process.stderr.write(`gaze: cannot run ${binary}: ${error.message}\n`)
  process.exit(1)
})

child.on('exit', (code, signal) => {
  for (const [name, relay] of relays) process.off(name, relay)
  if (signal) {
    process.kill(process.pid, signal)
    return
  }
  process.exit(code ?? 1)
})
