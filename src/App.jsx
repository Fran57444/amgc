import { useEffect } from 'react'
import './style.css'
import { initMusicPlayer } from './script'

const appAscii = `            
             ;x            
             +x            
       ;X:   +x   .X;      
         +x. +x .xx.      
          .x++xxX.        
  :XXXXXXXXX$&&&XXXXXXXXX:
           :Xx$$:          
         .Xx +x +X.        
       .xx.  +x  .X;      
       ;:    +x    ;:      
             +x            
             ;x            `

function App() {
  useEffect(() => {
    const cleanup = initMusicPlayer();
    return cleanup;
  }, []);

  return (
    <>
      <div id="auth-overlay" className="auth-overlay">
        <div className="auth-box">
          <pre className="auth-ascii">{appAscii}</pre>
          <label htmlFor="auth-username">private@amgc~$User</label>
          <input type="text" id="auth-username" autoComplete="username" />
          <label htmlFor="auth-password">private@amgc~$Password</label>
          <input type="password" id="auth-password" autoComplete="current-password" />
          <button id="auth-btn-submit" className="main-play-btn">Ingresar</button>
          <div id="auth-error" className="auth-error"></div>
        </div>
      </div>

      <div id="loading-spinner" className="spinner-overlay" style={{ display: 'none' }}>
          <div className="spinner" style={{ width: '50px', height: '50px' }}></div>
      </div>

      <div id="main-content">
      <button id="unread-message-indicator" className="unread-message-indicator" type="button" aria-label="Mensajes no leídos" hidden>!</button>
        <div id="yt-download-popup" className="yt-download-popup" aria-live="polite">
          <div className="yt-download-popup-header">
            <span className="yt-download-popup-icon">♪</span>
            <div>
              <strong id="yt-download-popup-title">Descargando canción</strong>
              <small id="yt-download-popup-message">Preparando audio...</small>
            </div>
          </div>
          <div className="yt-download-progress-bar">
            <div id="yt-download-progress-fill" className="yt-download-progress-fill"></div>
          </div>
          <div className="yt-download-progress-text">
            <span id="yt-download-progress-label">0%</span>
          </div>
        </div>

        <div id="offline-download-popup" className="yt-download-popup offline-download-popup" aria-live="polite">
          <div className="yt-download-popup-header">
            <span className="yt-download-popup-icon" aria-hidden="true">↓</span>
            <div>
              <strong id="offline-download-popup-title">Descargas offline</strong>
              <small id="offline-download-popup-message">Preparando recursos...</small>
            </div>
          </div>
          <div className="yt-download-progress-bar">
            <div id="offline-download-progress-fill" className="yt-download-progress-fill"></div>
          </div>
          <div className="yt-download-progress-text">
            <span id="offline-download-progress-label">0%</span>
          </div>
        </div>

        <div className="sidebar-shell">
          <span className="sidebar-trigger" aria-hidden="true" title="Abrir menú" />
          <nav aria-label="Navegación principal">
            <div className="nav-left"></div>
            
            <div id="btn-home" style={{ cursor: 'pointer' }} title="Ir a inicio">
               <pre>{appAscii}</pre>
            </div>

            <span id="sidebar-offline-status" className="sidebar-offline-status" hidden>Modo offline</span>
            <button id="btn-profile" className="profile-sidebar-card" type="button" title="Abrir perfil">
              <img src="/img/perrocorasongif.gif" alt="" className="profile-sidebar-avatar" draggable="false" />
              <span id="sidebar-profile-name">Usuario</span>
            </button>

            <div className="sidebar-separator"></div><br />
            <button id="btn-create-playlist" className="sidebar-btn" title="Crear Playlist">
              <img src="/img/add.png" draggable="false" className="no-drag" alt="Añadir Playlist" />
            </button>
            <div id="sidebar-playlists"></div>
            
            <div className="sidebar-separator"></div>
            <div className="nav-links">
              <a href="#canciones" id="btn-all-songs" title="Todas las canciones">
                CANCIONES
              </a>
              <a href="#ajustes" id="btn-settings" title="Ajustes">
                AJUSTES
              </a>
              <a href="#admin" id="btn-admin" title="Administración">
                CUENTAS
              </a>
            </div>
            <button id="btn-open-chat" className="sidebar-btn chat-sidebar-btn" title="Mensajes">
              <img src="/img/chat.png" draggable="false" className="no-drag" alt="Mensajes" />
              <span id="chat-notification-dot" aria-hidden="true"></span>
            </button>
          </nav>
        </div>
        
        <div id="lyrics-panel" className="view-panel"></div>
        <div id="secret-text" className="secret-text" aria-live="polite"></div>
        <div id="now-playing-lyric" className="now-playing-lyric" aria-live="polite" aria-atomic="true" hidden>
          <div className="now-playing-lyric-track">
            <span id="now-playing-lyric-text"></span>
            <span id="now-playing-lyric-next" className="now-playing-lyric-slot next"></span>
            <span id="now-playing-lyric-incoming" className="now-playing-lyric-slot incoming" aria-hidden="true"></span>
          </div>
        </div>
        
        <div id="all-songs-panel" className="view-panel">
          <div className="view-header-bar">
            <div style={{ display: 'flex', alignItems: 'center', gap: '15px' }}>
              <h2>lista completa de canciones</h2>
            </div>
            <input id="all-songs-search" className="all-songs-search" type="search" placeholder="Buscar canción o artista..." aria-label="Buscar canción o artista" />
            <button id="btn-play-all-songs" className="main-play-btn">
              <img src="/img/play.png" draggable="false" className="no-drag" alt="Reproducir todas" width="20" />
            </button>
          </div>
          <ul id="all-songs-list"></ul>
        </div>

        <div id="profile-panel" className="view-panel">
          <div className="view-header-bar">
            <div className="profile-panel-heading">
              <button id="profile-photo-button" className="profile-photo-button" type="button" title="Cambiar foto de perfil">
                <img id="profile-avatar" src="/img/perrocorasongif.gif" alt="" className="profile-avatar" />
                <span className="profile-photo-edit-overlay">
                  <img src="/img/edit.png" alt="Cambiar foto" />
                </span>
              </button>
              <input id="profile-photo-input" type="file" accept="image/*" hidden />
              <div className="profile-heading-info">
                <span className="profile-kicker">PERFIL</span>
                <div className="profile-name-row">
                  <h2 id="profile-name">Usuario</h2>
                </div>
                <div id="profile-status" className="profile-status-row"></div>
                <button id="btn-profile-chat-friend" className="control-btn profile-chat-friend-btn" type="button" hidden>CHAT</button>
              </div>
              <div id="profile-activity" className="activity-inline-text">Escuchando música</div>
            </div>
            <button id="btn-close-profile" className="control-btn" type="button">✕</button>
          </div>
          <div className="profile-content-grid">
            <section className="profile-card">
              <h3>Listas guardadas</h3>
              <ul id="profile-playlists" className="profile-list horizontal-list"></ul>
            </section>

            <section className="profile-card profile-stats-card">
              <h3>Estadísticas</h3>
              <div id="profile-stats" className="profile-stats-grid">
                <div><span>Rol</span><strong id="profile-stat-role">Usuario</strong></div>
                <div><span>Horas escuchadas</span><strong id="profile-stat-hours">0 h</strong></div>
                <div><span>Canciones añadidas</span><strong id="profile-stat-added">0</strong></div>
                <div><span>Canciones editadas</span><strong id="profile-stat-edited">0</strong></div>
                <div><span>Amigos</span><strong id="profile-stat-friends">0</strong></div>
                <div><span>Mensajes enviados</span><strong id="profile-stat-messages">0</strong></div>
                <div><span>Cuenta creada</span><strong id="profile-stat-created-at">-</strong></div>
              </div>
            </section>
            
            <section className="profile-card">
              <div className="profile-card-header-row" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '14px' }}>
                <h3>Amigos</h3>
                <button type="button" id="btn-open-friends-panel" className="admin-header-add-btn" title="Añadir amigo" aria-label="Añadir amigo">
                  <img src="/img/add.png" alt="Añadir amigo" draggable="false" />
                </button>
              </div>
              <ul id="profile-friends" className="profile-list horizontal-list"></ul>
            </section>

            <section id="profile-history-card" className="profile-card" style={{ display: 'none' }}>
              <h3>Historial reciente</h3>
              <ul id="profile-history" className="profile-list"></ul>
            </section>
          </div>
        </div>

        <div id="pl-view-panel" className="view-panel">
          <div className="pl-header-main">
            <img id="pl-view-photo" src={null} draggable="false" className="no-drag" alt=""/>
            <div className="pl-info-header">
               <span className="pl-badge">PLAYLIST</span>
               <h1 id="pl-view-name"></h1>
               <p id="pl-view-desc"></p>
               <div id="pl-view-owner" className="pl-view-owner"></div>
            </div>
            <div className="pl-actions-row">
              <button id="btn-play-playlist" className="main-play-btn">
                <span>▶</span>
              </button>
              <button id="btn-edit-playlist" className="control-btn" title="Editar Playlist">
                <img src="/img/edit.png" draggable="false" className="no-drag" alt=""/>
              </button>
              <button id="btn-share-playlist" className="control-btn" title="Compartir Playlist">
                <span>↗</span>
              </button>
              <button id="btn-save-playlist" className="control-btn" title="Guardar Playlist">
                <img src="/img/add.png" draggable="false" className="no-drag" alt="Guardar playlist"/>
              </button>
            </div>
          </div>
          <ul id="pl-view-tracks" className="pl-tracks-grid"></ul>
        </div>

        <div id="settings-panel" className="view-panel">
          <div className="view-header-bar">
            <h2>Ajustes</h2>
          </div>
          <div className="settings-wrapper">
            <div className="settings-section">
              <h3>Reproducción</h3>
              <div className="field-row">
                <label>TIEMPO DE SALTO EN SEGUNDOS</label>
                <input
                  type="number"
                  id="input-seek-seconds"
                  defaultValue="5"
                  min="1"
                  className="settings-input-dark settings-input-narrow"
                />
              </div>
              <div className="field-row">
                <label htmlFor="input-max-volume">VOLUMEN MÁXIMO (%)</label>
                <p>Mientras mas alto, mas se distorsionara el audio :p</p>
                <input
                  type="number"
                  id="input-max-volume"
                  defaultValue="200"
                  min="100"
                  max="1000"
                  step="10"
                  className="settings-input-dark settings-input-narrow"
                />
              </div>
              <br></br>
            </div>

            <div className="settings-section">
              <h3>Discord Rich Presence</h3>
              <p>Personaliza el texto que aparece en discord. Déjalo vacío para que no se muestre.</p>
              <label htmlFor="discord-presence-image-text">TEXTO DS</label>
              <input
                type="text"
                id="discord-presence-image-text"
                defaultValue=""
                maxLength="128"
                className="settings-input-dark"
              />
              <div className="lyrics-editor-actions">
                <button id="btn-save-discord-presence-image-text" className="main-play-btn lyrics-editor-btn" type="button">Guardar texto</button>
                <span id="discord-presence-image-text-status" className="lyrics-editor-status" aria-live="polite"></span>
              </div>
            </div>

            <div className="settings-section">
              <h3>Modo offline</h3>
              <p>Se descargan canciones, fotos y playlists en la cache para escuchar incluso sin conexión.</p>
              <label className="offline-mode-toggle" htmlFor="offline-mode-toggle">
                <input type="checkbox" id="offline-mode-toggle" />
                <span>Descargar</span>
              </label>
              <span id="offline-cache-status" className="lyrics-editor-status" aria-live="polite">Descargas offline desactivadas.</span>
            </div>

            <div className="settings-section">
              <h3>Frases</h3>
              <p>Escribe una frase por línea. Se mostrará una de estas frases aleatoriamente en la pantalla principal.</p>
              <textarea id="secret-phrases-input" className="settings-input-dark secret-phrases-input" rows="5" spellCheck="false"></textarea>
              <div className="lyrics-editor-actions">
                <button id="btn-save-secret-phrases" className="main-play-btn lyrics-editor-btn" type="button">Guardar frases</button>
                <span id="secret-phrases-status" className="lyrics-editor-status" aria-live="polite"></span>
              </div>
            </div>

            <div className="settings-section">
              <h3>Descargar de YouTube</h3>
              <p>Ingresa un enlace de YouTube limpio, sin &list= ni &start_radio=. La descarga se guarda localmente en MP3</p>
              <div className="field-row" style={{ maxWidth: '400px' }}>
                <input 
                  type="text" 
                  id="settings-yt-link" 
                  placeholder="https://www.youtube.com/watch?v=..."
                  className="settings-input-dark"
                />
                <input
                  type="text"
                  id="settings-yt-name"
                  placeholder="Nombre del archivo (opcional)"
                  maxLength="80"
                  className="settings-input-dark settings-input-spaced"
                />
                <button id="btn-settings-yt-download" className="main-play-btn" style={{backgroundColor: '#ff7221', marginTop: '10px', justifyContent: 'center', padding: '10px', width: '100%' }}>
                  Descargar Audio
                </button>
                <button id="btn-open-local-mp3-folder" className="main-play-btn" hidden type="button" style={{backgroundColor: '#333', marginTop: '8px', justifyContent: 'center', padding: '10px', width: '100%' }}>
                  Abrir carpeta de MP3
                </button>
                <span id="settings-yt-status" style={{ fontSize: '0.85rem', color: '#e79f32', marginTop: '5px', display: 'none' }}></span>
              </div><br></br>
            </div>


              <button id="btn-logout-settings" className="main-play-btn" style={{backgroundColor: '#ff4d4d', marginTop: '10px', padding: '10px 20px', justifyContent: 'center', alignSelf: 'flex-start'}}>
                Cerrar sesión
              </button>
            </div>
          </div>


        <div id="admin-panel" className="view-panel">
          <div className="view-header-bar">
            <h2>Administración</h2>
          </div>
          <div className="admin-layout">
            <section className="admin-card">
              <div className="admin-card-header admin-list-header">
                <h3>Usuarios disponibles</h3>
                <button type="button" className="admin-header-add-btn" id="admin-back-to-create" title="Agregar usuario" aria-label="Agregar usuario">
                  <img src="/img/add.png" alt="Agregar usuario" draggable="false" />
                </button>
              </div>
              <ul id="admin-users-list" className="admin-users-list"></ul>
            </section>

            <section className="admin-card admin-add-user-card">
              <div className="admin-card-header">
                <h3>Crear usuario</h3>
              </div>
              <form id="admin-user-form" className="admin-user-form">
                <label>
                  Usuario
                  <input type="text" id="admin-form-username" placeholder="" />
                </label>
                <label>
                  Contraseña
                  <input type="password" id="admin-form-password" placeholder="" />
                </label>
                <div className="admin-permissions-grid">
                  <label className="permission-check">
                    <input type="checkbox" value="manage_users" data-permission-option />
                    <span>Gestionar usuarios</span>
                  </label>
                  <label className="permission-check">
                    <input type="checkbox" value="edit_songs" data-permission-option />
                    <span>Editar canciones</span>
                  </label>
                  <label className="permission-check">
                    <input type="checkbox" value="delete_songs" data-permission-option />
                    <span>Eliminar canciones</span>
                  </label>
                  <label className="admin-role-toggle" style={{ marginLeft: '4px' }}>
                    <input type="checkbox" id="admin-form-is-admin" />
                    <span>Admin</span>
                  </label>
                </div>
                <button type="submit" className="main-play-btn admin-submit-btn">Crear usuario</button>
                <div id="admin-form-status" className="admin-form-status"></div>
              </form>
            </section>
          </div>
        </div>

        <div id="edit-song-panel" className="view-panel">
          <div className="edit-song-container">
            <div className="edit-song-top">
              <div className="edit-song-preview pl-image-edit-wrapper" id="song-image-edit-wrapper">
                <img id="edit-song-display-cover" src={null} alt="" />
                <div className="pl-image-placeholder">
                  <img src="/img/add.png" alt="Añadir foto" />
                  <span>Seleccionar foto</span>
                </div>
                <div className="pl-image-edit-overlay">
                    <img src="/img/edit.png" alt="Editar" />
                </div>
                <input type="file" id="edit-song-photo" accept="image/*" style={{display: 'none'}} />
              </div>
              <div id="edit-song-metadata" className="edit-song-metadata" hidden>
                <span id="edit-song-added-by"></span>
                <span id="edit-song-edited-by"></span>
                <span id="edit-song-added-at"></span>
              </div>

              <div className="edit-song-fields-red">
                <div className="field-row">
                  <label>NOMBRE</label>
                  <input type="text" id="edit-input-name" />
                </div>
                <div className="field-row">
                  <label>ARTISTA</label>
                  <input type="text" id="edit-input-artist" />
                </div>
                <div className="field-row">
                  <label>COLOR</label>
                  <input type="color" id="edit-input-color" />
                </div>
                <div className="field-row">
                  <label>PISTA DE AUDIO</label>
                  <input type="file" id="edit-input-mp3" accept="audio/*" />
                  <input type="text" id="edit-input-yt" className="settings-input-dark settings-input-spaced" placeholder="O ingresa el link de YouTube aquí..." />
                  <input
                    type="text"
                    id="edit-input-file-name"
                    placeholder="Nombre del archivo MP3 (opcional)"
                    maxLength="80"
                    style={{
                      background: 'rgba(255,255,255,0.05)',
                      border: '1px solid rgba(255,255,255,0.1)',
                      padding: '12px 15px',
                      color: '#fff',
                      borderRadius: '8px',
                      fontSize: '1rem',
                      outline: 'none',
                      marginTop: '8px'
                    }}
                  />
                </div>
              </div>
            </div>

            <div className="edit-song-lyrics-section">
              <label className="label-red-title">LETRA</label>
              <div className="lyrics-editor-toolbar edit-lyrics-toolbar">
                <button id="btn-play-edited-song" className="main-play-btn lyrics-editor-btn secondary" type="button">Reproducir esta canción</button>
                <button id="btn-insert-edit-lyric-time" className="main-play-btn lyrics-editor-btn secondary" type="button">Insertar tiempo actual</button>
              </div>
              <textarea id="edit-input-lyrics" className="lyrics-editor-input" rows="9" placeholder="00:00.000 | Primera línea&#10;00:04.250 | Segunda *línea*"></textarea>
              <span id="edit-lyrics-status" className="lyrics-editor-status" aria-live="polite"></span>
              <div className="lyrics-editor-preview-heading">Vista previa sincronizada · <span id="edit-lyrics-time">00:00.000</span> · pulsa una palabra para resaltarla</div>
              <ol id="edit-lyrics-preview" className="timed-lyrics-list editor-preview-list"></ol>
            </div>

            <div className="edit-song-actions">
              <button id="btn-delete-song" className="modal-btn-text" style={{color: '#ff4d4d', display: 'none'}}>Eliminar Canción</button>
              <button id="btn-save-edited-song" className="main-play-btn">Guardar Cambios</button>
              <button id="btn-cancel-edited-song" className="modal-btn-text">Cancelar</button>
            </div>
          </div>
        </div>

        <div id="edit-playlist-panel" className="view-panel">
          <div className="edit-song-container">
            <div className="edit-song-top">
              <div className="edit-song-preview pl-image-edit-wrapper" id="pl-image-edit-wrapper">
                <img id="edit-pl-display-cover" src={null} alt="" />
                <div className="pl-image-placeholder">
                  <img src="/img/add.png" alt="Añadir foto" />
                  <span>Seleccionar foto</span>
                </div>
                <div className="pl-image-edit-overlay">
                    <img src="/img/edit.png" alt="Editar" />
                </div>
                <input type="file" id="edit-pl-photo" accept="image/*" style={{display: 'none'}} />
              </div>

              <div className="edit-song-fields-red">
                <div className="field-row">
                  <label>NOMBRE</label>
                  <input type="text" id="edit-pl-name" />
                </div>
                <div className="field-row">
                  <label>DESCRIPCIÓN</label>
                  <input type="text" id="edit-pl-desc" />
                </div>
              </div>
            </div>

            <div className="edit-song-actions">
              <button id="btn-delete-pl" className="modal-btn-text" style={{color: '#ff4d4d', display: 'none'}}>Eliminar Playlist</button>
              <button id="btn-save-edited-pl" className="main-play-btn">Guardar Playlist</button>
              <button id="btn-cancel-edited-pl" className="modal-btn-text">Cancelar</button>
            </div>
          </div>
        </div>

        <div id="friends-panel" className="friends-panel" aria-hidden="true">
            <div className="friends-header">
                <h3>Amigos</h3>
                <button id="btn-close-friends" className="control-btn">✕</button>
            </div>
            <div className="add-friend-box">
                <input type="text" id="input-add-friend" placeholder="Nombre usuario..." />
                <button id="btn-add-friend" className="main-play-btn">+</button>
            </div>
            <ul id="friends-list" className="friends-list"></ul>
        </div>

        <div id="chat-modal" className="chat-modal">
            <div className="chat-header">
                <button id="btn-chat-back" className="control-btn chat-back-btn" type="button" aria-label="Volver a la lista de chats" hidden>←</button>
                <button id="chat-header-avatar" className="chat-header-avatar chat-header-avatar-button" type="button" aria-label="Abrir perfil" hidden>
                  <img src="/img/perrocorasongif.gif" alt="" draggable="false" />
                </button>
                <span id="chat-title" className="chat-title">CHAT</span>
                <span id="chat-title-status" className="chat-title-status" aria-label="Estado del usuario" hidden></span>
                <button id="btn-close-chat" className="control-btn">✕</button>
            </div>
        <div id="chat-friends-view" className="chat-table-view">
                <ul id="chat-friends-list" className="chat-friends-list"></ul>
        </div>
        <div id="chat-conversation-view" className="chat-table-view" hidden>
        <div id="chat-messages" className="chat-messages"></div>
        <div className="chat-input-row">
                <input type="text" id="chat-input" placeholder="Escribe un mensaje..." />
                <button id="btn-annoy-friend" className="control-btn chat-annoy-btn" type="button" aria-label="Molestar a este amigo">🗣</button>
                <button id="btn-send-message" className="main-play-btn" type="button" aria-label="Enviar mensaje">
                  <img src="/img/send.png" alt="" draggable="false" className="no-drag" />
                </button>
        </div>
        </div>
        </div>

        <aside className="friends-sidebar-shell" id="friends-sidebar-shell">
          <span className="friends-sidebar-trigger" aria-hidden="true" title="Abrir amigos" />
          <nav aria-label="Lista de amigos">
            <div className="friends-sidebar-header">
              <span>Amigos</span>
            </div>
            <ul id="friends-sidebar-list" className="friends-sidebar-list"></ul>
          </nav>
        </aside>

        <div className="animation-container">
          <div id="merged-symbol" className="merged-symbol show" aria-hidden="true">
            <svg viewBox="-100 -100 200 200" width="240" height="240" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="xMidYMid meet">
              <defs>
                <filter id="depth-shadow" x="-50%" y="-50%" width="200%" height="200%">
                  <feGaussianBlur in="SourceAlpha" stdDeviation="4"/>
                  <feOffset dx="0" dy="8" result="offsetblur"/>
                  <feComponentTransfer>
                    <feFuncA type="linear" slope="0.3"/>
                  </feComponentTransfer>
                  <feMerge>
                    <feMergeNode/>
                    <feMergeNode in="SourceGraphic"/>
                  </feMerge>
                </filter>
              </defs>
              <g id="star-lines" stroke="#ffffff" strokeWidth="5" strokeLinecap="round" filter="url(#depth-shadow)">
                <line x1="0" y1="-88" x2="0" y2="88" />
                <line x1="-88" y1="0" x2="88" y2="0" />
                <line x1="-78" y1="-78" x2="78" y2="78" />
                <line x1="-78" y1="78" x2="78" y2="-78" />
              </g>
            </svg>
          </div>
        </div>

        <div id="music-player-popup" className="player-popup">
          <img id="popup-cover" draggable="false" className="no-drag" alt="" />
          <div className="popup-info">
            <div id="popup-song-name" />
          </div>
        </div>

        <div id="bottom-bar-wrapper" className="ready interactive">
          <div id="queue-container">
            <ul id="queue-list"></ul>
          </div>

          <div id="bottom-bar">
            <div id="progress-container" style={{ position: 'relative', width: '100%' }}>
                <div id="inline-spinner" className="spinner" style={{ position: 'absolute', left: '47px', bottom: '25px', width: '30px', height: '30px', borderWidth: '3px', zIndex: 10, pointerEvents: 'none', display: 'none' }}></div>
                <img id="perro-gif" src="/img/perrocorasongif.gif" draggable="false" className="no-drag" alt="" style={{ display: 'none' }} />
                <div id="progress-bar" />
            </div>

            <div className="bar-content">
              <div className="track-info">
                <div id="listening-together-status" className="listening-together-status" hidden>
                  <span></span>
                  <button id="btn-exit-listening-together" type="button"><img src="/img/cancel.png" draggable="false" className="no-drag" alt="Salir" width="10" height="10" /></button>
                </div>
                <img id="bottom-bar-cover" draggable="false" className="no-drag" alt="" />
                <div className="track-text-wrapper">
                  <div className="track-title-container">
                    <div id="track-name" />
                    
                    <div className="song-actions-wrapper" id="bottom-bar-action-wrapper" style={{ position: 'relative' }}>
                      <button id="btn-add-to-playlist-bar" className="song-actions-btn" type="button" title="Opciones" style={{ background: 'transparent', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center' }}>
                         <img src="/img/add.png" draggable="false" className="no-drag" alt="Add" style={{ width: '20px', pointerEvents: 'none' }} />
                      </button>
                      <div className="song-actions-menu" id="bottom-bar-action-menu" style={{ bottom: '100%', top: 'auto', marginBottom: '5px' }}>
                        <button className="action-add-queue">Añadir a cola</button>
                        <button className="action-add-pl">Añadir a playlist</button>
                      </div>
                    </div>

                  </div>
                  <span id="track-artist" />
                  <span id="track-duration" aria-label="Duración de la canción">0:00</span>
                </div>
              </div>

              <div className="track-controls">
                <button id="btn-rewind" className="control-btn seek-btn" type="button" title="Retroceder">
                  «
                </button>
                <button id="btn-prev" className="control-btn" type="button">⏮</button>
                <button id="btn-playpause" className="control-btn" type="button">
                  <img src="/img/play.png" draggable="false" className="no-drag" alt=""/>
                </button>
                <button id="btn-next" className="control-btn" type="button">⏭</button>
                <button id="btn-forward" className="control-btn seek-btn" type="button" title="Adelantar">
                  »
                </button>
              </div>
              

              <div className="queue-action">
                <div className="volume-wrapper">
                    <button id="btn-volume" className="control-btn" type="button">
                        <img src="/img/volume.png" draggable="false" className="no-drag" alt=""/>
                    </button>
                    <div className="volume-slider-container">
                        <span id="volume-tooltip">100%</span>
                        <input type="range" id="volume-slider" min="0" max="2" step="0.01" defaultValue="1" />
                    </div>
                </div>
                <button id="btn-lyrics" className="control-btn">
                   <img src="/img/lyrics.png" draggable="false" className="no-drag" alt="Letra"/>
                </button>
                <button id="btn-shuffle" className="control-btn">
                   <img src="/img/aleatorio.png" draggable="false" className="no-drag" alt="Aleatorio" style={{ opacity: 0.7 }} />
                </button>
                <button id="btn-queue" className="control-btn">
                   =
                </button>

              </div>
            </div>
          </div>
        </div>
      </div>

      <div id="modal-overlay" className="modal-overlay">
        <div id="add-to-pl-modal" className="modal">
          <h3 style={{ margin: '0 0 15px 0', fontSize: '1.2rem' }}>Añadir a Playlist</h3>
          <ul id="add-to-pl-list"></ul>
          <div className="modal-btns" style={{ marginTop: '10px' }}>
             <button id="btn-close-add-pl" className="modal-btn-text">Cerrar</button>
          </div>
        </div>

        <div id="share-pl-modal" className="modal">
          <h3 style={{ margin: '0 0 10px 0', fontSize: '1.2rem' }}>Compartir Playlist</h3>
          <ul id="share-friends-list" className="add-to-pl-list"></ul>
          <div className="modal-btns" style={{ marginTop: '10px' }}>
             <button id="btn-close-share-pl" className="modal-btn-text">Cerrar</button>
          </div>
        </div>

        <div id="manage-members-modal" className="modal">
          <h3 style={{ margin: '0 0 8px 0', fontSize: '1.2rem' }}>Integrantes de la playlist</h3>
          <ul id="manage-members-list" className="add-to-pl-list"></ul>
          <div className="modal-btns" style={{ marginTop: '6px' }}>
             <button id="btn-close-manage-members" className="modal-btn-text">Cerrar</button>
          </div>
        </div>

        <div id="playlist-savers-modal" className="modal">
          <h3 id="playlist-savers-title" style={{ margin: '0 0 8px 0', fontSize: '1.2rem' }}>Personas que guardaron la playlist</h3>
          <ul id="playlist-savers-list" className="add-to-pl-list"></ul>
          <div className="modal-btns" style={{ marginTop: '6px' }}>
             <button id="btn-close-playlist-savers" className="modal-btn-text" type="button">Cerrar</button>
          </div>
        </div>
      </div>
    </>
  )
}

export default App