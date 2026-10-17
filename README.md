# gaze

El cerebro de cada proyecto. gaze guarda lo que se aprende trabajando (decisiones, correcciones, convenciones, datos del cliente y de la infraestructura) en una base local con búsqueda híbrida (texto + vectores), y se lo da a Claude Code **por búsqueda**, nunca cargándolo todo. Reemplaza a la memoria automática de Claude.

Es parte de la familia de herramientas de KikeDeAlba (bita, inkwell, recap, tally, atl, den): habla el sobre JSON de kit, se registra en `~/.config/kikedealba/tools.d/` y escucha los eventos de bita.

## Qué hace en cada sesión

| Momento | Qué inyecta | Tope |
|---|---|---|
| Inicio de sesión | Las reglas activas (del proyecto y globales) y una línea que dice que el cerebro existe | ~300 tokens de reglas; el resto queda en `gaze rule ls` |
| Cada prompt | Hasta 3 punteros `[id] título — 1 línea`, solo si la coincidencia es fuerte y no se inyectaron antes en la sesión | 150 tokens; casi siempre nada |
| Fin de sesión y antes de compactar | Nada. En segundo plano, Haiku extrae aprendizajes durables de la conversación y gaze los guarda (con deduplicación) | 0 |

Claude tiene 4 herramientas MCP (`gaze_search`, `gaze_remember`, `gaze_rule_add`, `gaze_link`) y la skill `gaze`, que le dice cuándo guardar y cómo escribir notas atómicas.

## Instalación

Requiere Rust (1.88 o más nuevo) y macOS (el daemon usa launchd; el resto funciona en cualquier Unix).

```sh
cargo install --locked --git https://github.com/KikeDeAlba/gaze --tag v0.2.1   # o, desde el clon: cargo install --path .
gaze setup                        # registra gaze en kit, crea ~/.config/gaze/config.toml y la base
gaze daemon install               # daemon en launchd que mantiene el modelo cargado (hooks de ~15 ms)
claude plugin marketplace add KikeDeAlba/gaze
claude plugin install gaze@gaze   # hooks, skill y servidor MCP
```

La primera vez que se calcula un embedding se descarga el modelo `multilingual-e5-small` (~120 MB) a `~/.cache/gaze`.

### Migrar la memoria de Claude

```sh
gaze import claude-memory --dry-run   # cuántas notas irían a cada proyecto
gaze import claude-memory
```

Lee `~/.claude/projects/*/memory/*.md` (sin `MEMORY.md`), descarta los directorios de `/private/tmp` y de Recap, resuelve el proyecto a partir de la ruta original y conserva el tipo: `user` → hecho global, `feedback` → regla del proyecto (o hecho si es global), `project` y `reference` → hecho. Los `[[enlaces]]` se vuelven aristas. Es idempotente.

### Ingerir lo que ya existe

```sh
gaze ingest                 # inkwell (páginas y notas de entradas) y recap (minutas)
gaze ingest --source inkwell
```

Es incremental por fecha de modificación. Las entradas de bita llegan solas por eventos (`gaze bita-hook`, suscrito a `stop`, `amend` y `delete`).

### Apagar la memoria automática de Claude

