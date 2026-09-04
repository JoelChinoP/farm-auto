**Orden Recomendado**

El desarrollo óptimo debe seguir un vertical slice seguro:

1. Fundaciones persistentes.
2. Dispositivos reales y Appium seguro.
3. Facebook sin efectos públicos.
4. Facebook 1×1 controlado.
5. Facebook multidispositivo.
6. TikTok reutilizando la infraestructura estable.

No conviene implementar Facebook y TikTok simultáneamente. Facebook debe funcionar completamente en un caso mínimo antes de escalarlo y antes de iniciar TikTok.

**Punto De Partida**

El agente debe considerar que actualmente:

- `src/app/*` contiene únicamente una demo visual con `useReducer`, fixtures y `setTimeout`.
- `src/app/demo-state.ts` no debe convertirse en fuente de verdad real.
- `src/app/control-panel.types.ts` contiene tipos visuales, no un modelo persistente definitivo.
- Solo existe `/api/health`.
- `src/lib/database.ts` está en esquema SQLite versión 1.
- `src/lib/queue.ts` tiene una cola genérica, pero todavía no conoce campañas, asignaciones, cancelaciones ni efectos públicos.
- No existe worker real.
- Mantine 9.6.0 ya está instalado y debe conservarse.
- El límite de la versión V2 es de `1 a 10` URLs, aunque el análisis antiguo mencione hasta 50. No mezclar ambos contratos.
- Facebook web solo debe extraer contexto. Like y comentario se realizan desde Facebook móvil mediante Appium.

**Arquitectura Objetivo**

```text
UI Mantine
   ↓
Route Handlers cortos
   ↓ valida, persiste y responde 202
SQLite + cola
   ↓
Worker Node único
   ├── ADB
   ├── Appium
   ├── Playwright + Edge
   └── DeepSeek
   ↓
Snapshots de estado
   ↓
UI mediante polling inicialmente
```

El agente no debe ejecutar procesos largos dentro de un Route Handler ni depender de timers del navegador.

**Fase 1: Contratos Y Persistencia**

Implementar primero el modelo real sin realizar ninguna acción pública.

Alcance:

- Separar los tipos de dominio de los tipos visuales.
- Crear un estado propio para `Assignment`, sin reutilizar `PostStatus`.
- Definir estados canónicos para campaña, publicación, asignación, operación, preparación, sesión y cleanup.
- Mantener `outcome_unknown` como estado final que requiere reconciliación manual.
- Crear migraciones SQLite desde la versión actual `1`.
- No copiar directamente las migraciones antiguas de `farm-auto`; algunas podían eliminar datos operativos.
- Crear respaldo de SQLite antes de migrar.
- Persistir perfiles, preparación, operaciones, locks, campañas, publicaciones, comentarios, asignaciones, horarios, checkpoints y evidencias.
- Adaptar la cola para incluir `campaignId`, `postId`, `assignmentId`, `operationId`, cancelación y fase de efecto.
- Impedir que `recoverStaleJobs` reintente automáticamente una asignación que pudo producir un efecto público.
- Añadir idempotencia para creación, preparación, extracción, generación, ejecución, cancelación y reconciliación.
- Rechazar la misma clave idempotente si el payload cambió.
- Crear el envelope HTTP:

```json
{
  "success": true,
  "data": {}
}
```

```json
{
  "success": false,
  "code": "DEVICE_NOT_READY",
  "message": "El dispositivo no está preparado",
  "details": {}
}
```

- Mantener todas las mutaciones restringidas a loopback y al header de cliente del panel.
- No guardar secretos de DeepSeek ni cookies en SQLite.

Criterios de salida:

- Migraciones probadas con base vacía y base existente.
- Dos conexiones no pueden reclamar la misma tarea.
- Una operación repetida con la misma idempotency key devuelve el resultado anterior.
- Una tarea con efecto público incierto no vuelve a `pending`.
- `npm run check` pasa.
- Todavía no se ejecutan likes, comentarios ni tap tap.

