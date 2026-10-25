import fs from 'node:fs'
import path from 'node:path'
import { renderDefault } from './config.js'
import { SCHEMA_VERSION } from './envelope.js'
import { VERSION, configPath, dataDir, dbPath, registryDir, selfCommand } from './paths.js'
import { Store } from './store.js'
import { nowIso } from './text.js'

export const CAPABILITIES = ['memory.search', 'memory.write', 'memory.graph.read', 'memory.rules', 'memory.ingest', 'memory.import', 'memory.hooks', 'mcp.stdio']

export const HOMEPAGE = 'https://github.com/KikeDeAlba/gaze'
export const INSTALL = 'npm install -g @kikedealba/gaze && gaze setup'

export const INTEGRATIONS_NOTE =
  'Las integraciones con cada agente (plugin, skill, MCP y hooks) las instala el paquete npm con kit; este binario solo registra gaze y prepara sus datos.'

export const NEXT = ['gaze daemon install', 'gaze import claude-memory --dry-run && gaze import claude-memory', 'gaze ingest']

export function capabilities() {
  return { name: 'gaze', version: VERSION, envelope: SCHEMA_VERSION, capabilities: [...CAPABILITIES], emits: [] }
}

export function manifest(bin) {
  return {
    manifestVersion: 1,
    name: 'gaze',
    version: VERSION,
    description: 'Per-project brain: local knowledge store with hybrid vector search for coding agents',
    bin: [...bin],
    envelope: SCHEMA_VERSION,
    capabilities: [...CAPABILITIES],
    emits: [],
    subscribes: [
      { tool: 'bita', events: ['stop', 'amend', 'delete'], command: [...bin, 'bita-hook'] },
      { tool: 'inkwell', events: ['docs.changed'], command: [...bin, 'inkwell-hook'] },
    ],
    mcp: { stdio: [...bin, 'mcp'] },
    homepage: HOMEPAGE,
    install: INSTALL,
    installedAt: nowIso(),
  }
}

export function manifestPath() {
  return path.join(registryDir(), 'gaze.json')
}

export async function setup({ self, open = () => Store.openDefault().close() } = {}) {
  const bin = self && self.length > 0 ? self : selfCommand()
  const registry = registryDir()
  fs.mkdirSync(registry, { recursive: true })
  const target = manifestPath()
  const temporary = path.join(registry, `gaze.json.${process.pid}.tmp`)
  fs.writeFileSync(temporary, `${JSON.stringify(manifest(bin), null, 2)}\n`)
  fs.renameSync(temporary, target)
  fs.mkdirSync(dataDir(), { recursive: true })
  const config = configPath()
  let configCreated = false
  if (!fs.existsSync(config)) {
    fs.mkdirSync(path.dirname(config), { recursive: true })
    fs.writeFileSync(config, renderDefault())
    configCreated = true
  }
  await open()
  return { manifest: target, config, configCreated, database: dbPath(), integrations: INTEGRATIONS_NOTE, next: [...NEXT] }
}

export function uninstall() {
  const target = manifestPath()
  const removed = fs.existsSync(target)
  if (removed) fs.rmSync(target)
  return { manifest: target, removed, next: ['gaze daemon uninstall'], kept: dbPath() }
}
