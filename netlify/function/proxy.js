// netlify/functions/proxy.js 

import fs from "fs";
import url from "url";
import { fileURLToPath } from "url";
import { dirname } from "path"; 
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ✅ catalog.json path
const catalogPath = `${__dirname}/catalog.json`;
let catalog = {};

try {
  const data = fs.readFileSync(catalogPath, "utf-8");
  catalog = JSON.parse(data);
  console.log("📦 catalog.json loaded successfully");
} catch (err) {
  console.error("⚠️ Failed to load catalog.json:", err.message);
  catalog = { error: "Catalog file missing or invalid JSON" };
}

// 🔄 Watch for file changes (optional in serverless, but kept same)
fs.watchFile(catalogPath, () => {
  try {
    const data = fs.readFileSync(catalogPath, "utf-8");
    catalog = JSON.parse(data);
    console.log("🔄 catalog.json reloaded");
  } catch (err) {
    console.error("⚠️ catalog reload failed:", err.message);
  }
});

// Unique Error Logging
const logFilePath = `${__dirname}/error.log`;
function logUniqueError(method, path, statusCode, errorMsg) {
  try {
    const entry = `[${new Date().toISOString()}] ${method}: ${path} ❌ ${
      statusCode || "NO_CODE"
    } - ${errorMsg}\n`;
    let existingLogs = "";
    if (fs.existsSync(logFilePath)) {
      existingLogs = fs.readFileSync(logFilePath, "utf-8");
    }
    if (!existingLogs.includes(`${method}: ${path} ❌ ${statusCode}`)) {
      fs.appendFileSync(logFilePath, entry);
    }
  } catch (err) {
    console.error("⚠️ Failed to write log:", err.message);
  }
}

// Allowed Origins
const allowedOrigins = [
  'http://localhost:4321',
  'http://127.0.0.1:4321',
  'http://localhost:4323',
  'http://127.0.0.1:4323',
  'http://localhost:8888',
  'http://127.0.0.1:8888',
  'http://localhost:4355',
  'http://127.0.0.1:4355',
  'https://dpsmult.netlify.app',
  'https://walletdpstg.netlify.app',
  'https://multisend-livid.vercel.app',
  'https://walletdps.vercel.app',
  'https://walletdps.netlify.app',
  'https://walletdps.netlify.com',
];

// CORS headers
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
  "Access-Control-Allow-Headers":
    "x-app-env, X-App-Env, X-App-Version, X-Requested-With, Content-Type, Authorization, Origin, Accept, X-App-Clientid, x-auth-token, X-Auth-Token, Referer, User-Agent, Cache-Control, Pragma",
  "Access-Control-Max-Age": "86400",
};

// ✅ Netlify handler
export async function handler(event, context) {
  const parsedUrl = url.parse(event.path, true);
  const incomingPath = parsedUrl.pathname.toLowerCase();
  const origin = event.headers.origin || "";
  const allowOrigin = allowedOrigins.find((o) => origin.startsWith(o)) || "*";

  // Handle OPTIONS
  if (event.httpMethod === "OPTIONS") {
    return {
      statusCode: 200,
      headers: corsHeaders,
      body: "",
    };
  }

  // ✅ Serve catalog.json
const rawPath = parsedUrl.pathname.replace(/\/+$/, '');

// Netlify paths
const cleanPath = rawPath.replace('/.netlify/functions/proxy', '').replace('/proxy', '');

if (cleanPath === '/v2/dapp/catalog') {
  return {
    statusCode: 200,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify(catalog, null, 2),
  };
}
  // Handle PATCH
  if (event.httpMethod === "PATCH") {
    try {
      const parsedBody = event.body ? JSON.parse(event.body) : {};
      console.log("PATCH received:", parsedBody);

      return {
        statusCode: 200,
        headers: corsHeaders,
        body: JSON.stringify({
          ok: true,
          message: "PATCH handled successfully",
          received: parsedBody,
        }),
      };
    } catch (err) {
      console.error("🔴 Invalid PATCH body:", err.message);
      logUniqueError(event.httpMethod, event.path, 400, err.message);
      return {
        statusCode: 400,
        headers: corsHeaders,
        body: JSON.stringify({ error: "Invalid PATCH body", details: err.message }),
      };
    }
  }

  // Ignore robots.txt
  if (incomingPath === "/robots.txt") {
    return {
      statusCode: 200,
      headers: { "Content-Type": "text/plain" },
      body: "",
    };
  }

  // 👇 Proxy logic
 const proxyPath = parsedUrl.pathname.replace('/.netlify/functions/proxy', '').replace('/proxy', '');
  const query = parsedUrl.search || "";
  const targetUrl = `https://api.mytonwallet.org${proxyPath}${query}`;

  try {
    const response = await fetch(targetUrl, {
      method: event.httpMethod,
      headers: {
        ...event.headers,
        "X-App-Env": event.headers["x-app-env"] || "Production",
      },
      body: ["GET", "HEAD"].includes(event.httpMethod) ? undefined : event.body,
    });

    const data = await response.text();
    return {
      statusCode: response.status,
      headers: {
        ...corsHeaders,
        "Content-Type": response.headers.get("content-type") || "application/json",
      },
      body: data,
    };
  } catch (error) {
    console.error(`🔴 ${event.httpMethod}: ${targetUrl} ❌ ${error.message}`);
    logUniqueError(event.httpMethod, targetUrl, 500, error.message);
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({ error: error.message }),
    };
  }
}
