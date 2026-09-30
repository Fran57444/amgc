import dns from 'node:dns';
dns.setServers(['8.8.8.8', '8.8.4.4']);

import dotenv from 'dotenv';
import express from 'express';
import mongoose from 'mongoose';
import cors from 'cors';
import compression from 'compression';
import multer from 'multer';
import { google } from 'googleapis';
import fs from 'fs';
import axios from 'axios';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Readable } from 'node:stream';
import ytdl from '@distube/ytdl-core';
import youtubedl from 'youtube-dl-exec';
import ffmpegPath from 'ffmpeg-static';
import { Server as SocketIOServer } from 'socket.io';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { randomBytes, timingSafeEqual } from 'node:crypto';

const desktopDownloaderOnly = process.env.MMAMGC_DESKTOP_DOWNLOADER === 'true';
if (!desktopDownloaderOnly) dotenv.config();

const app = express();
if (process.env.NODE_ENV === 'production') {
  app.set('trust proxy', 1);
}
const jwtSecret = process.env.JWT_SECRET
  || (process.env.NODE_ENV === 'production' ? null : randomBytes(64).toString('hex'));
if (!jwtSecret) {
  throw new Error('JWT_SECRET debe estar configurado en producción y contener al menos 32 caracteres.');
}
if (jwtSecret.length < 32) {
  throw new Error('JWT_SECRET debe contener al menos 32 caracteres.');
}
const JWT_EXPIRES_IN = '7d';
let passwordMigrationComplete = false;
let databaseInitializationPromise = null;
app.use(cors());
app.use(compression());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
if (desktopDownloaderOnly) {
  app.use((req, res, next) => {
    if (req.method === 'POST' && req.path === '/desktop/yt-download') {
      return next();
    }
    return res.sendStatus(404);
  });
}
if (!desktopDownloaderOnly) {
  app.use('/mp3', express.static(path.resolve(process.cwd(), 'public/mp3'), {
    maxAge: '1d',
    immutable: true
  }));
  app.get('/healthz', (_req, res) => {
    const isReady = isDatabaseReady() && passwordMigrationComplete;
    res.status(isReady ? 200 : 503).json({ status: isReady ? 'ok' : 'starting' });
  });
}

function isDatabaseReady() {
  return mongoose.connection.readyState === 1;
}

function ensureDatabaseConnection() {
  if (isDatabaseReady() && passwordMigrationComplete) return Promise.resolve();
  if (mongoose.connection.readyState !== 2 && databaseInitializationPromise && passwordMigrationComplete) {
    databaseInitializationPromise = null;
  }
  if (databaseInitializationPromise) return databaseInitializationPromise;

  const mongoUri = process.env.MONGO_URI
    || (process.env.NODE_ENV === 'production' ? '' : 'mongodb://localhost:27017/musicapp');
  if (!mongoUri) {
    return Promise.reject(new Error('Configura MONGO_URI con la URI de MongoDB Atlas en producción.'));
  }

  databaseInitializationPromise = mongoose.connect(mongoUri, {
    serverSelectionTimeoutMS: 10000,
    maxPoolSize: 5
  })
    .then(async () => {
      console.log('MongoDB Conectado');
      await bootstrapInitialAdmin();
      await migrateLegacyPasswords();
      passwordMigrationComplete = true;
    })
    .catch(error => {
      databaseInitializationPromise = null;
      console.error('Error conectando a MongoDB o migrando contraseñas:', error);
      throw error;
    });
  return databaseInitializationPromise;
}

if (!desktopDownloaderOnly) {
  ensureDatabaseConnection().catch(error => {
    console.error('La conexión inicial a MongoDB falló; se reintentará con la próxima petición.', error);
  });
}

function isValidObjectId(value) {
  return mongoose.Types.ObjectId.isValid(normalizeUserId(value));
}

async function requireUser(userId) {
  const normalizedId = normalizeUserId(userId);
  if (!normalizedId || !isValidObjectId(normalizedId)) return null;
  return User.findById(normalizedId);
}

const ALL_USER_PERMISSIONS = ['admin', 'manage_users', 'edit_songs', 'delete_songs'];

function hasPermission(user, permission) {
  return Boolean(user?.isAdmin)
    || (Array.isArray(user?.permissions)
      && (user.permissions.includes('admin') || user.permissions.includes(permission)));
}

async function authorizePermission(res, user, permission) {
  if (!user || !hasPermission(user, permission)) {
    res.status(403).json({ error: 'No tienes permiso para realizar esta acción.' });
    return false;
  }
  return true;
}

const userSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true },
  password: { type: String, required: true, select: false },
  isAdmin: { type: Boolean, default: false },
  permissions: [{ type: String }],
  isOnline: { type: Boolean, default: false },
  lastActive: { type: Date, default: Date.now },
  lastPlayed: {
    songId: String,
    songName: String,
    artist: String,
    cover: String,
    color: String,
    currentTime: Number,
    duration: Number,
    isPlaying: Boolean,
    updatedAt: Date
  },
  lastPlayedHistory: [{
    songId: String,
    songName: String,
    artist: String,
    cover: String,
    color: String,
    playedAt: Date
  }],
  savedPlaylists: [{ type: String }],
  settings: {
    seekSeconds: { type: Number, default: 5 },
    maxVolume: { type: Number, default: 200 },
    secretPhrases: { type: [String], default: [] }
  },
  stats: {
    songsPlayed: { type: Number, default: 0 },
    listeningSeconds: { type: Number, default: 0 },
    songsAdded: { type: Number, default: 0 },
    songsEdited: { type: Number, default: 0 },
    playlistsCreated: { type: Number, default: 0 },
    playlistsSaved: { type: Number, default: 0 },
    friendsAdded: { type: Number, default: 0 },
    messagesSent: { type: Number, default: 0 },
    lastPlayedAt: Date
  },
  friends: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  profilePhoto: { type: String, default: '' }
}, { timestamps: true });

const User = mongoose.model('User', userSchema);

const offlineListeningBatchSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  batchId: { type: String, required: true },
  seconds: { type: Number, required: true, min: 0 }
}, { timestamps: true });
offlineListeningBatchSchema.index({ userId: 1, batchId: 1 }, { unique: true });
const OfflineListeningBatch = mongoose.models.OfflineListeningBatch
  || mongoose.model('OfflineListeningBatch', offlineListeningBatchSchema);

async function hashPassword(password) {
  return bcrypt.hash(password, 12);
}

async function migrateLegacyPasswords() {
  const cursor = User.find({
    password: { $not: /^\$2[aby]\$\d{2}\$/ }
  }).select('+password').cursor();
  for await (const user of cursor) {
    user.password = await hashPassword(user.password);
    await user.save();
  }
}

async function bootstrapInitialAdmin() {
  if (await User.exists({})) return;
  const username = process.env.INITIAL_ADMIN_USERNAME?.trim();
  const password = process.env.INITIAL_ADMIN_PASSWORD;
  if (!username || !password) {
    console.warn('La base de datos no tiene usuarios. Configura INITIAL_ADMIN_USERNAME y INITIAL_ADMIN_PASSWORD para crear el primer administrador.');
    return;
  }
  if (password.length < 12 || password.length > 128) {
    throw new Error('INITIAL_ADMIN_PASSWORD debe tener entre 12 y 128 caracteres.');
  }
  await new User({
    username,
    password: await hashPassword(password),
    isAdmin: true,
    permissions: ALL_USER_PERMISSIONS,
    isOnline: false
  }).save();
  console.log('Se creó el administrador inicial desde variables de entorno.');
}

function createAccessToken(user) {
  return jwt.sign({}, jwtSecret, {
    subject: String(user._id),
    expiresIn: JWT_EXPIRES_IN
  });
}

const songSchema = new mongoose.Schema({
  name: String,
  artist: String,
  cover: String,
  path: String,
  color: String,
  lyrics: String,
  duration: { type: Number, default: 0 },
  addedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  editedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  addedAt: { type: Date, default: Date.now },
  editedAt: Date
});
const Song = mongoose.model('Song', songSchema);

const playlistSchema = new mongoose.Schema({
  id: String,
  name: String,
  desc: String,
  photo: String,
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  sharedWith: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  tracks: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Song' }],
  trackDetails: [{
    songId: { type: mongoose.Schema.Types.ObjectId, ref: 'Song' },
    addedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    addedAt: { type: Date },
    editedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    editedAt: { type: Date }
  }],
  duration: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});
playlistSchema.index({ userId: 1 });
playlistSchema.index({ sharedWith: 1 });
const Playlist = mongoose.model('Playlist', playlistSchema);

function normalizeUserId(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'object') {
    if (typeof value.toHexString === 'function') return value.toHexString();
    return normalizeUserId(value._id || value.id || value.userId);
  }
  if (typeof value !== 'string') return String(value);
  const trimmed = value.trim();
  if (!trimmed) return null;
  if ((trimmed.startsWith('{') && trimmed.endsWith('}'))
    || (trimmed.startsWith('"') && trimmed.endsWith('"'))) {
    try {
      return normalizeUserId(JSON.parse(trimmed));
    } catch {
    }
  }
  return trimmed;
}

const publicApiRoutes = new Set([
  'POST /auth/login',
  'GET /songs',
  'GET /health'
]);

app.use('/api', async (_req, res, next) => {
  try {
    await ensureDatabaseConnection();
    next();
  } catch (error) {
    console.error('La API no pudo conectarse a MongoDB.', error);
    res.status(503).json({
      error: 'La base de datos no está disponible. Verifica MONGO_URI y el acceso de red de MongoDB Atlas.'
    });
  }
});

app.use('/api', async (req, res, next) => {
  if (process.env.NODE_ENV === 'production' && !req.secure) {
    return res.status(400).json({ error: 'La API requiere una conexión HTTPS.' });
  }
  if (publicApiRoutes.has(`${req.method} ${req.path}`) || (req.method === 'GET' && req.path.startsWith('/media/'))) {
    return next();
  }

  const authorization = req.get('authorization') || '';
  const token = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
  if (!token) return res.status(401).json({ error: 'Debes iniciar sesión para continuar.' });

  try {
    const payload = jwt.verify(token, jwtSecret);
    const userId = normalizeUserId(payload.sub);
    if (!userId || !isValidObjectId(userId)) {
      return res.status(401).json({ error: 'La sesión no es válida. Inicia sesión nuevamente.' });
    }

    const user = await User.findById(userId).select('username isAdmin permissions');
    if (!user) return res.status(401).json({ error: 'La cuenta asociada a esta sesión ya no existe.' });

    const actorFields = [
      req.body?.userId,
      req.body?.requesterId,
      req.body?.sender,
      req.body?.fromUserId,
      req.query.requesterId
    ].filter(value => value !== undefined && value !== null && value !== '');
    if (actorFields.some(value => normalizeUserId(value) !== String(user._id))) {
      return res.status(403).json({ error: 'La identidad indicada no coincide con la sesión autenticada.' });
    }

    req.user = user;
    return next();
  } catch (error) {
    if (error instanceof jwt.JsonWebTokenError || error instanceof jwt.TokenExpiredError) {
      return res.status(401).json({ error: 'La sesión no es válida o ha expirado. Inicia sesión nuevamente.' });
    }
    return next(error);
  }
});

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', database: isDatabaseReady() ? 'connected' : 'disconnected' });
});

const messageSchema = new mongoose.Schema({
  sender: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  receiver: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  content: { type: String, required: true },
  type: { type: String, enum: ['chat', 'playlist_invitation'], default: 'chat' },
  playlistId: String,
  invitationStatus: { type: String, enum: ['pending', 'accepted', 'declined'], default: undefined },
  readAt: Date,
  timestamp: { type: Date, default: Date.now }
});
const Message = mongoose.model('Message', messageSchema);
let realtimeIo = null;

