// netlify/functions/proxy.js

import fs from "fs";
import url from "url";
import path from "path";

// ========== Resolve __dirname safely (Netlify-safe) ==========
const __dirname = path.dirname(new URL(import.meta.url).pathname);

// ========== Load catalog.json ==========
let catalog = {};
const catalogPath = path.join(__dirname, "catalog.json");

try {
  if (fs.existsSync(catalogPath)) {
    const raw = fs.readFileSync(catalogPath, "utf-8");
    catalog = JSON.parse(raw);
  } else {
    catalog = { error: "catalog.json not found" };
  }
} catch (err) {
  catalog = { error: "catalog.json read error", details: err.message };
}

// ========== Allowed Origins ==========
const allowedOrigins = [
  "*",
  "https://tonapi.netlify.app",
  "http://localhost:4321",
  "http://127.0.0.1:4321",
  "http://localhost:8888",
];

// ========== CORS ==========
function cors(origin) {
  return {
    "Access-Control-Allow-Origin":
      allowedOrigins.includes(origin) ? origin : "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "*",
    "Access-Control-Max-Age": "86400",
  };
}

// ========== Netlify Handler ==========
export async function handler(event) {
  const parsed = url.parse(event.rawUrl, true);
  const pathname = parsed.pathname;
  const search = parsed.search || "";
  const origin = event.headers.origin || "";
  const headers = cors(origin);

  // OPTIONS request
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers, body: "" };
  }

  // Serve catalog.json
  const clean = pathname
    .replace("/.netlify/functions/proxy", "")
    .replace("/proxy", "")
    .replace(/\/+$/, "");

  if (clean === "/v2/dapp/catalog") {
    return {
      statusCode: 200,
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify(catalog, null, 2),
    };
  }

  // robots.txt
  if (clean === "/robots.txt") {
    return { statusCode: 200, headers, body: "" };
  }

  // PROXY request
  const proxyPath = pathname
    .replace("/.netlify/functions/proxy", "")
    .replace("/proxy", "");

  const targetUrl = `https://api.mytonwallet.org${proxyPath}${search}`;
  console.log("➡️ Forwarding to:", targetUrl);

  try {
    const response = await fetch(targetUrl, {
      method: event.httpMethod,
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "X-App-Env": "Production",
      },
      body:
        ["POST", "PUT", "PATCH"].includes(event.httpMethod) && event.body
          ? event.body
          : undefined,
    });

    const text = await response.text();

    return {
      statusCode: response.status,
      headers: {
        ...headers,
        "Content-Type":
          response.headers.get("content-type") || "application/json",
      },
      body: text,
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: err.message }),
    };
  }
}