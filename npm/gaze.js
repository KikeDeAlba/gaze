#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { ensureBinary } from './install.js'

const FORWARDED = ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT']

const args = process.argv.slice(2)
const QUICK_EXIT = { hook: 0, mcp: 1 }

const quick = Object.hasOwn(QUICK_EXIT, args[0])

let binary
try {
  binary = await ensureBinary({ offline: quick })
} catch (error) {
  process.stderr.write(`gaze: ${error.message}\n`)
  process.exit(quick ? QUICK_EXIT[args[0]] : 1)
}
if (!binary) {
  process.stderr.write('gaze: the gaze binary is not installed yet; run `gaze setup` once to download it\n')
  process.exit(QUICK_EXIT[args[0]])
}

const child = spawn(binary, args, { stdio: 'inherit' })
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
