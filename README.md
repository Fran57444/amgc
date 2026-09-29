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

## Instaladores

`npm run build` genera los archivos web de producción en `dist`. Este repositorio todavía no define comandos para crear instaladores de escritorio Electron ni paquetes nativos para Android o iOS.
