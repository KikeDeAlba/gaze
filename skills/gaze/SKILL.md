---
name: gaze
description: Cerebro del proyecto con gaze: busca antes de preguntar y guarda decisiones, correcciones, convenciones y datos del cliente como notas atómicas.
---

# gaze

gaze guarda lo que se aprende de cada proyecto y lo encuentra por significado. Reemplaza a la memoria automática: no escribas archivos de memoria, usa gaze.

## Buscar antes de preguntar

Si necesitas un dato del proyecto (infra, cliente, convención, por qué se decidió algo), llama `gaze_search` antes de preguntarle al usuario. Los resultados son punteros `[id] título — fragmento`; para leer una nota completa pasa su id como `query`. Los avisos `gaze:` que llegan con el prompt son punteros, no contenido: léelos solo si sirven.

## Cuándo guardar (`gaze_remember`)

- Una decisión tomada y su porqué.
- Una corrección del usuario ("no, así no").
- Una convención del proyecto o del equipo.
- Un dato del cliente o de la infraestructura (cuentas, ambientes, contactos, fechas).

Nada efímero: ni el estado de la tarea, ni pasos ya hechos, ni lo que ya está en el código o en git.

## Formato de nota

Atómica: un hecho por nota, autocontenida, 1 a 5 frases. Título corto y buscable. Enlaza notas relacionadas con `[[Título]]`. Si ya existe una parecida, gaze la fusiona sola.

`kind`: `decision`, `fact` (por defecto), `rule`, `memory`.

## Reglas vs hechos

Una regla es una instrucción permanente que debe estar en contexto en cada sesión ("nunca X", "siempre Y"); usa `gaze_rule_add` (con `until` si vence). Todo lo demás es hecho o decisión: se busca cuando hace falta y no cuesta contexto. Las reglas son caras; guárdalas solo si el usuario las pide o las repite.

`project` se omite casi siempre (sale del directorio); usa `global` para lo que aplica a todos los proyectos.
