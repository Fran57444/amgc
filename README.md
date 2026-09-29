# Massive Model: A Miracle Growing Constantly

Reproductor de musica para uso personal.

## Requisitos

1. Instala Node.js 20 o superior.
2. Instala y ejecuta MongoDB localmente, o prepara una instancia MongoDB accesible desde el equipo que ejecutará el servidor.
3. Clona el repositorio y abre PowerShell en la carpeta del proyecto.

## Preparar el servidor

1. Instala las dependencias:

   ```powershell
   npm ci
   ```

2. Crea un archivo `.env` en la carpeta principal del proyecto. No publiques este archivo.
3. Agrega la URI de MongoDB y una clave de sesión persistente:

   ```dotenv
   NODE_ENV=development
   PORT=5000
   MONGO_URI=mongodb://127.0.0.1:27017/musicapp
   JWT_SECRET=REEMPLAZA_POR_UN_VALOR_ALEATORIO
   ```

4. Genera un valor aleatorio para `JWT_SECRET` y úsalo en `.env`:

   ```powershell
   node -e "console.log(require('node:crypto').randomBytes(48).toString('hex'))"
   ```

5. Si la base de datos todavía no tiene usuarios, agrega también el nombre y la contraseña iniciales del administrador. La contraseña debe tener entre 12 y 128 caracteres:

   ```dotenv
   INITIAL_ADMIN_USERNAME=tu_usuario
   INITIAL_ADMIN_PASSWORD=una_contrasena_larga_y_unica
   ```

   El administrador inicial solo se crea si la base de datos está vacía.

6. Si vas a usar Google Drive para los archivos, agrega las variables que correspondan:

   ```dotenv
   DRIVE_FOLDER_ID=
   GOOGLE_OAUTH_CREDENTIALS_JSON=
   GOOGLE_OAUTH_TOKEN_JSON=
   ```

7. Antes de ejecutar una versión que incluya la migración de contraseñas, crea una copia de seguridad de MongoDB. El servidor transforma automáticamente las contraseñas antiguas en hashes bcrypt al iniciar.

## Ejecutar en el equipo

1. Inicia MongoDB.
2. Desde la carpeta del proyecto, ejecuta:

   ```powershell
   npm run dev
   ```

3. Abre `http://localhost:5163` en el navegador.
4. Inicia sesión con la cuenta inicial o con una cuenta creada por un administrador.

## Publicar la web y habilitar tiempo real

La API y Socket.IO deben ejecutarse en un proceso Node persistente. No despliegues `backend/server.js` como función serverless: la aplicación usa conexiones Socket.IO autenticadas para presencia, actividad, seguimiento de reproducción y cambios de playlists. El blueprint `render.yaml` publica el frontend, la API y Socket.IO bajo un mismo origen y conserva los MP3 generados en un disco persistente.

1. Crea una base de datos en MongoDB Atlas. Antes de migrar una base existente, crea una copia de seguridad local:

   ```powershell
   mongodump --uri="$env:MONGO_URI" --out=.\backup
   ```

2. En Atlas, crea un usuario de base de datos con una contraseña fuerte y configura el acceso de red para el servicio Render. Permite únicamente las direcciones de salida que Render muestra para el servicio, si están disponibles; evita abrir MongoDB a todo internet.
3. Si ya tienes usuarios, canciones o playlists en MongoDB local, restaura la copia en la base de Atlas antes de publicar. Sustituye la URI por la de Atlas y el nombre de base por el que creaste:

   ```powershell
   mongorestore --uri="URI_DE_ATLAS" --nsInclude="musicapp.*" .\backup\musicapp
   ```

   Haz la primera restauración sobre una base vacía y conserva la copia de seguridad original.

4. Sube el repositorio a GitHub y, desde Render, crea un **Blueprint** conectado a ese repositorio. Render detectará `render.yaml` y preparará el servicio `mmamgc`.
5. En la configuración del servicio, completa `MONGO_URI` con la URI de Atlas. Si usas Google Drive, completa también `DRIVE_FOLDER_ID`, `GOOGLE_OAUTH_CREDENTIALS_JSON` y `GOOGLE_OAUTH_TOKEN_JSON` con los valores privados correspondientes. No los guardes en Git ni los compartas en el chat.
6. `JWT_SECRET` se genera automáticamente en Render. No lo regeneres después de publicar: invalidaría las sesiones activas. `INITIAL_ADMIN_USERNAME` y `INITIAL_ADMIN_PASSWORD` solo se necesitan si Atlas no tiene usuarios; el administrador inicial se crea únicamente con la base vacía.
7. Publica el Blueprint y espera a que `/healthz` responda con estado `ok`. La URL `https://<nombre-del-servicio>.onrender.com` será la dirección pública de la web, la API y Socket.IO. Usa esa misma URL para la versión Electron para conservar estados, actividad y seguimiento realtime entre todos los clientes.