**Fase 2: Dispositivos Y Appium Seguro**

Construir el núcleo de hardware antes de Facebook.

Alcance:

- Implementar inventario ADB usando siempre serial explícito.
- Ejecutar comandos con `spawn` o `execFile`, nunca con strings enviados a un shell.
- No ejecutar `adb kill-server`.
- Detectar conexión, autorización, modelo, `ro.serialno`, `android_id`, paquetes instalados y foreground.
- Verificar que el `hardwareId` coincida con el perfil registrado.
- Implementar preparación secuencial por dispositivo.
- Crear locks persistentes por dispositivo físico.
- Crear un worker local único con ownership y recuperación.
- Crear un cliente Appium propio para runtime.
- Mantener MCP Appium/Android únicamente para diagnóstico y pruebas.
- Usar capacidades explícitas:

```json
{
  "platformName": "Android",
  "appium:automationName": "uiautomator2",
  "appium:udid": "<serial>",
  "appium:systemPort": 8200,
  "appium:noReset": true,
  "appium:autoLaunch": false,
  "appium:suppressKillServer": true
}
```

- Reservar un `systemPort` único entre `8200` y `8299`.
- Crear timeout para cada operación ADB, Appium y cleanup.
- Confirmar jerarquía Android válida.
- Confirmar retorno a Home.
- Cerrar solamente sesiones Appium creadas por Farm Appium.
- Guardar `metadata.json`, screenshot y page source cuando falle Appium después de crear sesión.
- Marcar el dispositivo como `recovery_required` si el cleanup queda incierto.
- Mostrar siempre `Disponible para Farm Appium`, nunca “dispositivo libre globalmente”.

Implementar primero estas operaciones seguras:

- Preparar dispositivo.
- Leer estado.
- Abrir Home.
- Abrir una URL inocua.
- Verificar foreground.
- Cerrar sesión propia.
- Volver a Home.

Criterios de salida:

- Un serial no allowlisted nunca se utiliza.
- Dos workers no pueden usar el mismo dispositivo.
- Dos sesiones no pueden usar el mismo serial ni puerto.
- Un fallo de preparación no ejecuta ninguna acción pública.
- GenFarmer permanece intacto.
- E2E smoke seguro funciona con uno y luego dos dispositivos.
- No se ejecutan todavía likes ni comentarios.

**Fase 3: Facebook Read-Only Y Generación**

Conectar Facebook, pero todavía sin publicar.

Alcance de campaña:

- Crear campaña Facebook persistente.
- Seleccionar explícitamente dispositivos elegibles.
- Validar en servidor entre 1 y 10 URLs.
- Aceptar `facebook.com`, subdominios y `fb.watch`.
- Rechazar HTTP, credenciales, puertos no estándar, comillas, caracteres de control y redirecciones externas.
- Normalizar URL y detectar duplicados.
- Crear exactamente una publicación por URL.
- Mantener los posts en orden estable.
- Crear asignaciones `post × device` sin duplicados.
- Si Comentario está desactivado, no extraer contexto ni llamar a IA.

Extracción:

- Usar `launchPersistentContext` de Playwright con un perfil Edge dedicado fuera del repositorio.
- No utilizar el perfil personal predeterminado.
- No iniciar dos procesos con el mismo perfil.
- Detectar cookie `c_user`.
- Si falta sesión, responder `session_required`.
- No automatizar login, 2FA, CAPTCHA ni checkpoints.
- Expandir `Ver más`.
- Rechazar publicación ambigua, vacía, truncada o redirigida.
- Guardar contexto, URL final, hash, fecha, fuente y versión del extractor.
- Permitir edición manual.
- Versionar cada cambio de contexto.
- No ejecutar likes o comentarios desde Edge.

Generación:

- Usar `fetch` server-side contra DeepSeek.
- Mantener la API key exclusivamente en el servidor.
- Una petición IA por publicación para todos sus dispositivos.
- La respuesta debe identificar cada comentario con `assignmentId`.
- Validar JSON, cantidad exacta, longitud `2..500` y rango de palabras.
- No persistir respuestas parciales.
- Cancelar con `AbortSignal`.
- Separar el cupo de extracción del cupo de IA.
- No sobrescribir ediciones manuales sin confirmación.
- Cambiar contexto o intención debe marcar comentarios como desactualizados.

UI:

- Sustituir progresivamente los timers de `control-panel.tsx` por Route Handlers.
- Mantener la interfaz actual de Mantine.
- Conectar primero mediante polling de snapshots versionados.
- No introducir SSE hasta que el flujo funcione; agregarlo después solo si aporta valor medible.
- Recargar la página debe conservar campañas, publicaciones, comentarios y estados.

Criterios de salida:

- Una campaña preparada sobrevive a una recarga.
- La sesión ausente se distingue de un error técnico.
- La generación no puede iniciar con contexto inválido.
- Un cambio de contexto obliga a regenerar.
- No ocurre ninguna acción móvil pública.
- Los duplicados HTTP no crean duplicados persistentes.

**Fase 4: Facebook 1×1 Controlado**

Esta es la primera fase que puede producir un efecto público. Debe requerir autorización explícita del usuario y contenido controlado.

Alcance inicial obligatorio:

- Una campaña.
- Una publicación.
- Un dispositivo preparado.
- Una cuenta Facebook controlada.
- Like y comentario independientes.
- Confirmación explícita antes de iniciar.
- Sin rotación ni horarios todavía.

Secuencia de ejecución:

1. Revalidar perfil, serial, hardware, conexión, Appium, Facebook instalado y lock.
2. Crear sesión Appium propia.
3. Abrir Facebook móvil.
4. Confirmar foreground.
5. Confirmar identidad de cuenta y publicación.
6. Guardar checkpoint `before_like`.
7. Leer el estado actual del Like.
8. Si ya está activo, no pulsar.
9. Si no está activo, pulsar una sola vez y confirmar.
10. Guardar checkpoint `before_comment`.
11. Abrir compositor.
12. Escribir el texto exacto.
13. Leer el texto antes de enviar.
14. Enviar comentario.
15. Confirmar visibilidad.
16. Persistir resultado por acción.
17. Cerrar sesión propia.
18. Enviar Home y confirmarlo.

Reglas críticas:

- Si el Like fue confirmado y el comentario falla, no repetir el Like.
- Si el comentario pudo enviarse pero no puede confirmarse, usar `outcome_unknown`.
- Un error de cleanup nunca convierte un efecto confirmado en reintentable.
- Una acción incierta no se reintenta automáticamente.
- Guardar checkpoint antes de cada posible efecto.
- Guardar screenshot, page source y metadatos ante incertidumbre.
- Implementar reconciliación manual con `sent` o `not_sent`.
- El botón de reintento automático no debe aparecer para `outcome_unknown`.

Pruebas obligatorias:

- Fallo antes del Like.
- Fallo después del Like.
- Like ya activo.
- Timeout después de enviar comentario.
- Crash antes de persistir el resultado.
- Fallo durante Home.
- Repetición de la misma petición idempotente.
- Cancelación antes y durante cada frontera.

La fase no se considera aprobada si el agente no demuestra que un comentario posiblemente enviado no vuelve a enviarse automáticamente.

**Fase 5: Facebook Multidispositivo Y Operación Real**

Solo después de aprobar la fase 4.

Alcance:

- Crear el producto cartesiano exacto `N dispositivos × M publicaciones`.
- Mantener la selección explícita de dispositivos de la V2.
- Cada dispositivo procesa todas las publicaciones.
- Un job independiente por asignación.
- Una petición IA por publicación.
- Primera publicación con prioridad.
- Paralelismo entre dispositivos.
- Secuencia estricta por dispositivo.
- Horarios persistidos en SQLite.
- El navegador no controla la programación.
- Reanudar desde SQLite después de reinicio.
- Worker único con claim transaccional.
- Lock por dispositivo físico.
- Registrar identidad de cuenta o fingerprint de sesión por plataforma.
- Bloquear la escala si dos dispositivos usan una misma cuenta sin una decisión explícita.
- Persistir checkpoints y resultados por acción.
- Implementar cancelación global y cancelación individual.
- Detener nuevos claims antes de cancelar tareas activas.
- Cerrar sesiones propias y confirmar Home.
- Marcar cleanup incierto de forma independiente.
- Conservar todas las asignaciones en Historial.
- Impedir reemplazar una campaña con efectos públicos o reconciliaciones pendientes.
- Implementar retiro seguro de dispositivos ocupados.

Concurrencia inicial:

- Appium: una sesión por dispositivo.
- Extracción Facebook: una extracción por perfil.
- IA: dos solicitudes globales inicialmente, configurable hasta cuatro.
- Dispositivos diferentes: paralelos.
- Un mismo dispositivo: secuencial.

Criterios de salida:

- 10 URLs generan exactamente `10 × N` asignaciones.
- Dos workers no duplican trabajo.
- Reiniciar el proceso no repite efectos.
- Cancelar antes del efecto produce `cancelled`.
- Cancelar después de un posible efecto produce `outcome_unknown`.
- Un fallo de una publicación no detiene las demás.
- Historial muestra plan, resultado, cleanup, checkpoints y evidencias.
- GenFarmer no se cierra ni se administra.
- El aborto nunca ejecuta `taskkill`, `adb kill-server` ni cierra Edge/Chrome ajeno.

**Fase 6: TikTok**

TikTok debe implementarse únicamente después de que Facebook supere todos los criterios anteriores.

Primera parte: TikTok post 1×1.

- Crear un adaptador separado de Facebook.
- No reutilizar selectores ni asumir la misma estructura de UI.
- Reutilizar únicamente campañas, asignaciones, IA, locks, checkpoints, historial y cleanup.
- Validar solo `tiktok.com` y subdominios.
- Exigir dispositivo preparado y TikTok instalado.
- Verificar foreground, cuenta y publicación.
- Leer el estado actual del Like para no convertirlo en Unlike.
- Introducir y verificar el comentario.
- Confirmar visibilidad.
- Aplicar exactamente las mismas reglas de `outcome_unknown`.
- Usar contexto manual inicialmente si no existe un extractor TikTok definido.
- No crear un extractor web TikTok por analogía con Facebook.

Segunda parte: TikTok Live.

- Mantenerlo separado del flujo de post.
- Exigir URL Live válida.
- Validar rondas entre 1 y 50.
- Validar X/Y entre 0 y 5000.
- Calibrar coordenadas en un dispositivo controlado.
- Confirmar el conteo exacto de doble toque.
- Añadir checkpoints y cleanup.
- Tratar un tap posiblemente ejecutado como efecto incierto.
- No reintentar automáticamente una ronda incierta.
- Mantener Tap tap deshabilitado hasta completar esta prueba independiente.

**Puerta Facebook-TikTok**

El agente no debe comenzar TikTok hasta demostrar:

1. Preflight Appium exitoso y fallido.
2. Extracción Facebook con sesión válida.
3. Estado `session_required` correctamente mostrado.
4. Generación IA válida y validada.
5. Edición de contexto e invalidación de comentarios.
6. Ejecución Facebook sobre un dispositivo y publicación controlados.
7. Like ya activo sin producir Unlike.
8. Fallo posterior a un posible envío convertido en `outcome_unknown`.
9. Reconciliación manual sin reintento automático.
10. Cancelación antes, durante y después de cada etapa.
11. Reinicio sin duplicar acciones.
12. Evidencias disponibles en Historial.
13. Cleanup incierto bloqueando el dispositivo.
14. GenFarmer intacto.
15. Campaña multidispositivo estable con producto `N×M`.