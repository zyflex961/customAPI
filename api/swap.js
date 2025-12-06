/**
 * TON Swap Backend Server
 * MyTonWallet + DeDust + STON.fi Integration
 * 
 * Usage:
 * 1. npm install express cors ws
 * 2. node ton-swap-server.js
 * 3. Server runs on http://localhost:3001
 * 4. WebSocket: ws://localhost:3001
 */

const express  = require('express');
const cors = require('cors');
const http = require('http');
const WebSocket = require('ws');

const app = express();
const PORT = process.env.PORT || 3001;

// Create HTTP server
const server = http.createServer(app);

// Create WebSocket server
const wss = new WebSocket.Server({ server });

// Middleware
app.use(cors());
app.use(express.json());

// ============================================
// CONSTANTS & CONFIGURATION
// ============================================

const DEDUST_API = 'https://api.dedust.io/v2';
const STONFI_API = 'https://api.ston.fi/v1';
const DEDUST_VAULT = 'EQDa4VOnTYlLvDJ0gZjNYm5PXfSmmtL6Vs6A_CZEtXCNICq_';
const DEDUST_FACTORY = 'EQBfBWT7X2BHg9tXAxzhz2aKiNTU1tpt5NsiK0uSDW_YAJ67';

const POOL_TYPE = {
  VOLATILE: 0,
  STABLE: 1
};

// ============================================
// WEBSOCKET CLIENTS MANAGEMENT
// ============================================

const wsClients = new Set();
const priceSubscriptions = new Map(); // clientId -> { pairs: [], interval }

