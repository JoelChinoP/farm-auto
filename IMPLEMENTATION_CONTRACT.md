# Contrato de integracion

## Fuente de verdad

Antes de cambiar endpoints, campos, estados, variables, hilos o formatos `.genfarm`,
revisar siempre la documentacion de GenFarmer y lo que expone la API del servicio
local instalado. No deducir campos a partir del nombre de un control de su interfaz.

- API oficial: https://genfarmer-support.gitbook.io/genfarmer-eng/main-menu-bar/api
- Tareas: https://genfarmer-support.gitbook.io/genfarmer-eng/main-menu-bar/automation/saved-tasks
- Runs: https://genfarmer-support.gitbook.io/genfarmer-eng/main-menu-bar/automation/runs
- Endpoint inicial configurable: `http://127.0.0.1:55554`.
- El servicio no estaba disponible en esta maquina durante la implementacion.
  El contrato HTTP combina ejemplos oficiales y el cliente historico de
  `farm-auto` (`a09f80e:src/lib/genfarmer.ts`). Debe validarse en Windows.
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

Importar manualmente estos tres archivos desde `backend/automations/` en GenFarmer
y configurar los IDs reales de las apps resultantes. La web no importa ni modifica
workflows automaticamente. Despues de editar un paquete, actualizar la app en
GenFarmer y comprobar las entradas antes de volver a usarla.

| Archivo | Entradas |
| --- | --- |
| `open-content.genfarm` | `contentUrl`, `packageName` |
| `facebook.genfarm` | `contentUrl`, `like`, `comment`, `share`, `commentText`, `targetText` |
| `tiktok.genfarm` | Las mismas entradas que Facebook |

Los tres flags son booleanos independientes. Todos en `false` solo abren la URL.
`commentText` es obligatorio al comentar; `targetText` es un fragmento exacto
visible opcional, no una descripcion inventada. Las variables de selectores se
pueden modificar en GenFarmer sin cambios en el backend. Se preservan los defaults
de la app importada y solo se sustituyen las entradas de cada envio, tanto en
`input` como en `variables`.

Facebook usa Lite (`com.facebook.lite`); TikTok usa `com.zhiliaoapp.musically`.
Compartir significa **Compartir ahora (publico)** en Facebook y **Repost** en
TikTok. No hay TikTok Live. Los paquetes no usan coordenadas publicas fijas ni
reintentos de clicks. La validacion visual y cualquier fallo pertenecen a GenFarmer.

## Envio y programacion

1. React envia un `requestId` UUID, plataforma, dispositivos, publicaciones,
   flags y una fecha opcional en milisegundos Unix.
2. Python valida la seleccion contra GenFarmer, consulta una vez la app y el usuario
   para el lote y persiste una fila por dispositivo/publicacion en `submissions`.
3. Un `threading.Timer` por fila encola el envio. Un unico hilo trabajador hace los
   handoffs con `GENFARMER_DISPATCH_GAP` segundos de pausa (ritmo inicial: 1) para
   no saturar GenFarmer. Ademas, los lotes se escalonan en ventanas de
   `GENFARMER_CHUNK_SIZE` filas por publicacion: la ventana siguiente recien se
   programa `GENFARMER_CHUNK_GAP` segundos despues de la anterior (ritmo inicial:
   33/420; 0 desactiva). Es el unico programador local: sin polling de pendientes,
   sin cron ni servicios adicionales. El backend debe seguir abierto; cerrar el
   navegador no detiene la programacion.
4. Al vencer se reclama atomicamente la fila y se vuelve a consultar la conexion.
   Cada tarea tiene exactamente un dispositivo. GenFarmer administra su ejecucion;
   Farm no espera a que termine ni garantiza orden de finalizacion entre tareas.
5. Se crea la tarea (`POST /automation/tasks`), se fijan inputs/variables
   (`PUT /automation/tasks/:id`) y se crea el run (`POST /automation/runs`, `status: 0`).
6. La API instalada de GenFarmer 2.6.1 inicia el run 200 ms despues de crearlo.
   Farm no llama tambien a `PUT /automation/runs/:id/run`: el doble inicio deja
   el dispositivo en su cola interna y puede bloquear el proceso principal.

Limite inicial: 200 filas programadas/enviandose y 30 dias de anticipacion para
acotar el numero de hilos. Una sola instancia Uvicorn, sin `--reload` ni varios
workers durante ejecuciones. Tras reiniciar se recuperan los horarios pendientes;
lo que estaba enviandose pasa a `unknown` y no se repite. Una misma solicitud con
el mismo contenido devuelve sus filas existentes; cambiar el contenido con el mismo
UUID se rechaza. Cancelar solo funciona antes de reclamar el envio.

