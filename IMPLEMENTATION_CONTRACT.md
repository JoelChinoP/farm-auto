# Contrato de integracion

## Fuente de verdad

Antes de cambiar endpoints, campos, estados, variables, hilos o formatos `.genfarm`,
revisar siempre la documentacion de GenFarmer y lo que expone la API del servicio
local instalado. No deducir campos a partir del nombre de un control de su interfaz.

- API oficial: https://genfarmer-support.gitbook.io/genfarmer-eng/main-menu-bar/api
- Tareas: https://genfarmer-support.gitbook.io/genfarmer-eng/main-menu-bar/automation/saved-tasks
- Runs: https://genfarmer-support.gitbook.io/genfarmer-eng/main-menu-bar/automation/runs
- Endpoint inicial configurable: `http://127.0.0.1:55554`.
- El servicio instalado GenFarmer 2.6.1 se verifico en esta maquina. Ademas de los
  ejemplos oficiales, expone `GET /automation/runs/:id` con `status`, `taskId` y
  `deviceStatuses`; Farm valida estrictamente esa respuesta antes de usarla.
- La documentacion publica no define un contrato REST de programacion horaria
  ni el nombre del campo de numero de hilos. No se inventan esos campos.

## Responsabilidades

GenFarmer administra dispositivos, apps importadas, ejecuciones y logs.
Farm administra borradores en React, horarios y acuses de envio en SQLite.
No hay inventario duplicado, perfiles, Appium directo, ADB directo, historial
de acciones, cuentas sociales ni generacion de comentarios en el backend.

`GET /automation/devices` se consulta desde Python. `serialNo` es la identidad
estable y `currentDeviceId` es la conexion que se asigna a la tarea. Se respeta
`index` para ordenar y mostrar los dispositivos; sin indice se conserva el orden
recibido. Un identificador de conexion ausente impide el envio.

## Automatizaciones

Importar manualmente estos cuatro archivos desde `backend/automations/` en GenFarmer
y configurar los IDs reales de las apps resultantes. La web no importa ni modifica
workflows automaticamente. Despues de editar un paquete, actualizar la app en
GenFarmer y comprobar las entradas antes de volver a usarla.

| Archivo | Entradas |
| --- | --- |
| `open-content.genfarm` | `contentUrl`, `packageName` |
| `facebook.genfarm` | `contentUrl`, `like`, `comment`, `share`, `commentText`, `isPost`, `isReel`, `isVideo`, `isLive`, `diagnostic_only` |
| `facebook-live-rounds.genfarm` | `contentUrl`, `like`, `comment`, `share`, `commentText`, `isPost`, `isReel`, `isVideo`, `isLive`, `diagnostic_only` |
| `tiktok.genfarm` | `contentUrl`, `like`, `comment`, `share`, `save`, `commentText`, `targetText` |

Los cuatro flags son booleanos independientes. Facebook ejecuta las acciones habilitadas
en orden: Me gusta, Compartir y Comentar. Todos en `false` solo abren la URL.
`diagnostic_only` se mantiene en `false` para envios normales; al activarlo en una
prueba controlada se validan los controles sin publicar acciones.
`commentText` es obligatorio al comentar. En Facebook exactamente uno de los cuatro
flags de tipo debe ser `true`; Farm los obtiene con Playwright y no acepta una
clasificacion ambigua. El workflow no compara texto de la publicacion: conserva las
validaciones estructurales de reproductor, barra de acciones, editor, audiencia y
confirmaciones. En Reels la leyenda visible solo evita continuar si el contenido
cambia durante la ejecucion. Las variables de selectores se pueden modificar en
GenFarmer sin cambios en el backend.
`facebook-live-rounds.genfarm` es una copia independiente del flujo Facebook 2.6.20;
`facebook.genfarm` no se modifica. Cada ejecucion del nuevo paquete publica como
maximo un comentario. Farm, no el workflow, crea las rondas en orden y entrega una
tarea de un solo dispositivo despues de confirmar terminal la anterior. Esta modalidad
solo admite un Live, la accion Comentar, un mismo texto para todos los dispositivos y
1..200 rondas, sin superar el limite global de 200 filas.
La web mantiene esta modalidad en un apartado y borrador independientes de Facebook
normal; cambiar de vista no mezcla dispositivos, URLs, comentarios ni rondas.
Facebook y TikTok escriben `commentText` mediante `clientUiAutomator.sendKeys`, que
usa el teclado ADB de GenFarmer y Base64 UTF-8. No se usa el RPC `setText`, porque
GenFarmer 2.6.1 corrompe por esa ruta tildes, `ñ`, emojis y otros caracteres
multibyte. Cuando el comentario contiene emojis, Facebook no compara el texto leido
del editor: la jerarquia puede devolver `�` y detener el envio. Se conservan el
editor localizado, un unico toque en Enviar y la confirmacion posterior; los
comentarios sin emojis mantienen la comparacion exacta. Un borrador previo con `�`
se retira sin enviarlo; cualquier otro borrador previo se conserva y detiene la
accion.
Los cuatro flags deben tener default `false` en el paquete: GenFarmer 2.6.1 ignora
un `false` enviado cuando el default importado es verdadero.
Se preservan los defaults de la app importada y solo se sustituyen las entradas de
cada envio, tanto en `input` como en `variables`.

