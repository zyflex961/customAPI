// netlify/functions/proxy.ts
export async function handler(event) {
  // ✅ Allowed origins
  const allowedOrigins = [
    'http://localhost:4321',
    'http://127.0.0.1:4321',
    'http://localhost:4323',
    'http://127.0.0.1:4323',
    'http://localhost:8888',
    'http://127.0.0.1:8888',
    'https://dpsmult.netlify.app',
    'https://walletdpstg.netlify.app',
    'https://multisend-livid.vercel.app',
    'https://walletdps.vercel.app',
    'https://walletdps.netlify.app',

    'https://walletdps.netlify.com',
    'https://walletdps.netlify.app/.netlify/functions/proxy',
    ...(process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',').map((o) => o.trim()) : []),
  ];

  const origin = event.headers.origin || '';
  const allowOrigin =
    allowedOrigins.find((o) => origin.startsWith(o)) || '*';

  const corsHeaders = {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers':
      'x-app-env, X-App-Env, X-App-Version, X-Requested-With, Content-Type, Authorization, Origin, Accept, X-App-Clientid, x-auth-token, X-Auth-Token, Referer, User-Agent, Cache-Control, Pragma',
    'Access-Control-Max-Age': '86400',
  };

  // ✅ Handle CORS preflight
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: corsHeaders, body: '' };
  }

  // ✅ Local test PATCH handler (for MyTonWallet & swaps)
  if (event.httpMethod === 'PATCH') {
    try {
      const body = event.body ? JSON.parse(event.body) : {};
      console.log('🟢 PATCH Request Received:', body);

      if (event.path === '/.netlify/functions/proxy') {
        return {
          statusCode: 200,
          headers: corsHeaders,
          body: JSON.stringify({
            ok: true,
            message: '✅ PATCH method handled successfully!',
            received: body,
          }),
        };
      }
    } catch (err) {
      return {
        statusCode: 400,
        headers: corsHeaders,
        body: JSON.stringify({ error: 'Invalid PATCH body', details: err.message }),
      };
    }
  }

  // ✅ Special handling: local files or DPS manifest
  const urlParam = event.queryStringParameters?.url;
  if (
    urlParam &&
    (urlParam.includes('localhost:4323') ||
      urlParam.includes('localhost:4321') ||
      urlParam.includes('localhost:8888') ||
      urlParam.includes('walletdpstg.netlify.app') ||
      urlParam.includes('dpsmult.netlify.app'))
  ) {
    try {
      const res = await fetch(urlParam);
      const text = await res.text();
      return {
        statusCode: 200,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json',
        },
        body: text,
      };
    } catch (e) {
      return {
        statusCode: 500,
        headers: corsHeaders,
        body: JSON.stringify({ error: e.message }),
      };
    }
  }

  // ✅ Default: forward request to MyTonWallet API
  const path = event.path.replace('/.netlify/functions/proxy', '');
  const query = event.rawQuery ? `?${event.rawQuery}` : '';
  const targetUrl = `https://api.mytonwallet.org${path}${query}`;

  try {
    const response = await fetch(targetUrl, {
      method: event.httpMethod,
      headers: {
        ...event.headers,
        'X-App-Env':
          event.headers['x-app-env'] ||
          event.headers['X-App-Env'] ||
          'Production',
      },
      body: ['GET', 'HEAD'].includes(event.httpMethod)
        ? undefined
        : event.body,
    });

    const data = await response.text();
    return {
      statusCode: response.status,
      headers: {
        ...corsHeaders,
        'Content-Type':
          response.headers.get('content-type') || 'application/json',
      },
      body: data,
    };
  } catch (error) {
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({ error: error.message }),
    };
  }
}