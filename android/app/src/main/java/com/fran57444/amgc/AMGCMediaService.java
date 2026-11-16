package com.fran57444.amgc;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.util.Log;
import android.widget.RemoteViews;

import androidx.annotation.Nullable;
import androidx.core.app.NotificationCompat;
import androidx.media.app.NotificationCompat.MediaStyle;
import android.support.v4.media.MediaMetadataCompat;
import android.support.v4.media.session.MediaSessionCompat;
import android.support.v4.media.session.PlaybackStateCompat;

import java.io.ByteArrayOutputStream;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public class AMGCMediaService extends Service {
    public static final String ACTION_MEDIA_CONTROL = "com.fran57444.amgc.MEDIA_CONTROL";
    public static final String ACTION_UPDATE = "com.fran57444.amgc.MEDIA_UPDATE";
    private static final String ACTION_TOGGLE = "com.fran57444.amgc.MEDIA_TOGGLE";
    private static final String ACTION_PREVIOUS = "com.fran57444.amgc.MEDIA_PREVIOUS";
    private static final String ACTION_NEXT = "com.fran57444.amgc.MEDIA_NEXT";
    private static final String ACTION_SHUFFLE = "com.fran57444.amgc.MEDIA_SHUFFLE";
    private static final String CHANNEL_ID = "amgc_media_playback";
    private static final int NOTIFICATION_ID = 7001;
    private static final int MAX_ARTWORK_DIMENSION = 512;
    private static final int MAX_ARTWORK_BYTES = 8 * 1024 * 1024;
    private static final String TAG = "AMGCMediaService";

    private MediaSessionCompat mediaSession;
    private String title = "AMGC";
    private String artist = "";
    private String coverUrl = "";
    private String coverPath = "";
    private boolean isPlaying;
    private boolean shuffle;
    private long position;
    private long duration;
    private volatile int artworkRequestId;
    private volatile boolean destroyed;
    private long artworkRetryAfter;
    private int artworkRetryCount;
    private Bitmap artwork;
    private final ExecutorService artworkExecutor = Executors.newSingleThreadExecutor();
    private final Handler mainHandler = new Handler(Looper.getMainLooper());

    @Override
    public void onCreate() {
        super.onCreate();
        createNotificationChannel();
        mediaSession = new MediaSessionCompat(this, "AMGC Playback");
        mediaSession.setFlags(
            MediaSessionCompat.FLAG_HANDLES_MEDIA_BUTTONS
                | MediaSessionCompat.FLAG_HANDLES_TRANSPORT_CONTROLS
        );
        mediaSession.setCallback(new MediaSessionCompat.Callback() {
            @Override
            public void onPlay() {
                dispatchAction("toggle");
            }

            @Override
            public void onPause() {
                dispatchAction("toggle");
            }

            @Override
            public void onSkipToPrevious() {
                dispatchAction("previous");
            }

            @Override
            public void onSkipToNext() {
                dispatchAction("next");
            }

            @Override
            public void onCustomAction(String action, android.os.Bundle extras) {
                if (ACTION_SHUFFLE.equals(action)) dispatchAction("shuffle");
            }
        });
        mediaSession.setActive(true);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && ACTION_UPDATE.equals(intent.getAction())) {
            title = intent.getStringExtra("title");
            artist = intent.getStringExtra("artist");
            updateArtwork(intent.getStringExtra("coverUrl"), intent.getStringExtra("coverPath"));
            isPlaying = intent.getBooleanExtra("isPlaying", false);
            shuffle = intent.getBooleanExtra("shuffle", false);
            position = Math.max(0, Math.round(intent.getDoubleExtra("position", 0.0) * 1000));
            duration = Math.max(0, Math.round(intent.getDoubleExtra("duration", 0.0) * 1000));
        } else if (intent != null) {
            dispatchControlIntent(intent.getAction());
        }
        updateSessionState();
        Notification notification = buildNotification();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(
                NOTIFICATION_ID,
                notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK
            );
        } else {
            startForeground(NOTIFICATION_ID, notification);
        }
        return START_NOT_STICKY;
    }

    private void updateSessionState() {
        MediaMetadataCompat.Builder metadata = new MediaMetadataCompat.Builder()
            .putString(MediaMetadataCompat.METADATA_KEY_TITLE, title)
            .putString(MediaMetadataCompat.METADATA_KEY_ARTIST, artist)
            .putLong(MediaMetadataCompat.METADATA_KEY_DURATION, duration);
        if (artwork != null) {
            metadata.putBitmap(MediaMetadataCompat.METADATA_KEY_ART, artwork);
            metadata.putBitmap(MediaMetadataCompat.METADATA_KEY_ALBUM_ART, artwork);
        }
        mediaSession.setMetadata(metadata.build());

        long actions = PlaybackStateCompat.ACTION_PLAY
            | PlaybackStateCompat.ACTION_PAUSE
            | PlaybackStateCompat.ACTION_PLAY_PAUSE
            | PlaybackStateCompat.ACTION_SKIP_TO_PREVIOUS
            | PlaybackStateCompat.ACTION_SKIP_TO_NEXT;
        PlaybackStateCompat.Builder playback = new PlaybackStateCompat.Builder()
            .setActions(actions)
            .setState(
                isPlaying ? PlaybackStateCompat.STATE_PLAYING : PlaybackStateCompat.STATE_PAUSED,
                position,
                isPlaying ? 1f : 0f
            );
        playback.addCustomAction(
            new PlaybackStateCompat.CustomAction.Builder(
                ACTION_SHUFFLE,
                shuffle ? "Aleatorio activado" : "Aleatorio",
                R.drawable.ic_action_shuffle
            ).build()
        );
        mediaSession.setPlaybackState(playback.build());
    }

    private Notification buildNotification() {
        NotificationCompat.Builder builder = new NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_amgc)
            .setContentTitle(title)
            .setContentText(artist)
            .setLargeIcon(artwork)
            .setSubText(shuffle ? "Aleatorio activado" : "Aleatorio desactivado")
            .setCategory(NotificationCompat.CATEGORY_TRANSPORT)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setOnlyAlertOnce(true)
            .setOngoing(true)
            .setShowWhen(false)
            .setContentIntent(createLaunchIntent())
            .addAction(action(R.drawable.ic_action_shuffle,
                shuffle ? "Desactivar aleatorio" : "Aleatorio", ACTION_SHUFFLE, 0))
            .addAction(action(android.R.drawable.ic_media_previous,
                "Anterior", ACTION_PREVIOUS, 1))
            .addAction(action(
                isPlaying ? android.R.drawable.ic_media_pause : android.R.drawable.ic_media_play,
                isPlaying ? "Pausar" : "Reproducir", ACTION_TOGGLE, 2))
            .addAction(action(android.R.drawable.ic_media_next,
                "Siguiente", ACTION_NEXT, 3));
        builder.setStyle(new MediaStyle()
            .setMediaSession(mediaSession.getSessionToken())
            .setShowActionsInCompactView(0, 2, 3));
        Notification notification = builder.build();
        notification.bigContentView = buildExpandedContent();
        return notification;
    }

    private NotificationCompat.Action action(int icon, String label, String action, int requestCode) {
        return new NotificationCompat.Action.Builder(
            icon,
            label,
            createActionPendingIntent(action, requestCode)
        ).build();
    }

    private PendingIntent createActionPendingIntent(String action, int requestCode) {
        Intent intent = new Intent(this, AMGCMediaService.class).setAction(action);
        return PendingIntent.getService(
            this,
            requestCode,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );
    }

    private RemoteViews buildExpandedContent() {
        RemoteViews content = new RemoteViews(getPackageName(), R.layout.media_notification_expanded);
        content.setTextViewText(R.id.media_notification_title, title);
        content.setTextViewText(R.id.media_notification_artist, artist);
        if (artwork != null) {
            content.setImageViewBitmap(R.id.media_notification_cover, artwork);
        } else {
            content.setImageViewResource(R.id.media_notification_cover, R.drawable.ic_stat_amgc);
        }
        content.setImageViewResource(R.id.media_notification_shuffle, R.drawable.ic_action_shuffle);
        content.setImageViewResource(R.id.media_notification_previous, android.R.drawable.ic_media_previous);
        content.setImageViewResource(
            R.id.media_notification_toggle,
            isPlaying ? android.R.drawable.ic_media_pause : android.R.drawable.ic_media_play
        );
        content.setImageViewResource(R.id.media_notification_next, android.R.drawable.ic_media_next);
        content.setContentDescription(
            R.id.media_notification_shuffle,
            shuffle ? "Desactivar aleatorio" : "Aleatorio"
        );
        content.setContentDescription(R.id.media_notification_previous, "Anterior");
        content.setContentDescription(
            R.id.media_notification_toggle,
            isPlaying ? "Pausar" : "Reproducir"
        );
        content.setContentDescription(R.id.media_notification_next, "Siguiente");
        content.setOnClickPendingIntent(
            R.id.media_notification_shuffle,
            createActionPendingIntent(ACTION_SHUFFLE, 0)
        );
        content.setOnClickPendingIntent(
            R.id.media_notification_previous,
            createActionPendingIntent(ACTION_PREVIOUS, 1)
        );
        content.setOnClickPendingIntent(
            R.id.media_notification_toggle,
            createActionPendingIntent(ACTION_TOGGLE, 2)
        );
        content.setOnClickPendingIntent(
            R.id.media_notification_next,
            createActionPendingIntent(ACTION_NEXT, 3)
        );
        return content;
    }

    @Nullable
    private PendingIntent createLaunchIntent() {
        Intent launchIntent = getPackageManager().getLaunchIntentForPackage(getPackageName());
        if (launchIntent == null) return null;
        launchIntent.addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        return PendingIntent.getActivity(
            this,
            4,
            launchIntent,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );
    }

    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationChannel channel = new NotificationChannel(
            CHANNEL_ID,
            "Reproducción AMGC",
            NotificationManager.IMPORTANCE_LOW
        );
        channel.setDescription("Controles de reproducción y aleatorio");
        channel.setShowBadge(false);
        NotificationManager manager = getSystemService(NotificationManager.class);
        manager.createNotificationChannel(channel);
    }

    private void dispatchControlIntent(String action) {
        if (ACTION_TOGGLE.equals(action)) dispatchAction("toggle");
        else if (ACTION_PREVIOUS.equals(action)) dispatchAction("previous");
        else if (ACTION_NEXT.equals(action)) dispatchAction("next");
        else if (ACTION_SHUFFLE.equals(action)) dispatchAction("shuffle");
    }

    private void updateArtwork(String requestedCoverUrl, String requestedCoverPath) {
        String nextCoverUrl = requestedCoverUrl == null ? "" : requestedCoverUrl;
        String nextCoverPath = requestedCoverPath == null ? "" : requestedCoverPath;
        if (nextCoverUrl.isEmpty() && nextCoverPath.isEmpty()) {
            if (!coverUrl.isEmpty() || !coverPath.isEmpty()) {
                coverUrl = "";
                coverPath = "";
                artwork = null;
                artworkRetryCount = 0;
                artworkRetryAfter = 0;
                artworkRequestId += 1;
            }
            return;
        }
        if (nextCoverUrl.equals(coverUrl) && nextCoverPath.equals(coverPath) && artwork != null) return;
        if (nextCoverUrl.equals(coverUrl)
            && nextCoverPath.equals(coverPath)
            && System.currentTimeMillis() < artworkRetryAfter) return;
        if (!nextCoverUrl.equals(coverUrl) || !nextCoverPath.equals(coverPath)) {
            coverUrl = nextCoverUrl;
            coverPath = nextCoverPath;
            artworkRetryCount = 0;
            artwork = null;
        }
        int requestId = ++artworkRequestId;
        if (nextCoverPath.isEmpty()
            && !nextCoverUrl.startsWith("http://")
            && !nextCoverUrl.startsWith("https://")) {
            Log.w(TAG, "Se omitió una portada que no usa HTTP o HTTPS.");
            artworkRetryAfter = Long.MAX_VALUE;
            return;
        }

        artworkRetryAfter = Long.MAX_VALUE;
        artworkExecutor.execute(() -> {
            Bitmap downloadedArtwork = null;
            HttpURLConnection connection = null;
            try {
                if (!nextCoverPath.isEmpty()) {
                    try (InputStream input = new FileInputStream(nextCoverPath)) {
                        downloadedArtwork = decodeArtwork(readArtworkBytes(input));
                    } catch (IOException error) {
                        Log.w(TAG, "No se pudo abrir la portada offline; se intentará descargar.", error);
                    }
                }
                if (downloadedArtwork == null && !nextCoverUrl.isEmpty()) {
                    connection = (HttpURLConnection) new URL(nextCoverUrl).openConnection();
                    connection.setConnectTimeout(8000);
                    connection.setReadTimeout(8000);
                    connection.setInstanceFollowRedirects(true);
                    connection.setRequestProperty("Accept", "image/*");
                    int responseCode = connection.getResponseCode();
                    if (responseCode < 200 || responseCode >= 300) {
                        throw new IOException("El servidor de portadas respondió con HTTP " + responseCode + ".");
                    }
                    String contentType = connection.getContentType();
                    if (contentType != null && !contentType.toLowerCase().startsWith("image/")) {
                        throw new IOException("El servidor no devolvió una imagen.");
                    }
                    int contentLength = connection.getContentLength();
                    if (contentLength > MAX_ARTWORK_BYTES) {
                        throw new IOException("La portada supera el tamaño permitido.");
                    }
                    byte[] imageBytes;
                    try (InputStream input = connection.getInputStream()) {
                        imageBytes = readArtworkBytes(input);
                    }
                    downloadedArtwork = decodeArtwork(imageBytes);
                }
                if (downloadedArtwork == null) {
                    throw new IOException("No se pudo decodificar la portada de la canción.");
                }
            } catch (IOException error) {
                Log.w(TAG, "No se pudo descargar la portada de la canción.", error);
                scheduleArtworkRetry(nextCoverUrl, nextCoverPath, requestId);
                return;
            } finally {
                if (connection != null) connection.disconnect();
            }

            Bitmap loadedArtwork = downloadedArtwork;
            mainHandler.post(() -> {
                if (destroyed || requestId != artworkRequestId) {
                    if (!loadedArtwork.isRecycled()) loadedArtwork.recycle();
                    return;
                }
                artwork = loadedArtwork;
                artworkRetryAfter = 0;
                artworkRetryCount = 0;
                updateSessionState();
                NotificationManager manager = getSystemService(NotificationManager.class);
                if (manager != null) manager.notify(NOTIFICATION_ID, buildNotification());
            });
        });
    }

    private Bitmap decodeArtwork(byte[] imageBytes) throws IOException {
        BitmapFactory.Options bounds = new BitmapFactory.Options();
        bounds.inJustDecodeBounds = true;
        BitmapFactory.decodeByteArray(imageBytes, 0, imageBytes.length, bounds);
        if (bounds.outWidth <= 0 || bounds.outHeight <= 0) {
            throw new IOException("La portada no contiene una imagen válida.");
        }
        int sampleSize = 1;
        while (bounds.outWidth / sampleSize > MAX_ARTWORK_DIMENSION
            || bounds.outHeight / sampleSize > MAX_ARTWORK_DIMENSION) {
            sampleSize *= 2;
        }
        BitmapFactory.Options options = new BitmapFactory.Options();
        options.inSampleSize = sampleSize;
        Bitmap decoded = BitmapFactory.decodeByteArray(imageBytes, 0, imageBytes.length, options);
        if (decoded == null) throw new IOException("No se pudo decodificar la portada de la canción.");
        return decoded;
    }

    private byte[] readArtworkBytes(InputStream input) throws IOException {
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        byte[] buffer = new byte[8192];
        int total = 0;
        int count;
        while ((count = input.read(buffer)) != -1) {
            total += count;
            if (total > MAX_ARTWORK_BYTES) {
                throw new IOException("La portada supera el tamaño permitido.");
            }
            output.write(buffer, 0, count);
        }
        return output.toByteArray();
    }

    private void scheduleArtworkRetry(String requestedCoverUrl, String requestedCoverPath, int requestId) {
        mainHandler.post(() -> {
            if (destroyed
                || requestId != artworkRequestId
                || !requestedCoverUrl.equals(coverUrl)
                || !requestedCoverPath.equals(coverPath)) return;
            if (artworkRetryCount >= 3) {
                artworkRetryAfter = Long.MAX_VALUE;
                return;
            }
            artworkRetryCount += 1;
            long retryDelay = 15000L * artworkRetryCount;
            artworkRetryAfter = System.currentTimeMillis() + retryDelay;
            mainHandler.postDelayed(() -> {
                if (destroyed
                    || requestId != artworkRequestId
                    || !requestedCoverUrl.equals(coverUrl)
                    || !requestedCoverPath.equals(coverPath)
                    || artwork != null) return;
                artworkRetryAfter = 0;
                updateArtwork(requestedCoverUrl, requestedCoverPath);
            }, retryDelay);
        });
    }

    private void dispatchAction(String action) {
        Intent intent = new Intent(ACTION_MEDIA_CONTROL);
        intent.setPackage(getPackageName());
        intent.putExtra("action", action);
        sendBroadcast(intent);
    }

    @Override
    public void onDestroy() {
        destroyed = true;
        artworkExecutor.shutdownNow();
        if (mediaSession != null) {
            mediaSession.setActive(false);
            mediaSession.release();
        }
        if (artwork != null && !artwork.isRecycled()) artwork.recycle();
        stopForeground(STOP_FOREGROUND_REMOVE);
        super.onDestroy();
    }

    @Nullable
    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
