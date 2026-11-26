export function createSongListRenderer({
    listElement,
    searchInput,
    getSongs,
    getSongCover,
    getLoadingTrackId = () => '',
    createImageMarkup,
    escapeHtml,
    createSongContextMenuHtml,
    setupSongMenuListeners,
    setupQueueAddSwipe,
    openEditSongPanel,
    getSongSuggestions = () => [],
    getPendingSongs = () => [],
    isOfflineReady = () => false,
    openSongSuggestion = () => {},
    deleteSongSuggestion = () => {},
    canEditSuggestions = () => false,
    canDeleteSuggestions = () => false
}) {
    let renderToken = 0;

    function syncSongLoadingSpinner(item) {
        const cover = item.querySelector('.song-cover-loading');
        if (!cover) return;
        const isBusy = item.dataset.coverLoading === 'true'
            || item.classList.contains('is-loading')
            || item.classList.contains('is-syncing');
        let spinner = cover.querySelector('.song-loading-spinner');
        if (isBusy && !spinner) {
            spinner = document.createElement('span');
            spinner.className = 'song-loading-spinner';
            cover.appendChild(spinner);
        } else if (!isBusy) {
            spinner?.remove();
        }
        spinner?.classList.toggle('syncing', item.classList.contains('is-syncing'));
    }

    function watchSongCover(item, image) {
        if (!image) return;
        item.dataset.coverLoading = 'true';
        const finishLoading = () => {
            item.dataset.coverLoading = 'false';
            syncSongLoadingSpinner(item);
        };
        const finishFailedLoad = () => {
            if (image.isConnected) return;
            finishLoading();
        };
        image.addEventListener('load', finishLoading, { once: true });
        image.addEventListener('error', finishFailedLoad);
        if (image.complete && image.naturalWidth > 0) finishLoading();
        else if (image.complete && !image.isConnected) finishFailedLoad();
    }

    return function renderAllSongs() {
        if (!listElement) return;
        renderToken += 1;
        const activeRenderToken = renderToken;
        const scrollContainer = listElement.parentElement;
        const preservedScrollTop = scrollContainer?.scrollTop ?? 0;
        const searchTerm = searchInput?.value.trim().toLocaleLowerCase() || '';
        const matchingPendingSongs = [...getPendingSongs()].reverse()
            .filter(song => !searchTerm
                || `${song.name || ''} ${song.artist || ''}`.toLocaleLowerCase().includes(searchTerm));
        const matchingSongs = getSongs()
            .map((track, index) => ({ track, index }))
            .filter(({ track }) => !searchTerm
                || `${track.name || ''} ${track.artist || ''}`.toLocaleLowerCase().includes(searchTerm));
        const matchingEntries = [
            ...matchingPendingSongs.map(song => ({ pendingSong: song })),
            ...matchingSongs.map(song => ({ ...song, pendingSong: null }))
        ];
        let songIndex = 0;
        const renderedSongs = document.createDocumentFragment();

        const renderSongBatch = () => {
            if (activeRenderToken !== renderToken) return;
            const songsFragment = document.createDocumentFragment();
            const batchEnd = Math.min(songIndex + 50, matchingEntries.length);

            for (; songIndex < batchEnd; songIndex += 1) {
                const { track, index, pendingSong } = matchingEntries[songIndex];
                const item = document.createElement('li');
                if (pendingSong) {
                    item.className = 'all-songs-item catalog-pending-song is-loading';
                    item.dataset.pendingSongId = pendingSong.id;
                    item.setAttribute('aria-busy', 'true');
                    item.innerHTML = `
                        <span class="song-cover-loading">
                            ${createImageMarkup(pendingSong.cover || '', 'item-cover')}
                            <span class="song-loading-spinner" role="status" aria-label="Procesando canción"></span>
                        </span>
                        <div class="all-songs-item-info">
                            <span class="all-songs-item-name">${escapeHtml(pendingSong.name)}</span>
                            <span class="all-songs-item-artist">${escapeHtml(pendingSong.artist)}</span>
                            <span class="catalog-pending-status">${escapeHtml(pendingSong.status)}</span>
                        </div>
                        <span class="catalog-pending-indicator" aria-hidden="true"></span>
                    `;
                    songsFragment.appendChild(item);
                    continue;
                }
                item.className = 'all-songs-item';
                item.dataset.trackIndex = String(index);
                item.dataset.songId = String(track._id || track.id || '');
                const isLoading = String(getLoadingTrackId() || '') === item.dataset.songId;
                if (isLoading) item.classList.add('is-loading');
                item.setAttribute('aria-busy', String(isLoading));
                const coverSource = getSongCover(track);
                const isCoverLoading = Boolean(coverSource);
                item.dataset.coverLoading = String(isCoverLoading);
                const offlineBadge = isOfflineReady(track)
                    ? '<span class="offline-ready-badge" role="img" aria-label="Audio disponible sin conexión" title="Audio guardado en este dispositivo">✓</span>'
                    : '';
                const loadingSpinner = isLoading || isCoverLoading
                    ? '<span class="song-loading-spinner" role="status" aria-label="Cargando canción"></span>'
                    : '';
                const coverMarkup = `<span class="song-cover-loading">${createImageMarkup(coverSource, 'item-cover')}${loadingSpinner}${offlineBadge}</span>`;
                item.innerHTML = `
                    ${coverMarkup}
                    <div class="all-songs-item-info">
                        <span class="all-songs-item-title">
                            <span class="all-songs-item-name">${escapeHtml(track.name)}</span>
                            ${track.lyricsReady ? '<img class="all-songs-lyrics-icon" src="/img/lyrics.png" alt="Letra lista" title="Letra lista" />' : ''}
                        </span>
                        <span class="all-songs-item-artist">${escapeHtml(track.artist)}</span>
                    </div>
                    ${createSongContextMenuHtml(index, true)}
                `;
                watchSongCover(item, item.querySelector('.song-cover-loading img'));
                setupSongMenuListeners(item, index);
                setupQueueAddSwipe(item, track);
                songsFragment.appendChild(item);
            }
            renderedSongs.appendChild(songsFragment);

            if (songIndex < matchingEntries.length) {
                requestAnimationFrame(renderSongBatch);
                return;
            }

            if (!matchingEntries.length) {
                const emptySongItem = document.createElement('li');
                emptySongItem.className = 'all-songs-empty';
                emptySongItem.textContent = 'canción inexistente';
                renderedSongs.appendChild(emptySongItem);
            }

            if (!searchTerm) {
                getSongSuggestions().forEach(suggestion => {
                    const item = document.createElement('li');
                    item.className = 'all-songs-item all-songs-suggestion';
                    item.dataset.suggestionId = String(suggestion._id);
                    const heading = document.createElement('div');
                    heading.className = 'all-songs-suggestion-heading';
                    const label = document.createElement('span');
                    label.className = 'all-songs-suggestion-label';
                    label.textContent = 'SUGERENCIA';
                    const suggestedBy = document.createElement('span');
                    suggestedBy.className = 'all-songs-suggestion-author';
                    suggestedBy.textContent = suggestion.suggestedByName || 'Desconocido';
                    heading.append(label, suggestedBy);
                    const info = document.createElement('div');
                    info.className = 'all-songs-item-info';
                    const name = document.createElement('span');
                    name.className = 'all-songs-item-name';
                    name.textContent = suggestion.name || 'Canción sin nombre';
                    const artist = document.createElement('span');
                    artist.className = 'all-songs-item-artist';
                    artist.textContent = suggestion.artist || 'Artista desconocido';
                    info.append(name, artist);
                    item.append(heading, info);

                    if (canDeleteSuggestions()) {
                        const deleteButton = document.createElement('button');
                        deleteButton.type = 'button';
                        deleteButton.className = 'all-songs-suggestion-delete';
                        deleteButton.title = 'Eliminar sugerencia';
                        deleteButton.setAttribute('aria-label', 'Eliminar sugerencia');
                        const deleteIcon = document.createElement('img');
                        deleteIcon.src = '/img/cancel.png';
                        deleteIcon.alt = '';
                        deleteButton.appendChild(deleteIcon);
                        deleteButton.addEventListener('click', event => {
                            event.stopPropagation();
                            deleteButton.disabled = true;
                            Promise.resolve(deleteSongSuggestion(suggestion)).then(
                                () => { deleteButton.disabled = false; },
                                error => {
                                    deleteButton.disabled = false;
                                    console.error('No se pudo eliminar la sugerencia de canción.', error);
                                }
                            );
                        });
                        item.appendChild(deleteButton);
                    }

                    if (canEditSuggestions()) {
                        item.addEventListener('click', () => openSongSuggestion(suggestion));
                    } else {
                        item.classList.add('is-not-editable');
                    }
                    renderedSongs.appendChild(item);
                });
            }

            if (!searchTerm) {
                const addSongItem = document.createElement('li');
                addSongItem.className = 'all-songs-item add-song-card';
                addSongItem.style.border = '1px dashed rgba(255,255,255,0.3)';
                addSongItem.innerHTML = `
                    <div style="width: 40px; height: 40px; border-radius: 4px; background: rgba(255,255,255,0.15); display: flex; align-items: center; justify-content: center; font-size: 1.5rem; font-weight: bold; color: #fff;">+</div>
                    <div class="all-songs-item-info">
                        <span class="all-songs-item-name">Añadir Canción</span>
                        <span class="all-songs-item-artist">tocame....</span>
                    </div>
                `;
                addSongItem.addEventListener('click', () => openEditSongPanel(null));
                renderedSongs.appendChild(addSongItem);
            }

            listElement.replaceChildren(renderedSongs);
            if (scrollContainer) scrollContainer.scrollTop = preservedScrollTop;
        };

        renderSongBatch();
    };
}