function emitUserStatsChanged(userId) {
  if (!userId || !realtimeIo) return;
  const normalizedUserId = String(userId);
  realtimeIo.to(`user:${normalizedUserId}`).emit('userStatsChanged', { userId: normalizedUserId });
  User.findById(userId).select('friends').lean()
    .then(user => {
      for (const friendId of user?.friends || []) {
        realtimeIo?.to(`user:${friendId}`).emit('userStatsChanged', { userId: normalizedUserId });
      }
    })
    .catch(error => console.error('No se pudieron notificar las estadísticas actualizadas:', error));
}

function emitUserChanged(userId) {
  if (userId) realtimeIo?.to(`user:${userId}`).emit('userChanged', { userId: String(userId) });
}

function emitAdminUsersChanged() {
  realtimeIo?.to('admins').emit('adminUsersChanged');
}

function getOAuthClient() {
  const credentialsPath = path.resolve(process.cwd(), 'oauth-credentials.json');
  const tokenPath = path.resolve(process.cwd(), 'token.json');
  const credentialsContent = process.env.GOOGLE_OAUTH_CREDENTIALS_JSON
    || (fs.existsSync(credentialsPath) && fs.readFileSync(credentialsPath, 'utf-8'));
  const tokenContent = process.env.GOOGLE_OAUTH_TOKEN_JSON
    || (fs.existsSync(tokenPath) && fs.readFileSync(tokenPath, 'utf-8'));

  if (!credentialsContent || !tokenContent) {
    return null;
  }
  const credentials = JSON.parse(credentialsContent);
  const { client_secret, client_id, redirect_uris } = credentials.installed || credentials.web;

  const oAuth2Client = new google.auth.OAuth2(
    client_id,
    client_secret,
    redirect_uris[0] || 'http://localhost:3000'
  );
  
  const token = JSON.parse(tokenContent);
  oAuth2Client.setCredentials(token);
  return oAuth2Client;
}

const oauthClient = getOAuthClient();
const drive = google.drive({ version: 'v3', auth: oauthClient });
const upload = multer({ storage: multer.memoryStorage() });
let cachedDriveAccessToken = null;
let cachedDriveTokenExpiresAt = 0;
let discordAccessToken = null;
let discordAccessTokenExpiresAt = 0;
const discordExternalAssetCache = new Map();
const discordExternalAssetRequests = new Map();

async function getDiscordAppAccessToken() {
  if (discordAccessToken && Date.now() < discordAccessTokenExpiresAt) return discordAccessToken;
  const clientId = process.env.DISCORD_CLIENT_ID;
  const clientSecret = process.env.DISCORD_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error('Discord external assets requieren DISCORD_CLIENT_ID y DISCORD_CLIENT_SECRET en el servidor.');
  }

  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const response = await fetch('https://discord.com/api/oauth2/token', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${credentials}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      scope: 'applications.commands.update'
    })
  });
  if (!response.ok) throw new Error(`Discord OAuth respondió ${response.status} al solicitar el token de assets.`);
  const result = await response.json();
  if (typeof result.access_token !== 'string' || !Number.isFinite(result.expires_in)) {
    throw new Error('Discord devolvió un token OAuth incompleto.');
  }
  discordAccessToken = result.access_token;
  discordAccessTokenExpiresAt = Date.now() + Math.max(0, result.expires_in - 60) * 1000;
  return discordAccessToken;
}

async function verifyDiscordCoverUrl(imageUrl) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(imageUrl, {
      headers: { Range: 'bytes=0-0' },
      signal: controller.signal
    });
    const contentType = response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() || '';
    const finalUrl = new URL(response.url);
    await response.body?.cancel();
    if (!response.ok) {
      throw new Error(`la URL de portada respondió HTTP ${response.status} desde ${finalUrl.host}`);
    }
    if (finalUrl.protocol !== 'https:') {
      throw new Error(`la URL de portada redirigió a un destino no HTTPS (${finalUrl.host})`);
    }
    if (!contentType.startsWith('image/')) {
      throw new Error(`la URL de portada respondió "${contentType || 'sin Content-Type'}" desde ${finalUrl.host}`);
    }
    console.info(
      `Discord portada accesible (HTTP ${response.status}, ${contentType}, destino HTTPS ${finalUrl.host}).`
    );
  } finally {
    clearTimeout(timeout);
  }
}

async function verifyDiscordExternalAsset(assetPath) {
  const assetUrl = new URL(assetPath, 'https://media.discordapp.net/');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(assetUrl, {
      headers: { Range: 'bytes=0-0' },
      signal: controller.signal
    });
    const contentType = response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() || '';
    const finalUrl = new URL(response.url);
    await response.body?.cancel();
    if (!response.ok) {
      throw new Error(`el CDN de Discord respondió HTTP ${response.status}`);
    }
    if (finalUrl.protocol !== 'https:' || finalUrl.hostname !== 'media.discordapp.net') {
      throw new Error('el CDN de Discord redirigió a un destino inesperado');
    }
    if (!contentType.startsWith('image/')) {
      throw new Error(`el CDN de Discord respondió "${contentType || 'sin Content-Type'}"`);
    }
    console.info(`Discord CDN de portada accesible (HTTP ${response.status}, ${contentType}).`);
  } finally {
    clearTimeout(timeout);
  }
}

async function getDiscordExternalAssetKey(imageUrl) {
  const cachedKey = discordExternalAssetCache.get(imageUrl);
  if (cachedKey) return cachedKey;
  const pendingRequest = discordExternalAssetRequests.get(imageUrl);
  if (pendingRequest) return pendingRequest;

  const request = (async () => {
    const clientId = process.env.DISCORD_CLIENT_ID;
    if (!clientId || !process.env.DISCORD_CLIENT_SECRET) {
      throw new Error('Discord external assets no están configurados en el servidor.');
    }

    await verifyDiscordCoverUrl(imageUrl);
    const accessToken = await getDiscordAppAccessToken();
    const response = await fetch(`https://discord.com/api/v10/applications/${clientId}/external-assets`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ urls: [imageUrl] })
    });
    if (!response.ok) {
      const responseBody = (await response.text()).slice(0, 500);
      throw new Error(`Discord external-assets respondió ${response.status}: ${responseBody || 'sin detalle'}`);
    }
    const result = await response.json();
    const assetPath = result?.[0]?.external_asset_path;
    if (typeof assetPath !== 'string' || !assetPath) {
      throw new Error('Discord no devolvió una ruta para la portada externa.');
    }

    const assetKey = assetPath.startsWith('mp:') ? assetPath : `mp:${assetPath}`;
    console.info(
      `Discord external asset registrado (formato ${
        assetKey.startsWith('mp:external/') ? 'mp:external' : 'inesperado'
      }, ${assetKey.length} caracteres).`
    );
    try {
      await verifyDiscordExternalAsset(assetKey.slice(3));
    } catch (error) {
      console.warn('Discord no pudo validar la portada en su CDN:', error.message || error);
    }
    discordExternalAssetCache.set(imageUrl, assetKey);
    if (discordExternalAssetCache.size > 200) {
      discordExternalAssetCache.delete(discordExternalAssetCache.keys().next().value);
    }
    return assetKey;
  })();
  discordExternalAssetRequests.set(imageUrl, request);
  try {
    return await request;
  } finally {
    discordExternalAssetRequests.delete(imageUrl);
  }
}

function escapeDriveQueryValue(value = '') {
  return String(value)
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'");
}

async function findExistingDriveFileByName(fileName, mimeType = null) {
  if (!drive || !process.env.DRIVE_FOLDER_ID || !fileName) return null;

  const cleanName = String(fileName).trim();
  if (!cleanName) return null;

  const baseQuery = `'${process.env.DRIVE_FOLDER_ID}' in parents and name = '${escapeDriveQueryValue(cleanName)}' and trashed = false`;
  const query = mimeType ? `${baseQuery} and mimeType = '${escapeDriveQueryValue(mimeType)}'` : baseQuery;

  try {
    const { data } = await drive.files.list({
      q: query,
      pageSize: 10,
      fields: 'files(id, name, webContentLink, mimeType)',
      supportsAllDrives: true,
      includeItemsFromAllDrives: true
    });

    const existingFile = data.files && data.files.length > 0 ? data.files[0] : null;
    if (!existingFile) return null;

    if (existingFile.webContentLink) return existingFile;

    const { data: freshFile } = await drive.files.get({
      fileId: existingFile.id,
      fields: 'id, name, webContentLink, mimeType',
      supportsAllDrives: true
    });

    return freshFile || existingFile;
  } catch (error) {
    console.error('Error buscando archivo en Google Drive:', {
      message: error.message,
      code: error.code,
      status: error.response?.status,
      googleReason: error.response?.data?.error?.errors?.[0]?.reason
    });
    return null;
  }
}

async function uploadToDrive(fileObject) {
  if (!fileObject || !fileObject.originalname) {
    throw new Error('No se recibió un archivo válido para subir a Drive.');
  }

  const existingFile = await findExistingDriveFileByName(fileObject.originalname, fileObject.mimetype);
  if (existingFile?.webContentLink) {
    return existingFile.webContentLink;
  }

  const bufferStream = new (await import('stream')).PassThrough();
  bufferStream.end(fileObject.buffer);
  
  const { data } = await drive.files.create({
    media: { mimeType: fileObject.mimetype, body: bufferStream },
    requestBody: { name: fileObject.originalname, parents: [process.env.DRIVE_FOLDER_ID] },
    fields: 'id, webContentLink' 
  });
  
  await drive.permissions.create({
    fileId: data.id,
    requestBody: { role: 'reader', type: 'anyone' }
  });
  
  return data.webContentLink;
}