## Estados de la web

| Estado | Significado |
| --- | --- |
| `scheduled` | Persistido, esperando envio |
| `sending` | Handoff HTTP en curso |
| `sent` | GenFarmer acepto el inicio; **no significa accion completada** |
| `failed` | No enviado por desconexion, validacion o rechazo antes del run |
| `unknown` | No se puede confirmar la recepcion; revisar GenFarmer sin reenviar |
| `cancelled` | Horario cancelado antes del envio |

Los IDs de tarea y run quedan guardados para buscar en GenFarmer. No se consultan
sus logs ni se convierten errores de ejecucion posteriores en estados locales.
Una desconexion **despues** del acuse solo se vera en GenFarmer. Actualizar la web
consulta las filas locales, no los resultados de acciones.

## Contexto y consultas

Facebook permite solicitar metadatos publicos por URL. `og:description` suele venir
truncado con `...`; si el JSON publico de la pagina trae el mensaje completo y su
inicio coincide con esos metadatos, se usa ese texto (hasta 1000 caracteres). El
campo `context`, que viaja como `targetText`, se recorta a 500 para la verificacion
visible; la generacion con IA usa el texto completo (hasta 1000). Una cache en
memoria de cinco minutos y hasta 128
URLs evita repetir consultas; el navegador conserva la extraccion mientras se edita
el borrador. No se envian cookies ni credenciales.
Los redirects se restringen a dominios Facebook HTTPS y las respuestas a 1 MiB.
Si hay login, contenido privado o metadatos ausentes, se informa el error y se
permite pegar el texto. No se garantiza que los metadatos sean el texto visible
exacto; el operador debe revisarlo antes de usarlo como `targetText`.

## Comentarios con IA

Solo el endpoint `POST /api/comments` envia contexto e intencion a DeepSeek, y
unicamente cuando el operador pulsa **Generar con IA**. Usa `API_DEEPSEEK` del
`.env` de la raiz o `backend/.env` (este tiene prioridad); sin clave responde 503.
Una llamada cubre todos los dispositivos de una publicacion y debe devolver
exactamente un comentario por `deviceId` en JSON (`{"comments":[...]}`), con
`COMMENT_MIN_WORDS`..`COMMENT_MAX_WORDS` palabras, 2..500 caracteres (150 en
TikTok), una linea y sin caracteres de control; cualquier otra forma falla cerrado
con 502. Los tonos son `Cercano`, `Entusiasta`, `Informativo` y `Breve`; la
intencion es texto libre. Las intenciones se agrupan en filas (intencion, tono,
cantidad); los equipos se asignan en orden a cada fila y la suma debe coincidir
con los dispositivos seleccionados. El comentario final viaja por dispositivo en
`publications[].comments` y puede editarse a mano. No hay generacion automatica:
la IA nunca se invoca al extraer contexto ni al programar envios.

## Validacion en Windows

- Verificar puerto, sesion, envoltorio `success/data`, `serialNo`, `currentDeviceId`
  e `index` contra el servicio local; una forma inesperada falla cerrado.
- Importar los tres paquetes y probar **solo abrir** en un dispositivo controlado.
- La API instalada inicia el run al crearlo; no agregar un segundo inicio explicito.
- Verificar inputs booleanos, `Loop 1..0`, `TypeText`, selectores ES/EN y respuesta
  de `clientAdb.shell`; estan basados en paquetes historicos, no probados aqui.
- Probar cada combinacion de flags con contenido de prueba y revisar sus logs.
- Probar desconexion antes/despues del acuse, reinicio y cancelacion de un horario.
- Comprobar en GenFarmer su politica de concurrencia entre tareas del mismo equipo;
  por ahora no se simula un limite de hilos mediante un campo REST no documentado.

## Seguridad local

FastAPI, Vite y GenFarmer deben escuchar en loopback, en el mismo host Windows.
No publicar esta API sin autenticacion. Las mutaciones web requieren un origen
permitido y los POST un cuerpo JSON. No registrar comentarios ni secretos en logs.
`backend/.env` y `backend/data/app.db` ya estaban versionados en la plantilla:
se conservan sin editar sus datos, pero deben retirarse del seguimiento antes de
publicar el repositorio; `.gitignore` no elimina el seguimiento existente.
