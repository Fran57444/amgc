# Massive Model: A Miracle Growing Constantly

Reproductor de musica para uso personal.

## Discord Rich Presence (Electron)

Rich Presence muestra la cancion y el artista que se estan reproduciendo. Requiere
la app de escritorio y el cliente de Discord abierto; no se activa en el navegador.
La actividad usa el tipo de escucha, muestra la cancion y el artista, y desaparece
al pausar o detener el audio. El nombre de la aplicacion que Discord muestra encima
de la actividad se configura en Developer Portal y no se puede cambiar por cancion.
Para mostrar la portada de cada cancion, define tambien
`DISCORD_CLIENT_SECRET=<Client Secret>` en el `.env` local. Se usa unicamente en
Electron para solicitar a Discord un token temporal y registrar las portadas
remotas como assets externos; nunca lo incluyas en Render ni en el codigo.

1. Crea una aplicacion en el Discord Developer Portal.
2. Copia su Application ID.
3. Define `DISCORD_CLIENT_ID=<Application ID>` en `.env` dentro de
   `%APPDATA%\\mmamgc` para la version instalada.
4. Reinicia MMAMGC y Discord.

Si no aparece la presencia, revisa `%APPDATA%\\mmamgc\\discord-rpc.log`. El registro
indica si la app leyo el ID, conecto con Discord y publico la actividad; no guarda
el ID ni el nombre de la cancion.