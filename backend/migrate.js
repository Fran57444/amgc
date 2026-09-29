import dns from 'node:dns';
dns.setServers(['8.8.8.8', '8.8.4.4']);

import dotenv from 'dotenv';
dotenv.config();
import mongoose from 'mongoose';
import fs from 'fs';
import path from 'path';
import { google } from 'googleapis';
import http from 'http';
import url from 'url';
await mongoose.connect(process.env.MONGO_URI);

const songSchema = new mongoose.Schema({
  id: Number,
  name: String,
  artist: String,
  cover: String,
  path: String,
  color: String,
  lyrics: String
});
const Song = mongoose.model('Song', songSchema);
async function getOAuthClient() {
  const credentialsContent = fs.readFileSync('oauth-credentials.json', 'utf-8');
  const credentials = JSON.parse(credentialsContent);
  const { client_secret, client_id, redirect_uris } = credentials.installed || credentials.web;

  const oAuth2Client = new google.auth.OAuth2(
    client_id,
    client_secret,
    redirect_uris[0] || 'http://localhost:3000'
  );
  if (fs.existsSync('token.json')) {
    const token = JSON.parse(fs.readFileSync('token.json', 'utf-8'));
    oAuth2Client.setCredentials(token);
    return oAuth2Client;
  }
  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      try {
        const qs = url.parse(req.url, true).query;
        if (qs.code) {
          res.end('¡Autenticacion exitosa! Ya puedes cerrar esta pestana.');
          server.close();
          const { tokens } = await oAuth2Client.getToken(qs.code);
          oAuth2Client.setCredentials(tokens);
          fs.writeFileSync('token.json', JSON.stringify(tokens));
          resolve(oAuth2Client);
        }
      } catch {
        reject(e);
      }
    }).listen(3000, async () => {
      const authorizeUrl = oAuth2Client.generateAuthUrl({
        access_type: 'offline',
        scope: ['https://www.googleapis.com/auth/drive.file'],
      });
      console.log('🔗 Abre el siguiente enlace en tu navegador para autorizar la app con tu cuenta personal:\n');
      console.log(authorizeUrl);
      try {
        await import('open').then(m => m.default(authorizeUrl));
      } catch {
      }
    });
  });
}
async function uploadToPersonalDrive(authClient, filePath, mimeType) {
  const drive = google.drive({ version: 'v3', auth: authClient });
  const absolutePath = path.resolve('../public' + filePath);

  if (!fs.existsSync(absolutePath)) {
    console.warn(`⚠️ Archivo local no encontrado: ${absolutePath}`);
    return filePath;
  }

  const fileMetadata = {
    name: path.basename(filePath),
    parents: [process.env.DRIVE_FOLDER_ID],
  };
  
  const media = {
    mimeType: mimeType,
    body: fs.createReadStream(absolutePath),
  };

  try {
    const { data } = await drive.files.create({
      requestBody: fileMetadata,
      media: media,
      fields: 'id, webContentLink',
    });
    await drive.permissions.create({
      fileId: data.id,
      requestBody: { role: 'reader', type: 'anyone' },
    });

    console.log(`Subido a tu Drive: ${fileMetadata.name}`);
    return data.webContentLink;
  } catch (error) {
    console.error(`Error subiendo ${fileMetadata.name}:`, error.message);
    return filePath;
  }
}

async function iniciarMigracion() {
  try {
    console.log('Iniciando autenticación con cuenta personal...');
    const authClient = await getOAuthClient();
    
    const rawData = fs.readFileSync('musicData.json', 'utf-8');
    const jsonData = JSON.parse(rawData);
    const canciones = jsonData.songs;

    console.log(`🚀 Subiendo ${canciones.length} canciones a tu Google Drive personal...`);
    const cancionesProcesadas = [];

    for (const song of canciones) {
      console.log(`\nProcesando: [${song.id}] ${song.name} - ${song.artist}`);

      let newPath = song.path;
      if (song.path && song.path.startsWith('/mp3/')) {
        newPath = await uploadToPersonalDrive(authClient, song.path, 'audio/mpeg');
      }

      let newCover = song.cover;
      if (song.cover && song.cover.startsWith('/img/')) {
        const mime = song.cover.endsWith('.png') ? 'image/png' : 'image/jpeg';
        newCover = await uploadToPersonalDrive(authClient, song.cover, mime);
      }

      cancionesProcesadas.push({
        id: song.id,
        name: song.name,
        artist: song.artist,
        cover: newCover,
        path: newPath,
        color: song.color,
        lyrics: song.lyrics || ""
      });
    }

    await Song.deleteMany({});
    await Song.insertMany(cancionesProcesadas);

    console.log('\n✨ ¡Proceso completado! Tus canciones están en tu Drive personal y guardadas en MongoDB.');
    process.exit(0);
  } catch (error) {
    console.error('Error en la migración:', error);
    process.exit(1);
  }
}

iniciarMigracion();