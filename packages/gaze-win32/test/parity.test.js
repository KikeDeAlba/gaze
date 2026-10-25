import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const rustBin = process.env.GAZE_PARITY_RUST;
const jsBin = process.env.GAZE_PARITY_JS;

let skipReason = null;
if (!rustBin || !existsSync(rustBin)) {
  skipReason = 'GAZE_PARITY_RUST is not set or does not exist (expected target/debug/gaze)';
} else if (!jsBin || !existsSync(jsBin)) {
  skipReason = 'GAZE_PARITY_JS is not set or the port does not exist yet (expected packages/gaze-win32/bin/gaze.js)';
}

const DROPPED_KEYS = new Set(['generatedAt', 'createdAt', 'updatedAt', 'firedAt', 'avgMs', 'ms', 'version', 'pid', 'uptimeSecs']);

function commandFor(kind) {
  return kind === 'rust' ? [rustBin, []] : [process.execPath, [jsBin]];
}

function invoke(kind, dir, args, stdin, extraEnv = {}) {
  const [cmd, prefix] = commandFor(kind);
  const env = {
    ...process.env,
    GAZE_DATA_DIR: dir,
    GAZE_CONFIG: join(dir, 'config.toml'),
    GAZE_SOCKET: join(dir, 's.sock'),
    KIT_REGISTRY_DIR: join(dir, 'tools.d'),
    INKWELL_DOCS_DIR: join(dir, 'docs'),
    INKWELL_DB_PATH: join(dir, 'inkwell.db'),
    GAZE_EMBEDDER: 'fake',
    GAZE_PROJECT: 'den',
    GAZE_BITA_BIN: join(dir, 'no-bita'),
    ...extraEnv,
  };
  if (!('GAZE_HARVEST' in extraEnv)) delete env.GAZE_HARVEST;
  delete env.KIT_HEADLESS;
  const out = spawnSync(cmd, [...prefix, ...args], { env, input: stdin ?? '', encoding: 'utf8', cwd: dir, timeout: 60000 });
  if (out.error) throw out.error;
  return { code: out.status, stdout: out.stdout, stderr: out.stderr };
}

function round(n) {
  return Number.isInteger(n) ? n : Math.round(n * 1e6) / 1e6;
}

function clean(value) {
  if (Array.isArray(value)) return value.map(clean);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      if (DROPPED_KEYS.has(key)) continue;
      out[key] = clean(value[key]);
    }
    return out;
  }
  if (typeof value === 'number') return round(value);
  return value;
}

function sortEntries(text) {
  if (typeof text !== 'string' || !text.startsWith('[')) return text;
  const entries = text.split(/\n(?=\[)/);
  return entries.sort().join('\n');
}

class Session {
  constructor(kind) {
    this.kind = kind;
    this.dir = realpathSync(mkdtempSync(join(tmpdir(), `gaze-parity-${kind}-`)));
    mkdirSync(join(this.dir, 'docs'), { recursive: true });
    this.ids = new Map();
    this.trace = [];
  }

  subst(text) {
    let out = text;
    for (const [name, id] of this.ids) out = out.split(id).join(`<${name}>`);
    const escaped = JSON.stringify(this.dir).slice(1, -1);
    if (escaped !== this.dir) out = out.split(escaped).join('<dir>');
    return out.split(this.dir).join('<dir>');
  }

  expand(text) {
    return text.replace(/\{([A-Z][A-Z0-9]*)\}/g, (match, name) => (this.ids.has(name) ? this.ids.get(name) : match));
  }

  record(step, code, raw) {
    const shown = this.subst(raw.trim());
    let body;
    try {
      body = clean(JSON.parse(shown));
    } catch {
      body = shown;
    }
    if (body && body.command === 'search' && Array.isArray(body.data)) {
      body.data = body.data.map(({ score, ...rest }) => rest).sort((a, b) => a.title.localeCompare(b.title));
    }
    if (body && body.command === 'stats' && body.data && body.data.daemon) {
      const { running, socket } = body.data.daemon;
      body.data.daemon = { running, socket };
    }
    if (typeof body === 'string' && step.startsWith('search ')) body = sortEntries(body);
    this.trace.push({ step: this.subst(step), code, body });
  }

  register(raw, as) {
    let id = null;
    try {
      const parsed = JSON.parse(raw.trim());
      if (parsed && parsed.data && typeof parsed.data.id === 'string' && /^[0-9a-z]{10}$/.test(parsed.data.id)) id = parsed.data.id;
    } catch {
      return;
    }
    if (!id) return;
    if (as) this.ids.set(as, id);
    else if (![...this.ids.values()].includes(id)) this.ids.set(`N${this.ids.size + 1}`, id);
  }

  run(args, { stdin, as, env } = {}) {
    const real = args.map((a) => this.expand(a));
    const res = invoke(this.kind, this.dir, real, stdin === undefined ? undefined : this.expand(stdin), env);
    this.register(res.stdout, as);
    this.record(args.join(' '), res.code, res.stdout);
    return res;
  }

  mcp(messages) {
    const stdin = this.expand(messages.map((m) => JSON.stringify(m)).join('\n') + '\n');
    const res = invoke(this.kind, this.dir, ['mcp'], stdin);
    for (const m of res.stdout.matchAll(/\[([0-9a-z]{10})\]/g)) {
      if (![...this.ids.values()].includes(m[1])) this.ids.set(`N${this.ids.size + 1}`, m[1]);
    }
    const replies = res.stdout
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => clean(JSON.parse(this.subst(l))))
      .map((reply) => {
        const content = reply.result && reply.result.content;
        if (Array.isArray(content)) for (const item of content) item.text = sortEntries(item.text);
        return reply;
      });
    this.trace.push({ step: 'mcp', code: res.code, body: replies });
  }

  finish() {
    rmSync(this.dir, { recursive: true, force: true });
    return this.trace;
  }
}

