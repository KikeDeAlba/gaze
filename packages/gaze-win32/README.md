# @kikedealba/gaze-win32

Port de gaze a JavaScript para Windows. Corre sobre `node.exe` con JS y `.wasm`, sin cargar ningún binario nativo. Reemplaza al `gaze.exe` que un EDR corporativo mataba al arrancar.

No se instala a mano: `@kikedealba/gaze` lo trae como `optionalDependency`, y npm solo lo instala en Windows (`"os": ["win32"]`). El comando que se usa es `gaze`, el lanzador `npm/gaze.js` del paquete principal. macOS y Linux siguen con el binario de Rust.

Requiere Node 24.5 o más nuevo. La base es `node:sqlite` (FTS5), los vectores se comparan por fuerza bruta en JS y los embeddings usan `onnxruntime-web` (WASM) con el modelo q8 `Xenova/multilingual-e5-small`, que se descarga a `%LOCALAPPDATA%\gaze\cache`. Una base 0.6.x con `vec0` se migra al abrirla y se reindexa.

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