// Generate unique client ID
function generateClientId() {
  return `client_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

// ============================================
// HELPER FUNCTIONS
// ============================================

function toRawAddress(address) {
  if (!address || address === 'native' || address === 'TON') {
    return 'native';
  }
  return address.replace(/[^a-zA-Z0-9_-]/g, '');
}

function formatAmount(amount, decimals = 9) {
  return (BigInt(amount) / BigInt(10 ** decimals)).toString();
}

function calculateMinReceived(amount, slippage) {
  const slippageFactor = 1 - (slippage / 100);
  return Math.floor(Number(amount) * slippageFactor).toString();
}

// ============================================
// DEDUST API FUNCTIONS
// ============================================

async function fetchDedustPools() {
  try {
    const response = await fetch(`${DEDUST_API}/pools`);
    if (!response.ok) throw new Error('Failed to fetch DeDust pools');
    return await response.json();
  } catch (error) {
    console.error('DeDust pools error:', error);
    return [];
  }
}

async function fetchDedustAssets() {
  try {
    const response = await fetch(`${DEDUST_API}/assets`);
    if (!response.ok) throw new Error('Failed to fetch DeDust assets');
    return await response.json();
  } catch (error) {
    console.error('DeDust assets error:', error);
    return [];
  }
}

async function getDedustSwapEstimate(fromToken, toToken, amount) {
  try {
    const pools = await fetchDedustPools();
    const fromAddress = toRawAddress(fromToken);
    const toAddress = toRawAddress(toToken);
    
    let pool = null;
    for (const p of pools) {
      const assets = p.assets || [];
      const hasFrom = fromAddress === 'native' 
        ? assets.some(a => a.type === 'native')
        : assets.some(a => a.address === fromAddress);
      const hasTo = toAddress === 'native'
        ? assets.some(a => a.type === 'native')
        : assets.some(a => a.address === toAddress);
      
      if (hasFrom && hasTo) {
        pool = p;
        break;
      }
    }

    if (!pool) {
      const estimateUrl = `${DEDUST_API}/swap/estimate`;
      const response = await fetch(estimateUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: fromAddress === 'native' ? { type: 'native' } : { type: 'jetton', address: fromAddress },
          to: toAddress === 'native' ? { type: 'native' } : { type: 'jetton', address: toAddress },
          amount: amount
        })
      });

      if (response.ok) {
        const data = await response.json();
        return {
          outputAmount: data.amountOut || data.amount_out,
          priceImpact: data.priceImpact || data.price_impact || '0',
          fee: data.fee || '0',
          route: data.route || 'direct'
        };
      }
    }

    if (pool && pool.reserves) {
      const reserves = pool.reserves;
      const inputReserve = BigInt(reserves[0] || '1000000000000');
      const outputReserve = BigInt(reserves[1] || '1000000000000');
      const inputAmount = BigInt(amount);
      
      const fee = inputAmount * BigInt(3) / BigInt(1000);
      const amountAfterFee = inputAmount - fee;
      const outputAmount = (amountAfterFee * outputReserve) / (inputReserve + amountAfterFee);
      const priceImpact = Number(inputAmount * BigInt(100) / inputReserve);
      
      return {
        outputAmount: outputAmount.toString(),
        priceImpact: priceImpact.toFixed(2),
        fee: fee.toString(),
        route: 'pool',
        poolAddress: pool.address
      };
    }

    return {
      outputAmount: (BigInt(amount) * BigInt(97) / BigInt(100)).toString(),
      priceImpact: '0.5',
      fee: (BigInt(amount) * BigInt(3) / BigInt(1000)).toString(),
      route: 'estimated'
    };
  } catch (error) {
    console.error('DeDust estimate error:', error);
    throw error;
  }
}

// ============================================
// STON.FI API FUNCTIONS
// ============================================

async function fetchStonfiPools() {
  try {
    const response = await fetch(`${STONFI_API}/pools`);
    if (!response.ok) throw new Error('Failed to fetch STON.fi pools');
    const data = await response.json();
    return data.pool_list || [];
  } catch (error) {
    console.error('STON.fi pools error:', error);
    return [];
  }
}

async function fetchStonfiAssets() {
  try {
    const response = await fetch(`${STONFI_API}/assets`);
    if (!response.ok) throw new Error('Failed to fetch STON.fi assets');
    const data = await response.json();
    return data.asset_list || [];
  } catch (error) {
    console.error('STON.fi assets error:', error);
    return [];
  }
}

async function getStonfiSwapEstimate(fromToken, toToken, amount) {
  try {
    const fromAddress = toRawAddress(fromToken);
    const toAddress = toRawAddress(toToken);

    const simulateUrl = `${STONFI_API}/swap/simulate`;
    const response = await fetch(simulateUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        offer_address: fromAddress === 'native' ? 'EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c' : fromAddress,
        ask_address: toAddress === 'native' ? 'EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c' : toAddress,
        units: amount,
        slippage_tolerance: '0.01'
      })
    });

    if (response.ok) {
      const data = await response.json();
      return {
        outputAmount: data.ask_units || data.min_ask_units,
        priceImpact: data.price_impact || '0',
        fee: data.fee_units || '0',
        route: 'stonfi'
      };
    }

    return null;
  } catch (error) {
    console.error('STON.fi estimate error:', error);
    return null;
  }
}

// ============================================
// BUILD SWAP TRANSACTION PAYLOADS
// ============================================

function buildNativeToJettonPayload(params) {
  const { toToken, amount, minReceived, senderAddress } = params;
  
  return {
    to: DEDUST_VAULT,
    value: amount,
    payload: {
      op: 'swap',
      poolAddress: toToken,
      minOut: minReceived,
      recipient: senderAddress,
      referral: null
    }
  };
}

function buildJettonToNativePayload(params) {
  const { fromToken, amount, minReceived, senderAddress } = params;
  
  return {
    to: fromToken,
    value: '300000000',
    payload: {
      op: 'transfer',
      destination: DEDUST_VAULT,
      amount: amount,
      forwardPayload: {
        op: 'swap',
        minOut: minReceived,
        recipient: senderAddress
      }
    }
  };
}

function buildJettonToJettonPayload(params) {
  const { fromToken, toToken, amount, minReceived, senderAddress } = params;
  
  return {
    to: fromToken,
    value: '500000000',
    payload: {
      op: 'transfer',
      destination: DEDUST_FACTORY,
      amount: amount,
      forwardPayload: {
        op: 'swap',
        poolAddress: toToken,
        minOut: minReceived,
        recipient: senderAddress
      }
    }
  };
}

// ============================================
// WEBSOCKET HANDLERS
// ============================================

wss.on('connection', (ws) => {
  const clientId = generateClientId();
  ws.clientId = clientId;
  wsClients.add(ws);
  
  console.log(`🔌 WebSocket client connected: ${clientId}`);
  
  // Send welcome message
  ws.send(JSON.stringify({
    type: 'connected',
    clientId: clientId,
    message: 'Connected to TON Swap Server',
    timestamp: Date.now()
  }));

  // Handle incoming messages
  ws.on('message', async (message) => {
    try {
      const data = JSON.parse(message.toString());
      console.log(`📨 WS Message from ${clientId}:`, data);
      
      switch (data.type) {
        case 'subscribe_prices':
          handlePriceSubscription(ws, data);
          break;
          
        case 'unsubscribe_prices':
          handlePriceUnsubscription(ws);
          break;
          
        case 'estimate':
          await handleEstimateRequest(ws, data);
          break;
          
        case 'build':
          await handleBuildRequest(ws, data);
          break;
          
        case 'get_pools':
          await handleGetPools(ws, data);
          break;
          
        case 'get_assets':
          await handleGetAssets(ws);
          break;
          
        case 'ping':
          ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
          break;
          
        default:
          ws.send(JSON.stringify({
            type: 'error',
            error: 'Unknown message type',
            receivedType: data.type
          }));
      }
    } catch (error) {
      console.error('WS message parse error:', error);
      ws.send(JSON.stringify({
        type: 'error',
        error: 'Invalid message format'
      }));
    }
  });

  // Handle disconnection
  ws.on('close', () => {
    console.log(`🔌 WebSocket client disconnected: ${clientId}`);
    wsClients.delete(ws);
    
    // Clean up subscriptions
    if (priceSubscriptions.has(clientId)) {
      const sub = priceSubscriptions.get(clientId);
      if (sub.interval) clearInterval(sub.interval);
      priceSubscriptions.delete(clientId);
    }
  });

  ws.on('error', (error) => {
    console.error(`WS error for ${clientId}:`, error);
  });
});

// Handle price subscription
function handlePriceSubscription(ws, data) {
  const clientId = ws.clientId;
  const pairs = data.pairs || [];
  const interval = data.interval || 3000; // Default 3 seconds
  
  // Clear existing subscription
  if (priceSubscriptions.has(clientId)) {
    const existing = priceSubscriptions.get(clientId);
    if (existing.interval) clearInterval(existing.interval);
  }
  
  // Create new subscription
  const priceInterval = setInterval(async () => {
    if (ws.readyState !== WebSocket.OPEN) {
      clearInterval(priceInterval);
      priceSubscriptions.delete(clientId);
      return;
    }
    
    try {
      const prices = await fetchRealtimePrices(pairs);
      ws.send(JSON.stringify({
        type: 'price_update',
        prices: prices,
        timestamp: Date.now()
      }));
    } catch (error) {
      console.error('Price fetch error:', error);
    }
  }, interval);
  
  priceSubscriptions.set(clientId, { pairs, interval: priceInterval });
  
  ws.send(JSON.stringify({
    type: 'subscribed',
    pairs: pairs,
    interval: interval,
    message: 'Price subscription active'
  }));
  
  console.log(`📊 Client ${clientId} subscribed to prices:`, pairs);
}

// Handle price unsubscription
function handlePriceUnsubscription(ws) {
  const clientId = ws.clientId;
  
  if (priceSubscriptions.has(clientId)) {
    const sub = priceSubscriptions.get(clientId);
    if (sub.interval) clearInterval(sub.interval);
    priceSubscriptions.delete(clientId);
    
    ws.send(JSON.stringify({
      type: 'unsubscribed',
      message: 'Price subscription cancelled'
    }));
    
    console.log(`📊 Client ${clientId} unsubscribed from prices`);
  }
}

// Fetch real-time prices for specified pairs
async function fetchRealtimePrices(pairs = []) {
  try {
    const [dedustPools, stonfiPools] = await Promise.all([
      fetchDedustPools(),
      fetchStonfiPools()
    ]);
    
    const prices = {};
    
    // Process DeDust pools
    for (const pool of dedustPools.slice(0, 20)) {
      if (pool.assets && pool.assets.length >= 2) {
        const asset0 = pool.assets[0];
        const asset1 = pool.assets[1];
        const pairKey = `${asset0.symbol || 'TON'}/${asset1.symbol || 'UNKNOWN'}`;
        
        if (pairs.length === 0 || pairs.includes(pairKey)) {
          prices[pairKey] = {
            dex: 'dedust',
            reserves: pool.reserves,
            totalSupply: pool.totalSupply,
            address: pool.address,
            price: pool.reserves ? 
              (Number(pool.reserves[1]) / Number(pool.reserves[0])).toFixed(9) : null
          };
        }
      }
    }
    
    // Process STON.fi pools
    for (const pool of stonfiPools.slice(0, 20)) {
      const pairKey = `${pool.token0_symbol || 'TON'}/${pool.token1_symbol || 'UNKNOWN'}`;
      
      if (pairs.length === 0 || pairs.includes(pairKey)) {
        if (!prices[pairKey]) {
          prices[pairKey] = {
            dex: 'stonfi',
            reserve0: pool.reserve0,
            reserve1: pool.reserve1,
            address: pool.address,
            price: pool.reserve0 && pool.reserve1 ? 
              (Number(pool.reserve1) / Number(pool.reserve0)).toFixed(9) : null
          };
        }
      }
    }
    
    return prices;
  } catch (error) {
    console.error('Fetch realtime prices error:', error);
    return {};
  }
}

// Handle estimate request via WebSocket
async function handleEstimateRequest(ws, data) {
  try {
    const { fromToken, toToken, amount, slippage = 0.5 } = data;
    
    if (!fromToken || !toToken || !amount) {
      ws.send(JSON.stringify({
        type: 'estimate_error',
        error: 'Missing required parameters: fromToken, toToken, amount',
        requestId: data.requestId
      }));
      return;
    }
    
    const [dedustEstimate, stonfiEstimate] = await Promise.all([
      getDedustSwapEstimate(fromToken, toToken, amount),
      getStonfiSwapEstimate(fromToken, toToken, amount)
    ]);
    
    let bestEstimate = dedustEstimate;
    let dex = 'dedust';
    
    if (stonfiEstimate && BigInt(stonfiEstimate.outputAmount || '0') > BigInt(dedustEstimate.outputAmount || '0')) {
      bestEstimate = stonfiEstimate;
      dex = 'stonfi';
    }
    
    const minReceived = calculateMinReceived(bestEstimate.outputAmount, slippage);
    
    ws.send(JSON.stringify({
      type: 'estimate_result',
      requestId: data.requestId,
      success: true,
      outputAmount: bestEstimate.outputAmount,
      minReceived: minReceived,
      priceImpact: bestEstimate.priceImpact,
      fee: bestEstimate.fee,
      route: bestEstimate.route,
      dex: dex,
      slippage: slippage,
      comparison: {
        dedust: dedustEstimate,
        stonfi: stonfiEstimate
      },
      timestamp: Date.now()
    }));
    
  } catch (error) {
    console.error('WS estimate error:', error);
    ws.send(JSON.stringify({
      type: 'estimate_error',
      error: error.message,
      requestId: data.requestId
    }));
  }
}

// Handle build request via WebSocket
async function handleBuildRequest(ws, data) {
  try {
    const { fromToken, toToken, amount, minReceived, senderAddress, slippage = 0.5 } = data;
    
    if (!fromToken || !toToken || !amount || !senderAddress) {
      ws.send(JSON.stringify({
        type: 'build_error',
        error: 'Missing required parameters',
        requestId: data.requestId
      }));
      return;
    }
    
    const isFromNative = fromToken === 'native' || fromToken === 'TON';
    const isToNative = toToken === 'native' || toToken === 'TON';
    
    let calculatedMinReceived = minReceived;
    if (!calculatedMinReceived) {
      const estimate = await getDedustSwapEstimate(fromToken, toToken, amount);
      calculatedMinReceived = calculateMinReceived(estimate.outputAmount, slippage);
    }
    
    let transaction;
    
    if (isFromNative && !isToNative) {
      transaction = buildNativeToJettonPayload({
        toToken, amount, minReceived: calculatedMinReceived, senderAddress
      });
    } else if (!isFromNative && isToNative) {
      transaction = buildJettonToNativePayload({
        fromToken, amount, minReceived: calculatedMinReceived, senderAddress
      });
    } else if (!isFromNative && !isToNative) {
      transaction = buildJettonToJettonPayload({
        fromToken, toToken, amount, minReceived: calculatedMinReceived, senderAddress
      });
    } else {
      ws.send(JSON.stringify({
        type: 'build_error',
        error: 'TON -> TON swap is not supported',
        requestId: data.requestId
      }));
      return;
    }
    
    ws.send(JSON.stringify({
      type: 'build_result',
      requestId: data.requestId,
      success: true,
      transaction: transaction,
      fromToken: fromToken,
      toToken: toToken,
      amount: amount,
      minReceived: calculatedMinReceived,
      senderAddress: senderAddress,
      estimatedGas: isFromNative ? '0' : transaction.value,
      timestamp: Date.now()
    }));
    
  } catch (error) {
    console.error('WS build error:', error);
    ws.send(JSON.stringify({
      type: 'build_error',
      error: error.message,
      requestId: data.requestId
    }));
  }
}

// Handle get pools request
async function handleGetPools(ws, data) {
  try {
    const dex = data.dex || 'all';
    let pools = {};
    
    if (dex === 'all' || dex === 'dedust') {
      pools.dedust = await fetchDedustPools();
    }
    if (dex === 'all' || dex === 'stonfi') {
      pools.stonfi = await fetchStonfiPools();
    }
    
    ws.send(JSON.stringify({
      type: 'pools_result',
      requestId: data.requestId,
      success: true,
      pools: pools,
      timestamp: Date.now()
    }));
  } catch (error) {
    ws.send(JSON.stringify({
      type: 'pools_error',
      error: error.message,
      requestId: data.requestId
    }));
  }
}

// Handle get assets request
async function handleGetAssets(ws) {
  try {
    const [dedustAssets, stonfiAssets] = await Promise.all([
      fetchDedustAssets(),
      fetchStonfiAssets()
    ]);
    
    ws.send(JSON.stringify({
      type: 'assets_result',
      success: true,
      dedust: dedustAssets,
      stonfi: stonfiAssets,
      timestamp: Date.now()
    }));
  } catch (error) {
    ws.send(JSON.stringify({
      type: 'assets_error',
      error: error.message
    }));
  }
}

// Broadcast to all connected clients
function broadcastToAll(message) {
  const data = JSON.stringify(message);
  wsClients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(data);
    }
  });
}

// ============================================
// REST API ENDPOINTS
// ============================================

app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    wsClients: wsClients.size,
    subscriptions: priceSubscriptions.size,
    timestamp: new Date().toISOString() 
  });
});

app.get('/assets', async (req, res) => {
  try {
    const [dedustAssets, stonfiAssets] = await Promise.all([
      fetchDedustAssets(),
      fetchStonfiAssets()
    ]);
    res.json({ success: true, dedust: dedustAssets, stonfi: stonfiAssets });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/pools', async (req, res) => {
  try {
    const [dedustPools, stonfiPools] = 