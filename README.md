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

Plataformas: macOS arm64 (Apple Silicon), Linux x64 y arm64 usan el binario nativo de Rust, precompilado. Windows (x64 y arm64) corre un port en JavaScript sobre `node.exe`, sin ningún binario propio: viene en `@kikedealba/gaze-win32`, una `optionalDependency` que npm instala solo en Windows. Requiere Node 24.5 o más nuevo. El daemon usa launchd en macOS, una unidad de usuario de systemd en Linux y, en Windows, un proceso bajo demanda sin tarea programada ni servicio; si tu equipo tiene antivirus o EDR corporativo, lee [Windows con antivirus o EDR corporativo](#windows-con-antivirus-o-edr-corporativo).

```sh
npm install -g @kikedealba/gaze && gaze setup   # registra gaze en kit, crea ~/.config/gaze/config.toml y la base
gaze daemon install                             # daemon que mantiene el modelo cargado: launchd, systemd o, en Windows, un proceso bajo demanda (hooks de ~40 ms con el lanzador de npm)
claude plugin marketplace add KikeDeAlba/gaze
claude plugin install gaze@gaze                 # hooks, skill y servidor MCP
```

En macOS y Linux, el paquete de npm no trae el binario, pero sí su SHA-256: `npm/checksums.json` lo genera el pipeline de publicación para cada target (`aarch64-apple-darwin`, `x86_64-unknown-linux-gnu` y `aarch64-unknown-linux-gnu`). Al instalarse, el `postinstall` descarga el asset del release `v<versión>` en GitHub (solo por https y solo desde `github.com` y sus hosts de assets, con hasta 3 redirecciones y un tope de 200 MB) y lo compara con ese hash. Si el hash no coincide, falta `checksums.json` o el tar trae algo que no es un archivo normal, la instalación falla; si el problema es de red (sin conexión, HTTP o timeout), la instalación termina bien y avisa. En Windows no se descarga nada del release: el release no tiene asset de Windows y `checksums.json` no lo incluye. Lo que se instala y dónde queda depende de la plataforma:

| Plataforma | Qué se instala | Dónde queda | Marca de versión |
|---|---|---|---|
| macOS y Linux | Asset `gaze-<versión>-<target>.tar.gz` del release | `vendor/gaze` dentro del paquete | `vendor/.version` |
| Windows | Nada que descargar: el port JS `@kikedealba/gaze-win32` (`optionalDependency`) | `node_modules` de npm; corre con `node.exe` | La versión del paquete |

En Windows no hay ejecutable propio ni binario nativo: ni `.exe`, ni `.node`, ni `.dll` en el paquete ni en sus dependencias (el pipeline de publicación lo comprueba en el árbol instalado). El port es JavaScript más los `.wasm` de `onnxruntime-web`. Esto responde a Check Point Harmony Endpoint, que mataba el `gaze.exe` al arrancar con el código de salida `0xDEAD`. El `postinstall` y el lanzador borran la carpeta `vendor\` que dejó una versión 0.6.x.

El comando `gaze` es un lanzador de Node (`npm/gaze.js`). En macOS y Linux ejecuta el binario nativo; en Windows carga el port en el mismo proceso de `node.exe`. Si en macOS o Linux el `postinstall` no corrió (por red, por `npm install --ignore-scripts` o porque npm bloqueó los scripts), **la primera ejecución de `gaze` descarga el binario**; por eso conviene que esa primera ejecución sea `gaze setup` y no un hook, que tiene pocos segundos. `GAZE_BINARY_PATH` usa un binario propio en lugar del descargado, avisa por stderr en cada ejecución y en Windows desactiva el port. `GAZE_FORCE_JS=1` obliga a usar el port en macOS y Linux (sirve para pruebas).

El manifiesto de kit (`~/.config/kikedealba/tools.d/gaze.json`, en Windows `%APPDATA%\kikedealba\tools.d\gaze.json`) y el plist de launchd guardan la ruta del binario nativo dentro de `vendor/`, que cambia con cada versión (con pnpm vive en su store versionado) y con el prefijo global de npm. En Windows guardan el comando `node.exe` más `npm\gaze.js` del paquete, y esas mismas rutas usan las integraciones de los agentes. Tras `npm i -g` o `pnpm add -g` de otra versión, eso se repara solo:

- El `postinstall` corre `gaze setup` y `gaze daemon install` si ya existían el manifiesto o el plist. pnpm no corre `postinstall` sin aprobación, así que no se puede depender de él.
- Por eso el lanzador revisa en cada ejecución el manifiesto de kit. Repara si el binario registrado ya no existe, si su versión es menor que la del paquete o si el plist no apunta al binario registrado cuando ese binario es el suyo. En ese caso lanza en segundo plano `install.js --repair`, que en macOS y Linux descarga el binario si falta y en todas las plataformas corre `gaze setup` y `gaze daemon install`. El hook o comando en curso no espera. Basta con la siguiente ejecución de `gaze`, aunque sea un hook de Claude Code.
- No repara si no existe `tools.d/gaze.json` (aunque haya plist: quitar el manifiesto es decisión del usuario), si el binario registrado existe y no está en el `vendor/` de un paquete `@kikedealba/gaze` (instalación con cargo o manual) ni con `GAZE_BINARY_PATH`. Dos instalaciones de npm o pnpm no se quitan el registro: gana la versión mayor y, con la misma versión, la que ya estaba.
- Solo corre una reparación a la vez por usuario, con el candado `repair.lock` (modo 0600) en el directorio de datos de gaze (`~/.local/share/gaze`). Si falla, o si al terminar el registro sigue sin apuntar al binario (por ejemplo, porque el binario reporta otra versión que el paquete), el candado guarda el error y no se reintenta en 10 minutos. Un candado de más de 10 minutos solo se reemplaza si su proceso ya no existe; uno de más de 1 hora se reemplaza siempre, por si el pid se reutilizó. `gaze setup`, `gaze daemon …` y `gaze uninstall` explícitos nunca disparan la reparación. El `postinstall` y la reparación dan hasta 180 s a cada paso, más que el peor caso de `gaze daemon install`.
- Medido en macOS arm64 (100 corridas de `gaze capabilities --json`): binario nativo 4.0 ms, lanzador 27.5 ms, lanzador con la revisión 28.0 ms (mediana).

En macOS y Linux, el manifiesto y el plist apuntan al binario nativo y no al lanzador del `PATH` (`~/Library/pnpm/bin/gaze` o `<prefijo>/bin/gaze`): launchd arranca el daemon con `PATH=/usr/bin:/bin:/usr/sbin:/sbin`, donde no está el `node` de nvm, Volta o Homebrew, y el lanzador dejaría un proceso de Node residente (~44 MB) junto al daemon. Con el binario nativo, Den y kit tampoco pagan los ~24 ms del lanzador en cada llamada.

Si hace falta a mano: `gaze setup && gaze daemon install`. En macOS y Linux, `vendor/.version` guarda la versión del binario descargado: si no coincide con la del paquete, se vuelve a descargar. En Windows no hay nada que descargar ni marca de versión: la versión es la del paquete. El `postinstall` y la reparación reapuntan las integraciones de los agentes (hooks y MCP de Codex, Gemini, OpenCode, Antigravity y Claude Desktop) al binario nativo (macOS y Linux) o a `node.exe` más `npm\gaze.js` (Windows), conservando el modo de cada archivo; si alguna no se puede reescribir, avisan con el nombre del archivo y conservan la ruta anterior hasta que corras `gaze setup`.

En macOS, `gaze daemon install` saca el job anterior de launchd, espera hasta 10 s a que `launchctl print gui/<uid>/com.kikedealba.gaze` deje de encontrarlo, lo habilita (`launchctl enable`, por si se deshabilitó), carga el plist, espera hasta 10 s a que el job tenga pid y hasta 30 s a que responda en el socket. Reintenta hasta 3 veces y, si no queda cargado, sale con error y el detalle de cada intento. Si el job sigue vivo pero aún no responde (la primera vez puede estar descargando el modelo), termina bien y lo dice. En el peor caso tarda unos 160 s. `gaze daemon uninstall` falla con un error claro si launchd no descarga el job, y entonces no borra el plist. `gaze daemon status` distingue entre corriendo, plist instalado pero no cargado en launchd, cargado sin responder todavía en el socket y apagado (campo `state`: `running`, `not-loaded`, `starting`, `stopped`).

En Windows, el daemon es un proceso bajo demanda: `gaze daemon install` **no crea ninguna tarea programada** ni servicio. Si existe la tarea `gaze-daemon` de una versión 0.6.x (la creaba `schtasks /Create /SC ONLOGON`), la termina y la borra con `schtasks /Delete`. Después levanta el daemon si no responde (espera hasta unos 30 s a que conteste en el pipe) y escribe la marca `%LOCALAPPDATA%\gaze\daemon.json`. El proceso es `node.exe <...>\npm\gaze.js serve --idle-minutes 120`, oculto, sin ventana, con su salida en `%LOCALAPPDATA%\gaze\serve.log`. Se apaga solo tras 120 minutos sin peticiones. Además, un hook de prompt o un embedding que encuentre el daemon apagado lo vuelve a lanzar en segundo plano, como máximo una vez cada 120 s (marca `serve.spawned`). `gaze daemon uninstall` lo apaga, borra `daemon.json` y quita la tarea `gaze-daemon` si todavía existe. `gaze daemon status` informa `state`: `running`, `idle` (marca instalada pero daemon apagado, se levanta bajo demanda) o `stopped`.

Los hooks (`gaze hook …`) y `gaze mcp` nunca descargan: si todavía no hay binario, avisan por stderr y salen (0 los hooks, para no romper la sesión; 1 el MCP).

Si npm no puede escribir en su prefijo global (`EACCES`), revisa `npm config get prefix` y usa uno de tu usuario: `npm config set prefix ~/.npm-global` y vuelve a instalar.

Detrás de un proxy: si hay `HTTPS_PROXY` o `HTTP_PROXY` (o sus versiones en minúscula) y no está `NODE_USE_ENV_PROXY`, el instalador relanza la descarga en un proceso de Node con `NODE_USE_ENV_PROXY=1`, que hace que `fetch` use el proxy y respete `NO_PROXY`. El paquete exige Node 24.5 o más nuevo, la primera versión con `NODE_USE_ENV_PROXY`.

El plugin de Claude Code (hooks, skill y MCP) se instala desde el marketplace de git, no desde npm; sus comandos llaman a `gaze` en el `PATH`.

### Alternativa: compilar con cargo

Requiere Rust 1.88 o más nuevo:

```sh
cargo install --locked --git https://github.com/KikeDeAlba/gaze --tag v0.7.0   # o, desde el clon: cargo install --path .
gaze setup
```

La primera vez que se calcula un embedding se descarga el modelo `multilingual-e5-small` (~470 MB) a la caché de gaze (`~/.cache/gaze` en macOS y Linux, `%LOCALAPPDATA%\gaze\cache` en Windows, o `GAZE_CACHE_DIR`).

### Windows con antivirus o EDR corporativo

Para TI. En Windows, gaze ya no ejecuta un `gaze.exe`: Check Point lo mataba al arrancar con el código de salida `0xDEAD`. Ahora todo corre como JavaScript dentro de `node.exe`, sin binarios propios (ver [Instalación](#instalación)). Esto es lo que gaze hace en el equipo.

| Qué | Dónde |
|---|---|
| Proceso | `node.exe` ejecutando `...\@kikedealba\gaze\npm\gaze.js`; el daemon es el mismo comando con `serve --idle-minutes 120` |
| Paquete | `%APPDATA%\npm\node_modules\@kikedealba\gaze` (con el prefijo global de npm por defecto) y su dependencia opcional `@kikedealba/gaze-win32`, en `node_modules` |
| Datos: base `gaze.db`, bitácoras, marcas y candados | `%LOCALAPPDATA%\gaze\` |
| Caché del modelo | `%LOCALAPPDATA%\gaze\cache\models\Xenova--multilingual-e5-small\<revisión>` (`GAZE_CACHE_DIR` la cambia) |
| Configuración | `%APPDATA%\gaze\config.toml` |
| Canal del daemon | Named pipe `\\.\pipe\gaze-<usuario>` (el nombre de usuario en minúsculas, solo letras, números, `_` y `-`) |
| Token del daemon | `%LOCALAPPDATA%\gaze\daemon.token`, de 32 bytes; cada arranque del daemon lo renueva |
| Bitácora del daemon | `%LOCALAPPDATA%\gaze\serve.log` |
| Tarea programada | Ninguna. Si queda la `gaze-daemon` de una 0.6.x, `gaze daemon install` o `gaze daemon uninstall` la borran |

Qué hace el port:

- No carga ningún binario nativo. La base usa `node:sqlite` (con FTS5), los vectores se comparan por fuerza bruta en JavaScript y los embeddings corren con `onnxruntime-web` en WASM.
- El daemon es bajo demanda (ver [Instalación](#instalación)). Habla por el named pipe, no por un puerto de red, y cada mensaje va firmado con HMAC-SHA256 (`gaze-ipc-v3`) con el token de `daemon.token`: el token no viaja por el pipe.
- Una base 0.6.x creada por el binario nativo (con `vec0`) se migra al abrirla y la original queda como `gaze.db.vec0.bak` junto a la base. Los vectores se regeneran cada vez que se abre una base con notas, sin ningún vector y con esa copia al lado (también si la migración se cortó antes): un comando de la CLI los regenera en el mismo proceso antes de seguir, y los hooks `session-start`, `prompt` y `harvest` lanzan `gaze reindex` en segundo plano, como mucho una vez cada 10 minutos (marca `reindex.spawned` en el directorio de datos). Si otro proceso está migrando la base, un hook espera 1,5 s y luego sale sin dar contexto.
- La primera vez que se calcula un embedding, descarga el modelo q8 `Xenova/multilingual-e5-small` de Hugging Face: el modelo pesa 118 MB y el tokenizador unos 17 MB. Solo acepta https, solo desde `huggingface.co` y su CDN (`cdn-lfs.huggingface.co`, `cdn-lfs.hf.co`, `cdn-lfs-us-1.hf.co`, `cas-bridge.xethub.hf.co` y `*.cdn.hf.co`), fija la revisión del repositorio y compara el SHA-256 de cada archivo antes de guardarlo. El modelo es más chico que el del binario nativo (~470 MB), pero sigue siendo un archivo grande escrito de una vez.

Si algo falla, el primer lugar es `%LOCALAPPDATA%\gaze\serve.log`. Para ver si el daemon responde: `gaze daemon status`.

Qué pedirle a TI si aun así se bloquea `node.exe` o la descarga del modelo:

- Una excepción por carpeta (no por hash) para `%LOCALAPPDATA%\gaze`, en Behavioral Protection / Anti-Ransomware y en el antivirus: ahí se escribe el modelo, la base y los archivos del daemon.
- Permitir a `node.exe` abrir y escuchar el named pipe `\\.\pipe\gaze-<usuario>`, y que `node.exe` pueda salir por https a `huggingface.co` y a los hosts del CDN de arriba (o, si no hay salida, copiar el modelo ya descargado a la misma ruta de la caché).

No hay ejecutable de gaze que aprobar por hash: lo que se ejecuta es `node.exe`.

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

Las carpetas de inkwell sin vínculo con bita nunca crean un proyecto: se asignan a un proyecto o grupo conocido; si no, al proyecto conocido cuyo nombre normalizado sea el prefijo más largo del nombre de la carpeta; si no, a `global`. Las entradas que caen en `global` usan el `project`/`projectId` del frontmatter si es conocido.

Es incremental por fecha de modificación. Las entradas de bita llegan solas por eventos (`gaze bita-hook`, suscrito a `stop`, `amend` y `delete`). Los cambios de páginas y notas de inkwell también: `gaze inkwell-hook` está suscrito a `docs.changed` y, por cada cambio, ingiere el archivo escrito (`written`), olvida la nota borrada (`deleted`, o un `written` cuyo archivo ya no existe; un `deleted` cuyo archivo sigue en disco solo la refresca) y al mover (`moved`) renombra la clave (aplica primero todos los movimientos del evento como un solo paso, así que cadenas e intercambios conservan sus notas) conservando la nota, sus enlaces, visitas e inyecciones; si el destino ya tenía nota, la reemplaza y le pasa sus enlaces entrantes. Ignora rutas absolutas, con `..`, que no sean `.md`, con algún tramo que empiece por `.` o que estén bajo carpetas `.assets`; mover hacia una de ellas olvida la nota de origen. Solo acepta un `docsRoot` absoluto (si no, usa `INKWELL_DOCS_DIR`) y marca `rootMismatch` cuando no coincide con la raíz configurada. Si una carpeta no resuelve a un proyecto conocido, refresca los proyectos de bita una vez por evento. Sale con código 1 si algún cambio falló, tras imprimir el resumen.

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
gaze uninstall          # quita el registro de kit; la base se queda en ~/.local/share/gaze (en Windows, %LOCALAPPDATA%\gaze)
npm uninstall -g @kikedealba/gaze
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

Para un directorio, en este orden (gana el primero que acierta):

1. `GAZE_PROJECT`.
2. Caché en la base: 24 horas; 1 hora si el resultado fue `global`.
3. `bita repo which --json`, solo dentro de un repo.
4. `scopeMapping` de `~/.config/bita/config.json` (el prefijo más largo) con el slug del directorio: el remoto `origin`; sin remoto, o en una carpeta sin repo, la ruta relativa a `~/dev` en minúsculas (`~/dev/github.com/KikeDeAlba` → `github.com/kikedealba`).
5. `gaze.toml` (`project = "Nombre"`) en la raíz del repo; sin repo, se busca hacia arriba dentro de `~/dev`.
6. Scope automático: compara los segmentos del slug (del más profundo al más superficial, sin el host) con los nombres de proyecto de bita. Ignora los segmentos de menos de 4 caracteres y los genéricos (`api`, `apps`, `web`, `core`, `shared`, `services`, `devops`, `infra`, `platform`, `docs`, `frontend`, `backend`, `modules`, `tools`, `test`, entre otros). Acierta si el nombre normalizado (sin acentos, espacios, `-` ni `_`) es igual al segmento, o si el nombre empieza con el segmento en frontera de palabra (`doters-sso` → «Doters SSO Legacy», `kikedealba` → «KikeDeAlba Modules»; `viva` no acierta con «Vivaaerobus»), y el resultado es único. Lo registra con `bita scope set <prefijo> <id>` (fuente `auto-scope`; `suggestion` si bita falla) y lo anota en `harvest.log`.
7. `global`.

Los hooks (inicio de sesión y prompt) no corren el scope automático ni `bita projects`, para no pasarse de su tiempo límite: si su resolución da `global` sin caché, lanzan en segundo plano `gaze project --cwd <dir> --refresh`, que sí lo corre y deja el resultado en el caché para el siguiente prompt o sesión. `gaze project` y la cosecha usan la resolución completa.

El nombre del proyecto se guarda como slug (igual que las carpetas de inkwell). Si el caché quedó viejo, `gaze project --refresh` lo ignora y lo rehace.

## Grupos de proyectos

Un grupo junta proyectos de un mismo cliente. Lo que se guarda en el grupo (`--project dp`) y lo de cualquiera de sus proyectos se ve desde todos ellos: reglas al iniciar sesión y resultados de búsqueda. Así «en los proyectos de DP los commits van así» se escribe una vez: `gaze rule add "..." --project dp`.

## Datos

| Qué | macOS y Linux | Windows |
|---|---|---|
| Base | `~/.local/share/gaze/gaze.db` (SQLite con sqlite-vec y FTS5) | `%LOCALAPPDATA%\gaze\gaze.db` (`node:sqlite` con FTS5; los vectores van en una tabla `chunk_vectors`) |
| Daemon | Socket `~/.local/share/gaze/gaze.sock` | Named pipe `\\.\pipe\gaze-<usuario>`; token en `%LOCALAPPDATA%\gaze\daemon.token` |
| Bitácoras | `harvest.log` y `serve.log` en la carpeta de la base | `harvest.log` y `serve.log` en `%LOCALAPPDATA%\gaze` |
| Configuración | `~/.config/gaze/config.toml` | `%APPDATA%\gaze\config.toml` |
| Modelo | `~/.cache/gaze/models` | `%LOCALAPPDATA%\gaze\cache\models` |

`GAZE_DB_PATH` cambia la base y `GAZE_DATA_DIR` la carpeta de datos; `GAZE_SOCKET` cambia el socket o el pipe y `GAZE_CACHE_DIR` la caché. Fuera de Windows, el port JS se niega a abrir una base del binario nativo (`vec0`): para probarlo, apúntale otro `GAZE_DATA_DIR`.

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

con `GAZE_HARVEST=1`, que apaga todos los hooks de gaze en esa sesión hija. El prompt incluye los proyectos conocidos (tabla de proyectos y grupos). Cada nota va al proyecto de la carpeta, salvo que el modelo la atribuya a otro proyecto conocido o a `global`; un nombre desconocido cae al proyecto de la carpeta. Lo que devuelve se guarda con deduplicación y queda en `~/.local/share/gaze/harvest.log`.

## Desarrollo

```sh
cargo test                      # usa un embedder falso: no descarga modelos
cargo clippy --all-targets -- -D warnings
cargo build --release
npm run test:npm                # lanzador e instalador de npm, contra un servidor local
```

El port de Windows tiene sus propias pruebas en `packages/gaze-win32` (ver su [README](packages/gaze-win32/README.md)); la paridad con el binario de Rust corre en CI.

`GAZE_DOWNLOAD_BASE` cambia la URL base de los releases (por omisión `https://github.com/KikeDeAlba/gaze/releases/download`). Solo acepta https, salvo `http://127.0.0.1` y `http://localhost`, y avisa por stderr cuando se usa; las pruebas del instalador la apuntan a un servidor local y generan su propio `checksums.json`. `npm/checksums.json` no se versiona: para probar el paquete a mano, créalo con el formato `{"version":"<v>","assets":{"<target>":{"file":"gaze-<v>-<target>.tar.gz","sha256":"<hex>"}}}`.

`GAZE_EMBEDDER=fake` sirve para probar la CLI sin modelo.

## Licencia

MIT
