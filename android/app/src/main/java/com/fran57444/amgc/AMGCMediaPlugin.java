package com.fran57444.amgc;

import android.Manifest;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.net.Uri;
import android.os.Build;
import android.util.Log;

import androidx.core.content.ContextCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.app.NotificationCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.Locale;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

@CapacitorPlugin(
    name = "AMGCMedia",
    permissions = {
        @Permission(alias = "notifications", strings = { Manifest.permission.POST_NOTIFICATIONS })
    }
)
public class AMGCMediaPlugin extends Plugin {
    private static final String CHAT_CHANNEL_ID = "amgc_chat_messages";
    private static final String TAG = "AMGCMediaPlugin";
    private static final long MAX_OFFLINE_MEDIA_BYTES = 100L * 1024 * 1024;
    private static final long MAX_CACHED_IMAGE_BYTES = 5L * 1024 * 1024;
    private BroadcastReceiver actionReceiver;
    private final ExecutorService notificationExecutor = Executors.newSingleThreadExecutor();
    private final ExecutorService mediaDownloadExecutor = Executors.newFixedThreadPool(2);

    @Override
    public void load() {
        IntentFilter filter = new IntentFilter(AMGCMediaService.ACTION_MEDIA_CONTROL);
        actionReceiver = new BroadcastReceiver() {
            @Override
            public void onReceive(Context context, Intent intent) {
                JSObject event = new JSObject();
                event.put("action", intent.getStringExtra("action"));
                notifyListeners("mediaAction", event);
            }
        };
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            getContext().registerReceiver(actionReceiver, filter, Context.RECEIVER_NOT_EXPORTED);
        } else {
            getContext().registerReceiver(actionReceiver, filter);
        }
    }

    @PluginMethod
    public void requestNotificationPermission(PluginCall call) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
            resolvePermission(call, NotificationManagerCompat.from(getContext()).areNotificationsEnabled());
            return;
        }
        if (getPermissionState("notifications") == PermissionState.GRANTED) {
            resolvePermission(call, NotificationManagerCompat.from(getContext()).areNotificationsEnabled());
            return;
        }
        requestPermissionForAlias("notifications", call, "notificationPermissionCallback");
    }

    @PluginMethod
    public void checkNotificationPermission(PluginCall call) {
        boolean granted = NotificationManagerCompat.from(getContext()).areNotificationsEnabled()
            && (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU
                || getPermissionState("notifications") == PermissionState.GRANTED);
        resolvePermission(call, granted);
    }

    @PluginMethod
    public void openSpotifyAuthorization(PluginCall call) {
        Uri uri = Uri.parse(call.getString("url", ""));
        if (!"https".equals(uri.getScheme())
            || !"accounts.spotify.com".equalsIgnoreCase(uri.getHost())) {
            call.reject("El enlace de autorización de Spotify no es válido.");
            return;
        }
        try {
            Intent intent = new Intent(Intent.ACTION_VIEW, uri);
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);
            call.resolve();
        } catch (Exception error) {
            call.reject("No se pudo abrir Spotify en el navegador.", error);
        }
    }

    @PluginMethod
    public void downloadDriveFile(PluginCall call) {
        String fileId = call.getString("fileId", "");
        String mediaType = call.getString("mediaType", "");
        if (!fileId.matches("^[A-Za-z0-9_-]{25,}$")) {
            call.reject("El identificador del archivo de Drive no es válido.");
            return;
        }
        if (!"audio".equals(mediaType)
            && !"image".equals(mediaType)
            && !"image-large".equals(mediaType)) {
            call.reject("El tipo de recurso offline no es válido.");
            return;
        }

        mediaDownloadExecutor.execute(() -> {
            boolean isImage = mediaType.startsWith("image");
            String imageSize = "image-large".equals(mediaType) ? "w1000" : "w160";
            String[] candidateUrls = isImage
                ? new String[] {
                    "https://drive.google.com/thumbnail?id=" + fileId + "&sz=" + imageSize,
                    "https://drive.google.com/uc?export=download&id=" + fileId
                }
                : new String[] {
                    "https://drive.google.com/uc?export=download&id=" + fileId
                };
            IOException lastError = null;
            for (String candidateUrl : candidateUrls) {
                try {
                    call.resolve(downloadDriveFileToDisk(fileId, mediaType, candidateUrl));
                    return;
                } catch (IOException error) {
                    lastError = error;
                    if (isImage) {
                        Log.w(TAG, "Falló una variante de imagen de Drive; se probará la siguiente.", error);
                    }
                }
            }
            call.reject("No se pudo descargar el recurso directamente desde Google Drive.", lastError);
        });
    }

    private JSObject downloadDriveFileToDisk(String fileId, String mediaType, String sourceUrl)
        throws IOException {
        HttpURLConnection connection = null;
        File temporaryFile = null;
        try {
            connection = (HttpURLConnection) new URL(sourceUrl).openConnection();
            connection.setConnectTimeout(10000);
            connection.setReadTimeout(sourceUrl.contains("/thumbnail") ? 10000 : 30000);
            connection.setInstanceFollowRedirects(true);
            connection.setRequestProperty("User-Agent", "AMGC-Android");
            int status = connection.getResponseCode();
            if (status < 200 || status >= 300) {
                throw new IOException("Google Drive respondió " + status + ".");
            }
            String contentType = connection.getContentType();
            if (contentType != null
                && contentType.regionMatches(true, 0, "text/html", 0, "text/html".length())) {
                throw new IOException("Google Drive devolvió una página HTML en lugar del archivo.");
            }
            if (mediaType.startsWith("image")
                && sourceUrl.contains("/thumbnail")
                && (contentType == null
                    || !contentType.regionMatches(true, 0, "image/", 0, "image/".length()))) {
                throw new IOException("Google Drive no devolvió una miniatura de imagen.");
            }
            long contentLength = connection.getContentLengthLong();
            long maximumBytes = mediaType.startsWith("image")
                ? MAX_CACHED_IMAGE_BYTES
                : MAX_OFFLINE_MEDIA_BYTES;
            if (contentLength > maximumBytes) {
                throw new IOException("El archivo supera el límite de descarga offline.");
            }

            File directory = new File(getContext().getFilesDir(), "offline-media");
            if (!directory.exists() && !directory.mkdirs()) {
                throw new IOException("No se pudo preparar el almacenamiento offline.");
            }
            String extension = getMediaExtension(contentType, mediaType);
            String fileName = "image-large".equals(mediaType)
                ? fileId + ".large" + extension
                : fileId + extension;
            File destination = new File(directory, fileName);
            temporaryFile = new File(directory, fileId + "." + UUID.randomUUID() + ".tmp");
            long totalBytes = 0;
            try (InputStream input = connection.getInputStream();
                 FileOutputStream output = new FileOutputStream(temporaryFile)) {
                byte[] buffer = new byte[32 * 1024];
                int bytesRead;
                while ((bytesRead = input.read(buffer)) != -1) {
                    totalBytes += bytesRead;
                    if (totalBytes > maximumBytes) {
                        throw new IOException("El archivo supera el límite de descarga offline.");
                    }
                    output.write(buffer, 0, bytesRead);
                }
                output.getFD().sync();
            }
            if (totalBytes == 0) throw new IOException("Google Drive devolvió un archivo vacío.");
            if (destination.exists() && !destination.delete()) {
                throw new IOException("No se pudo reemplazar la copia offline anterior.");
            }
            if (!temporaryFile.renameTo(destination)) {
                throw new IOException("No se pudo guardar el archivo offline.");
            }
            temporaryFile = null;

            JSObject result = new JSObject();
            result.put("path", destination.getAbsolutePath());
            result.put("contentType", contentType == null ? "application/octet-stream" : contentType);
            result.put("bytes", totalBytes);
            return result;
        } finally {
            if (connection != null) connection.disconnect();
            if (temporaryFile != null) temporaryFile.delete();
        }
    }

    private String getMediaExtension(String contentType, String mediaType) {
        String normalizedType = contentType == null ? "" : contentType.toLowerCase(Locale.ROOT);
        if (normalizedType.startsWith("image/png")) return ".png";
        if (normalizedType.startsWith("image/webp")) return ".webp";
        if (normalizedType.startsWith("image/gif")) return ".gif";
        if (normalizedType.startsWith("image/")) return ".jpg";
        if (normalizedType.startsWith("audio/mp4")) return ".m4a";
        if (normalizedType.startsWith("audio/ogg")) return ".ogg";
        if (normalizedType.startsWith("audio/wav")) return ".wav";
        return "audio".equals(mediaType) ? ".mp3" : ".jpg";
    }

    @PermissionCallback
    private void notificationPermissionCallback(PluginCall call) {
        resolvePermission(
            call,
            getPermissionState("notifications") == PermissionState.GRANTED
                && NotificationManagerCompat.from(getContext()).areNotificationsEnabled()
        );
    }

    private void resolvePermission(PluginCall call, boolean granted) {
        JSObject result = new JSObject();
        result.put("granted", granted);
        call.resolve(result);
    }

    @PluginMethod
    public void update(PluginCall call) {
        Intent intent = new Intent(getContext(), AMGCMediaService.class);
        intent.setAction(AMGCMediaService.ACTION_UPDATE);
        intent.putExtra("title", call.getString("title", "AMGC"));
        intent.putExtra("artist", call.getString("artist", ""));
        intent.putExtra("coverUrl", call.getString("coverUrl", ""));
        intent.putExtra("coverPath", call.getString("coverPath", ""));
        intent.putExtra("isPlaying", call.getBoolean("isPlaying", false));
        intent.putExtra("shuffle", call.getBoolean("shuffle", false));
        intent.putExtra("position", call.getDouble("position", 0.0));
        intent.putExtra("duration", call.getDouble("duration", 0.0));
        try {
            ContextCompat.startForegroundService(getContext(), intent);
            call.resolve();
        } catch (Exception error) {
            call.reject("No se pudo iniciar el servicio multimedia de AMGC.", error);
        }
    }

    @PluginMethod
    public void stop(PluginCall call) {
        try {
            getContext().stopService(new Intent(getContext(), AMGCMediaService.class));
            call.resolve();
        } catch (Exception error) {
            call.reject("No se pudo detener el servicio multimedia de AMGC.", error);
        }
    }

    @PluginMethod
    public void showChatNotification(PluginCall call) {
        String title = call.getString("title", "Un amigo");
        String body = call.getString("body", "Te envió un mensaje.");
        String avatarUrl = call.getString("avatarUrl", "");
        String messageId = call.getString("id", String.valueOf(System.currentTimeMillis()));
        NotificationManagerCompat notificationManager = NotificationManagerCompat.from(getContext());
        if (!notificationManager.areNotificationsEnabled()) {
            call.reject("Las notificaciones están desactivadas en los ajustes de Android.");
            return;
        }

        createChatNotificationChannel();
        int notificationId = 8100 + Math.floorMod(messageId.hashCode(), 100000);
        NotificationCompat.Builder builder = new NotificationCompat.Builder(getContext(), CHAT_CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_amgc)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(new NotificationCompat.BigTextStyle().bigText(body))
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setAutoCancel(true)
            .setOnlyAlertOnce(true)
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
            .setContentIntent(createChatLaunchIntent());
        try {
            notificationManager.notify(notificationId, builder.build());
        } catch (SecurityException error) {
            call.reject("No se pudo publicar la notificación. Revisa los permisos de Android.", error);
            return;
        }
        call.resolve();

        if (avatarUrl.startsWith("http://") || avatarUrl.startsWith("https://")) {
            notificationExecutor.execute(() -> {
                Bitmap avatar = downloadAvatar(avatarUrl);
                if (avatar == null) return;
                builder.setLargeIcon(avatar);
                try {
                    notificationManager.notify(notificationId, builder.build());
                } catch (SecurityException error) {
                    Log.w(TAG, "No se pudo actualizar la notificación con la foto del remitente.", error);
                }
            });
        }
    }

    private void createChatNotificationChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationChannel channel = new NotificationChannel(
            CHAT_CHANNEL_ID,
            "Mensajes de amigos",
            NotificationManager.IMPORTANCE_HIGH
        );
        channel.setDescription("Mensajes recibidos de tus amigos en AMGC");
        NotificationManager manager = getContext().getSystemService(NotificationManager.class);
        if (manager != null) manager.createNotificationChannel(channel);
    }

    private PendingIntent createChatLaunchIntent() {
        Intent launchIntent = getContext().getPackageManager()
            .getLaunchIntentForPackage(getContext().getPackageName());
        if (launchIntent == null) return null;
        launchIntent.addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        return PendingIntent.getActivity(
            getContext(),
            8100,
            launchIntent,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );
    }

    private Bitmap downloadAvatar(String avatarUrl) {
        HttpURLConnection connection = null;
        try {
            connection = (HttpURLConnection) new URL(avatarUrl).openConnection();
            connection.setConnectTimeout(5000);
            connection.setReadTimeout(5000);
            connection.setInstanceFollowRedirects(true);
            try (java.io.InputStream input = connection.getInputStream()) {
                return BitmapFactory.decodeStream(input);
            }
        } catch (IOException error) {
            Log.w(TAG, "No se pudo descargar la foto del remitente.", error);
            return null;
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    @Override
    protected void handleOnDestroy() {
        if (actionReceiver != null) {
            getContext().unregisterReceiver(actionReceiver);
            actionReceiver = null;
        }
        notificationExecutor.shutdownNow();
        mediaDownloadExecutor.shutdownNow();
    }
}
