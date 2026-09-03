# Farm Appium

## Contexto

- `ANALISIS_FARM_AUTO.md` es la especificacion funcional de referencia.
- La aplicacion es local: Next.js, SQLite, ADB y Appium/UiAutomator2.
- Los MCP Android y Appium son herramientas de desarrollo; el runtime usara APIs propias y un cliente Appium cuando exista el primer flujo.

## Reglas

- Mantener la estructura pequena; crear carpetas solo cuando exista codigo real para ellas.
- Consultar Context7 antes de usar APIs de librerias o frameworks.
- Usar SQLite como fuente persistente y transacciones para reclamar trabajos de cola.
- Seleccionar siempre el serial explicitamente cuando haya mas de un dispositivo.
- No ejecutar likes, comentarios, envios ni otras acciones publicas sin una solicitud explicita.
- Ante un posible efecto publico no verificable, detener el flujo y registrar `outcome_unknown`; nunca reintentar automaticamente.
- Guardar screenshot y page source cuando una automatizacion falle despues de crear sesion.
- Ejecutar `npm run check` despues de cambios relevantes.

## Estilo

- TypeScript estricto, App Router y Server Components por defecto.
- Preferir funciones y APIs nativas antes que nuevas abstracciones o dependencias.
- Comentarios solo para decisiones no evidentes.
