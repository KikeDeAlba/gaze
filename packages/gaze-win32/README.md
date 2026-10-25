# @kikedealba/gaze-win32

Port de gaze a JavaScript para Windows. Corre sobre `node.exe` con JS y `.wasm`, sin cargar ningún binario nativo. Reemplaza al `gaze.exe` que un EDR corporativo mataba al arrancar.

No se instala a mano: `@kikedealba/gaze` lo trae como `optionalDependency`, y npm solo lo instala en Windows (`"os": ["win32"]`). El comando que se usa es `gaze`, el lanzador `npm/gaze.js` del paquete principal. macOS y Linux siguen con el binario de Rust.

Requiere Node 24.5 o más nuevo. La base es `node:sqlite` (FTS5), los vectores se comparan por fuerza bruta en JS y los embeddings usan `onnxruntime-web` (WASM) con el modelo q8 `Xenova/multilingual-e5-small`, que se descarga a `%LOCALAPPDATA%\gaze\cache`. Una base 0.6.x con `vec0` se migra al abrirla y se reindexa.

| Módulo | Equivale a | Qué hace |
|---|---|---|
| `envelope.js` | `envelope.rs` | Sobre JSON de kit (`success`, `failure`) y `GazeError` |
| `paths.js` | `paths.rs` | Rutas de datos, config, caché, socket y token; `simplify` de rutas `\\?\` |
| `text.js` | `text.rs` y `frontmatter` de `ingest.rs` | `fold`, `terms`, chunks, `snippet`, `estimateTokens`, ids |
| `vector.js` | helpers de `embed.rs` | `normalize` en f32, `cosine`, blobs f32 little-endian |
| `config.js` | `config.rs` | `config.toml` con los mismos valores por omisión y umbrales en f32 |
| `db.js` | `db.rs` | Esquema SQLite; los vectores van en `chunk_vectors` (BLOB) en lugar de `vec0` |
| `ipc.js` | `ipc.rs` | Named pipe en Windows y socket Unix en macOS y Linux, con HMAC mutuo |

## Bases de gaze nativo (0.6.x)

Una base creada por el binario nativo usa la tabla virtual `vec0` de sqlite-vec, que `node:sqlite` no puede cargar.

- **Windows:** al abrirla, el port copia todas las tablas normales y el índice de texto a una base nueva, marca las notas sin vectores y deja la original como `gaze.db.vec0.bak`. Después hay que correr `gaze reindex` para regenerar los vectores. No usa `writable_schema`.
- **macOS y Linux:** el port se niega a abrirla, para no romper la base del binario nativo. Usa `GAZE_DATA_DIR` para darle al port su propio directorio.

## Daemon e IPC

El daemon escucha en `\\.\pipe\gaze-<usuario>` en Windows y en `<datos>/gaze.sock` en macOS y Linux (`GAZE_SOCKET` cambia ambos). Cada arranque rota un token de 32 bytes en `<datos>/daemon.token`. Las peticiones y las respuestas van firmadas con HMAC-SHA256 (contexto `gaze-ipc-v3`) sobre los dos nonces, el número de secuencia y el `sha256` del cuerpo, así que el token nunca viaja, ni el cliente ni el servidor aceptan a quien no lo conozca y un cuerpo alterado no pasa. Ambos sentidos usan el mismo sobre `{ auth, body }`, con `body` como JSON en texto. Los límites son los de gaze nativo: líneas de 1 MiB hacia el daemon, respuestas de hasta 64 MiB y 60 s de inactividad por conexión.

Rutas, daemon bajo demanda, named pipe y qué pedirle a TI: [README de gaze](../../README.md#windows-con-antivirus-o-edr-corporativo).

## Cómo se verifica

```sh
cd packages/gaze-win32
npm install --force   # fuera de Windows, npm rechaza el paquete por "os": ["win32"]
npm test
```

`npm test` corre `node --test "test/**/*.test.js"`. La prueba que carga el modelo real se salta salvo que pongas `GAZE_TEST_MODEL=1` (descarga ~135 MB):

```sh
GAZE_TEST_MODEL=1 npm test
```

### Paridad con Rust

`test/parity.test.js` compara la salida del port con la del binario de Rust, ambos con el embedder falso (`GAZE_EMBEDDER=fake`). Se salta si faltan estas dos variables:

| Variable | Qué apunta |
|---|---|
| `GAZE_PARITY_RUST` | Binario de Rust, por ejemplo `target/debug/gaze` (`cargo build` en la raíz) |
| `GAZE_PARITY_JS` | `packages/gaze-win32/bin/gaze.js` |

```sh
GAZE_PARITY_RUST="$PWD/target/debug/gaze" GAZE_PARITY_JS="$PWD/packages/gaze-win32/bin/gaze.js" node --test packages/gaze-win32/test/parity.test.js
```

Corre desde la raíz del repo. `test/store.test.js` también usa `GAZE_PARITY_RUST` para comparar la búsqueda.
