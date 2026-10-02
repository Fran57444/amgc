# A Miracle Growing Constantly

Reproductor de musica para uso personal.

## Actualizaciones de la aplicación de escritorio

La aplicación de Windows comprueba las publicaciones de GitHub al iniciarse. Cuando encuentra una versión nueva, muestra un botón morado debajo del chat: permite descargarla y, al terminar, reiniciar para instalarla. La primera versión con esta función debe instalarse manualmente; las versiones posteriores podrán actualizarse desde ese botón.

Para publicar una actualización:

1. Incrementa `version` en `package.json` (por ejemplo, de `3.0.1` a `3.0.2`).
2. Configura `GH_TOKEN` en PowerShell con un token de GitHub que tenga permiso para publicar releases en `Fran57444/mmamgc`. No guardes el token en el repositorio.
3. Ejecuta `npm.cmd run desktop:publish`.
4. Comprueba que la release esté publicada y contenga el instalador `.exe`, `latest.yml` y el archivo `.blockmap`.

La release debe estar publicada y ser accesible para las instalaciones que actualizarán; los borradores y las releases preliminares no se ofrecen al canal estable.