# GenFarmer Control Panel

Panel local para operar automatizaciones de GenFarmer con un dispositivo Android, auditoría SQLite y revisión humana. La aplicación abre contenido de TikTok/Facebook por enlace y usa DeepSeek V4 Flash para proponer borradores naturales; no publica engagement social de forma automática.

## Cómo Funciona

```text
Navegador
  -> Next.js http://127.0.0.1:3000
     -> SQLite local (auditoría, aprobación, idempotencia)
     -> DeepSeek (solo generación de texto)
     -> GenFarmer http://127.0.0.1:55554
        -> ADB -> dispositivo Android
```

El navegador nunca accede directamente a GenFarmer ni recibe la clave de DeepSeek. Los Route Handlers validan entradas, bloquean ejecuciones simultáneas por dispositivo, preparan variables de tarea y esperan el resultado de GenFarmer.

## Requisitos

- Windows con GenFarmer 2.6.1 ejecutándose.
- Node.js 24 o posterior.
- Un dispositivo o emulador autorizado por ADB.
- TikTok y/o Facebook instalados para navegación social.
- WhatsApp instalado solo si se usará el envío individual consentido.
- Una clave DeepSeek con acceso a `deepseek-v4-flash`.

## Variables De Entorno

La aplicación carga `E:\genfarm\.env`. Hay una plantilla sin secretos en `.env.example`.

| Variable | Requerida | Valor predeterminado | Uso |
| --- | --- | --- | --- |
| `API_DEEPSEEK` | Sí para redactar | Ninguno | Clave privada de DeepSeek |
| `DEEPSEEK_MODEL` | No | `deepseek-v4-flash` | Modelo de generación |
| `GENFARMER_URL` | No | `http://127.0.0.1:55554` | API local de GenFarmer |
| `GENFARMER_USER_ID` | No | `30331` | Usuario operativo local |
| `ADB_PATH` | No | ADB incluido con GenFarmer | Ejecutable ADB |
| `CONTROL_PANEL_DB_PATH` | No | `data/control-panel.sqlite` | Base SQLite del panel |

No anteponer `NEXT_PUBLIC_` a ninguna clave. No confirmar `.env` en Git.

Ejemplo:

```dotenv
GENFARMER_URL=http://127.0.0.1:55554
GENFARMER_USER_ID=30331
API_DEEPSEEK=valor_privado
DEEPSEEK_MODEL=deepseek-v4-flash
```

## Instalación Y Ejecución

Desde `E:\genfarm`:

```powershell
npm install
npm run dev
```

Abrir `http://127.0.0.1:3000`. Para producción local:

```powershell
npm run build
npm start
```

Ambos comandos enlazan únicamente a `127.0.0.1`.

## Primer Uso

1. Iniciar GenFarmer y conectar el dispositivo por ADB.
2. Abrir el panel y seleccionar el dispositivo correcto.
3. Pulsar `Preparar`. El servidor importa los paquetes faltantes, crea una tarea por automatización y la asigna únicamente a ese dispositivo.
4. La preparación termina ejecutando `Pantalla de inicio`.
5. Introducir un enlace HTTPS de TikTok o Facebook y pulsar `Abrir`.
6. Realizar manualmente cualquier like, comentario o interacción pública.
7. Pulsar `Ir a inicio` al terminar la sesión.

La preparación es idempotente: reutiliza apps/tareas registradas y no duplica la importación en cada uso.

## Automatizaciones

### Pantalla De Inicio

Archivo: `automations/device-home.genfarm`

Responsabilidad única: presionar Android Home, registrar el resultado y terminar. Se ejecuta al preparar el dispositivo, antes de una navegación y al finalizar o recuperar una acción fallida.

### Abrir Contenido Social

Archivo: `automations/open-social-content.genfarm`

Recibe `contentUrl` y `packageName` como variables de tarea. El backend acepta únicamente HTTPS y comprueba que el host corresponda a TikTok o Facebook. El paquete Android se elige en el servidor, nunca desde un valor libre del navegador.

Esta automatización no pulsa Like ni publica comentarios. Deja la aplicación abierta para revisión e interacción manual.

### WhatsApp Consentido

Archivo: `automations/whatsapp-send-consented.genfarm`

Recibe `phoneNumber` y `messageText` sin valores operativos incrustados. Abre un único chat, escribe el texto aprobado, pulsa Enviar una vez y vuelve a Home.

El backend exige borrador aprobado, consentimiento confirmado, número internacional válido, un solo dispositivo remitente e idempotencia. Un envío fallido o incierto no se reintenta automáticamente.

## Mensajes DeepSeek

El formulario solicita contexto, intención y tono. DeepSeek devuelve JSON validado por Zod. El prompt permite con moderación expresiones peruanas suaves como `chévere`, `bacán`, `tranqui`, `al toque`, `causa` o `pe`, como máximo una y solo cuando encaja.

Flujo de comentario social:

1. Generar borrador.
2. Editar y aprobar.
3. Copiar el texto aprobado.
4. Publicarlo manualmente en la app abierta.

Flujo de mensaje directo:

1. Generar borrador para WhatsApp.
2. Editar, indicar el destinatario y confirmar consentimiento.
3. Aprobar explícitamente.
4. Enviar una sola vez desde un dispositivo con WhatsApp instalado.