Con gaze activo, la memoria automática sobra. Según la documentación de Claude Code ([memory](https://code.claude.com/docs/en/memory)), cualquiera de estas la apaga:

- En una sesión: `/memory` y desactivar el interruptor de auto memory (guarda `"autoMemoryEnabled": false` en `~/.claude/settings.json`).
- A mano, en `~/.claude/settings.json` (o en el `.claude/settings.json` de un solo proyecto):

  ```json
  { "autoMemoryEnabled": false }
  ```

- Por variable de entorno: `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`.

### Desinstalar

```sh
claude plugin uninstall gaze@gaze
gaze daemon uninstall
gaze uninstall          # quita el registro de kit; la base se queda en ~/.local/share/gaze
```

## Comandos

Todos aceptan `--json` y responden con el sobre de kit (`{schemaVersion, ok, command, generatedAt, data, meta?, error?}`).

```text
gaze remember [--project P] [--kind K] [--title T] [--pin] [--until AAAA-MM-DD] <texto|@archivo|->
gaze search <consulta> [--project P | --all] [--kind K] [--limit 5]
gaze show <id>
gaze rule add <texto> [--project P | --global] [--until AAAA-MM-DD] [--pin]
gaze rule ls [--project P | --all]
gaze rule rm <id>
gaze group set <nombre> <proyecto>...   # p. ej. gaze group set dp Dportenis DPSuites "IA DP"
gaze group ls | gaze group rm <nombre>
gaze move <id> --project <proyecto o grupo>
gaze link <a> <b>
gaze forget <id>
gaze graph [--project P]
gaze ingest [--source inkwell|recap|bita|all]
gaze import claude-memory [--dry-run] [--root ~/.claude/projects]
gaze project [--cwd DIR] [--refresh]
gaze stats
gaze capabilities
gaze setup | gaze uninstall
gaze daemon install|uninstall|status
gaze serve [--idle-minutes N]
gaze mcp
gaze hook session-start|prompt|harvest
gaze bita-hook
gaze reindex [--all]
```

Tipos de nota: `rule`, `fact`, `decision`, `doc`, `entry`, `issue`, `meeting`, `memory`. Proyecto `global` para lo que aplica en todos lados.

### Contratos que consumen otros

- `search --json` → `data: [{id, title, kind, project, snippet, score}]` (snippet de 200 caracteres o menos).
- `show <id> --json` → la nota con `body` y `neighbors: [{id, title, kind, edgeKind}]`.
- `graph --json` (lo usa den) → `data: {nodes: [{id, project, kind, title, degree, pinned, updatedAt}], edges: [{src, dst, kind, weight}]}`.
- `capabilities --json` → `memory.search`, `memory.write`, `memory.graph.read`, `memory.rules`, `memory.ingest`, `memory.import`, `memory.hooks`, `mcp.stdio`.

## Cómo resuelve el proyecto

Para un directorio: `bita repo which --json` si existe; si no, el remoto `origin` contra el `scopeMapping` de `~/.config/bita/config.json` (el prefijo más largo); si no, `gaze.toml` en la raíz del repo (`project = "Nombre"`); si no, `global`. El nombre del proyecto se guarda como slug (igual que las carpetas de inkwell) y el resultado se cachea 24 horas en la base. `GAZE_PROJECT` lo fuerza.

## Grupos de proyectos

Un grupo junta proyectos de un mismo cliente. Lo que se guarda en el grupo (`--project dp`) y lo de cualquiera de sus proyectos se ve desde todos ellos: reglas al iniciar sesión y resultados de búsqueda. Así «en los proyectos de DP los commits van así» se escribe una vez: `gaze rule add "..." --project dp`.

## Datos

- Base: `~/.local/share/gaze/gaze.db` (SQLite con sqlite-vec y FTS5; `GAZE_DB_PATH` la cambia).
- Socket del daemon: `~/.local/share/gaze/gaze.sock`. Bitácoras: `harvest.log` y `serve.log` en la misma carpeta.
- Configuración: `~/.config/gaze/config.toml`.
- Modelo: `~/.cache/gaze/models`.

Cada nota se parte en fragmentos de ~400 tokens con su embedding (e5 con los prefijos `query:` y `passage:`). La búsqueda une BM25 y vectores con reciprocal rank fusion. Los `[[Título]]` se vuelven aristas `link` (primero dentro del proyecto, luego en `global`; si el destino aún no existe, se enlaza cuando llegue). Las claves de Jira y los `entryId` de bita generan aristas `same-issue` y `same-entry`; los 5 vecinos más parecidos, aristas `similar`.

Al guardar, si ya hay una nota del mismo proyecto con similitud de 0.94 o más, se fusiona: con 0.97 o más (o si una contiene a la otra) se queda la nueva; si no, la nueva va arriba y la anterior abajo.

## Configuración

`gaze setup` escribe los valores por omisión:

```toml
[search]
dedupe_threshold = 0.94
replace_threshold = 0.97
similar_threshold = 0.91
similar_neighbors = 5

[hooks]
rules_tokens = 300
prompt_tokens = 150
prompt_max = 3
prompt_min_chars = 20
prompt_threshold = 0.84
prompt_margin = 0.03
prompt_lexical_threshold = 0.75

[harvest]
enabled = true
model = "haiku"
max_chars = 40000
min_chars = 600
max_items = 8
timeout_seconds = 240
```

Los umbrales están calibrados para `multilingual-e5-small`, que comprime las similitudes (dos textos sin relación rondan 0.80–0.88). Por eso el hook de prompt no usa un umbral absoluto solo: exige que el mejor resultado supere por `prompt_margin` a la mediana de los 10 primeros. Sin daemon, el hook no carga el modelo: busca solo por texto con reglas más estrictas y levanta el daemon en segundo plano.

## Cosecha

`gaze hook harvest` regresa de inmediato y deja un proceso aparte que lee el transcript (solo el texto de usuario y asistente, sin salidas de herramientas ni recordatorios del sistema), toma lo nuevo desde la última cosecha de esa sesión, lo recorta y corre:

```sh
claude -p --model haiku --output-format json --tools "" --strict-mcp-config --no-session-persistence --disable-slash-commands
```

con `GAZE_HARVEST=1`, que apaga todos los hooks de gaze en esa sesión hija. Lo que devuelve se guarda con deduplicación y queda en `~/.local/share/gaze/harvest.log`.

## Desarrollo

```sh
cargo test                      # usa un embedder falso: no descarga modelos
cargo clippy --all-targets -- -D warnings
cargo build --release
```

`GAZE_EMBEDDER=fake` sirve para probar la CLI sin modelo.

## Licencia

MIT