Facebook usa Lite (`com.facebook.lite`); TikTok usa `com.zhiliaoapp.musically`.
En un Facebook Live se exige el marcador visible `DIRECTO`/`LIVE`, el anuncio de
transmision y una fila estructural unica de Like, comentario y compartir antes de
cualquier accion; no se exige usuario ni descripcion visibles.
Si un enlace directo abre primero la pestaña Videos, solo se entra al unico video
visible cuando OCR confirma el marcador Live y el anuncio de transmision; ese toque
de navegacion no se repite.
Al abrir comentarios se espera la transicion hasta que aparezca el editor, sin
repetir el toque en Comentar.
Tras el unico envio de un comentario Live, la confirmacion puede ocultar el
teclado y desplazar la publicacion para revelar comentarios recientes. Antes
del desplazamiento relee la jerarquia para no enviar el gesto a un teclado que
haya reaparecido; nunca usa ese desplazamiento para justificar otro click de envio.
Compartir significa **Compartir ahora (publico)** en Facebook, **Repost** en videos
TikTok y la accion **Compartir** de la hoja de un TikTok Live. En videos TikTok las
acciones se ejecutan en el orden Like, Guardar (Favoritos), Comentar y Repost; Guardar
no existe en Live y se rechaza. Los selectores por etiqueta cubren espanol, ingles y
frances (`attribuer un`, `partager une video`, `republier`, `envoyer a`,
`copier le lien`), y el estado del Like tambien se lee de un hijo `selected`/`checked`
del control. Guardar hace un unico toque: TikTok no expone estado persistente y el
aviso se registra sin bloquear. En Live, el comentario
se confirma visible en el chat; Like es un unico toque aceptado porque TikTok no
expone un estado persistente. En videos, el estado de Me gusta se lee de
`selected`/`checked` o de la etiqueta `Video con me gusta`; si no se reconoce, el
flujo se detiene despues del unico toque sin ejecutar Comentar ni Compartir. La
validacion del enlace Live admite parametros de consulta (`?`/`#`). El panel de
comentarios puede exponer dos `EditText` con el mismo id (composer colapsado con
placeholder y editor enfocado); se prefiere el enfocado antes de comparar o escribir.
El boton de enviar puede quedar debajo del editor en el compositor nuevo; se busca
primero un `Button` pequeno alineado a la derecha junto al editor y, si no, el control
en linea del editor. `targetText` viaja
solo como contexto: el workflow no exige que el texto visible del video o Live
coincida, porque TikTok trunca la leyenda y sustituye caracteres no estandar en la
jerarquia. Los paquetes no
usan coordenadas publicas fijas ni reintentos de clicks inciertos.

GenFarmer 2.6.1 finaliza un run como `SUCCESS` incluso cuando un nodo devuelve fallo;
por tanto ese estado solo libera la cola y nunca prueba una accion social. Para TikTok
se revisa el `result.json` de evidencia y el log de la tarea. Farm no reintenta.

## Envio y programacion

1. React envia un `requestId` UUID, plataforma, dispositivos, publicaciones,
   flags y una fecha limite opcional en milisegundos Unix (`scheduledAt`).
