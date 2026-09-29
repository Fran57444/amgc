# Massive Model: A Miracle Growing Constantly

Reproductor de musica para uso personal.

## Portadas en Discord Rich Presence

La app de escritorio registra en Discord la portada de la cancion que esta sonando.
Configura `DISCORD_CLIENT_ID` y `DISCORD_CLIENT_SECRET` como variables privadas del
servidor (en Render, desde **Environment**). El `DISCORD_CLIENT_ID` del servidor
debe coincidir con el usado por la app de escritorio. No incluyas el secreto en
el cliente de escritorio ni lo compartas. `PUBLIC_APP_URL` debe apuntar a la URL
HTTPS publica de la aplicacion para que Discord pueda acceder a las portadas.