function both(scenario) {
  const results = {};
  for (const kind of ['rust', 'js']) {
    const session = new Session(kind);
    try {
      scenario(session);
    } finally {
      results[kind] = session.finish();
    }
  }
  assert.equal(results.js.length, results.rust.length);
  for (let i = 0; i < results.rust.length; i++) {
    assert.deepStrictEqual(results.js[i], results.rust[i], `step ${i}: ${results.rust[i].step}`);
  }
}

const opts = { skip: skipReason ?? false };

test('remember: create, dedupe, replace, kinds, pin, until, stdin and errors', opts, () => {
  both((s) => {
    s.run(['remember', '--title', 'Firma', 'den se firma con Developer ID, ver [[Release]]', '--json'], { as: 'A' });
    s.run(['remember', '--title', 'Release', 'Los releases salen de main', '--json'], { as: 'B' });
    s.run(['remember', '--title', 'Firma', 'den se firma con Developer ID, ver [[Release]]', '--json']);
    s.run(['remember', '--title', 'Firma', 'den se firma con certificado nuevo, ver [[Release]]', '--json']);
    s.run(['remember', 'Nota sin titulo explicito sobre despliegues', '--json']);
    s.run(['remember', '--kind', 'decision', '--pin', '--title', 'Usar pnpm', 'Decidimos usar pnpm en todos los repos', '--json']);
    s.run(['remember', '--kind', 'doc', '--until', '2099-12-31', '--title', 'Vigente', 'Documento con vigencia larga', '--json']);
    s.run(['remember', '--project', 'otro', '--title', 'Ajena', 'Nota de otro proyecto sobre facturacion', '--json']);
    s.run(['remember', '-', '--title', 'Desde stdin', '--json'], { stdin: 'cuerpo leido desde la entrada estandar\n' });
    s.run(['remember', '--kind', 'bogus', 'x', '--json']);
    s.run(['remember', '--until', '31/12/2030', 'x', '--json']);
    s.run(['remember', '   ', '--json']);
    s.run(['remember', 'ñandú café ünïcode 日本語 emoji nota', '--title', 'Unicode', '--json']);
    s.run(['show', '{A}', '--json']);
  });
});