2. Python valida la seleccion contra GenFarmer, consulta una vez la app y el usuario
   para el lote y persiste una fila por dispositivo/publicacion en `submissions`.
   Cada fila recibe una hora aleatoria entre la recepcion y el limite, ordenadas
   por publicacion dentro de cada dispositivo. Sin fecha o con limite vencido,
   queda lista para envio inmediato. El horario sorteado se conserva al repetir
   la misma solicitud; no se vuelve a sortear.
   En comentarios Live por rondas se sortea solo el inicio del lote; todas las filas
   conservan esa hora y se ordenan por ronda y luego por el orden de dispositivos de
   GenFarmer.
3. Un unico hilo trabajador consulta las filas vencidas y considera solo la primera
   de cada dispositivo. Una pendiente vencida se envia en cuanto el equipo esta
   libre, tambien tras reiniciar el backend; no se descarta ni se reprograma.
   Los handoffs llevan `GENFARMER_DISPATCH_GAP` segundos de
   pausa (ritmo inicial: 1) para no saturar GenFarmer. No hay un temporizador por
   fila, cron ni servicios adicionales. El backend debe seguir abierto; cerrar el
   navegador no detiene la programacion.
4. Antes de reclamar una fila, Farm revisa el envio anterior del mismo dispositivo.
   Para comentarios Live por rondas tambien revisa la fila anterior de la misma
   solicitud, aunque pertenezca a otro dispositivo.
   Si tiene run, consulta `GET /automation/runs/:id` cada
   `GENFARMER_COMPLETION_POLL` segundos (ritmo inicial: 5). Solo libera la siguiente
   publicacion cuando el run esta `ABORTED`, `STOPPED` o `FINISHED` (2/3/4) y su
   unico `deviceStatus` esta `SUCCESS`, `FAIL` o `ABORTED` (2/3/4). Un formato
   desconocido, un run distinto o una recepcion anterior incierta sin IDs bloquean
   el siguiente envio; nunca provocan un reintento. Si el run ya cerro (`finishedAt`)
   con el dispositivo sin iniciar (status 0), tampoco puede seguir ejecutando: se
   libera la siguiente publicacion y el envio incierto se conserva como `sent` sin
   reenviarse nunca. Si la respuesta es un run sin
   identidad (GenFarmer 2.6.1 ya no conserva ese run en su historial), el equipo no
   puede tener una ejecucion en curso: se libera la siguiente publicacion y el envio
   incierto se conserva como `sent`/`unknown` sin reenviarse nunca.
5. Cuando no hay predecesor activo se reclama atomicamente la fila y se vuelve a
   consultar la conexion. Cada tarea tiene exactamente un dispositivo.
6. Se crea la tarea (`POST /automation/tasks`), se fijan inputs/variables
   (`PUT /automation/tasks/:id`) y se crea el run (`POST /automation/runs`, `status: 0`).
7. La API instalada de GenFarmer 2.6.1 inicia el run 200 ms despues de crearlo.
   Farm no llama tambien a `PUT /automation/runs/:id/run`: el doble inicio deja
   el dispositivo en su cola interna y puede bloquear el proceso principal.

Limite inicial: 200 filas programadas/enviandose y 30 dias de anticipacion para
acotar la cola local. Una sola instancia Uvicorn, sin `--reload` ni varios
workers durante ejecuciones. Tras reiniciar se recuperan los horarios pendientes;
lo que estaba enviandose pasa a `unknown` y no se repite. Una misma solicitud con
el mismo contenido devuelve sus filas existentes; cambiar el contenido con el mismo
UUID se rechaza. Cancelar solo funciona antes de reclamar el envio.

## Estados de la web

| Estado | Significado |
| --- | --- |
| `scheduled` | Persistido, esperando horario o finalizacion del run anterior del equipo |
| `sending` | Handoff HTTP en curso |
| `sent` | GenFarmer acepto el inicio; **no significa accion completada** |
| `failed` | No enviado por desconexion, validacion o rechazo antes del run |
| `unknown` | No se puede confirmar la recepcion; revisar GenFarmer sin reenviar |
| `cancelled` | Horario cancelado antes del envio |

