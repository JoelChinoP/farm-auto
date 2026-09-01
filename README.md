## Runtime local en Windows

Requisitos del sistema:

- Node.js 24 y npm 10 o superior.
- JDK compatible con Android SDK y `JAVA_HOME` configurado.
- Android SDK, Platform Tools y `ANDROID_HOME` o `ANDROID_SDK_ROOT`.
- Dispositivos con depuración USB autorizada.
- `ADB_PATH` configurado o `adb.exe` disponible en `PATH`.
- `APPIUM_HOME` sin definir.

Instalación y diagnóstico:

```powershell
npm ci
npm run appium:doctor
npm run build
```

Appium y Next.js son procesos independientes. Inícialos en terminales separadas desde la raíz del proyecto:

```powershell
npm run appium:server
```

```powershell
npm start
```

Appium escucha únicamente en `127.0.0.1:4723`. Next.js no inicia ni detiene ese proceso.

## Configuración

Crea `.env` a partir de `.env.example`. Las variables del proceso Windows tienen prioridad sobre ese archivo.

Los dispositivos se incorporan desde el panel con identidad física, alias, orden y un `systemPort` único entre `8200` y `8299`. La preparación valida ADB, salud Appium, sesión UiAutomator2, jerarquía accesible y Home.

La extracción de contexto de Facebook abre la publicación en la aplicación Android mediante Appium, lee su jerarquía accesible y vuelve a Home sin intentar efectos públicos.

## Verificación

```powershell
npm run lint
npm run typecheck
npm test
npm run build
```

Los E2E físicos no forman parte de `npm test`:

```powershell
$env:RUN_APPIUM_E2E="1"
npm run test:e2e:appium
```

El smoke se ejecuta de forma secuencial sobre `APPIUM_DEVICE_IDS`, emparejando cada dispositivo con el `systemPort` en la misma posición de `APPIUM_SYSTEM_PORTS`. La configuración local validada usa `ce10171ab4d3543f04`/`8298` y `988a9838544a4b5a37`/`8299`; no ejecutes el smoke mientras Appium Inspector tenga una sesión abierta sobre alguno de ellos.

Las pruebas con efectos públicos también requieren `RUN_APPIUM_DESTRUCTIVE=1` y las variables de contenido controlado declaradas en `e2e/appium/destructive/controlled/social.test.ts`.