El servicio usa el plan Starter para evitar la suspensión por inactividad y un disco persistente para que los MP3 locales generados no desaparezcan al reiniciar. El servidor de medios de Google Drive requiere las variables OAuth indicadas; sin ellas, esa función no estará disponible en producción.

## Desplegar también en Vercel

Vercel puede alojar una segunda instancia del frontend y de la API, conectada directamente a la misma base de MongoDB Atlas que Render. Esto no reemplaza ni modifica Render: ambos servicios siguen activos y leen/escriben la misma base.

1. En Vercel, importa el mismo repositorio como un proyecto separado. `vercel.json` configura el frontend estático y enruta `/api/*` a `api/index.js`; `build:vercel` compila el cliente sin intentar abrir una conexión Socket.IO serverless.
2. En **Project Settings → Environment Variables**, configura `MONGO_URI` con la misma URI de Atlas que usa Render y `JWT_SECRET` con el mismo secreto persistente para compartir sesiones. Si se usan, configura también `DRIVE_FOLDER_ID`, `GOOGLE_OAUTH_CREDENTIALS_JSON` y `GOOGLE_OAUTH_TOKEN_JSON`. No guardes secretos en Git.
3. Si Atlas limita el acceso de red, permite la salida de Vercel con una opción de egress/IP estática disponible para tu plan. No abras Atlas a cualquier IP (`0.0.0.0/0`) salvo que comprendas y aceptes el riesgo.
4. Despliega y comprueba `https://<proyecto>.vercel.app/api/health`; debe devolver `{"status":"ok","database":"connected"}`.

Render conserva Socket.IO y el realtime completo para sus propios clientes. La versión de Vercel comparte los datos de Atlas, pero no recibe ni emite eventos de Socket.IO: presencia, actividad, mensajes y playlists modificados desde Vercel no se propagan instantáneamente a clientes de Render/Vercel. La persistencia de MP3 bajo `/mp3` también pertenece al disco de Render; el almacenamiento temporal de funciones Vercel no es un reemplazo de ese disco. Usa Render para estas funciones hasta migrarlas a almacenamiento compartido y un proveedor realtime compatible con serverless.

## Aplicación de escritorio Electron

La versión de escritorio abre `https://mmamgc.onrender.com`, por lo que comparte el mismo servidor, las mismas cuentas y las mismas conexiones Socket.IO que la web. Presencia, actividad, seguimiento de reproducción, playlists y mensajes realtime siguen funcionando entre clientes. Para las descargas de YouTube, Electron inicia un proceso local limitado a esa tarea; el audio resultante se sube a Render para guardarlo en Drive o en su disco persistente. Así, la solicitud a YouTube sale desde el equipo que ejecuta Electron, mientras que la cuenta, la biblioteca y el realtime siguen usando Render. La autenticación y los datos offline permanecen en el perfil persistente de Electron. Para iniciar sesión y sincronizar con otras cuentas se necesita conexión al servidor; el modo offline de la aplicación usa las descargas locales ya guardadas.

Para ejecutar el cliente contra el servidor publicado:

```powershell
npm ci
npm run desktop
```

Para desarrollar la interfaz contra Vite en `http://127.0.0.1:5163`:

```powershell
npm run desktop:dev
```

Para generar el instalador NSIS de Windows:

```powershell
npm run desktop:build
```

El instalador se genera en `dist-electron`. El servicio local de descargas escucha solo en loopback, no carga la configuración MongoDB/Google del proyecto y usa una clave aleatoria efímera entre Electron y el proceso local. Electron mantiene `nodeIntegration` desactivado, aislamiento de contexto y sandbox habilitados; los enlaces externos HTTP(S) se abren en el navegador predeterminado.


## Comprobar cambios

Desde la carpeta del proyecto:

```powershell
npm run lint
npm run build
```

## Cerrar o actualizar

1. Para detener el servidor, vuelve a la ventana de PowerShell y pulsa `Ctrl+C`.
2. Para actualizar el código, descarga los cambios y ejecuta `npm ci`.
3. Mantén `.env`, los archivos de credenciales y las copias de seguridad ocultas.

`npm run build` genera los archivos web de producción en `dist`. `npm run desktop:build` genera el instalador de Windows; no hay instaladores nativos para Android o iOS.