DeepSeek nunca selecciona teléfono, dispositivo, aprobación ni acción de envío.

## API Local

Todas las respuestas usan `{ "success": true, "data": ... }`. Los errores incluyen `code` y `message` y usan un estado HTTP apropiado.

| Método | Ruta | Función |
| --- | --- | --- |
| `GET` | `/api/status` | Salud, ADB, capacidades, registros y actividad |
| `POST` | `/api/setup` | Importar/asignar automatizaciones y ejecutar Home |
| `POST` | `/api/automations/home` | Llevar un dispositivo a Home |
| `POST` | `/api/automations/open-content` | Validar y abrir contenido social |
| `GET` | `/api/messages` | Listar borradores auditados |
| `POST` | `/api/messages/draft` | Generar un borrador con DeepSeek |
| `PUT` | `/api/messages/:id/approve` | Editar y aprobar; registrar consentimiento |
| `POST` | `/api/messages/:id/send` | Enviar un WhatsApp aprobado una vez |
| `GET` | `/api/runs/:id` | Consultar una ejecución GenFarmer |
| `DELETE` | `/api/runs/:id` | Detener una ejecución GenFarmer |

Ejemplo para abrir contenido:

```json
{
  "deviceId": "emulator-5554",
  "idempotencyKey": "8e294f88-b12d-4f59-b327-608f23317285",
  "platform": "tiktok",
  "url": "https://www.tiktok.com/@cuenta/live"
}
```

## Persistencia

`data/control-panel.sqlite` contiene:

- `automation_registry`: IDs importados por automatización y dispositivo.
- `message_drafts`: contenido, estado, consentimiento, destinatario y errores.
- `operations`: idempotencia, run de GenFarmer y resultado.
- `device_locks`: exclusión mutua temporal por dispositivo.

La base y sus archivos WAL están ignorados por Git.

## Pruebas

Verificación completa de código:

```powershell
npm run check
```

Comandos individuales:

```powershell
npm run lint
npm test
npm run build
```

Los tests comprueban hosts/protocolos permitidos, normalización de teléfono, JSON válido, ausencia de valores reales y correspondencia entre `successNode`/`failNode` y `edges`.

Prueba manual de integración:

1. Confirmar `GET /api/status` con GenFarmer y ADB en línea.
2. Ejecutar `POST /api/setup` dos veces y comprobar que no duplica apps/tareas.
3. Abrir TikTok y Facebook con enlaces válidos y confirmar el paquete en primer plano.
4. Ejecutar Home y confirmar el launcher en primer plano.
5. Probar URL HTTP, host incorrecto y dispositivo inexistente; deben fallar sin ejecutar ADB.
6. Generar un borrador real y comprobar que la clave no aparece en respuesta o logs.
7. Si WhatsApp no está instalado, comprobar el bloqueo `WHATSAPP_NOT_INSTALLED`.
8. Solo con WhatsApp y un contacto de prueba consentido, aprobar y ejecutar un envío real.

## Límites De Seguridad

- No hay envíos masivos ni programación de campañas.
- No hay likes automáticos, comentarios públicos automáticos ni engagement coordinado.
- No hay acceso del navegador a ADB, GenFarmer o DeepSeek.
- No hay reintento automático de un envío de resultado incierto.
- La disponibilidad de una app no implica que su sesión esté autenticada; el operador debe verificarla visualmente.

GenFarmer escucha actualmente en su puerto propio. Mantener las reglas de firewall sin acceso público y usar este panel solo desde el mismo PC.

## Estado Verificado En Este Equipo

Validación realizada el 26 de agosto de 2026 sobre `emulator-5554`:

- UI en `127.0.0.1:3000`: responde `200` y renderiza controles de dispositivo, contenido y mensajes.
- GenFarmer 2.6.1: salud `200`; tres paquetes y tres tareas importados sin duplicados.
- ADB: dispositivo autorizado; TikTok y Facebook detectados; WhatsApp no instalado.
- TikTok: intento HTTPS real abrió `com.zhiliaoapp.musically`.
- Facebook: intento HTTPS real abrió `com.facebook.katana`.
- Home: recuperó `com.google.android.apps.nexuslauncher` después de ambas pruebas.
- DeepSeek: `deepseek-v4-flash` generó JSON válido, persistido y aprobado.
- Errores: protocolo HTTP, host incorrecto, dispositivo inexistente, consentimiento ausente y WhatsApp ausente fueron rechazados con códigos específicos.
- Código: ESLint, seis tests automatizados, TypeScript y build de producción aprobados.

Dos condiciones externas impiden afirmar un envío completo desde GenFarmer en este momento:

- GenFarmer responde `Automation feature is expired` al validar remotamente el serial del emulador. El panel lo expone como `GENFARMER_AUTOMATION_EXPIRED`. Se debe habilitar una licencia/dispositivo válido en GenFarmer; no existe ni se implementa un bypass por ADB.
- Las reglas entrantes públicas de GenFarmer requieren permisos de administrador para deshabilitarse. La sesión actual recibió `Access denied`. Ejecutar PowerShell como administrador y correr:

```powershell
cd E:\genfarm
.\scripts\secure-genfarmer-firewall.ps1
```

El script deshabilita únicamente reglas entrantes `Allow` asociadas a `GenFarmer.exe` y después comprueba que el acceso loopback continúa funcionando.
