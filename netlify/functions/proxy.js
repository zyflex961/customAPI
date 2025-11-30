// full link: https://walletdps.netlify.app/.netlify/functions/proxy
// netlify/functions/proxy.js

import fs from "fs";
import path from "path";

// ===== Load catalog.json =====
// Use process.cwd() instead of __dirname
let catalog = {};
const catalogPath = path.join(process.cwd(), "netlify/functions/catalog.json");

try {
  catalog = JSON.parse(fs.readFileSync(catalogPath, "utf8"));
  console.log("📦 catalog.json loaded");
} catch (err) {
  console.error("❌ Failed loading catalog:", err.message);
  catalog = { error: "Catalog missing or invalid" };
}

// ===== Allowed Origins =====
const allowedOrigins = [
  "*",
 "https://tonapi.netlify.app",
 "http://localhost:4321",
 "http://127.0.0.1:4321",
 "https://walletweb-delta.vercel.app",
 "https://walletdps.vercel.app",
 "https://walletdps-ihg2.vercel.app",
 "https://walletdps.netlify.app",
  "https://walletdps.vercel.app",
  "http://localhost:8888",
  "http://127.0.0.1:8888",
];

// ===== CORS =====
function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": allowedOrigins.includes(origin)
      ? origin
      : "*",
    "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "*",
    "Access-Control-Max-Age": "86400",
  };
}

// ===== MAIN HANDLER =====
export async function handler(event) {
  const parsed = new URL(event.rawUrl);
  const pathname = parsed.pathname;
  const query = parsed.search || "";
  const origin = event.headers.origin || "";
  const cors = corsHeaders(origin);

  // Handle OPTIONS
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers: cors, body: "" };
  }

  // Serve catalog.json
  const clean = pathname
    .replace("/.netlify/functions/proxy", "")
    .replace("/proxy", "")
    .replace(/\/+$/, "");

  if (clean === "/v2/dapp/catalog") {
    return {
      statusCode: 200,
      headers: { ...cors, "Content-Type": "application/json" },
      body: JSON.stringify(catalog, null, 2),
    };
  }

  if (clean === "/robots.txt") {
    return { statusCode: 200, headers: cors, body: "" };
  }

  // === PROXY request ===
  const proxyPath = pathname
    .replace("/.netlify/functions/proxy", "")
    .replace("/proxy", "");

  const target = `https://api.mytonwallet.org${proxyPath}${query}`;
  console.log("➡️ Forwarding:", target);

  try {
    const response = await fetch(target, {
      method: event.httpMethod,
      headers: {
        Accept: "application/json,text/plain,*/*",
        "Content-Type": "application/json",
        "X-App-Env": "Production",
      },
      body: ["GET", "HEAD"].includes(event.httpMethod)
        ? undefined
        : event.body,
    });

    return {
      statusCode: response.status,
      headers: {
        ...cors,
        "Content-Type":
          response.headers.get("content-type") || "application/json",
      },
      body: await response.text(),
    };
  } catch (err) {
    console.error("❌ Proxy Error:", err.message);
    return {
      statusCode: 500,
      headers: cors,
      body: JSON.stringify({ error: err.message }),
    };
  }
}
