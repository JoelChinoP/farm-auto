# Implementation Contract

## Objetivo

Separar la programacion de la publicacion de ejecuciones, corregir el manejo temporal y ejecutar campanas de Facebook Lite de forma idempotente y paralela entre dispositivos.

## Requisitos obligatorios

### Ejecuciones

- [x] Separar "Programar" de "Publicar ejecuciones".
- [x] Programar no debe ejecutar inmediatamente salvo que corresponda por fecha/hora.
- [x] Publicar ejecuciones debe procesar las ejecuciones pendientes.
- [x] Una ejecucion nunca debe ejecutarse dos veces.
- [x] Las ejecuciones vencidas pendientes deben reconciliarse y ejecutarse.
- [x] Mantener estados consistentes antes, durante y despues de ejecutar.

### Fecha y hora

- [x] Identificar por que la hora del sistema no coincide.
- [x] Definir una unica estrategia de zona horaria.
- [x] Reconciliar ejecuciones pendientes utilizando la hora correcta.
- [x] Verificar que la interfaz muestre correctamente la hora actualizada.

### Preparar campana Facebook Lite

- [x] Ejecutar force-stop.
- [x] Ir al HOME.
- [x] Abrir Facebook Lite.
- [x] Ejecutar en paralelo sobre dispositivos conectados/configurados.

### Ejecutar campana

- [x] Abrir la publicacion con Facebook Lite.
- [x] Ejecutar acciones configuradas.
- [x] Timeout configurable por accion.
- [x] Un fallo individual no debe detener las siguientes acciones.
- [x] Registrar correctamente errores.
- [x] Cerrar Facebook Lite al terminar.
- [x] Volver al HOME.

### Paralelismo

- [x] Los dispositivos deben trabajar en paralelo.
- [x] Las acciones de un mismo dispositivo deben mantener su orden.
- [x] Un fallo en un dispositivo no debe detener los demas.

### Verificacion

- [ ] Reconciliar los 5 dispositivos configurados.
- [x] Probar los 3 enlaces indicados.
- [x] Verificar programacion.
- [x] Verificar ejecucion inmediata.
- [x] Verificar ejecuciones vencidas.
- [x] Verificar que no existan ejecuciones duplicadas.

## Decisiones tecnicas

- Se reutilizaran SQLite WAL, transacciones `immediate`, `operations`, `jobs` y locks por dispositivo existentes; no se agregara un scheduler, lock ni cola paralela nuevos.
- SQLite conservara timestamps como epoch en milisegundos. La UI convertira solo en sus fronteras entre epoch y componentes locales del navegador para `datetime-local` y filtros por fecha. No se aplicaran offsets manuales.
- Programar congelara el manifiesto, los schedules y las operaciones de ejecucion, pero no los jobs ejecutables. Publicar creara jobs idempotentemente; el worker reconciliara schedules vencidos que aun no tengan job.
- No se realizaran acciones publicas durante la inspeccion. Las pruebas fisicas con posibles efectos publicos se limitaran a lo solicitado y se detendran como `outcome_unknown` si el resultado no puede verificarse.
- Las preparaciones Facebook Lite se encolan con cada campana y se procesan en el mismo pool por dispositivo, limitado por `WORKER_DEVICE_CONCURRENCY` (5 por defecto).

## Archivos modificados

- `IMPLEMENTATION_CONTRACT.md`: contrato y seguimiento obligatorio de la tarea.
- `src/lib/facebook.ts`, `src/worker.ts`: programacion/publicacion idempotente, reconciliacion vencida y preparacion por campana.
- `src/lib/facebook-mobile.ts`, `src/lib/device-runtime.ts`, `src/lib/adb.ts`: timeout y resultado por accion; ciclo Facebook Lite y cleanup.
- `src/app/control-panel.tsx`, `src/app/campaign-planning-review.tsx`, `src/lib/local-time.ts`: controles separados y conversion local correcta para `datetime-local`.
- `src/lib/database.ts`: migracion 17 con inicio persistente por accion.
- `test/adb.test.ts`, `test/facebook.test.ts`, `test/facebook-mobile.test.ts`, `test/local-time.test.ts`: cobertura de lifecycle, enlaces, programacion/publicacion, vencidas, duplicados, fallos parciales y zona horaria.

## Riesgos encontrados

- La UI insertaba UTC (`toISOString().slice(0, 16)`) en `datetime-local`, que interpreta hora local al leerlo: en un host UTC-05 desplaza la programacion cinco horas.
- ADB detecta 33 dispositivos conectados y SQLite tiene mas de cinco perfiles. Los cinco de menor orden son los configurados para esta comprobacion; los equipos 1 y 2 siguen con estado persistido `recovery_required` y requieren reconciliation mediante el worker.
- La prueba de enlaces confirma normalizacion y autorizacion local; no resolvio contenido remoto ni ejecutó efectos publicos.

## Pruebas realizadas

- `npm test`: 140 pruebas aprobadas.
- Ciclo no publico en los cinco seriales configurados: `am force-stop com.facebook.lite` -> Home -> `monkey -p com.facebook.lite -c android.intent.category.LAUNCHER 1`; los cinco llegaron a `com.facebook.lite/.MainActivity` y terminaron en el launcher Samsung tras cleanup.

## Pruebas pendientes de validacion manual

- Reconciliar con el worker los equipos 1 (`988e94414444565339`) y 2 (`988919355a3031504d`), que ya estaban en `recovery_required`.
- Verificar contenido remoto de los tres enlaces sin iniciar acciones publicas.

## Estado final

- [x] Implementacion terminada.
- [x] Pruebas realizadas.
- [ ] Sin requisitos pendientes.
