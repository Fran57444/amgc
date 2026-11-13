export function getPlaybackLastHeardAt(playback, fallbackPlayback = null) {
  const candidates = [
    playback?.lastHeardAt,
    fallbackPlayback?.lastHeardAt,
    playback?.isPlaying === false ? playback.updatedAt : '',
    fallbackPlayback?.isPlaying === false ? fallbackPlayback.updatedAt : ''
  ].filter(value => Number.isFinite(Date.parse(value || '')));
  if (candidates.length) {
    return candidates.reduce((latest, candidate) => (
      Date.parse(candidate) > Date.parse(latest) ? candidate : latest
    ));
  }
  return playback?.updatedAt || fallbackPlayback?.updatedAt || '';
}

export function formatPlaybackRelativeTime(value, now = Date.now()) {
  const timestamp = Date.parse(value || '');
  if (!Number.isFinite(timestamp)) return '';
  const minutes = Math.floor(Math.max(0, now - timestamp) / 60000);
  if (minutes < 1) return 'hace unos segundos';
  if (minutes < 60) return `hace ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `hace ${hours} h`;
  return `hace ${Math.floor(hours / 24)} d`;
}

export function getPlaybackLastHeardLabel(playback, isListening, fallbackPlayback = null, now = Date.now()) {
  if (isListening) return '';
  return formatPlaybackRelativeTime(getPlaybackLastHeardAt(playback, fallbackPlayback), now);
}

export function getPlaybackElapsedSeconds(playback, isOnline, now = Date.now()) {
  const currentTime = Math.max(0, Number(playback?.currentTime) || 0);
  const duration = Math.max(0, Number(playback?.duration) || 0);
  const updatedAt = Date.parse(playback?.updatedAt || '');
  const elapsedSinceUpdate = isOnline
    && playback?.isPlaying !== false
    && Number.isFinite(updatedAt)
    ? Math.max(0, (now - updatedAt) / 1000)
    : 0;
  const elapsed = currentTime + elapsedSinceUpdate;
  return duration > 0 ? Math.min(duration, elapsed) : elapsed;
}
