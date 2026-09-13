# Farm

Panel local React + FastAPI para enviar contenido a GenFarmer.
Dispositivos desde GenFarmer, contexto publico de Facebook y una unica tabla SQLite
para horarios y acuses. El historial de acciones se consulta en GenFarmer.

## Preparacion

Python 3.11+ y Node compatible con Vite 8 (20.19+ o 22.12+).

```sh
npm install
python -m venv backend/.venv
```

Windows PowerShell:

```powershell
backend\.venv\Scripts\python -m pip install -r backend/requirements.txt
npm run dev
```

Linux:

```sh
backend/.venv/bin/python -m pip install -r backend/requirements.txt
backend/.venv/bin/python -m uvicorn backend.app.main:app --host 127.0.0.1 --port 8000
```

`npm run dev` ejecuta juntos `npm run dev:back` y `npm run dev:front`; el panel queda
en `http://127.0.0.1:5173` y Vite delega `/api` al backend. Para produccion,
`npm run prod` construye React y sirve el panel y la API desde FastAPI en
`http://127.0.0.1:8000` con una sola instancia.

## GenFarmer

1. Iniciar GenFarmer en el mismo equipo, con la sesion operativa abierta.
2. Revisar `backend/.env.example` y ajustar `backend/.env`. Puerto inicial: `55554`.
3. Importar `backend/automations/open-content.genfarm`, `facebook.genfarm` y
   `tiktok.genfarm` desde GenFarmer. Configurar sus IDs reales en
   `GENFARMER_OPEN_APP_ID`, `GENFARMER_FACEBOOK_APP_ID` y `GENFARMER_TIKTOK_APP_ID`.
4. La API instalada de GenFarmer 2.6.1 inicia cada run al crearlo; Farm no envia
   un segundo inicio explicito. Reiniciar el backend al cambiar configuracion.

No se importa nada ni se inicia una automatizacion al abrir la web. Sin configurar
los workflows se pueden consultar dispositivos y extraer contexto, pero no enviar.

## Uso

- **Dispositivos:** refleja GenFarmer; no hay altas, bajas ni preparacion local.
- **Facebook / TikTok:** elegir equipos, URLs, acciones, revisar texto y enviar o
  programar. Los flags son independientes; sin flags solo se abre el contenido.
- **Comentarios:** las intenciones se reparten en grupos (**Intención / Tono /
  Cantidad**) que deben cubrir los equipos seleccionados; se pueden agregar o quitar
  grupos. Los equipos se asignan en orden a cada grupo. **Generar con IA** pide un
  comentario distinto por dispositivo a DeepSeek usando el contexto visible; se
  revisan y se pueden editar antes de enviar. Requiere `API_DEEPSEEK` en el `.env`
  de la raíz (o en `backend/.env`, que tiene prioridad).
- **Envios:** `Programado`, `Enviando`, `Enviado`, `No enviado`, `Por verificar` o
  `Cancelado`. Pulsar **Actualizar** para consultar cambios.

**Enviado no significa accion completada.** Consultar resultados y errores de
ejecucion en GenFarmer mediante Task ID / Run ID. No se reintentan envios inciertos.
Los horarios sobreviven a reinicios; el backend debe estar encendido para enviarlos.
Usar una sola instancia, sin `--reload` durante envios.

## Comprobaciones

```sh
npm run lint
npm run typecheck
npm run build
python -m compileall -x '/\.venv/' backend/app
python backend/check.py
```

`check.py` usa SQLite temporal y un GenFarmer simulado: nunca contacta telefonos.
Los paquetes y el contrato deben validarse en el servidor Windows antes de acciones
reales. Reglas y limites: [IMPLEMENTATION_CONTRACT.md](IMPLEMENTATION_CONTRACT.md).
