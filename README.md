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