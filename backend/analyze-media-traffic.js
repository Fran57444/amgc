import dotenv from 'dotenv';
import mongoose from 'mongoose';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
dotenv.config({ path: path.join(projectRoot, '.env') });

const mongoUri = process.env.MONGO_URI;
if (!mongoUri) {
    console.error('Falta MONGO_URI en el entorno o en el archivo .env.');
    process.exit(1);
}

const songSchema = new mongoose.Schema({
    path: String,
    cover: String
}, { collection: 'songs' });
const playlistSchema = new mongoose.Schema({
    photo: String
}, { collection: 'playlists' });
const userSchema = new mongoose.Schema({
    profilePhoto: String
}, { collection: 'users' });

const Song = mongoose.model('MediaAuditSong', songSchema);
const Playlist = mongoose.model('MediaAuditPlaylist', playlistSchema);
const User = mongoose.model('MediaAuditUser', userSchema);

function extractDriveFileId(url) {
    if (/^(?:drive\.google\.com|drive\.usercontent\.google\.com)$/i.test(url.hostname)) {
        return url.searchParams.get('id')
            || url.pathname.match(/\/file\/d\/([\w-]+)/)?.[1]
            || url.pathname.match(/\/files\/([\w-]+)/)?.[1]
            || null;
    }
    return url.pathname.match(/^\/(?:api\/)?media\/([\w-]{25,})$/)?.[1] || null;
}

function classifyMediaUrl(value) {
    if (typeof value !== 'string' || !value.trim()) return 'vacío';
    if (value === '/img/vinculo.png') return 'imagen-placeholder';

    let url;
    try {
        url = new URL(value, 'https://amgc.invalid');
    } catch {
        return 'URL-inválida';
    }

    const hostname = url.hostname.toLowerCase();
    const pathname = url.pathname;
    if (pathname.startsWith('/mp3/')) return 'legacy-/mp3-(Render)';
    if (/^\/(?:api\/)?media\/[\w-]{25,}$/.test(pathname)) return 'proxy-/api/media-(Render)';
    if (/^\/(?:api\/)?spotify\/cover$/.test(pathname)) return 'proxy-/api/spotify/cover-(Render)';
    if (hostname === 'i.scdn.co') return 'Spotify-CDN-directo';
    if (/^(?:drive\.google\.com|drive\.usercontent\.google\.com)$/i.test(hostname)
        || hostname === 'www.googleapis.com' && pathname.startsWith('/drive/v3/files/')) {
        return 'Google-Drive-directo';
    }
    if (hostname === 'amgc.invalid') return 'otra-ruta-relativa';
    if (hostname.endsWith('.onrender.com') || hostname === 'onrender.com') return 'otra-URL-de-Render';
    return 'otra-URL-externa';
}

async function inspectField(Model, field) {
    const counts = new Map();
    const driveFileIds = new Set();
    let records = 0;
    const cursor = Model.find({}, { [field]: 1, _id: 0 })
        .lean()
        .cursor({ batchSize: 200 });

    for await (const record of cursor) {
        records += 1;
        const value = record[field];
        const category = classifyMediaUrl(value);
        counts.set(category, (counts.get(category) || 0) + 1);
        if (typeof value !== 'string') continue;

        try {
            const url = new URL(value, 'https://amgc.invalid');
            const fileId = extractDriveFileId(url);
            if (fileId) driveFileIds.add(fileId);
        } catch {
            // Invalid values are counted above and excluded from file-ID totals.
        }
    }

    return { records, counts, uniqueDriveFiles: driveFileIds.size };
}

async function main() {
    await mongoose.connect(mongoUri, {
        serverSelectionTimeoutMS: 10000,
        maxPoolSize: 2,
        readPreference: 'secondaryPreferred'
    });

    const reports = [
        ['Canciones.audio', Song, 'path'],
        ['Canciones.caratula', Song, 'cover'],
        ['Playlists.foto', Playlist, 'photo'],
        ['Usuarios.fotoPerfil', User, 'profilePhoto']
    ];

    console.log('Auditoría de referencias multimedia (solo lectura; sin URLs ni IDs):');
    for (const [label, Model, field] of reports) {
        const report = await inspectField(Model, field);
        console.log(`\n${label}: ${report.records} registros`);
        for (const [category, count] of [...report.counts].sort(([a], [b]) => a.localeCompare(b))) {
            console.log(`  ${category}: ${count}`);
        }
        console.log(`  IDs de Drive distintos: ${report.uniqueDriveFiles}`);
    }
    console.log('\nNota: esto clasifica referencias guardadas; no mide solicitudes ni bytes históricos de Render.');
    console.log('La API puede reescribir URLs de Drive como /api/media; la ruta efectiva depende del cliente.');
}

main()
    .catch(error => {
        console.error('No se pudo completar la auditoría:', error.name || 'Error', error.code || '');
        process.exitCode = 1;
    })
    .finally(async () => {
        await mongoose.disconnect();
    });
