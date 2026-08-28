# Reporte de estado del panel y dispositivos

**Fecha de corte (UTC):** 2026-08-28T19:12:19Z  
**Revision evaluada:** `da82f11` más cambios locales de esta sesión  
**Entorno:** Windows, Node.js `v24.20.0`, npm `11.19.0`, Next.js `16.3.3`, GenFarmer `2.6.1`

## Resultado ejecutivo

**Estado global: NO APTO para ejecutar automatizaciones de produccion.**

- El panel compila, arranca y responde correctamente en `http://127.0.0.1:3000`.
- Las 27 pruebas automaticas, ESLint y el build de produccion finalizaron correctamente.
- ADB detecta 17 de 17 dispositivos en estado `device`, todos autorizados.
- GenFarmer detecta los mismos 17 seriales mediante USB.
- TikTok y Facebook estan instalados en los 17 dispositivos.
- Cinco dispositivos tienen los 6 paquetes actuales registrados; los otros 12 tienen 0 de 6.
- Solo 3 dispositivos superaron la prueba de conectividad IP. Los otros 14 no devolvieron ruta de red ni respuesta al ping de comprobacion.
- La creacion de runs ya incluye `userId`; GenFarmer crea el run, aunque Home aun termina con estado de dispositivo `0`.
- UIAutomator devolvio una jerarquia valida en 16 de 17 dispositivos.
- Todos los dispositivos informan `health=7` (`COLD`) y `temperature=-20.0 C`; esta telemetria de bateria es anomala y debe revisarse.

## Comprobaciones del proyecto

| Comprobacion | Resultado | Evidencia |
|---|---|---|
| ESLint | OK | `npm run lint` sin errores |
| Pruebas | OK | 27 aprobadas, 0 fallidas, 0 omitidas |
| Build | OK | Compilacion, TypeScript y generacion de rutas completadas |
| Inicio de produccion | OK con advertencia | Ready en 146 ms; Next.js advierte que con `output: standalone` se debe usar `.next/standalone/server.js` |
| Pagina principal | OK | HTTP 200, `text/html`, 22,792 bytes |
| `GET /api/status` | OK | HTTP 200; GenFarmer, DeepSeek y 17 dispositivos visibles |
| GenFarmer | OK | HTTP 200, version `2.6.1` |
| DeepSeek | Configurado, no invocado | Clave presente y modelo `deepseek-v4-flash`; no se genero contenido ni se consumio la API |
| Proteccion de mutaciones | OK | Peticion sin marca y peticion con origen hostil rechazadas con HTTP 403 |

Comando de validacion principal:

```text
npm run check
```

El comando ejecuto, en orden, `npm run lint`, `npm test` y `npm run build`.

## Estado por dispositivo

Leyenda:

- **Red OK:** respuesta de `ping -c 1 -W 2 1.1.1.1` y direccion WLAN visible.
- **UI OK:** `uiautomator dump` genero XML con una etiqueta `hierarchy` valida.
- **Registro:** automatizaciones registradas localmente para ese serial, sobre un total real de 6.
- **No listo:** al menos una condicion necesaria impide una automatizacion completa.

| Serial | Modelo / pantalla efectiva | Bateria | Datos usados | Red | UI / foco detectado | Aplicaciones | Registro | Estado y causa principal |
|---|---|---:|---:|---|---|---|---:|---|
| `9888da37514e46454b` | SM-G892U / 1080x1920 | 99%* | 9% | FALLO | OK / MTP | TT 41.6.15; FB 514.0.0.65.72 | 6/6 | No listo: sin red y Home sin verificar |
| `988919355a3031504d` | SM-G892U / 1080x1920 | 99%* | 12% | FALLO | OK / Ajustes | TT 41.6.15; FB 514.0.0.65.72 | 0/6 | No listo: sin red y sin configurar |
| `98891946323046464f` | SM-G892U / 720x1280 | 99%* | 12% | FALLO | OK / no disponible | TT 41.6.15; FB 514.0.0.65.72 | 0/6 | No listo: sin red, sin foco y sin configurar |
| `9889194744474c5559` | SM-G892U / 1080x1920 | 99%* | 12% | OK | FALLO / Facebook | TT 41.6.15; FB 514.0.0.65.72 | 0/6 | No listo: UIAutomator fallo y no esta configurado |
| `98895a373638594759` | SM-G892A / 1080x1920 | 99%* | 11% | FALLO | OK / Launcher | TT 41.6.15; FB 514.0.0.65.72 | 0/6 | No listo: sin red y sin configurar |
| `988994314f46333246` | SM-G892A / 1080x1920 | 99%* | 11% | OK | OK / Launcher | TT 41.6.15; FB 514.0.0.65.72 | 0/6 | No listo: sin configurar |
| `98899a39445a494350` | SM-G892A / 1080x1920 | 99%* | 11% | OK | OK / Launcher | TT 41.6.15; FB 514.0.0.65.72 | 6/6 | No listo: Home termino con estado de dispositivo 0 |
| `98899a414649314f44` | SM-G892A / 1080x1920 | 99%* | 11% | FALLO | OK / Launcher | TT 41.6.15; FB 514.0.0.65.72 | 0/6 | No listo: sin red y sin configurar |
| `988a1b343338315936` | SCV36 / 1080x2220 | 100%* | 12% | FALLO | OK / no disponible | TT 41.6.15; FB 514.0.0.65.72 | 0/6 | No listo: sin red, sin foco y sin configurar |
| `988a1b39503035544d` | SM-G892A / 1080x1920 | 99%* | 12% | FALLO | OK / Launcher | TT 41.6.15; FB 514.0.0.65.72 | 6/6 | No listo: sin red y Home sin verificar |
| `988a5739595858584d` | SM-G892A / 1080x1920 | 99%* | 12% | FALLO | OK / Launcher | TT 41.6.15; FB 514.0.0.65.72 | 0/6 | No listo: sin red y sin configurar |
| `988a5c3653524b4f50` | SM-G892U / 1080x1920 | 99%* | 13% | FALLO | OK / Launcher | TT 41.6.15; FB 514.0.0.65.72 | 0/6 | No listo: sin red y sin configurar |
| `988a9838544a4b5a37` | SM-G892A / 1080x1920 | 99%* | 11% | FALLO | OK / Launcher | TT 41.6.15; FB 514.0.0.65.72 | 0/6 | No listo: sin red y sin configurar |
| `988c1c463038394e43` | SM-G892A / 1080x2220 | 99%* | 11% | FALLO | OK / no disponible | TT 41.6.15; FB 514.0.0.65.72 | 6/6 | No listo: sin red, sin foco y Home sin verificar |
| `988d10334e34355739` | SM-G892A / 1080x1920 | 99%* | 12% | FALLO | OK / Launcher | TT 41.6.15; FB 575.1.0.55.73 | 6/6 | No listo: sin red y Home sin verificar |
| `988dd1414330514858` | SM-G892A / 1080x1920 | 99%* | 12% | FALLO | OK / Launcher | TT 41.6.15; FB 514.0.0.65.72 | 0/6 | No listo: sin red y sin configurar |
| `ce10171ab4d3543f04` | SM-G950U / 1080x2220 | 71%* | 13% | FALLO | OK / no disponible | TT 41.6.15; FB 575.1.0.55.73 | 0/6 | No listo: sin red, sin foco y sin configurar |

