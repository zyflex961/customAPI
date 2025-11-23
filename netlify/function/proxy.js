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
  console.log('📦 catalog.json loaded successfully');
} catch (err) {
  console.error('⚠️ Failed to load catalog.json:', err.message);
  catalog = { error: 'Catalog missing or invalid JSON' };
}

// Watch for updates (dev only)
fs.watchFile(catalogPath, () => {
  try {
    const data = fs.readFileSync(catalogPath, 'utf-8');
    catalog = JSON.parse(data);
    console.log('🔄 catalog.json reloaded');
  } catch (err) {
    console.error('⚠️ catalog reload failed:', err.message);
  }
});

// ========== CORS ==========
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
  'Access-Control-Allow-Headers':
    'x-app-env, X-App-Env, X-App-Version, X-Requested-With, Content-Type, Authorization, Origin, Accept, X-App-Clientid, x-auth-token, X-Auth-Token, Referer, User-Agent, Cache-Control, Pragma',

  'Access-Control-Max-Age': '86400',
};

// ========== Handler ==========
export async function handler(event) {
  const parsedUrl = url.parse(event.rawUrl, true); // FIX: rawUrl preserves ?period=1Y
  const pathname = parsedUrl.pathname;
  const search = parsedUrl.search || '';

  // OPTIONS
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 200,
      headers: corsHeaders,
      body: '',
    };
  }

  // ========== Serve catalog.json ==========
  const cleanPath = pathname.replace('/.netlify/functions/proxy', '').replace('/proxy', '').replace(/\/+$/, '');

  if (cleanPath === '/v2/dapp/catalog') {
    return {
      statusCode: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify(catalog, null, 2),
    };
  }

  // Ignore robots.txt
  if (cleanPath === '/robots.txt') {
    return { statusCode: 200, body: '' };
  }

  // ========== PROXY to MyTonWallet ==========

  const proxyPath = pathname.replace('/.netlify/functions/proxy', '').replace('/proxy', '');

  const targetUrl = `https://api.mytonwallet.org${proxyPath}${search}`;

  console.log('➡️ Forwarding to:', targetUrl);

  try {
    const response = await fetch(targetUrl, {
      method: event.httpMethod,
      headers: {
        'X-App-Env': event.headers['x-app-env'] || 'Production',
        'Content-Type': event.headers['content-type'] || 'application/json',
      },
      body: ['GET', 'HEAD'].includes(event.httpMethod) ? undefined : event.body,
    });
    const body = await response.text();
    return {
      statusCode: response.status,
      headers: {
        ...corsHeaders,
        'Content-Type': response.headers.get('content-type') || 'application/json',
      },
      body,
    };
  } catch (err) {
    console.error('❌ Proxy error:', err.message);
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({ error: err.message }),
    };
  }
}
