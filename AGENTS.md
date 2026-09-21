# Farm

- Leer `IMPLEMENTATION_CONTRACT.md` antes de tocar la integracion.
- Consultar siempre documentacion de GenFarmer y contrato del servicio local
  instalado; no inventar endpoints, estados, formatos o campos de scheduling.
- Dispositivos y orden pertenecen a GenFarmer; SQLite solo conserva envios.
- Una tarea por dispositivo/publicacion. Nunca interpretar `sent` como accion
  completada ni reintentar una recepcion incierta.
- Las cuatro automatizaciones editables estan en `backend/automations/`.
- Mantener React Compiler y controles nativos; no agregar dependencias por defecto.
- Verificar lint, typecheck, build y `python backend/check.py` sin acciones reales.
- No modificar `.env` real ni SQLite existente para pruebas. Ambos archivos ya
  estaban versionados antes de esta integracion; no publicar credenciales.