async function saveMp3Locally(title, buffer, requestedName = '', outputDirectory) {
  const mp3Directory = outputDirectory || path.resolve(process.cwd(), 'public/mp3');
  await fs.promises.mkdir(mp3Directory, { recursive: true });

  const safeTitle = (requestedName || title || 'audio-youtube')
    .replace(/\.mp3$/i, '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100) || 'audio-youtube';
  const fileName = `${safeTitle}-${Date.now()}.mp3`;
  const filePath = path.join(mp3Directory, fileName);

  await fs.promises.writeFile(filePath, buffer);
  return { fileName, filePath: outputDirectory ? filePath : `/mp3/${fileName}` };
}

function sanitizeAudioFileName(requestedName, fallbackName, extension = '.mp3') {
  const safeName = (requestedName || fallbackName || 'audio')
    .replace(/\.[a-z0-9]+$/i, '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100) || 'audio';
  return `${safeName}${extension}`;
}

function extractDriveId(url) {
  if (!url) return url;
  const match = url.match(/[-\w]{25,}/);
  return match ? match[0] : url;
}

function isValidYoutubeUrl(value) {
  if (!value || typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    const host = url.hostname.replace(/^www\./, '').toLowerCase();
    return host === 'youtube.com' || host === 'm.youtube.com' || host === 'youtu.be';
  } catch {
    return false;
  }
}

function convertAudioStreamToMp3(inputStream) {
  if (!ffmpegPath) {
    return Promise.reject(new Error('FFmpeg no está disponible en este entorno.'));
  }

  return new Promise((resolve, reject) => {
    const ffmpeg = spawn(ffmpegPath, [
      '-hide_banner',
      '-loglevel', 'error',
      '-i', 'pipe:0',
      '-vn',
      '-codec:a', 'libmp3lame',
      '-b:a', '192k',
      '-f', 'mp3',
      'pipe:1'
    ]);
    const outputChunks = [];
    const errorChunks = [];

    ffmpeg.stdout.on('data', chunk => outputChunks.push(chunk));
    ffmpeg.stderr.on('data', chunk => errorChunks.push(chunk));
    ffmpeg.on('error', error => {
      reject(error);
    });
    ffmpeg.on('close', code => {
      if (code !== 0) {
        const details = Buffer.concat(errorChunks).toString('utf8').trim();
        reject(new Error(details || `FFmpeg terminó con código ${code}.`));
        return;
      }
      resolve(Buffer.concat(outputChunks));
    });

    ffmpeg.stdin.on('error', error => {
      if (error.code !== 'EPIPE') reject(error);
    });
    inputStream.on('error', reject);
    inputStream.pipe(ffmpeg.stdin);
  });
}

function convertAudioToMp3(inputBuffer) {
  return convertAudioStreamToMp3(Readable.from([inputBuffer]));
}

async function downloadWithYtDlp(ytLink) {
  const temporaryDirectory = path.resolve(process.cwd(), 'tmp');
  await fs.promises.mkdir(temporaryDirectory, { recursive: true });
  const temporaryInput = path.join(temporaryDirectory, `youtube-${Date.now()}.%(ext)s`);

  try {
    const ytDlpOptions = {
      output: temporaryInput,
      format: 'bestaudio[abr<=128]/bestaudio[ext=m4a]/bestaudio/best',
      concurrentFragments: 8,
      httpChunkSize: '10M',
      noPlaylist: true,
      noWarnings: true,
      noCheckCertificates: true,
      print: 'after_move:%(title)s',
      addHeader: 'referer:https://www.youtube.com/'
    };

    if (process.env.YOUTUBE_COOKIES_FILE) {
      ytDlpOptions.cookiefile = process.env.YOUTUBE_COOKIES_FILE;
    }

    const output = await youtubedl(ytLink, ytDlpOptions);

    const downloadedFiles = await fs.promises.readdir(temporaryDirectory);
    const inputFileName = downloadedFiles
      .filter(fileName => fileName.startsWith(path.basename(temporaryInput).split('.%')[0]))
      .sort()
      .pop();

    if (!inputFileName) throw new Error('yt-dlp no generó el archivo de audio.');
    const inputFilePath = path.join(temporaryDirectory, inputFileName);
    const inputBuffer = await fs.promises.readFile(inputFilePath);
    const title = String(output || 'audio').trim().split(/\r?\n/).pop() || 'audio';

    return { title, buffer: await convertAudioToMp3(inputBuffer), inputFilePath };
  } finally {
    const temporaryFiles = await fs.promises.readdir(temporaryDirectory).catch(() => []);
    await Promise.all(
      temporaryFiles
        .filter(fileName => fileName.startsWith(path.basename(temporaryInput).split('.%')[0]))
        .map(fileName => fs.promises.rm(path.join(temporaryDirectory, fileName), { force: true }))
    );
  }
}

async function downloadYoutubeAudio(ytLink) {
  try {
    return await downloadWithYtDlp(ytLink);
  } catch (ytDlpError) {
    const requestSource = desktopDownloaderOnly ? 'este equipo' : 'el servidor alojado';
    if (/429|too many requests|rate limit/i.test(ytDlpError.message || '')) {
      const error = new Error(
        `YouTube limitó temporalmente las solicitudes desde la IP de ${requestSource}. Abre cmd y ejecuta "ipconfig /flushdns", si no funciona, espera.`
      );
      error.statusCode = 429;
      throw error;
    }
    try {
      const info = await ytdl.getInfo(ytLink);
      const audioStream = ytdl(ytLink, { quality: 'highestaudio', filter: 'audioonly' });
      return {
        title: info.videoDetails.title || 'audio',
        buffer: await convertAudioStreamToMp3(audioStream)
      };
    } catch (fallbackError) {
      const message = fallbackError?.message || 'El enlace no pudo ser procesado por YouTube.';
      if (/429|too many requests|rate limit/i.test(`${ytDlpError.message} ${message}`)) {
        const error = new Error(
          `YouTube limitó temporalmente las solicitudes desde la IP de ${requestSource}. Abre cmd y ejecuta "ipconfig /flushdns", si no funciona, espera.`
        );
        error.statusCode = 429;
        throw error;
      }
      throw new Error(message);
    }
  }
}

app.post('/desktop/yt-download', async (req, res) => {
  const remoteAddress = req.socket.remoteAddress || '';
  const isLoopback = remoteAddress === '127.0.0.1'
    || remoteAddress === '::1'
    || remoteAddress === '::ffff:127.0.0.1';
  const expectedKey = process.env.MMAMGC_DESKTOP_DOWNLOAD_KEY || '';
  const receivedKey = req.get('x-desktop-download-key') || '';
  const expectedKeyBuffer = Buffer.from(expectedKey);
  const receivedKeyBuffer = Buffer.from(receivedKey);
  const hasValidKey = expectedKeyBuffer.length > 0
    && expectedKeyBuffer.length === receivedKeyBuffer.length
    && timingSafeEqual(expectedKeyBuffer, receivedKeyBuffer);

  if (!desktopDownloaderOnly || !isLoopback || !hasValidKey) {
    return res.sendStatus(404);
  }

  try {
    const { ytLink, fileName, saveLocally } = req.body;
    if (!isValidYoutubeUrl(ytLink)) {
      return res.status(400).json({ error: 'El enlace de YouTube no es válido.' });
    }
    const { title, buffer } = await downloadYoutubeAudio(ytLink);
    if (saveLocally !== true) {
      return res.json({ title, audio: buffer.toString('base64') });
    }
    const localFile = await saveMp3Locally(
      title,
      buffer,
      fileName,
      process.env.MMAMGC_DESKTOP_DOWNLOAD_DIRECTORY
    );
    res.json({ title, fileName: localFile.fileName, path: localFile.filePath });
  } catch (error) {
    res.status(error.statusCode || 500).json({ error: error.message });
  }
});

if (desktopDownloaderOnly) {
  app.use((_req, res) => res.sendStatus(404));
}

app.post('/api/auth/register', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Usuario y contraseña requeridos' });
    if (!await authorizePermission(res, req.user, 'manage_users')) return;
    if (String(password).length < 8 || String(password).length > 128) {
      return res.status(400).json({ error: 'La contraseña debe tener entre 8 y 128 caracteres.' });
    }

    const existing = await User.findOne({ username });
    if (existing) return res.status(400).json({ error: 'El nombre de usuario ya existe' });

    const user = new User({
      username: String(username).trim(),
      password: await hashPassword(String(password)),
      isAdmin: false,
      permissions: ['user'],
      isOnline: false
    });

    await user.save();
    emitAdminUsersChanged();
    res.json({
      _id: user._id,
      username: user.username,
      isAdmin: user.isAdmin,
      permissions: user.permissions,
      settings: user.settings,
      savedPlaylists: user.savedPlaylists || [],
      profilePhoto: user.profilePhoto && user.profilePhoto.includes('drive.google.com')
        ? `${req.protocol}://${req.get('host')}/api/media/${extractDriveId(user.profilePhoto)}`
        : user.profilePhoto || ''
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!passwordMigrationComplete) {
      return res.status(503).json({ error: 'La base de datos aún está preparando las credenciales seguras. Intenta nuevamente.' });
    }
    const user = await User.findOne({ username: String(username || '').trim() }).select('+password');
    if (!user || !(await bcrypt.compare(String(password || ''), user.password))) {
      return res.status(401).json({ error: 'Credenciales inválidas/Cuenta inexistente. Pidele acceso a un administrador.' });
    }

    user.isOnline = true;
    user.lastActive = new Date();
    await user.save();

    res.json({
      token: createAccessToken(user),
      _id: user._id,
      username: user.username,
      isAdmin: user.isAdmin,
      permissions: user.permissions,
      settings: user.settings,
      savedPlaylists: user.savedPlaylists || [],
      lastPlayed: user.lastPlayed,
      lastPlayedHistory: user.lastPlayedHistory || [],
      profilePhoto: user.profilePhoto && user.profilePhoto.includes('drive.google.com')
        ? `${req.protocol}://${req.get('host')}/api/media/${extractDriveId(user.profilePhoto)}`
        : user.profilePhoto || ''
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/auth/me', async (req, res) => {
  try {
    const user = await User.findById(req.user._id).select('-password');
    const userData = user.toObject();
    if (userData.profilePhoto && userData.profilePhoto.includes('drive.google.com')) {
      userData.profilePhoto = `${req.protocol}://${req.get('host')}/api/media/${extractDriveId(userData.profilePhoto)}`;
    }
    res.json(userData);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/users/:id/profile-photo', upload.single('photo'), async (req, res) => {
  try {
    if (String(req.params.id) !== String(req.user._id)) {
      return res.status(403).json({ error: 'Solo puedes cambiar tu propia foto de perfil.' });
    }
    if (!req.file) return res.status(400).json({ error: 'Falta la foto de perfil' });
    const profilePhoto = await uploadToDrive(req.file);
    const user = await User.findByIdAndUpdate(
      req.params.id,
      { profilePhoto },
      { returnDocument: 'after' }
    ).select('-password');
    if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });
    const userData = user.toObject();
    if (userData.profilePhoto && userData.profilePhoto.includes('drive.google.com')) {
      userData.profilePhoto = `${req.protocol}://${req.get('host')}/api/media/${extractDriveId(userData.profilePhoto)}`;
    }
    emitUserChanged(user._id);
    realtimeIo?.to(`user:${user._id}`).emit('friendsChanged');
    for (const friendId of user.friends || []) {
      realtimeIo?.to(`user:${friendId}`).emit('friendsChanged');
    }
    res.json(userData);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/users', async (req, res) => {
  try {
    if (!await authorizePermission(res, req.user, 'manage_users')) return;
    const users = await User.find().select('-password').sort({ username: 1 }).lean();
    res.json(users.map(user => {
      if (user.profilePhoto?.includes('drive.google.com')) {
        user.profilePhoto = `${req.protocol}://${req.get('host')}/api/media/${extractDriveId(user.profilePhoto)}`;
      }
      return user;
    }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/users', async (req, res) => {
  try {
    const { username, password, isAdmin, permissions } = req.body;
    if (!await authorizePermission(res, req.user, 'manage_users')) return;
    if (!username || !password) {
      return res.status(400).json({ error: 'Usuario y contraseña requeridos' });
    }
    if (String(password).length < 8 || String(password).length > 128) {
      return res.status(400).json({ error: 'La contraseña debe tener entre 8 y 128 caracteres.' });
    }

    const existing = await User.findOne({ username });
    if (existing) {
      return res.status(400).json({ error: 'El nombre de usuario ya existe' });
    }

    const user = new User({
      username,
      password: await hashPassword(String(password)),
      isAdmin: Boolean(isAdmin),
      permissions: Boolean(isAdmin) || (Array.isArray(permissions) && permissions.includes('admin'))
        ? ALL_USER_PERMISSIONS
        : (Array.isArray(permissions) && permissions.length ? permissions : ['user']),
      isOnline: true,
      lastActive: new Date()
    });

    await user.save();
    emitAdminUsersChanged();
    res.json({
      _id: user._id,
      username: user.username,
      isAdmin: user.isAdmin,
      permissions: user.permissions,
      settings: user.settings,
      lastActive: user.lastActive
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/users/:id', async (req, res) => {
  try {
    const { username, password, isAdmin, permissions, profilePhoto } = req.body;
    if (!await authorizePermission(res, req.user, 'manage_users')) return;
    const update = {};

    if (typeof username === 'string' && username.trim()) {
      const duplicate = await User.findOne({ username: username.trim(), _id: { $ne: req.params.id } });
      if (duplicate) return res.status(400).json({ error: 'El nombre de usuario ya existe' });
      update.username = username.trim();
    }

    if (typeof password === 'string' && password.trim()) {
      if (password.length < 8 || password.length > 128) {
        return res.status(400).json({ error: 'La contraseña debe tener entre 8 y 128 caracteres.' });
      }
      update.password = await hashPassword(password);
    }

    if (typeof isAdmin === 'boolean') {
      update.isAdmin = isAdmin;
    }

    if (Array.isArray(permissions)) {
      update.permissions = permissions.length ? permissions : ['user'];
    }
    if (typeof profilePhoto === 'string') update.profilePhoto = profilePhoto;

    if (update.isAdmin || (Array.isArray(update.permissions) && update.permissions.includes('admin'))) {
      update.permissions = ALL_USER_PERMISSIONS;
    } else if (!Array.isArray(update.permissions)) {
      update.permissions = ['user'];
    }

    const user = await User.findByIdAndUpdate(req.params.id, update, { returnDocument: 'after' }).select('-password');
    if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });
    const result = user.toObject();
    if (result.profilePhoto?.includes('drive.google.com')) {
      result.profilePhoto = `${req.protocol}://${req.get('host')}/api/media/${extractDriveId(result.profilePhoto)}`;
    }
    emitUserChanged(user._id);
    realtimeIo?.to(`user:${user._id}`).emit('friendsChanged');
    const updatedFriends = await User.findById(user._id).select('friends').lean();
    for (const friendId of updatedFriends?.friends || []) {
      realtimeIo?.to(`user:${friendId}`).emit('friendsChanged');
    }
    realtimeIo?.to(`user:${user._id}`).emit('accountAccessChanged');
    emitAdminUsersChanged();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/users/:id', async (req, res) => {
  try {
    if (!await authorizePermission(res, req.user, 'manage_users')) return;
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });

    if (user.username === 'Fran') {
      return res.status(400).json({ error: 'No puedes eliminar al administrador principal.' });
    }

    await User.findByIdAndDelete(req.params.id);
    realtimeIo?.to(`user:${req.params.id}`).emit('accountRemoved');
    emitAdminUsersChanged();
    res.json({ success: true, message: 'Usuario eliminado correctamente' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/users/status', async (req, res) => {
  try {
    const { userId, isOnline, lastPlayed } = req.body;
    if (!userId) return res.status(400).json({ error: 'Falta userId' });

    const updateData = { lastActive: new Date() };
    if (typeof isOnline === 'boolean') {
      const activeSockets = isOnline === false && realtimeIo
        ? await realtimeIo.in(`user:${userId}`).fetchSockets()
        : [];
      if (isOnline || activeSockets.length === 0) updateData.isOnline = isOnline;
    }
    let previousUser = null;
    if (lastPlayed) {
      previousUser = await User.findById(userId).select('lastPlayed lastPlayedHistory');
      const isNewSong = String(previousUser?.lastPlayed?.songId || '') !== String(lastPlayed.songId || '');
      updateData.lastPlayed = {
        ...lastPlayed,
        updatedAt: new Date()
      };
      if (isNewSong || !previousUser?.lastPlayedHistory?.length) {
        updateData.$push = {
          lastPlayedHistory: {
            $each: [{
              songId: lastPlayed.songId,
              songName: lastPlayed.songName,
              artist: lastPlayed.artist,
              cover: lastPlayed.cover,
              color: lastPlayed.color,
              playedAt: new Date()
            }],
            $slice: -20
          }
        };
      }
      if (lastPlayed.countListeningDelta !== false) {
        updateData.$inc = {
          'stats.listeningSeconds': lastPlayed.isPlaying
            ? Math.max(0, Number(lastPlayed.currentTime || 0) - Number(previousUser?.lastPlayed?.currentTime || 0))
            : 0
        };
        if (isNewSong) updateData.$inc['stats.songsPlayed'] = 1;
      }
      updateData['stats.lastPlayedAt'] = new Date();
    }
    const updatedUser = await User.findByIdAndUpdate(userId, updateData, {
      returnDocument: 'after'
    }).select('friends isOnline lastPlayed lastActive').lean();
    if (lastPlayed) emitUserStatsChanged(userId);
    if (updatedUser && (typeof isOnline === 'boolean' || lastPlayed)) {
      for (const friendId of updatedUser.friends || []) {
        realtimeIo?.to(`user:${friendId}`).emit('presenceChanged', {
          userId: String(updatedUser._id),
          isOnline: updatedUser.isOnline,
          lastPlayed: updatedUser.lastPlayed,
          updatedAt: updatedUser.lastActive
        });
      }
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/users/offline-listening', async (req, res) => {
  try {
    const { batchId, seconds } = req.body;
    const listeningSeconds = Number(seconds);
    if (
      typeof batchId !== 'string'
      || !/^[\w-]{8,80}$/.test(batchId)
      || !Number.isFinite(listeningSeconds)
      || listeningSeconds <= 0
      || listeningSeconds > 3600
    ) {
      return res.status(400).json({ error: 'El lote de escucha offline no es válido.' });
    }

    try {
      const result = await OfflineListeningBatch.updateOne(
        { userId: req.user._id, batchId },
        { $setOnInsert: { seconds: listeningSeconds } },
        { upsert: true }
      );
      if (result.upsertedCount) emitUserStatsChanged(req.user._id);
    } catch (error) {
      if (error.code !== 11000) throw error;
    }

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/users/:id/stats', async (req, res) => {
  try {
    const isSelf = String(req.params.id) === String(req.user._id);
    const isFriend = !isSelf && await User.exists({ _id: req.user._id, friends: req.params.id });
    if (!isSelf && !isFriend) return res.status(403).json({ error: 'Solo puedes consultar estadísticas de amigos.' });
    const user = await User.findById(req.params.id).select('stats friends isAdmin createdAt').lean();
    if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });
    const offlineListening = await OfflineListeningBatch.aggregate([
      { $match: { userId: new mongoose.Types.ObjectId(req.params.id) } },
      { $group: { _id: null, seconds: { $sum: '$seconds' } } }
    ]);
    const stats = {
      ...(user.stats || {}),
      listeningSeconds: Number(user.stats?.listeningSeconds || 0) + Number(offlineListening[0]?.seconds || 0),
      role: user.isAdmin ? 'Administrador' : 'Usuario',
      createdAt: user.createdAt,
      friendsAdded: user.stats?.friendsAdded ?? (user.friends || []).length
    };
    res.json(stats);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/users/settings', async (req, res) => {
  try {
    const { userId, settings } = req.body;
    if (!userId || !settings || typeof settings !== 'object' || Array.isArray(settings)) {
      return res.status(400).json({ error: 'Se requiere userId y un objeto settings válido.' });
    }
    if (settings.secretPhrases !== undefined && (
      !Array.isArray(settings.secretPhrases)
      || !settings.secretPhrases.every(phrase => typeof phrase === 'string')
    )) {
      return res.status(400).json({ error: 'secretPhrases debe ser una lista de frases de texto.' });
    }
    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ error: 'Usuario no encontrado.' });

    const currentSettings = user.toObject().settings || {};
    user.settings = {
      ...currentSettings,
      ...(settings.seekSeconds !== undefined && Number.isFinite(Number(settings.seekSeconds))
        ? { seekSeconds: Number(settings.seekSeconds) }
        : {}),
      ...(settings.maxVolume !== undefined && Number.isFinite(Number(settings.maxVolume))
        ? { maxVolume: Number(settings.maxVolume) }
        : {}),
      ...(settings.secretPhrases !== undefined
        ? { secretPhrases: settings.secretPhrases.map(phrase => phrase.trim()).filter(Boolean) }
        : {})
    };
    await user.save();
    emitUserChanged(user._id);
    res.json(user.settings);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/users/friends/:userId', async (req, res) => {
  try {
    if (String(req.params.userId) !== String(req.user._id)) {
      return res.status(403).json({ error: 'Solo puedes consultar tu propia lista de amigos.' });
    }
    const user = await User.findById(req.params.userId).populate({
      path: 'friends',
      select: 'username isOnline lastActive lastPlayed lastPlayedHistory profilePhoto isAdmin friends',
      populate: {
        path: 'friends',
        select: 'username isOnline lastActive lastPlayed lastPlayedHistory profilePhoto isAdmin'
      }
    });
    if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });
    const friends = (user.friends || []).map(friend => {
      const friendData = friend.toObject();
      if (friendData.profilePhoto && friendData.profilePhoto.includes('drive.google.com')) {
        friendData.profilePhoto = `${req.protocol}://${req.get('host')}/api/media/${extractDriveId(friendData.profilePhoto)}`;
      }
      friendData.friends = (friendData.friends || []).map(nestedFriend => {
        if (nestedFriend.profilePhoto && nestedFriend.profilePhoto.includes('drive.google.com')) {
          nestedFriend.profilePhoto = `${req.protocol}://${req.get('host')}/api/media/${extractDriveId(nestedFriend.profilePhoto)}`;
        }
        return nestedFriend;
      });
      return friendData;
    });
    res.json(friends);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/users/friends/add', async (req, res) => {
  try {
    const { userId, friendUsername } = req.body;
    const friend = await User.findOne({ username: friendUsername });
    if (!friend) return res.status(404).json({ error: 'Usuario a añadir no encontrado' });
    if (friend._id.toString() === userId) return res.status(400).json({ error: 'No puedes añadirte a ti mismo' });

    const user = await User.findById(userId);
    const isNewFriend = !user.friends.some(id => String(id) === String(friend._id));
    if (isNewFriend) {
      user.friends.push(friend._id);
      await user.save();
    }
    if (!friend.friends.includes(user._id)) {
      friend.friends.push(user._id);
      friend.stats.friendsAdded = (friend.stats.friendsAdded || 0) + 1;
      await friend.save();
    }
    if (isNewFriend) {
      user.stats.friendsAdded = (user.stats.friendsAdded || 0) + 1;
      await user.save();
    }

    realtimeIo?.to(`user:${user._id}`).emit('friendsChanged');
    realtimeIo?.to(`user:${friend._id}`).emit('friendsChanged');
    emitUserStatsChanged(user._id);
    emitUserStatsChanged(friend._id);
    res.json({ success: true, friend: { _id: friend._id, username: friend.username, isOnline: friend.isOnline } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/messages/:userId/:friendId', async (req, res) => {
  try {
    const { userId, friendId } = req.params;
    if (String(userId) !== String(req.user._id)) {
      return res.status(403).json({ error: 'Solo puedes consultar tus propias conversaciones.' });
    }
    if (!isValidObjectId(userId) || !isValidObjectId(friendId)) {
      return res.status(400).json({ error: 'Usuarios no válidos' });
    }
    const chatUser = await requireUser(userId);
    if (!chatUser || !(chatUser.friends || []).some(id => String(id) === String(friendId))) {
      return res.status(403).json({ error: 'Solo puedes consultar chats con tus amigos' });
    }
    const messages = await Message.find({
      $or: [
        { sender: userId, receiver: friendId },
        { sender: friendId, receiver: userId }
      ]
    }).sort({ timestamp: 1 }).lean();
    const readResult = await Message.updateMany(
      { receiver: userId, sender: friendId, readAt: { $exists: false } },
      { $set: { readAt: new Date() } }
    );
    if (readResult.modifiedCount) {
      realtimeIo?.to(`user:${friendId}`).emit('messagesRead', { readerId: userId });
    }
    res.json(messages);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/messages', async (req, res) => {
  try {
    const { sender, receiver, content } = req.body;
    if (!sender || !receiver || !String(content || '').trim()) return res.status(400).json({ error: 'Datos incompletos' });
    if (!isValidObjectId(sender) || !isValidObjectId(receiver) || String(sender) === String(receiver)) {
      return res.status(400).json({ error: 'Usuarios no válidos' });
    }
    const [senderUser, receiverUser] = await Promise.all([requireUser(sender), requireUser(receiver)]);
    if (!senderUser || !receiverUser) return res.status(404).json({ error: 'Usuario no encontrado' });
    if (!(senderUser.friends || []).some(id => String(id) === String(receiver))) {
      return res.status(403).json({ error: 'Solo puedes enviar mensajes a tus amigos' });
    }

    const message = new Message({ sender, receiver, content: String(content).trim() });
    await message.save();
    await User.findByIdAndUpdate(sender, { $inc: { 'stats.messagesSent': 1 } });
    emitUserStatsChanged(sender);
    if (realtimeIo) {
      realtimeIo.to(`user:${receiver}`).emit('messageReceived', { message: message.toObject() });
      realtimeIo.to(`user:${sender}`).emit('messageSent', { message: message.toObject() });
    }
    res.json(message);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/notifications/:userId', async (req, res) => {
  try {
    if (String(req.params.userId) !== String(req.user._id)) {
      return res.status(403).json({ error: 'Solo puedes consultar tus propias notificaciones.' });
    }
    if (!isValidObjectId(req.params.userId)) return res.status(400).json({ error: 'Usuario no válido' });
    const notifications = await Message.find({
      receiver: req.params.userId,
      readAt: { $exists: false }
    }).sort({ timestamp: -1 }).limit(100).lean();
    res.json(notifications);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/notifications/:userId/read', async (req, res) => {
  try {
    if (String(req.params.userId) !== String(req.user._id)) {
      return res.status(403).json({ error: 'Solo puedes actualizar tus propias notificaciones.' });
    }
    if (!isValidObjectId(req.params.userId)) return res.status(400).json({ error: 'Usuario no válido' });
    await Message.updateMany({ receiver: req.params.userId, readAt: { $exists: false } }, { $set: { readAt: new Date() } });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/songs', async (req, res) => {
  if (!isDatabaseReady()) {
    return res.status(503).json({ error: 'La base de datos no está disponible.' });
  }

  try {
    const songs = await Song.find().lean();
    const songsWithProxy = songs.map(song => {
      const songObj = song;
      if (songObj.path && songObj.path.includes('drive.google.com')) {
        songObj.path = `${req.protocol}://${req.get('host')}/api/media/${extractDriveId(songObj.path)}`;
      }
      if (songObj.cover && songObj.cover.includes('drive.google.com')) {
        songObj.cover = `${req.protocol}://${req.get('host')}/api/media/${extractDriveId(songObj.cover)}`;
      }
      return songObj;
    });
    res.json({ songs: songsWithProxy });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/discord/external-assets', async (req, res) => {
  if (!process.env.DISCORD_CLIENT_ID || !process.env.DISCORD_CLIENT_SECRET) {
    return res.status(503).json({ error: 'Discord no tiene configuradas las credenciales de assets en el servidor.' });
  }
  if (!isValidObjectId(req.body?.songId)) {
    return res.status(400).json({ error: 'La canción para registrar la portada no es válida.' });
  }

  try {
    const song = await Song.findById(req.body.songId).select('cover').lean();
    if (!song?.cover || song.cover === '/img/vinculo.png') {
      return res.status(404).json({ error: 'La canción no tiene una portada disponible.' });
    }

    const publicAppUrl = new URL(process.env.PUBLIC_APP_URL || 'https://mmamgc.onrender.com/');
    if (publicAppUrl.protocol !== 'https:' || publicAppUrl.username || publicAppUrl.password) {
      return res.status(503).json({ error: 'PUBLIC_APP_URL debe ser una URL HTTPS pública.' });
    }
    const isDriveCover = song.cover.includes('drive.google.com');
    const driveFileId = isDriveCover ? extractDriveId(song.cover) : null;
    if (isDriveCover && !/^[\w-]{25,}$/.test(driveFileId || '')) {
      return res.status(400).json({ error: 'La URL de portada de Google Drive no es válida.' });
    }
    const imageUrl = isDriveCover
      ? new URL(`/api/media/${driveFileId}`, publicAppUrl)
      : new URL(song.cover, publicAppUrl);
    if (imageUrl.protocol !== 'https:' || imageUrl.username || imageUrl.password
      || imageUrl.origin !== publicAppUrl.origin) {
      return res.status(400).json({ error: 'La portada debe estar alojada en el servidor HTTPS de la aplicación.' });
    }

    const largeImageKey = await getDiscordExternalAssetKey(imageUrl.href);
    return res.json({
      applicationId: process.env.DISCORD_CLIENT_ID,
      largeImageKey
    });
  } catch (error) {
    console.error('No se pudo registrar la portada de la canción en Discord:', error);
    return res.status(502).json({
      error: 'Discord no pudo registrar la portada de esta canción.',
      reason: error.message || 'Error desconocido al registrar el asset.'
    });
  }
});

app.post('/api/songs', upload.fields([{ name: 'mp3' }, { name: 'cover' }]), async (req, res) => {
  try {
    if (!await authorizePermission(res, req.user, 'edit_songs')) return;
    let pathUrl = req.body.existingPath || '';
    let coverUrl = req.body.existingCover || '';

    if (req.body.ytLink) {
      const { buffer, title } = await downloadYoutubeAudio(req.body.ytLink);
      const fileObject = {
        buffer,
        originalname: sanitizeAudioFileName(req.body.fileName, title || 'Cancion_YT'),
        mimetype: 'audio/mpeg'
      };
      pathUrl = await uploadToDrive(fileObject);
    } else if (req.files['mp3']) {
      const uploadedFile = req.files['mp3'][0];
      if (req.body.fileName) {
        uploadedFile.originalname = sanitizeAudioFileName(
          req.body.fileName,
          uploadedFile.originalname,
          path.extname(uploadedFile.originalname) || '.mp3'
        );
      }
      pathUrl = await uploadToDrive(uploadedFile);
    }

    if (req.files['cover']) coverUrl = await uploadToDrive(req.files['cover'][0]);

    const songData = {
      name: req.body.name,
      artist: req.body.artist,
      color: req.body.color || '#ffffff',
      lyrics: req.body.lyrics,
      duration: Math.max(0, Number(req.body.duration) || 0),
      path: pathUrl,
      cover: coverUrl
    };

    let savedSong;
    const editorId = req.user._id;
    if (req.body.id && req.body.id !== 'undefined') {
      songData.editedBy = editorId || undefined;
      songData.editedAt = new Date();
      savedSong = await Song.findByIdAndUpdate(req.body.id, { $set: songData }, { returnDocument: 'after', runValidators: true })
        .populate('editedBy', 'username');
      if (editorId) await User.findByIdAndUpdate(editorId, { $inc: { 'stats.songsEdited': 1 } });
    } else {
      const newSong = new Song({
        ...songData,
        addedBy: editorId || undefined,
        editedBy: editorId || undefined,
        addedAt: new Date(),
        editedAt: new Date()
      });

      savedSong = await newSong.save();
      if (editorId) await User.findByIdAndUpdate(editorId, { $inc: { 'stats.songsAdded': 1 } });
    }
    
      if (editorId) emitUserStatsChanged(editorId);
      realtimeIo?.emit('songCatalogChanged');
    res.json(savedSong);
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

app.patch('/api/songs/:id/duration', async (req, res) => {
  try {
    if (!await authorizePermission(res, req.user, 'edit_songs')) return;
    const duration = Math.max(0, Number(req.body.duration) || 0);
    if (!isValidObjectId(req.params.id) || duration <= 0) {
      return res.status(400).json({ error: 'Duración no válida' });
    }
    const song = await Song.findByIdAndUpdate(
      req.params.id,
      { $set: { duration } },
      { returnDocument: 'after', runValidators: true }
    ).select('_id duration');
    if (!song) return res.status(404).json({ error: 'Canción no encontrada' });

    const playlists = await Playlist.find({ tracks: song._id }).select('tracks');
    await Promise.all(playlists.map(async playlist => {
      const songs = await Song.find({ _id: { $in: playlist.tracks } }).select('duration');
      const playlistDuration = songs.reduce((total, item) => total + Math.max(0, Number(item.duration) || 0), 0);
      await Playlist.updateOne({ _id: playlist._id }, { $set: { duration: playlistDuration, updatedAt: new Date() } });
    }));
    if (editorId) emitUserStatsChanged(editorId);
    realtimeIo?.emit('songCatalogChanged');
    res.json(song);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.delete('/api/songs/:id', async (req, res) => {
  try {
    if (!await authorizePermission(res, req.user, 'delete_songs')) return;
    const { id } = req.params;
    await Song.findByIdAndDelete(id);
    const affectedPlaylists = await Playlist.find({ tracks: id }).select('tracks');
    await Playlist.updateMany({}, { $pull: { tracks: id, trackDetails: { songId: id } } });
    await Promise.all(affectedPlaylists.map(async playlist => {
      const remainingTracks = playlist.tracks.filter(trackId => String(trackId) !== String(id));
      const songs = remainingTracks.length
        ? await Song.find({ _id: { $in: remainingTracks } }).select('duration')
        : [];
      const duration = songs.reduce((total, song) => total + Math.max(0, Number(song.duration) || 0), 0);
      await Playlist.updateOne({ _id: playlist._id }, { $set: { duration, updatedAt: new Date() } });
    }));
    realtimeIo?.emit('songCatalogChanged');
    res.json({ success: true, message: 'Canción eliminada correctamente' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/playlists', async (req, res) => {
  try {
    const profileUserId = req.query.profileUserId ? normalizeUserId(req.query.profileUserId) : null;
    if (req.query.profileUserId && (!profileUserId || !isValidObjectId(profileUserId))) {
      return res.status(400).json({ error: 'Perfil no válido' });
    }
    if (profileUserId && !(await User.exists({ _id: profileUserId }))) {
      return res.status(404).json({ error: 'Perfil no encontrado' });
    }
    const requestUserData = !profileUserId && req.user?._id
      ? await User.findById(req.user._id).select('savedPlaylists').lean()
      : null;
    const playlistQuery = profileUserId
      ? { $or: [{ userId: profileUserId }, { sharedWith: profileUserId }] }
      : req.user?._id
        ? {
          $or: [
            { userId: req.user._id },
            { sharedWith: req.user._id },
            { id: { $in: requestUserData?.savedPlaylists || [] } }
          ]
        }
        : {};
    const playlists = await Playlist.find(playlistQuery)
      .select('id name desc photo tracks trackDetails duration userId sharedWith createdAt updatedAt')
      .populate({
        path: 'tracks',
        select: 'name artist cover path color duration addedBy editedBy addedAt editedAt',
        populate: [
          { path: 'addedBy', select: 'username profilePhoto' },
          { path: 'editedBy', select: 'username profilePhoto' }
        ]
      })
      .populate({ path: 'userId', select: 'username profilePhoto' })
      .populate({ path: 'sharedWith', select: 'username profilePhoto' })
      .populate({ path: 'trackDetails.addedBy', select: 'username profilePhoto' })
      .populate({ path: 'trackDetails.editedBy', select: 'username profilePhoto' })
      .lean();

    const playlistIds = playlists.map(playlist => playlist.id).filter(Boolean);
    const savedCounts = playlistIds.length
      ? await User.aggregate([
        { $match: { savedPlaylists: { $in: playlistIds } } },
        { $unwind: '$savedPlaylists' },
        { $match: { savedPlaylists: { $in: playlistIds } } },
        { $group: { _id: { userId: '$_id', playlistId: '$savedPlaylists' } } },
        { $group: { _id: '$_id.playlistId', count: { $sum: 1 } } }
      ])
      : [];
    const savedCountByPlaylistId = new Map(savedCounts.map(item => [String(item._id), item.count]));
    playlists.forEach(playlist => {
      playlist.savedCount = savedCountByPlaylistId.get(String(playlist.id)) || 0;
    });
    
    await Promise.all(playlists.map(async pl => {
      const calculatedDuration = (pl.tracks || []).reduce((total, song) => (
        total + Math.max(0, Number(song.duration) || 0)
      ), 0);
      if (calculatedDuration !== Number(pl.duration) || (calculatedDuration > 0 && !pl.duration)) {
        pl.duration = calculatedDuration;
        await Playlist.updateOne({ _id: pl._id }, { $set: { duration: calculatedDuration, updatedAt: new Date() } });
      }
    }));

    const playlistsWithProxy = playlists.map(pl => {
      const plObj = pl;
      plObj.ownerName = plObj.userId && plObj.userId.username ? plObj.userId.username : 'Desconocido';
      plObj.ownerId = plObj.userId ? String(plObj.userId._id || plObj.userId) : null;
      plObj.ownerPhoto = plObj.userId?.profilePhoto || '';
      if (plObj.ownerPhoto && plObj.ownerPhoto.includes('drive.google.com')) {
        plObj.ownerPhoto = `${req.protocol}://${req.get('host')}/api/media/${extractDriveId(plObj.ownerPhoto)}`;
      }
      plObj.sharedWith = Array.isArray(plObj.sharedWith)
        ? plObj.sharedWith.map(u => {
          const profilePhoto = u.profilePhoto && u.profilePhoto.includes('drive.google.com')
            ? `${req.protocol}://${req.get('host')}/api/media/${extractDriveId(u.profilePhoto)}`
            : u.profilePhoto || '';
          return { _id: String(u._id), username: u.username, profilePhoto };
        })
        : [];
      
      if (plObj.photo && plObj.photo.includes('drive.google.com')) {
        plObj.photo = `${req.protocol}://${req.get('host')}/api/media/${extractDriveId(plObj.photo)}`;
      }

      if (plObj.tracks && plObj.tracks.length > 0) {
        plObj.tracks = plObj.tracks.map(song => {
          const detail = (plObj.trackDetails || []).find(item => String(item.songId) === String(song._id));
          if (detail) {
            song.addedBy = detail.addedBy;
            song.addedAt = detail.addedAt;
            song.editedBy = detail.editedBy;
            song.editedAt = detail.editedAt;
          }
          if (song.path && song.path.includes('drive.google.com')) {
            song.path = `${req.protocol}://${req.get('host')}/api/media/${extractDriveId(song.path)}`;
          }
          if (song.cover && song.cover.includes('drive.google.com')) {
            song.cover = `${req.protocol}://${req.get('host')}/api/media/${extractDriveId(song.cover)}`;
          }
          for (const contributor of [song.addedBy, song.editedBy]) {
            if (contributor?.profilePhoto && contributor.profilePhoto.includes('drive.google.com')) {
              contributor.profilePhoto = `${req.protocol}://${req.get('host')}/api/media/${extractDriveId(contributor.profilePhoto)}`;
            }
          }
          return song;
        });
      }
      return plObj;
    });

    res.json(playlistsWithProxy);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/playlists/:id/saves', async (req, res) => {
  try {
    const playlist = await Playlist.findOne({ id: req.params.id }).select('id').lean();
    if (!playlist) return res.status(404).json({ error: 'Playlist no encontrada' });
    const savers = await User.find({ savedPlaylists: playlist.id })
      .select('username profilePhoto')
      .sort({ username: 1 })
      .lean();
    res.json({
      count: savers.length,
      users: savers.map(user => ({
        _id: String(user._id),
        username: user.username,
        profilePhoto: user.profilePhoto && user.profilePhoto.includes('drive.google.com')
          ? `${req.protocol}://${req.get('host')}/api/media/${extractDriveId(user.profilePhoto)}`
          : user.profilePhoto || ''
      }))
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/playlists', upload.single('photo'), async (req, res) => {
  try {
    const { id, name, desc } = req.body;
    const userId = normalizeUserId(req.body.userId);
    if (!userId || !isValidObjectId(userId) || !(await requireUser(userId))) {
      return res.status(401).json({ error: 'Usuario no válido' });
    }
    const existingPlaylist = id ? await Playlist.findOne({ id }).select('userId sharedWith tracks trackDetails') : null;
    const canEditExisting = existingPlaylist && (
      String(existingPlaylist.userId) === String(userId)
      || existingPlaylist.sharedWith.some(sharedUserId => String(sharedUserId) === String(userId))
    );
    if (existingPlaylist && !canEditExisting) {
      return res.status(403).json({ error: 'Solo el propietario o un integrante puede editar esta playlist' });
    }
    
    let tracks = req.body.tracks;
    if (typeof tracks === 'string') {
      try { tracks = JSON.parse(tracks); } catch { tracks = []; }
    }

    let photoUrl = req.body.photo || req.body.existingPhoto || '';

    if (req.file) {
      photoUrl = await uploadToDrive(req.file);
    }

    const trackIds = Array.isArray(tracks) ? tracks.map(track => (
      typeof track === 'object' && track !== null ? track._id || track.id : track
    )).filter(Boolean).map(trackId => String(trackId)) : [];
    let incomingTrackDetails = req.body.trackDetails;
    if (typeof incomingTrackDetails === 'string') {
      try { incomingTrackDetails = JSON.parse(incomingTrackDetails); } catch { incomingTrackDetails = []; }
    }
    const detailsBySongId = new Map(
      (Array.isArray(incomingTrackDetails) ? incomingTrackDetails : []).map(detail => [
        String(detail.songId || detail._id || detail.id),
        detail
      ])
    );
    const previousDetails = new Map((existingPlaylist?.trackDetails || []).map(detail => [String(detail.songId), detail]));
    const trackDetails = Array.isArray(tracks) ? tracks.map(track => {
      const songId = typeof track === 'object' && track !== null ? track._id || track.id : track;
      if (!songId) return null;
      const incoming = typeof track === 'object' && track !== null ? track : {};
      const submittedDetail = detailsBySongId.get(String(songId)) || {};
      const previous = previousDetails.get(String(songId));
      const wasAlreadyInPlaylist = existingPlaylist?.tracks?.some(existingTrackId => (
        String(existingTrackId) === String(songId)
      ));
      const isNewTrack = !wasAlreadyInPlaylist;
      return {
        songId,
        addedBy: isNewTrack ? userId : previous?.addedBy,
        addedAt: isNewTrack ? new Date() : previous?.addedAt,
        editedBy: submittedDetail.editedBy?._id || submittedDetail.editedBy
          || incoming.editedBy?._id || incoming.editedBy || previous?.editedBy,
        editedAt: submittedDetail.editedAt || incoming.editedAt || previous?.editedAt
      };
    }).filter(Boolean) : [];
    const songs = trackIds.length
      ? await Song.find({ _id: { $in: trackIds } }).select('duration')
      : [];
    const calculatedDuration = songs.reduce((total, song) => (
      total + Math.max(0, Number(song.duration) || 0)
    ), 0);
    const duration = calculatedDuration;
    const updateDoc = {
      name,
      desc,
      photo: photoUrl,
      tracks: trackIds,
      trackDetails,
      duration,
      updatedAt: new Date(),
      userId: existingPlaylist?.userId || userId
    };

    const newPl = await Playlist.findOneAndUpdate(
      { id: id || new mongoose.Types.ObjectId().toString() }, 
      updateDoc,
      { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true }
    );
    if (!existingPlaylist && userId) {
      await User.findByIdAndUpdate(userId, { $inc: { 'stats.playlistsCreated': 1 } });
      emitUserStatsChanged(userId);
    }
    emitPlaylistChanged(newPl, userId);
    res.json(newPl);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

async function recalculatePlaylistDuration(playlist) {
  const currentPlaylist = await Playlist.findById(playlist._id).select('id userId sharedWith tracks');
  if (!currentPlaylist) return null;
  const songs = currentPlaylist.tracks.length
    ? await Song.find({ _id: { $in: currentPlaylist.tracks } }).select('duration')
    : [];
  const duration = songs.reduce((total, song) => total + Math.max(0, Number(song.duration) || 0), 0);
  await Playlist.updateOne(
    { _id: currentPlaylist._id },
    { $set: { duration, updatedAt: new Date() } }
  );
  return Playlist.findById(currentPlaylist._id);
}

function emitPlaylistChanged(playlist, changedBy) {
  if (!realtimeIo || !playlist) return;
  const recipients = new Set([
    String(playlist.userId),
    ...(playlist.sharedWith || []).map(memberId => String(memberId))
  ]);
  recipients.forEach(recipientId => {
    realtimeIo.to(`user:${recipientId}`).emit('playlistChanged', {
      playlistId: playlist.id,
      changedBy
    });
  });
}

app.post('/api/playlists/:id/tracks', async (req, res) => {
  try {
    const userId = normalizeUserId(req.body.userId);
    const songId = normalizeUserId(req.body.songId);
    if (!isValidObjectId(userId) || !isValidObjectId(songId)) {
      return res.status(400).json({ error: 'Usuario o canción no válidos' });
    }
    const song = await Song.findById(songId);
    if (!song) return res.status(404).json({ error: 'Canción no encontrada' });

    const updated = await Playlist.findOneAndUpdate(
      {
        id: req.params.id,
        $or: [{ userId }, { sharedWith: userId }],
        tracks: { $ne: songId }
      },
      {
        $addToSet: { tracks: songId },
        $push: { trackDetails: { songId, addedBy: userId, addedAt: new Date() } },
        $set: { updatedAt: new Date() }
      },
      { returnDocument: 'after' }
    );
    if (!updated) {
      const existing = await Playlist.findOne({ id: req.params.id }).select('tracks');
      if (!existing) return res.status(404).json({ error: 'Playlist no encontrada' });
      if (existing.tracks.some(track => String(track) === String(songId))) {
        return res.status(409).json({ error: 'La canción ya está en la playlist' });
      }
      return res.status(403).json({ error: 'No tienes permiso para editar esta playlist' });
    }

    const currentPlaylist = await recalculatePlaylistDuration(updated);
    emitPlaylistChanged(currentPlaylist, userId);
    res.json({ success: true, playlist: currentPlaylist });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.delete('/api/playlists/:id/tracks/:songId', async (req, res) => {
  try {
    const userId = normalizeUserId(req.body.userId);
    const songId = normalizeUserId(req.params.songId);
    if (!isValidObjectId(userId) || !isValidObjectId(songId)) {
      return res.status(400).json({ error: 'Usuario o canción no válidos' });
    }
    const playlist = await Playlist.findOne({ id: req.params.id }).select('userId sharedWith tracks');
    if (!playlist) return res.status(404).json({ error: 'Playlist no encontrada' });
    const canEdit = String(playlist.userId) === String(userId)
      || playlist.sharedWith.some(memberId => String(memberId) === String(userId));
    if (!canEdit) return res.status(403).json({ error: 'No tienes permiso para editar esta playlist' });
    if (!playlist.tracks.some(track => String(track) === String(songId))) {
      return res.status(404).json({ error: 'La canción ya no está en la playlist' });
    }

    const updated = await Playlist.findOneAndUpdate(
      {
        id: req.params.id,
        tracks: songId
      },
      {
        $pull: {
          tracks: songId,
          trackDetails: { songId }
        },
        $set: { updatedAt: new Date() }
      },
      { returnDocument: 'after' }
    );
    if (!updated) return res.status(404).json({ error: 'La canción ya no está en la playlist' });

    const currentPlaylist = await recalculatePlaylistDuration(updated);
    emitPlaylistChanged(currentPlaylist, userId);
    res.json({ success: true, playlist: currentPlaylist });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/playlists/:id/save', async (req, res) => {
  try {
    const userId = normalizeUserId(req.body.userId);
    if (!userId || !isValidObjectId(userId)) return res.status(400).json({ error: 'Falta el usuario' });
    if (!(await requireUser(userId))) return res.status(404).json({ error: 'Usuario no encontrado' });
    const playlist = await Playlist.findOne({ id: req.params.id }).select('id userId sharedWith');
    if (!playlist) return res.status(404).json({ error: 'Playlist no encontrada' });
    if (String(playlist.userId) === String(userId)) {
      return res.status(400).json({ error: 'El propietario ya tiene esta playlist' });
    }
    const alreadySaved = (await User.exists({ _id: userId, savedPlaylists: playlist.id })) !== null;
    if (!alreadySaved) {
      await User.findByIdAndUpdate(userId, { $addToSet: { savedPlaylists: playlist.id } });
      await User.findByIdAndUpdate(userId, { $inc: { 'stats.playlistsSaved': 1 } });
    }
    const updatedUser = await User.findById(userId).select('savedPlaylists').lean();
    const savedCount = await User.countDocuments({ savedPlaylists: playlist.id });
    const saver = await User.findById(userId).select('username profilePhoto').lean();
    emitUserStatsChanged(userId);
    realtimeIo?.to(`user:${userId}`).emit('playlistsChanged');
    realtimeIo?.emit('playlistSavesChanged', {
      playlistId: playlist.id,
      savedCount,
      saved: true,
      user: saver ? {
        _id: String(saver._id),
        username: saver.username,
        profilePhoto: saver.profilePhoto && saver.profilePhoto.includes('drive.google.com')
          ? `${req.protocol}://${req.get('host')}/api/media/${extractDriveId(saver.profilePhoto)}`
          : saver.profilePhoto || ''
      } : null
    });
    res.json({ success: true, savedPlaylists: updatedUser?.savedPlaylists || [], savedCount });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.delete('/api/playlists/:id/save', async (req, res) => {
  try {
    const userId = normalizeUserId(req.body.userId);
    if (!userId || !isValidObjectId(userId)) return res.status(400).json({ error: 'Falta el usuario' });
    if (!(await requireUser(userId))) return res.status(404).json({ error: 'Usuario no encontrado' });
    const playlist = await Playlist.findOne({ id: req.params.id });
    if (!playlist) return res.status(404).json({ error: 'Playlist no encontrada' });
    if (String(playlist.userId) === String(userId)) {
      return res.status(400).json({ error: 'El propietario no puede quitar su propia playlist' });
    }
    const hasSavedPlaylist = (await User.exists({ _id: userId, savedPlaylists: playlist.id })) !== null;
    if (!hasSavedPlaylist) {
      return res.status(403).json({ error: 'No tienes guardada esta playlist' });
    }
    await User.findByIdAndUpdate(userId, { $pull: { savedPlaylists: playlist.id } });
    await User.findByIdAndUpdate(userId, { $inc: { 'stats.playlistsSaved': -1 } });
    const updatedUser = await User.findById(userId).select('savedPlaylists').lean();
    const savedCount = await User.countDocuments({ savedPlaylists: playlist.id });
    const saver = await User.findById(userId).select('username profilePhoto').lean();
    emitUserStatsChanged(userId);
    realtimeIo?.to(`user:${userId}`).emit('playlistsChanged');
    realtimeIo?.emit('playlistSavesChanged', {
      playlistId: playlist.id,
      savedCount,
      saved: false,
      user: saver ? {
        _id: String(saver._id),
        username: saver.username,
        profilePhoto: saver.profilePhoto && saver.profilePhoto.includes('drive.google.com')
          ? `${req.protocol}://${req.get('host')}/api/media/${extractDriveId(saver.profilePhoto)}`
          : saver.profilePhoto || ''
      } : null
    });
    res.json({ success: true, savedPlaylists: updatedUser?.savedPlaylists || [], savedCount });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/playlists/:id/share', async (req, res) => {
  try {
    const { id } = req.params;
    const { fromUserId, friendId } = req.body;
    if (!fromUserId || !friendId || !isValidObjectId(fromUserId) || !isValidObjectId(friendId)) {
      return res.status(400).json({ error: 'Faltan datos para compartir la playlist' });
    }

    const playlist = await Playlist.findOne({ id });
    if (!playlist) return res.status(404).json({ error: 'Playlist no encontrada' });

    const fromUser = await User.findById(fromUserId).select('username friends');
    if (!fromUser) return res.status(404).json({ error: 'Usuario no encontrado' });
    if (String(playlist.userId) !== String(fromUserId)) {
      return res.status(403).json({ error: 'Solo el propietario puede compartir esta playlist' });
    }
    if (!fromUser.friends.map(String).includes(String(friendId))) {
      return res.status(403).json({ error: 'Solo puedes compartir playlists con tus amigos' });
    }

    const invitation = await new Message({
      sender: fromUserId,
      receiver: friendId,
      content: `${fromUser.username} te invitó a compartir la playlist "${playlist.name}"!`,
      type: 'playlist_invitation',
      playlistId: playlist.id,
      invitationStatus: 'pending'
    }).save();
    await User.findByIdAndUpdate(fromUserId, { $inc: { 'stats.messagesSent': 1 } });
    emitUserStatsChanged(fromUserId);
    if (realtimeIo) {
      realtimeIo.to(`user:${friendId}`).emit('messageReceived', {
        message: invitation.toObject()
      });
      realtimeIo.to(`user:${fromUserId}`).emit('messageSent', {
        message: invitation.toObject()
      });
    }

    res.json({ success: true, invitation });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

async function respondToPlaylistInvitation(messageId, userId, accept, trackIds = []) {
  if (!isValidObjectId(userId) || !isValidObjectId(messageId)) return { error: 'Datos de invitación no válidos' };
  const invitation = await Message.findOne({
    _id: messageId,
    receiver: userId,
    type: 'playlist_invitation',
    invitationStatus: 'pending'
  });
  if (!invitation) return { error: 'Invitación no encontrada o ya respondida' };
  const playlist = await Playlist.findOne({ id: invitation.playlistId });
  if (!playlist) return { error: 'Playlist no encontrada' };
  invitation.invitationStatus = accept ? 'accepted' : 'declined';
  await invitation.save();
  if (!accept) {
    realtimeIo?.to(`user:${invitation.sender}`).emit('messageUpdated', { messageId: invitation._id });
    realtimeIo?.to(`user:${userId}`).emit('messageUpdated', { messageId: invitation._id });
    return { invitation };
  }
  if (!playlist.sharedWith.some(id => String(id) === String(userId))) {
    playlist.sharedWith.push(userId);
    playlist.updatedAt = new Date();
    await playlist.save();
  }
  if (Array.isArray(trackIds) && trackIds.length) {
    const validTracks = await Song.find({ _id: { $in: trackIds } }).select('_id').lean();
    const existing = new Set(playlist.tracks.map(track => String(track)));
    validTracks.forEach(track => {
      if (!existing.has(String(track._id))) playlist.tracks.push(track._id);
    });
    const songs = playlist.tracks.length
      ? await Song.find({ _id: { $in: playlist.tracks } }).select('duration')
      : [];
    playlist.duration = songs.reduce((total, song) => total + Math.max(0, Number(song.duration) || 0), 0);
    playlist.updatedAt = new Date();
    await playlist.save();
  }
  if (realtimeIo) {
    realtimeIo.to(`user:${playlist.userId}`).emit('playlistChanged', { playlistId: playlist.id, memberId: userId });
    realtimeIo.to(`user:${userId}`).emit('playlistChanged', { playlistId: playlist.id, memberId: userId });
    realtimeIo.to(`user:${invitation.sender}`).emit('messageUpdated', { messageId: invitation._id });
    realtimeIo.to(`user:${userId}`).emit('messageUpdated', { messageId: invitation._id });
  }
  return { invitation, playlist };
}

app.post('/api/playlists/:id/members/remove', async (req, res) => {
  try {
    const userId = normalizeUserId(req.body.userId);
    const memberId = normalizeUserId(req.body.memberId);
    if (!isValidObjectId(userId) || !isValidObjectId(memberId)) {
      return res.status(400).json({ error: 'Usuarios no válidos' });
    }
    const playlist = await Playlist.findOne({ id: req.params.id });
    if (!playlist) return res.status(404).json({ error: 'Playlist no encontrada' });
    const isOwner = String(playlist.userId) === String(userId);
    const isLeaving = String(userId) === String(memberId);
    if (!isOwner && !isLeaving) return res.status(403).json({ error: 'No tienes permiso para modificar integrantes' });
    if (isOwner && String(memberId) === String(playlist.userId)) {
      return res.status(400).json({ error: 'El propietario no puede quitarse de la playlist' });
    }
    const updateResult = await Playlist.updateOne(
      { _id: playlist._id, sharedWith: memberId },
      { $pull: { sharedWith: memberId }, $set: { updatedAt: new Date() } }
    );
    if (!updateResult.matchedCount) {
      return res.status(404).json({ error: 'El usuario ya no pertenece a esta playlist' });
    }
    playlist.sharedWith = playlist.sharedWith.filter(id => String(id) !== String(memberId));
    if (realtimeIo) {
      realtimeIo.to(`user:${playlist.userId}`).emit('playlistChanged', { playlistId: playlist.id });
      realtimeIo.to(`user:${memberId}`).emit('playlistChanged', { playlistId: playlist.id });
    }
    res.json({ success: true, playlist });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/playlists/invitations/:messageId/respond', async (req, res) => {
  try {
    const result = await respondToPlaylistInvitation(req.params.messageId, req.body.userId, req.body.accept !== false, req.body.trackIds);
    if (result.error) return res.status(404).json(result);
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/messages/:messageId/accept', async (req, res) => {
  try {
    const result = await respondToPlaylistInvitation(req.params.messageId, req.body.userId, true);
    if (result.error) return res.status(404).json(result);
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/playlists/:id/accept', async (req, res) => {
  try {
    if (!isValidObjectId(req.body.userId)) return res.status(400).json({ error: 'Usuario no válido' });
    const invitation = await Message.findOne({
      receiver: req.body.userId,
      playlistId: req.params.id,
      type: 'playlist_invitation',
      invitationStatus: 'pending'
    });
    if (!invitation) return res.status(404).json({ error: 'Invitación no encontrada o ya respondida' });
    const result = await respondToPlaylistInvitation(invitation._id, req.body.userId, true, req.body.trackIds);
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/messages/:messageId/decline', async (req, res) => {
  try {
    const result = await respondToPlaylistInvitation(req.params.messageId, req.body.userId, false);
    if (result.error) return res.status(404).json(result);
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/playlists/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ error: 'Falta userId' });
    const playlist = await Playlist.findOne({ id }).select('userId sharedWith');
    if (!playlist) return res.status(404).json({ error: 'Playlist no encontrada' });
    if (String(playlist.userId) !== String(userId)) {
      return res.status(403).json({ error: 'Solo el propietario puede eliminar esta playlist' });
    }
    const savedByUsers = await User.find({ savedPlaylists: id }).select('_id').lean();
    await Playlist.deleteOne({ id });
    await User.updateMany(
      { savedPlaylists: id },
      { $pull: { savedPlaylists: id }, $inc: { 'stats.playlistsSaved': -1 } }
    );
    const recipients = new Set([
      String(playlist.userId),
      ...(playlist.sharedWith || []).map(String),
      ...savedByUsers.map(savedUser => String(savedUser._id))
    ]);
    for (const recipientId of recipients) {
      realtimeIo?.to(`user:${recipientId}`).emit('playlistChanged', { playlistId: id, deleted: true });
      if (savedByUsers.some(savedUser => String(savedUser._id) === recipientId)) {
        emitUserStatsChanged(recipientId);
      }
    }
    res.json({ success: true, message: 'Playlist eliminada correctamente' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/yt-download', async (req, res) => {
  try {
    const { ytLink, fileName } = req.body;
    if (!ytLink) return res.status(400).json({ error: 'Falta el link de YouTube' });
    if (!isValidYoutubeUrl(ytLink)) {
      return res.status(400).json({ error: 'El enlace de YouTube no es válido.' });
    }

    const { buffer, title } = await downloadYoutubeAudio(ytLink);
    const localFile = await saveMp3Locally(title, buffer, fileName);

    res.json({
      success: true,
      title,
      path: localFile.filePath,
      fileName: localFile.fileName,
      size: buffer.length
    });
  } catch (error) {
    res.status(error.statusCode || 500).json({ error: error.message });
  }
});

app.post('/api/yt-download/upload', upload.single('mp3'), async (req, res) => {
  try {
    if (!req.file?.buffer?.length) {
      return res.status(400).json({ error: 'No se recibió un archivo de audio válido.' });
    }
    const title = String(req.body.title || req.file.originalname || 'audio').trim();
    const localFile = await saveMp3Locally(title, req.file.buffer, req.body.fileName);
    res.json({
      success: true,
      title,
      path: localFile.filePath,
      fileName: localFile.fileName,
      size: req.file.size
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/media/:fileId', async (req, res) => {
  try {
    const { fileId } = req.params;
    if (!oauthClient) {
      console.error('Drive no disponible: cliente OAuth no inicializado.');
      return res.status(503).json({ error: 'Google Drive no está configurado en el servidor.' });
    }

    const now = Date.now();
    if (!cachedDriveAccessToken || cachedDriveTokenExpiresAt <= now) {
      const accessTokenObj = await oauthClient.getAccessToken();
      cachedDriveAccessToken = accessTokenObj.token || accessTokenObj;
      cachedDriveTokenExpiresAt = now + (5 * 60 * 1000);
    }

    const headers = { Authorization: `Bearer ${cachedDriveAccessToken}` };
    if (req.headers.range) headers.Range = req.headers.range;

    const response = await axios({
      method: 'get',
      url: `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`,
      headers: headers,
      responseType: 'stream',
      validateStatus: (status) => status >= 200 && status < 400 
    });

    if (response.headers['content-type']) res.setHeader('Content-Type', response.headers['content-type']);
    if (response.headers['content-length']) res.setHeader('Content-Length', response.headers['content-length']);
    if (response.headers['content-range']) res.setHeader('Content-Range', response.headers['content-range']);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'public, max-age=86400, stale-while-revalidate=604800');

    res.status(response.status);
    response.data.pipe(res);
  } catch (error) {
    const status = error.response?.status;
    const googleError = error.response?.data?.error;
    const isAuthError = status === 401
      || status === 403
      || error.code === 'invalid_grant'
      || error.message?.includes('invalid_grant');
    const responseStatus = status === 404 ? 404 : isAuthError ? 502 : 500;

    console.error('Error obteniendo archivo multimedia desde Google Drive:', {
      fileId,
      message: error.message,
      code: error.code,
      status,
      googleReason: googleError?.errors?.[0]?.reason || googleError?.status
    });

    res.status(responseStatus).json({
      error: isAuthError
        ? 'La autorizacion de Google Drive expiro o no tiene permisos.'
        : status === 404
          ? 'El archivo no existe en Google Drive.'
          : 'No se pudo obtener el archivo multimedia desde Google Drive.',
      ...(process.env.NODE_ENV !== 'production' && { details: error.message })
    });
  }
});

if (process.env.NODE_ENV === 'production') {
  const webAppDirectory = path.resolve(process.cwd(), 'dist');
  app.use(express.static(webAppDirectory));
  app.use((req, res, next) => {
    if (
      req.method !== 'GET'
      || req.path === '/api'
      || req.path.startsWith('/api/')
      || req.path === '/socket.io'
      || req.path.startsWith('/socket.io/')
    ) {
      next();
      return;
    }
    res.sendFile(path.join(webAppDirectory, 'index.html'), error => {
      if (error) next(error);
    });
  });
}

const isMainModule = process.argv[1]
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isMainModule) {
  const requestedPort = process.env.PORT === '0' ? 0 : Number(process.env.PORT) || 5000;
  const host = desktopDownloaderOnly ? '127.0.0.1' : undefined;
  const server = app.listen(requestedPort, host, () => {
    const boundPort = server.address().port;
    console.log(desktopDownloaderOnly
      ? `MMAMGC_DESKTOP_DOWNLOADER_READY:${boundPort}`
      : `Servidor corriendo en puerto ${boundPort}`);
  });

  if (!desktopDownloaderOnly) {
    const io = new SocketIOServer(server, {
      cors: { origin: true, credentials: true }
    });
    realtimeIo = io;

  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth?.token;
      if (typeof token !== 'string' || !token) {
        return next(new Error('Se requiere una sesión autenticada.'));
      }
      const payload = jwt.verify(token, jwtSecret);
      const userId = normalizeUserId(payload.sub);
      if (!userId || !isValidObjectId(userId)) {
        return next(new Error('La sesión no es válida.'));
      }
      const user = await User.findById(userId).select('_id isAdmin permissions');
      if (!user) return next(new Error('La cuenta asociada ya no existe.'));
      socket.data.userId = String(user._id);
      socket.data.canManageUsers = Boolean(user.isAdmin || user.permissions?.includes('manage_users'));
      socket.data.tokenExpiresAt = payload.exp * 1000;
      return next();
    } catch {
      return next(new Error('La sesión no es válida o ha expirado.'));
    }
  });

  io.on('connection', (socket) => {
    const authenticatedUserId = socket.data.userId;
    const tokenExpiryTimer = setTimeout(
      () => socket.disconnect(true),
      Math.max(0, socket.data.tokenExpiresAt - Date.now())
    );
    socket.join(`user:${authenticatedUserId}`);
    if (socket.data.canManageUsers) socket.join('admins');
    const refreshFriendIds = async () => {
      const user = await User.findById(authenticatedUserId).select('friends').lean();
      socket.data.friendIds = (user?.friends || []).map(String);
      return socket.data.friendIds;
    };
    const onlinePresencePromise = User.findByIdAndUpdate(
      authenticatedUserId,
      { isOnline: true, lastActive: new Date() },
      { returnDocument: 'after' }
    ).select('lastActive').lean();
    Promise.all([refreshFriendIds(), onlinePresencePromise]).then(([friendIds, onlineUser]) => {
      for (const friendId of friendIds) {
        io.to(`user:${friendId}`).emit('presenceChanged', {
          userId: authenticatedUserId,
          isOnline: true,
          updatedAt: onlineUser?.lastActive
        });
      }
    }).catch(error => console.error('Error actualizando presencia y amigos del socket:', error));

    socket.on('friendsChanged', () => {
      refreshFriendIds().catch(error => console.error('Error actualizando amigos del socket:', error));
    });

    socket.on('annoy', async ({ friendId } = {}, acknowledge = () => {}) => {
      const senderId = socket.data.userId;
      const normalizedFriendId = normalizeUserId(friendId);
      if (!senderId || !normalizedFriendId || !isValidObjectId(normalizedFriendId)) {
        acknowledge({ success: false, error: 'El usuario destinatario no es válido.' });
        return;
      }
      try {
        const [sender, recipient] = await Promise.all([
          User.findById(senderId).select('username friends').lean(),
          User.findById(normalizedFriendId).select('friends').lean()
        ]);
        const areFriends = sender?.friends?.some(id => String(id) === normalizedFriendId)
          && recipient?.friends?.some(id => String(id) === senderId);
        if (!areFriends) {
          acknowledge({ success: false, error: 'Solo puedes molestar a un amigo.' });
          return;
        }
        const recipientRoom = `user:${normalizedFriendId}`;
        if (!(await io.in(recipientRoom).fetchSockets()).length) {
          acknowledge({ success: false, error: 'Tu amigo no está conectado en este momento.' });
          return;
        }
        io.to(recipientRoom)
          .timeout(5000)
          .emit('annoy', {
            senderId,
            senderName: sender.username
          }, (deliveryError, responses = []) => {
            if (deliveryError) {
              acknowledge({ success: false, error: 'El dispositivo del amigo no confirmó la reproducción.' });
              return;
            }
            const playbackResult = responses.find(response => response?.success);
            acknowledge(playbackResult || {
              success: false,
              error: responses.find(response => response?.error)?.error || 'No se pudo reproducir el audio en el dispositivo del amigo.'
            });
          });
      } catch (error) {
        console.error('No se pudo enviar la molestia en tiempo real:', error);
        acknowledge({ success: false, error: 'No se pudo enviar la molestia.' });
      }
    });

    socket.on('songChanged', async ({ excludeUserId, playback } = {}) => {
      const normalizedId = authenticatedUserId;
      if (!playback || typeof playback !== 'object' || Array.isArray(playback)) return;
      const normalizedExcludeId = normalizeUserId(excludeUserId);
      for (const friendId of socket.data.friendIds || []) {
        if (normalizedExcludeId && friendId === normalizedExcludeId) continue;
        io.to(`user:${friendId}`).emit('songChanged', {
          userId: normalizedId,
          playback: { ...playback, updatedAt: playback.updatedAt || new Date().toISOString() }
        });
      }
      if (normalizedExcludeId && socket.data.friendIds?.includes(normalizedExcludeId)) {
        io.to(`user:${normalizedExcludeId}`).emit('playbackStatusChanged', {
          userId: normalizedId,
          playback: { ...playback, updatedAt: playback.updatedAt || new Date().toISOString() }
        });
      }
    });
    socket.on('disconnect', async () => {
      clearTimeout(tokenExpiryTimer);
      const normalizedId = socket.data.userId;
      if (!normalizedId) return;
      const remainingSockets = [...io.sockets.sockets.values()]
        .some(activeSocket => activeSocket.data.userId === normalizedId);
      if (remainingSockets) return;
      try {
        const user = await User.findByIdAndUpdate(
          normalizedId,
          { isOnline: false, lastActive: new Date() },
          { returnDocument: 'after' }
        ).select('friends lastPlayed lastActive').lean();
        for (const friendId of user?.friends || []) {
          io.to(`user:${friendId}`).emit('presenceChanged', {
            userId: normalizedId,
            isOnline: false,
            lastPlayed: user.lastPlayed,
            updatedAt: user.lastActive
          });
        }
      } catch (error) {
        console.error('Error actualizando presencia desconectada:', error);
      }
    });
  });
  }
  server.requestTimeout = 0;
  server.timeout = 0;
}

export default app;