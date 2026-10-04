export function createSongListRenderer({
    listElement,
    searchInput,
    getSongs,
    getSongCover,
    createImageMarkup,
    createSongContextMenuHtml,
    setupSongMenuListeners,
    setupQueueAddSwipe,
    openEditSongPanel
}) {
    let renderToken = 0;

    return function renderAllSongs() {
        if (!listElement) return;
        renderToken += 1;
        const activeRenderToken = renderToken;
        listElement.innerHTML = '';
        const searchTerm = searchInput?.value.trim().toLocaleLowerCase() || '';
        const matchingSongs = getSongs()
            .map((track, index) => ({ track, index }))
            .filter(({ track }) => !searchTerm
                || `${track.name || ''} ${track.artist || ''}`.toLocaleLowerCase().includes(searchTerm));
        let songIndex = 0;

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
                        <span class="all-songs-item-name">${track.name}</span>
                        <span class="all-songs-item-artist">${track.artist}</span>
                    </div>
                    ${createSongContextMenuHtml(index, true)}
                `;
                setupSongMenuListeners(item, index);
                setupQueueAddSwipe(item, track);
                songsFragment.appendChild(item);
            }
            listElement.appendChild(songsFragment);

            if (songIndex < matchingSongs.length) {
                requestAnimationFrame(renderSongBatch);
                return;
            }

            if (!matchingSongs.length) {
                const emptySongItem = document.createElement('li');
                emptySongItem.className = 'all-songs-empty';
                emptySongItem.textContent = 'canción inexistente';
                listElement.appendChild(emptySongItem);
                return;
            }

            if (searchTerm) return;

            const addSongItem = document.createElement('li');
            addSongItem.className = 'all-songs-item add-song-card';
            addSongItem.style.border = '1px dashed rgba(255,255,255,0.3)';
            addSongItem.innerHTML = `
                <div style="width: 40px; height: 40px; border-radius: 4px; background: rgba(255,255,255,0.15); display: flex; align-items: center; justify-content: center; font-size: 1.5rem; font-weight: bold; color: #fff;">+</div>
                <div class="all-songs-item-info">
                    <span class="all-songs-item-name">Añadir Canción</span>
                    <span class="all-songs-item-artist">Haz clic para agregar un nuevo tema</span>
                </div>
            `;
            addSongItem.addEventListener('click', () => openEditSongPanel(null));
            listElement.appendChild(addSongItem);
        };

        renderSongBatch();
    };
}