test('search: fts, vector, kinds, limit, all, explain, expired notes', opts, () => {
  both((s) => {
    s.run(['remember', '--title', 'Firma', 'den se firma con Developer ID y notarizacion', '--json']);
    s.run(['remember', '--title', 'Release', 'Los releases salen de main con etiqueta', '--json']);
    s.run(['remember', '--kind', 'decision', '--title', 'Pnpm', 'Decidimos usar pnpm como gestor de paquetes', '--json']);
    s.run(['remember', '--kind', 'issue', '--title', 'Falla login', 'El login falla cuando la sesion expira', '--json']);
    s.run(['remember', '--until', '2000-01-01', '--title', 'Caducada', 'Nota caducada sobre firma antigua', '--json']);
    s.run(['remember', '--project', 'otro', '--title', 'Ajena', 'Facturacion mensual del cliente otro', '--json']);
    s.run(['search', 'firma developer', '--json']);
    s.run(['search', 'releases main', '--json']);
    s.run(['search', 'gestor paquetes', '--json']);
    s.run(['search', 'sesion expira login', '--kind', 'issue', '--json']);
    s.run(['search', 'firma', '--kind', 'decision', '--json']);
    s.run(['search', 'firma', '--limit', '1', '--json']);
    s.run(['search', 'facturacion', '--json']);
    s.run(['search', 'facturacion', '--project', 'otro', '--json']);
    s.run(['search', 'facturacion', '--all', '--json']);
    s.run(['search', 'firma developer', '--explain', '--json']);
    s.run(['search', 'caducada antigua', '--json']);
    s.run(['search', 'zzzz qqqq', '--json']);
    s.run(['search', 'firma', '--limit', 'abc', '--json']);
    s.run(['search', 'firma', '--project', 'den', '--all', '--json']);
    s.run(['search', 'firma developer']);
    s.run(['search', 'zzzz qqqq']);
  });
});

test('show, link, forget, move and graph', opts, () => {
  both((s) => {
    s.run(['remember', '--title', 'Firma', 'den se firma con Developer ID, ver [[Release]]', '--json'], { as: 'A' });
    s.run(['remember', '--title', 'Release', 'Los releases salen de main', '--json'], { as: 'B' });
    s.run(['remember', '--title', 'Suelta', 'Nota aislada sin enlaces', '--json'], { as: 'C' });
    s.run(['show', '{A}', '--json']);
    s.run(['show', '{B}', '--json']);
    s.run(['show', '{A}']);
    s.run(['show', 'nope000000', '--json']);
    s.run(['link', '{B}', '{C}', '--json']);
    s.run(['link', '{B}', '{B}', '--json']);
    s.run(['link', '{B}', 'nope000000', '--json']);
    s.run(['show', '{C}', '--json']);
    s.run(['graph', '--project', 'den', '--json']);
    s.run(['graph', '--json']);
    s.run(['move', '{C}', '--project', 'otro', '--json']);
    s.run(['move', 'nope000000', '--project', 'otro', '--json']);
    s.run(['show', '{C}', '--json']);
    s.run(['graph', '--project', 'den', '--json']);
    s.run(['forget', '{C}', '--json']);
    s.run(['forget', '{C}', '--json']);
    s.run(['show', '{B}', '--json']);
    s.run(['search', 'aislada', '--all', '--json']);
  });
});

test('rule add, ls and rm', opts, () => {
  both((s) => {
    s.run(['rule', 'ls', '--json']);
    s.run(['rule', 'add', 'Nunca uses npm', '--json'], { as: 'R1' });
    s.run(['rule', 'add', 'Responde en espanol', '--pin', '--json'], { as: 'R2' });
    s.run(['rule', 'add', 'Regla temporal', '--until', '2099-01-01', '--json'], { as: 'R3' });
    s.run(['rule', 'add', 'Regla global', '--global', '--json'], { as: 'R4' });
    s.run(['rule', 'add', 'Nunca uses npm', '--json']);
    s.run(['rule', 'add', 'Regla otra', '--project', 'otro', '--json'], { as: 'R5' });
    s.run(['rule', 'ls', '--json']);
    s.run(['rule', 'ls', '--all', '--json']);
    s.run(['rule', 'ls', '--project', 'otro', '--json']);
    s.run(['rule', 'ls']);
    s.run(['remember', '--title', 'No regla', 'Un hecho cualquiera', '--json'], { as: 'F' });
    s.run(['rule', 'rm', '{F}', '--json']);
    s.run(['rule', 'rm', '{R1}', '--json']);
    s.run(['rule', 'rm', '{R1}', '--json']);
    s.run(['rule', 'ls', '--json']);
  });
});

test('group set, ls and rm', opts, () => {
  both((s) => {
    s.run(['group', 'ls', '--json']);
    s.run(['group', 'ls']);
    s.run(['group', 'set', 'equipo', 'den', 'otro', '--json']);
    s.run(['group', 'set', 'solo', 'den', '--json']);
    s.run(['group', 'set', 'equipo', 'den', 'otro', 'tercero', '--json']);
    s.run(['group', 'set', 'vacio', '--json']);
    s.run(['group', 'ls', '--json']);
    s.run(['group', 'ls']);
    s.run(['group', 'rm', 'solo', '--json']);
    s.run(['group', 'rm', 'solo', '--json']);
    s.run(['group', 'ls', '--json']);
  });
});