\* Los 17 dispositivos estan alimentados por USB, pero Android informa estado `NOT_CHARGING`, salud `COLD` y temperatura `-20.0 C`. No se considera una lectura fisica confiable hasta revisar la telemetria o la simulacion de bateria.

Todos los equipos usan Android 9, API 28. El almacenamiento de datos tiene entre 87% y 91% libre, por lo que no se detecto presion de espacio.

## Hallazgos bloqueantes

### 1. GenFarmer crea el run, pero Home no se completa

El payload de creacion ya incluye `userId`, por lo que desaparecio el error de base de datos. La prueba real devolvio un `runId`, pero Home termino con estado global `2` y estado de dispositivo `0`:

```text
RUN_FAILED: status=2, deviceStatus=0
```

Impacto: la interfaz debe marcar el dispositivo como no listo y mostrar `RUN_FAILED` hasta que GenFarmer pueda ejecutar Home.

### 2. La mayoria de los dispositivos no tiene red

Solo estos tres seriales respondieron la comprobacion IP:

- `9889194744474c5559`
- `988994314f46333246`
- `98899a39445a494350`

Los otros 14 no mostraron ruta en `ip route` y no respondieron al ping. Las aplicaciones sociales requieren conectividad antes de una prueba funcional.

### 3. Configuracion incompleta

Estos cinco seriales tienen 6 de 6 automatizaciones registradas:

- `9888da37514e46454b`
- `98899a39445a494350`
- `988a1b39503035544d`
- `988c1c463038394e43`
- `988d10334e34355739`

Los otros 12 tienen 0 de 6. La preparacion masiva debe ejecutarse de forma secuencial y conservar el resultado individual.

## Hallazgos adicionales

- `9889194744474c5559` no genero una jerarquia UIAutomator valida en dos intentos. La extraccion accesible de Facebook puede fallar en ese equipo.
- El paquete enfocado no pudo determinarse en cuatro equipos: `98891946323046464f`, `988a1b343338315936`, `988c1c463038394e43` y `ce10171ab4d3543f04`. La verificacion posterior a abrir TikTok o Facebook depende de este dato.
- La UI obtiene ahora el manifiesto de seis paquetes desde `/api/status` y exige los slugs exactos.
- El inicio con `npm start` funciona, pero Next.js indica que no es el comando recomendado cuando `output` es `standalone`.
- Las pruebas automaticas validan esquemas, seguridad y estructura de los grafos, pero no cubren la integracion real con ADB, GenFarmer, SQLite o DeepSeek.

## Pruebas no ejecutadas

No se realizaron likes, comentarios ni toques en Live. Estas acciones generan efectos externos y requieren URLs controladas, cuentas de prueba y coordenadas calibradas.

Tampoco se genero contenido con DeepSeek para evitar consumo de API sin un caso de prueba autorizado.

## Acciones recomendadas

1. Diagnosticar por que GenFarmer deja Home con estado de dispositivo `0` aunque crea el run correctamente.
2. Restablecer Wi-Fi o la ruta de red de los 14 equipos sin conectividad y repetir una comprobacion HTTP, no solo ICMP.
3. Ejecutar la configuracion de 6 paquetes en cada serial y verificar que el registro quede en 6/6.
4. Corregir UIAutomator en `9889194744474c5559` y revisar la deteccion de foco en los cuatro equipos sin paquete enfocado.
5. Revisar la telemetria de bateria `COLD/-20.0 C` antes de operacion prolongada.
6. Ejecutar pruebas funcionales con cuentas y publicaciones controladas; verificar manualmente cada efecto desde una segunda cuenta.

## Criterio de salida

El sistema podra considerarse listo cuando:

- `npm run check` siga pasando.
- GenFarmer cree y complete un run Home sin errores.
- Cada equipo objetivo tenga red, ADB `device`, correspondencia GenFarmer y 6/6 registros.
- La aplicacion requerida este instalada y autenticada.
- UIAutomator y la deteccion de foco funcionen en cada equipo objetivo.
- Las acciones con efecto externo se validen en cuentas de prueba autorizadas.