Los IDs de tarea y run quedan guardados para buscar en GenFarmer. El estado del run
se consulta solo para ordenar publicaciones del mismo equipo; no se consultan logs
ni se convierten resultados de ejecucion en estados locales.
Una desconexion **despues** del acuse solo se vera en GenFarmer. Actualizar la web
consulta las filas locales, no los resultados de acciones.

## Contexto y consultas

Facebook se inspecciona con un contexto Chromium nuevo de Playwright, sin cookies ni
credenciales. Se restringen las navegaciones principales y el enlace canonico a
dominios Facebook HTTPS. La URL final clasifica Reels; los marcadores visibles de
transmision clasifican Live; las rutas/metadatos de video clasifican videos y el
resto se trata como publicacion. `og:description` suele venir truncado con `...`; si
el JSON publico trae el mensaje completo y su inicio coincide, se usa ese texto
(hasta 2000 caracteres) solo como contexto para IA. Una cache en memoria de cinco
minutos y hasta 128 URLs evita repetir navegaciones. Si no hay metadatos, el tipo
todavia puede detectarse y el operador puede pegar contexto para IA.

## Comentarios con IA

Solo el endpoint `POST /api/comments` envia contexto e intencion a DeepSeek, y
unicamente cuando el operador pulsa **Generar con IA**. Usa `API_DEEPSEEK` del
`.env` de la raiz o `backend/.env` (este tiene prioridad); sin clave responde 503.
Una llamada cubre todos los dispositivos de una publicacion y debe devolver
exactamente un comentario por `deviceId` en JSON (`{"comments":[...]}`), con
`COMMENT_MIN_WORDS`..`COMMENT_MAX_WORDS` palabras, 2..500 caracteres (150 en
TikTok), una linea y sin caracteres de control; cualquier otra forma falla cerrado
con 502. Los tonos son `Cercano`, `Entusiasta`, `Informativo`, `Breve`,
`Dulce / Cálido`, `Empático / Asertivo`, `Distante / Formal`,
`Pasivo-Agresivo / Sarcástico`, `Frío / Cortante` y `Defensivo / Agresivo`.
La intencion es texto libre, con sugerencias para Ataque directo, Evitación /
Desvinculación, Crítica Constructiva, Afrontamiento Enfocado en el Problema,
Desinformación o Error Factual y Elogio o Apoyo. Las intenciones se agrupan en
filas (intencion, tono, cantidad); los equipos se asignan en orden a cada fila y
la suma debe coincidir con los dispositivos seleccionados. El comentario final
viaja por dispositivo en `publications[].comments` y puede editarse a mano. No
hay generacion automatica: la IA nunca se invoca al extraer contexto ni al
programar envios.

## Validacion en Windows

- Verificar puerto, sesion, envoltorio `success/data`, `serialNo`, `currentDeviceId`
  e `index` contra el servicio local; una forma inesperada falla cerrado.
- Importar los cuatro paquetes y probar **solo abrir** en un dispositivo controlado.
- La API instalada inicia el run al crearlo; no agregar un segundo inicio explicito.
- Confirmar que `GET /automation/runs/:id` mantiene los codigos de run y dispositivo
  verificados antes de actualizar GenFarmer.
- Verificar inputs booleanos, `Loop 1..0`, `TypeText`, selectores ES/EN y respuesta
  de `clientAdb.shell`; estan basados en paquetes historicos, no probados aqui.
- Instalar el Chromium compatible con el Playwright fijado mediante
  `python -m playwright install chromium`.
- Probar cada combinacion de flags con contenido de prueba y revisar sus logs.
- Probar desconexion antes/despues del acuse, reinicio y cancelacion de un horario.
- Farm permite concurrencia entre equipos distintos, pero nunca entrega una segunda
  publicacion al mismo equipo hasta comprobar la finalizacion de la anterior.

## Seguridad local

FastAPI, Vite y GenFarmer deben escuchar en loopback, en el mismo host Windows.
No publicar esta API sin autenticacion. Las mutaciones web requieren un origen
permitido y los POST un cuerpo JSON. No registrar comentarios ni secretos en logs.
`backend/.env` y `backend/data/app.db` ya estaban versionados en la plantilla:
se conservan sin editar sus datos, pero deben retirarse del seguimiento antes de
publicar el repositorio; `.gitignore` no elimina el seguimiento existente.
