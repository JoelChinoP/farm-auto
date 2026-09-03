# Farm Appium

Base local para reconstruir el panel descrito en `ANALISIS_FARM_AUTO.md`.

## Inicio

```bash
npm install
npm run appium:doctor
npm run dev
```

Appium se ejecuta aparte cuando comiencen las automatizaciones:

```bash
npm run appium:server
```

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

La cola usa SQLite; no se agrega Redis, un worker ni WebdriverIO hasta que exista el primer proceso real que deba consumirlos.

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
