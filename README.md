# A Miracle Growing Constantly

Reproductor de musica para uso personal.

## Variables de entorno para pruebas

En desarrollo, el backend carga el archivo `.env` de la raiz del proyecto. Para habilitar Spotify y las funciones de YouTube, configura las variables necesarias:

```env
SPOTIFY_CLIENT_ID=
SPOTIFY_CLIENT_SECRET=
SPOTIFY_REDIRECT_URI=
YOUTUBE_API_KEY=
YOUTUBE_COOKIES_FILE=
```

`YOUTUBE_COOKIES_FILE` es opcional y debe apuntar al archivo de cookies de YouTube. No compartas ni subas el `.env`, ya que puede contener credenciales.

## Dispositivos de reproducción

Los dispositivos que se conectan quedan asociados a la cuenta en MongoDB y aparecen en el selector de transferencia, incluidos los que estén desconectados. El nombre mostrado se detecta a partir del navegador y la plataforma; la transferencia solo está disponible hacia dispositivos conectados. Estos cambios de historial requieren desplegar la versión actualizada del backend.