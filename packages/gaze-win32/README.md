# @kikedealba/gaze-win32

Port de gaze a JavaScript para Windows. Corre sobre `node.exe` con JS y `.wasm`, sin binarios nativos sin firma. Lo instala `@kikedealba/gaze` como dependencia opcional en Windows; no se usa directamente.

Requiere Node 24.5 o más nuevo. La base es `node:sqlite`, los embeddings usan `onnxruntime-web` (wasm) y el config se lee con `smol-toml`.

## Base del port

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

El daemon escucha en `\\.\pipe\gaze-<usuario>` en Windows y en `<datos>/gaze.sock` en macOS y Linux (`GAZE_SOCKET` cambia ambos). Cada arranque rota un token de 32 bytes en `<datos>/daemon.token`. Las peticiones y las respuestas van firmadas con HMAC-SHA256 sobre un nonce, así que el token nunca viaja y ni el cliente ni el servidor aceptan a quien no lo conozca. Los límites son los de gaze nativo: líneas de 1 MiB hacia el daemon, respuestas de hasta 64 MiB y 60 s de inactividad por conexión.

## Cómo se verifica

```sh
cd packages/gaze-win32
npm install --force   # fuera de Windows, npm rechaza el paquete por "os": ["win32"]
npm test
```

Las pruebas de `text`, `paths`, `config` y los nombres de pipe de `ipc` comparan caso por caso con la salida del código Rust de `src/`. La de `db` compara el DDL con `src/db.rs` cuando el repo está completo.
