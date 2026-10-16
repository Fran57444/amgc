export function createSongListRenderer({
    listElement,
    searchInput,
    getSongs,
    getSongCover,
    createImageMarkup,
    escapeHtml,
    createSongContextMenuHtml,
    setupSongMenuListeners,
    setupQueueAddSwipe,
    openEditSongPanel,
    getSongSuggestions = () => [],
    openSongSuggestion = () => {},
    deleteSongSuggestion = () => {},
    canEditSuggestions = () => false,
    canDeleteSuggestions = () => false
}) {
    let renderToken = 0;

    return function renderAllSongs() {
        if (!listElement) return;
        renderToken += 1;
        const activeRenderToken = renderToken;
        const scrollContainer = listElement.parentElement;
        const preservedScrollTop = scrollContainer?.scrollTop ?? 0;
        const searchTerm = searchInput?.value.trim().toLocaleLowerCase() || '';
        const matchingSongs = getSongs()
            .map((track, index) => ({ track, index }))
            .filter(({ track }) => !searchTerm
                || `${track.name || ''} ${track.artist || ''}`.toLocaleLowerCase().includes(searchTerm));
        let songIndex = 0;
        const renderedSongs = document.createDocumentFragment();

        const renderSongBatch = () => {
            if (activeRenderToken !== renderToken) return;
            const songsFragment = document.createDocumentFragment();
            const batchEnd = Math.min(songIndex + 50, matchingSongs.length);

            for (; songIndex < batchEnd; songIndex += 1) {
                const { track, index } = matchingSongs[songIndex];
                const item = document.createElement('li');
                item.className = 'all-songs-item';
                item.dataset.trackIndex = String(index);
                item.innerHTML = `
                    ${createImageMarkup(getSongCover(track), 'item-cover')}
                    <div class="all-songs-item-info">
                        <span class="all-songs-item-title">
                            <span class="all-songs-item-name">${escapeHtml(track.name)}</span>
                            ${track.lyricsReady ? '<img class="all-songs-lyrics-icon" src="/img/lyrics.png" alt="Letra lista" title="Letra lista" />' : ''}
                        </span>
                        <span class="all-songs-item-artist">${escapeHtml(track.artist)}</span>
                    </div>
                    ${createSongContextMenuHtml(index, true)}
                `;
                setupSongMenuListeners(item, index);
                setupQueueAddSwipe(item, track);
                songsFragment.appendChild(item);
            }
            renderedSongs.appendChild(songsFragment);

            if (songIndex < matchingSongs.length) {
                requestAnimationFrame(renderSongBatch);
                return;
            }

            if (!matchingSongs.length) {
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
