// netlify/functions/proxy.js

import fs from 'fs';
import url from 'url';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ========== Load catalog.json ==========
const catalogPath = `${__dirname}/catalog.json`;
let catalog = {};

try {
  const data = fs.readFileSync(catalogPath, 'utf-8');
  catalog = JSON.parse(data);
} catch (err) {
  logError('Catalog load error', err);
  catalog = { error: 'Catalog missing or invalid JSON' };
}
// ========== Allowed Origins ==========
const allowedOrigins = [
  'http://localhost:4321',
  'http://127.0.0.1:4321',
  'http://localhost:4323',
  'http://127.0.0.1:4323',
  'http://localhost:4355',
  'http://127.0.0.1:4355',
  'http://localhost:8888',
  'http://127.0.0.1:8888',
  'https://dpsmult.netlify.app',
  'https://walletdpstg.netlify.app',
  'https://multisend-livid.vercel.app',
  'https://walletdps.vercel.app',
  'https://walletdps.netlify.app',
  'https://walletdps.netlify.com',
];
// ========== Error Logger ==========
function logError(context, err) {
  const logPath = `${__dirname}/error.log`;
  const timestamp = new Date().toISOString();
  const message = `[${timestamp}] [${context}] ${err.message || err}\n`;
  try {
    fs.appendFileSync(logPath, message, 'utf-8');
  } catch (fileErr) {
    console.error('⚠️ Failed to write error log:', fileErr.message);
  }
  console.error(message);
}

// ========== CORS Helper ==========
function getCorsHeaders(origin) {
  if (allowedOrigins.includes(origin)) {
    return {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': '*',
      'Access-Control-Max-Age': '86400',
    };
  }
  return { 'Access-Control-Allow-Origin': 'null' };
}

// ========== Handler ==========
export async function handler(event) {
  const parsedUrl = url.parse(event.rawUrl, true);
  const pathname = parsedUrl.pathname;
  const search = parsedUrl.search || '';

  const origin = event.headers.origin || '';
  const corsHeaders = getCorsHeaders(origin);

  // OPTIONS
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: corsHeaders, body: '' };
  }

  // Serve Catalog
  const cleanPath = pathname.replace('/.netlify/functions/proxy', '').replace('/proxy', '').replace(/\/+$/, '');
  if (cleanPath === '/v2/dapp/catalog') {
    return {
      statusCode: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify(catalog, null, 2),
    };
  }
  if (cleanPath === '/robots.txt') {
    return { statusCode: 200, headers: corsHeaders, body: '' };
  }

  // Proxy Logic
  const proxyPath = pathname.replace('/.netlify/functions/proxy', '').replace('/proxy', '');
  const targetUrl = `https://api.mytonwallet.org${proxyPath}${search}`;

  console.log(`➡️  [${event.httpMethod}] ${proxyPath}`);

  try {
    let incomingToken = '';
    let incomingClientId = '';
    Object.keys(event.headers).forEach((key) => {
      if (key.toLowerCase() === 'x-auth-token') incomingToken = event.headers[key];
      if (key.toLowerCase() === 'x-app-clientid') incomingClientId = event.headers[key];
    });

    const newHeaders = {
      Accept: 'application/json, text/plain, */*',
      'Content-Type': 'application/json',
      'X-App-Env': event.headers['x-app-env'] || event.headers['X-App-Env'] || 'Production',
      Origin: 'https://mytonwallet.org',
      Referer: 'https://mytonwallet.org/',
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      Connection: 'keep-alive',
    };

    if (incomingToken) newHeaders['X-Auth-Token'] = incomingToken;
    if (incomingClientId) newHeaders['X-App-Clientid'] = incomingClientId;

    let requestBody = event.body;
    if (['POST', 'PUT', 'PATCH'].includes(event.httpMethod) && event.body) {
      if (event.isBase64Encoded) {
        requestBody = Buffer.from(event.body, 'base64').toString('utf-8');
      }
    } else {
      requestBody = undefined;
    }

    const response = await fetch(targetUrl, {
      method: event.httpMethod,
      headers: newHeaders,
      body: requestBody,
    });

    const responseBody = await response.text();

    if (!response.ok) {
      logError(`API Error ${response.status}`, responseBody.substring(0, 200));
    }

    return {
      statusCode: response.status,
      headers: {
        ...corsHeaders,
        'Content-Type': response.headers.get('content-type') || 'application/json',
      },
      body: responseBody,
    };
  } catch (err) {
    logError('Network Error', err);
    return {
      statusCode: 502,
      headers: corsHeaders,
      body: JSON.stringify({ error: 'Upstream connection failed contact with admin', details: err.message }),
    };
  }
}
