const SPOTIFY_PAGE_SIZE = 50;
const TRACK_BATCH_SIZE = 1000;
const PAGE_BATCH_SIZE = 5;
const TRACK_FIELDS = 'items(track(id,name,is_local,artists(name),album(images(url)))),next,total';

function wait(milliseconds) {
    return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function requestSpotifyPage(offset, getAccessToken, refreshAccessToken) {
    let accessToken = await getAccessToken();
    let refreshed = false;
    let rateLimitRetries = 0;
    let networkRetries = 0;

    while (true) {
        let response;
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 15_000);
        try {
            const query = new URLSearchParams({
                limit: String(SPOTIFY_PAGE_SIZE),
                offset: String(offset),
                fields: TRACK_FIELDS
            });
            response = await fetch(`https://api.spotify.com/v1/me/tracks?${query}`, {
                headers: { Authorization: `Bearer ${accessToken}` },
                cache: 'no-store',
                signal: controller.signal
            });
        } catch (error) {
            clearTimeout(timeout);
            if (networkRetries >= 2) throw error;
            networkRetries += 1;
            await wait(500 * (2 ** networkRetries));
            continue;
        }
        clearTimeout(timeout);

        if (response.status === 401 && !refreshed) {
            await response.body?.cancel();
            accessToken = await refreshAccessToken();
            refreshed = true;
            continue;
        }
        if (response.status === 429 && rateLimitRetries < 2) {
            await response.body?.cancel();
            const retryAfter = Number(response.headers.get('retry-after'));
            const retryDelay = Number.isFinite(retryAfter)
                ? Math.min(30_000, Math.max(1000, retryAfter * 1000))
                : 1000 * (rateLimitRetries + 1);
            rateLimitRetries += 1;
            await wait(retryDelay);
            continue;
        }
        if (!response.ok) {
            const result = await response.json().catch(() => null);
            throw new Error(result?.error?.message || `Spotify respondió ${response.status}.`);
        }

        const result = await response.json();
        const items = Array.isArray(result.items) ? result.items : [];
        return {
            tracks: items.map(item => item.track).filter(track => track && !track.is_local).map(track => ({
                id: track.id,
                name: track.name,
                artist: track.artists?.map(artist => artist.name).filter(Boolean).join(', ') || 'Artista desconocido',
                coverUrl: track.album?.images?.[0]?.url || ''
            })).filter(track => track.id && track.name),
            total: Number(result.total) || 0,
            hasMore: Boolean(result.next),
            nextOffset: offset + items.length
        };
    }
}

export async function fetchSpotifyLikedTracksPage(offset, getAccessToken) {
    let refreshPromise = null;
    const refreshAccessToken = () => {
        if (!refreshPromise) {
            refreshPromise = Promise.resolve(getAccessToken(true));
        }
        return refreshPromise;
    };

    const tracks = [];
    let total = 0;
    let nextOffset = offset;
    let hasMore = true;

    for (
        let batchOffset = offset;
        batchOffset < offset + TRACK_BATCH_SIZE && hasMore;
        batchOffset += SPOTIFY_PAGE_SIZE * PAGE_BATCH_SIZE
    ) {
        const offsets = Array.from(
            { length: PAGE_BATCH_SIZE },
            (_value, index) => batchOffset + index * SPOTIFY_PAGE_SIZE
        );
        const pages = await Promise.all(offsets.map(pageOffset =>
            requestSpotifyPage(pageOffset, getAccessToken, refreshAccessToken)
        ));
        for (const page of pages) {
            tracks.push(...page.tracks);
            total = page.total;
            nextOffset = page.nextOffset;
            if (!page.hasMore) {
                hasMore = false;
                break;
            }
        }
    }

    return { tracks, total, hasMore, nextOffset };
}
