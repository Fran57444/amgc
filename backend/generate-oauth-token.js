import dotenv from 'dotenv';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { google } from 'googleapis';
import open from 'open';

dotenv.config();

const port = Number(process.env.OAUTH_CALLBACK_PORT || 3000);
const redirectUri = `http://localhost:${port}`;
const credentialsContent = process.env.GOOGLE_OAUTH_CREDENTIALS_JSON;

if (!credentialsContent) {
  throw new Error('Falta GOOGLE_OAUTH_CREDENTIALS_JSON en .env.');
}

const credentials = JSON.parse(credentialsContent);
const { client_id: clientId, client_secret: clientSecret } =
  credentials.installed || credentials.web || {};

if (!clientId || !clientSecret) {
  throw new Error('Las credenciales OAuth no contienen client_id y client_secret.');
}

const authClient = new google.auth.OAuth2(clientId, clientSecret, redirectUri);
const authorizeUrl = authClient.generateAuthUrl({
  access_type: 'offline',
  prompt: 'consent',
  scope: ['https://www.googleapis.com/auth/drive.file']
});

function updateEnvironmentFile(token) {
  const envPath = path.resolve(process.cwd(), '.env');
  const envContent = fs.readFileSync(envPath, 'utf8');
  const serializedToken = JSON.stringify(token);
  const tokenLine = `GOOGLE_OAUTH_TOKEN_JSON=${serializedToken}`;
  const tokenPattern = /^GOOGLE_OAUTH_TOKEN_JSON=.*$/m;
  const updatedContent = tokenPattern.test(envContent)
    ? envContent.replace(tokenPattern, tokenLine)
    : `${envContent.trimEnd()}\n${tokenLine}\n`;

  fs.writeFileSync(envPath, updatedContent);
  fs.writeFileSync(
    path.resolve(process.cwd(), 'token.json'),
    `${JSON.stringify(token, null, 2)}\n`
  );
}

const server = http.createServer(async (request, response) => {
  const requestUrl = new URL(request.url, redirectUri);
  const authorizationError = requestUrl.searchParams.get('error');
  const code = requestUrl.searchParams.get('code');

  if (authorizationError) {
    response.end('La autorizacion fue cancelada. Puedes cerrar esta pestana.');
    server.close();
    console.error(`Google rechazo la autorizacion: ${authorizationError}`);
    return;
  }

  if (!code) {
    response.statusCode = 400;
    response.end('Falta el codigo de autorizacion.');
    return;
  }

  try {
    const { tokens } = await authClient.getToken(code);
    if (!tokens.refresh_token) {
      throw new Error('Google no devolvio refresh_token; vuelve a ejecutar el flujo.');
    }

    authClient.setCredentials(tokens);
    updateEnvironmentFile(tokens);
    response.end('Autorizacion exitosa. Puedes cerrar esta pestana.');
    console.log('Token OAuth generado y guardado en .env y token.json.');
  } catch (error) {
    response.statusCode = 500;
    response.end('No se pudo completar la autorizacion.');
    console.error('Error intercambiando el codigo OAuth:', error.message);
  } finally {
    server.close();
  }
});

server.listen(port, async () => {
  console.log('Abre este enlace para autorizar Google Drive:');
  console.log(authorizeUrl);
  try {
    await open(authorizeUrl);
  } catch {
    console.log('No se pudo abrir el navegador automaticamente; copia el enlace manualmente.');
  }
});
