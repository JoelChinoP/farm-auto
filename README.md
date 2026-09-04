# Farm Appium

Base local para reconstruir el panel descrito en `ANALISIS_FARM_AUTO.md`.

## Inicio

```bash
npm install
npm run appium:doctor
```

Ejecuta cada proceso en una terminal separada:

```bash
npm run appium:server
npm run worker
npm run dev
```

El worker es obligatorio para preparación, extracción, generación y ejecuciones Facebook/TikTok. Usa un único claim transaccional en SQLite, procesa dispositivos diferentes en paralelo y mantiene secuencia estricta dentro de cada dispositivo. `WORKER_DEVICE_CONCURRENCY` limita el paralelismo móvil; `DEEPSEEK_CONCURRENCY` parte de 2 y admite hasta 4 solicitudes.

Para generación configura `API_DEEPSEEK`. La primera extracción sin cookie `c_user` abre Microsoft Edge con un perfil dedicado fuera del repositorio; inicia sesión manualmente y pulsa `Reintentar extracción`. Farm Appium no automatiza login, 2FA, CAPTCHA ni checkpoints.

Para habilitar Facebook configura `FACEBOOK_ACCOUNT_RESOURCE_ID` con el resource-id del indicador de cuenta activa, `FACEBOOK_POST_CONTAINER_RESOURCE_ID` con el contenedor de una publicación y `FACEBOOK_POST_URL_RESOURCE_ID` con el permalink/URL canónico expuesto dentro de ese contenedor. Si la compilación de Facebook ofusca esos IDs como `(name removed)`, usa `@accessibility` en los siete `FACEBOOK_*_RESOURCE_ID`: el adaptador verificará el perfil propio, el texto objetivo único y controles accesibles acotados al post. Si se habilitan comentarios, configura también `FACEBOOK_COMMENT_COMPOSER_RESOURCE_ID`, `FACEBOOK_COMMENT_EDITOR_RESOURCE_ID`, `FACEBOOK_COMMENT_SUBMIT_RESOURCE_ID` y `FACEBOOK_COMMENT_RESULT_CONTAINER_RESOURCE_ID`. La cuenta esperada se guarda por dispositivo desde **Dispositivos > Editar**; `FACEBOOK_CONTROLLED_ACCOUNT` solo sirve como fallback para ejecuciones 1×1 antiguas.

La UI acepta de 1 a 10 publicaciones, exige selección explícita de dispositivos y muestra la matriz exacta `N × M` antes de autorizarla. El worker vuelve a verificar hardware, paquete, foreground, cuenta, URL efectiva y texto objetivo, y busca cada control dentro de la estructura objetivo; no usa coordenadas. Las etiquetas accesibles de Like y del disparador de comentarios pueden calibrarse con `FACEBOOK_*_LABELS` usando `|` como separador. Para incorporar un equipo nuevo, su serial debe estar conectado y autorizado por ADB para registrar la identidad física antes de persistir el perfil.

Un Like ya activo no se pulsa. Cada posible efecto tiene un checkpoint previo. Si un comentario pudo enviarse pero no puede confirmarse, la asignación queda `outcome_unknown`, conserva screenshot, page source y metadatos, y solo puede continuar tras marcar manualmente `sent` o `not_sent` en Historial. Nunca se reintenta automáticamente.

TikTok post usa un adaptador móvil propio y solo admite `1 publicación × 1 dispositivo`, contexto manual y una cuenta controlada en `TIKTOK_CONTROLLED_ACCOUNT`. Sus resource IDs y etiquetas se configuran con `TIKTOK_*`; `TIKTOK_PUBLIC_EFFECTS_ENABLED=false` mantiene bloqueados Like y comentario hasta validar los selectores en contenido controlado.

TikTok Live es un flujo independiente. Valida URL `/@usuario/live`, 1–50 rondas y coordenadas X/Y de 0–5000; guarda un checkpoint antes de cada doble toque y no reintenta una ronda incierta. Registra la calibración exacta con `TIKTOK_LIVE_CALIBRATED_DEVICE_ID`, `TIKTOK_LIVE_CALIBRATED_X` y `TIKTOK_LIVE_CALIBRATED_Y`. `TIKTOK_LIVE_EFFECTS_ENABLED` debe permanecer en `false` hasta completar esa prueba física sobre una cuenta y Live controlados.

## OpenCode

`opencode.json` habilita permisos sin confirmacion y configura:

- Ponytail 4.9.0.
- Context7 remoto.
- Android MCP sobre ADB.
- Appium MCP oficial con UiAutomator2.
- Playwright MCP para verificar el panel web.

OpenCode reenvia `ANDROID_HOME` y `JAVA_HOME` desde el entorno del proceso con `{env:...}`. No hay rutas absolutas dependientes del sistema operativo. `adb` debe estar en `PATH`; `ADB_PATH` puede definirse para el runtime si hace falta.

`CAPABILITIES_CONFIG` y `SCREENSHOTS_DIR` son opcionales para Appium MCP. Si se usan, deben definirse en el entorno con rutas validas para la maquina; `.appium/capabilities.json` sirve como base. Reinicia OpenCode despues de cambiar la configuracion, plugins, MCPs o skills.

## Estructura inicial

```text
.opencode/skills/       instrucciones especializadas para agentes
.appium/                capacidades MCP locales
src/app/                UI y route handlers Next.js
src/lib/                configuracion, SQLite y cola
test/                   pruebas unitarias sin framework adicional
data/                   SQLite local ignorado por Git
```

La cola y el worker único usan SQLite; no se agrega Redis ni WebdriverIO.

## Convivencia con GenFarmer en Windows

En Windows, GenFarmer es una herramienta externa de inspeccion y comandos ADB. Farm Appium no inicia, cierra, reinicia, sondea ni administra su proceso. Nunca ejecuta `adb kill-server`; toda operacion ADB usa `-s <serial>`. Solo cierra sesiones Appium creadas por Farm Appium y utiliza un `systemPort` exclusivo por dispositivo.

- Next.js y Appium permanecen en loopback.
- La integracion futura usara `appium:suppressKillServer=true`.
- Nunca se ejecutara `taskkill` por nombre ni se cerraran procesos Edge o Chrome ajenos.
- La UI solo afirmara `Disponible para Farm Appium`, no disponibilidad global.
- Los puertos Appium deben reservarse sin colisionar con GenFarmer.
- El aborto global solo afecta campañas, tareas y sesiones propias.
- GenFarmer puede permanecer abierto durante toda la operacion.

## Verificacion

```bash
npm run check
```