test('stats, capabilities and project', opts, () => {
  both((s) => {
    s.run(['stats', '--json']);
    s.run(['capabilities', '--json']);
    s.run(['project', '--json']);
    s.run(['project', '--cwd', s.dir, '--json']);
    s.run(['remember', '--title', 'Firma', 'den se firma con Developer ID', '--json']);
    s.run(['remember', '--kind', 'decision', '--title', 'Pnpm', 'Decidimos usar pnpm', '--json']);
    s.run(['rule', 'add', 'Nunca uses npm', '--json']);
    s.run(['hook', 'session-start'], { stdin: '{"session_id":"st","cwd":"/"}' });
    s.run(['stats', '--json']);
    s.run(['stats']);
  });
});

test('hook session-start and prompt for claude and gemini', opts, () => {
  both((s) => {
    s.run(['rule', 'add', 'Nunca uses npm', '--json']);
    s.run(['rule', 'add', 'Responde siempre en espanol', '--pin', '--json']);
    s.run(['remember', '--title', 'Despliegue pagos', 'El despliegue de la api de pagos usa github actions y aws lambda', '--json']);
    s.run(['remember', '--title', 'Base de datos', 'La base de datos principal es postgres en rds con replicas', '--json']);
    s.run(['hook', 'session-start'], { stdin: '{"session_id":"c1","cwd":"/"}' });
    s.run(['hook', 'session-start', '--harness', 'claude'], { stdin: '{"session_id":"c2","cwd":"/"}' });
    s.run(['hook', 'session-start', '--harness', 'gemini'], { stdin: '{"session_id":"g1","cwd":"/"}' });
    s.run(['hook', 'prompt'], { stdin: '{"session_id":"c1","cwd":"/","prompt":"como es el despliegue de la api de pagos con github actions"}' });
    s.run(['hook', 'prompt'], { stdin: '{"session_id":"c1","cwd":"/","prompt":"como es el despliegue de la api de pagos con github actions"}' });
    s.run(['hook', 'prompt', '--harness', 'claude'], { stdin: '{"session_id":"c3","cwd":"/","prompt":"donde vive la base de datos principal postgres"}' });
    s.run(['hook', 'prompt', '--harness', 'gemini'], { stdin: '{"session_id":"g2","cwd":"/","prompt":"el despliegue de la api de pagos aws lambda"}' });
    s.run(['hook', 'prompt'], { stdin: '{"session_id":"c4","cwd":"/","prompt":"hola"}' });
    s.run(['hook', 'prompt'], { stdin: '{"session_id":"c4","cwd":"/","prompt":"/clear"}' });
    s.run(['hook', 'prompt'], { stdin: '{"session_id":"c4","cwd":"/","prompt":"tema totalmente distinto sobre quimica organica avanzada"}' });
    s.run(['hook', 'prompt'], { stdin: 'not json' });
    s.run(['hook', 'session-start'], { stdin: '' });
    s.run(['hook', 'session-start'], { stdin: '{"session_id":"h","cwd":"/"}', env: { GAZE_HARVEST: '1' } });
    s.run(['stats', '--json']);
  });
});

test('mcp session: initialize, tools/list, tools/call', opts, () => {
  both((s) => {
    s.run(['remember', '--title', 'Firma', 'den se firma con Developer ID, ver [[Release]]', '--json'], { as: 'A' });
    s.run(['remember', '--title', 'Release', 'Los releases salen de main', '--json'], { as: 'B' });
    s.mcp([
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'parity', version: '0' } } },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'gaze_search', arguments: { query: 'firma developer' } } },
      { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'gaze_search', arguments: { query: '{A}' } } },
      { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'gaze_search', arguments: {} } },
      { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'gaze_remember', arguments: { body: 'Nota desde mcp sobre cuentas', project: 'global' } } },
      { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'nope', arguments: {} } },
      { jsonrpc: '2.0', id: 8, method: 'ping' },
      { jsonrpc: '2.0', id: 9, method: 'bogus/method' },
    ]);
    s.run(['search', 'cuentas', '--project', 'global', '--json']);
  });
});
