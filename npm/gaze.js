#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { ensureBinary, jsMode, loadPort, needsRepair, SHIM, startRepair } from './install.js'

const FORWARDED = ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT']

const args = process.argv.slice(2)
const QUICK_EXIT = { hook: 0, mcp: 1 }

const quick = Object.hasOwn(QUICK_EXIT, args[0])
const registering = ['setup', 'daemon', 'uninstall'].includes(args[0])
const warn = quick ? undefined : (message) => process.stderr.write(message)

async function runJs() {
  let port
  try {
    port = await loadPort()
  } catch (error) {
    process.stderr.write(`gaze: ${error.message}\n`)
    process.exit(quick ? QUICK_EXIT[args[0]] : 1)
  }
  if (!registering && needsRepair(SHIM)) startRepair({ warn })
  const self = [process.execPath, SHIM]
  if (args[0] === 'setup' || args[0] === 'uninstall') {
    const { runSetup } = await import('./setup.js')
    process.exitCode = await runSetup(args, SHIM, { native: (argv, io) => port.main(argv, { self, io }) })
    return
  }
  process.exitCode = await port.main(args, { self })
}

async function runNative() {
  let binary
  try {
    binary = await ensureBinary({ offline: quick })
  } catch (error) {
    process.stderr.write(`gaze: ${error.message}\n`)
    process.exit(quick ? QUICK_EXIT[args[0]] : 1)
  }
  if (!registering && needsRepair(binary)) startRepair({ warn })
  if (!binary) {
    process.stderr.write('gaze: the gaze binary is not installed yet; run `gaze setup` once to download it\n')
    process.exit(QUICK_EXIT[args[0]])
  }
  if (args[0] === 'setup' || args[0] === 'uninstall') {
    const { runSetup } = await import('./setup.js')
    process.exit(await runSetup(args, binary))
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
}

await (jsMode() ? runJs() : runNative())
