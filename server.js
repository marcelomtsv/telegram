import express from 'express';
import cors from 'cors';
import { WebSocketServer } from 'ws';
import http from 'http';
import dotenv from 'dotenv';
import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { Api } from 'telegram/tl/index.js';
import fs from 'fs';

dotenv.config();

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, perMessageDeflate: true });

// CORS configurado para aceitar requisições do Easypanel
app.use(cors({
  origin: process.env.CORS_ORIGIN || '*',
  credentials: true
}));
app.use(express.json());

// Armazenamento
const sessions = new Map();
const wsClients = new Set();
const messageHandlers = new Map();
const entityCache = new Map(); // Cache de entidades para evitar chamadas repetidas
let API_ID = parseInt(process.env.API_ID || '0');
let API_HASH = process.env.API_HASH || '';

// Batching de mensagens para WebSocket
const messageQueue = [];
let batchTimer = null;
const BATCH_INTERVAL = 100; // 100ms - agrupa mensagens (aumentado para reduzir carga)
const MAX_BATCH_SIZE = 50; // Máximo de mensagens por batch (reduzido)

// Broadcast otimizado com batching
function broadcastMessage(data) {
  messageQueue.push(data);
  
  if (messageQueue.length >= MAX_BATCH_SIZE) {
    flushBatch();
  } else if (!batchTimer) {
    batchTimer = setTimeout(flushBatch, BATCH_INTERVAL);
  }
}

function flushBatch() {
  if (messageQueue.length === 0) return;
  
  const batch = messageQueue.splice(0, MAX_BATCH_SIZE);
  const wsData = JSON.stringify({ type: 'batch_messages', data: batch });
  
  // Enviar para todos os clientes conectados
  const clientsToRemove = [];
  wsClients.forEach(ws => {
    if (ws.readyState === 1) {
      try {
        ws.send(wsData);
      } catch (e) {
        clientsToRemove.push(ws);
      }
    } else {
      clientsToRemove.push(ws);
    }
  });
  
  clientsToRemove.forEach(ws => wsClients.delete(ws));
  
  if (batchTimer) {
    clearTimeout(batchTimer);
    batchTimer = null;
  }
  
  // Se ainda há mensagens na fila, agendar próximo flush
  if (messageQueue.length > 0) {
    batchTimer = setTimeout(flushBatch, BATCH_INTERVAL);
  }
}

// Cache de entidades com TTL
async function getCachedEntity(client, entityId, ttl = 300000) { // 5 minutos
  const cacheKey = `${client.session.save()}_${entityId}`;
  const cached = entityCache.get(cacheKey);
  
  if (cached && Date.now() - cached.timestamp < ttl) {
    return cached.data;
  }
  
  try {
    const entity = await client.getEntity(entityId);
    const name = entity.firstName || entity.title || entity.username || 'Desconhecido';
    entityCache.set(cacheKey, { data: name, timestamp: Date.now() });
    
    // Limpar cache antigo (manter apenas últimos 10000)
    if (entityCache.size > 10000) {
      const firstKey = entityCache.keys().next().value;
      entityCache.delete(firstKey);
    }
    
    return name;
  } catch (e) {
    return 'Desconhecido';
  }
}

// Salvar credenciais
function saveCredentials(apiId, apiHash) {
  API_ID = parseInt(apiId);
  API_HASH = apiHash;
  fs.writeFileSync('.env', `API_ID=${API_ID}\nAPI_HASH=${API_HASH}\nPORT=3001\n`, 'utf8');
  dotenv.config();
}

// Handler otimizado de mensagens
function setupMessageHandlers(client, sessionId) {
  if (messageHandlers.has(sessionId)) {
    try {
      client.removeEventHandler(messageHandlers.get(sessionId));
    } catch (e) {}
  }

  const handlerId = client.addEventHandler(async (event) => {
    // Processar apenas se sessão está ativa
    const session = sessions.get(sessionId);
    if (!session || session.status !== 'active') return;
    
    if (event.className === 'UpdateNewMessage') {
      const msg = event.message;
      if (msg && msg.message) {
        // Processar de forma assíncrona não bloqueante com delay mínimo
        setImmediate(async () => {
          // Pequeno delay para não sobrecarregar
          await new Promise(resolve => setTimeout(resolve, Math.random() * 10));
          
          let senderName = null;
          if (msg.fromId) {
            senderName = await getCachedEntity(client, msg.fromId);
          }

          const data = {
            sessionId,
            id: msg.id,
            message: msg.message,
            senderName,
            fromId: msg.fromId?.toString() || null,
            timestamp: Date.now(),
          };

          broadcastMessage(data);
        });
      }
    }
  });

  messageHandlers.set(sessionId, handlerId);
}

// ========== API ENDPOINTS ==========

app.post('/api/config', (req, res) => {
  try {
    const { apiId, apiHash } = req.body;
    if (!apiId || !apiHash) return res.status(400).json({ error: 'API_ID e API_HASH obrigatórios' });
    saveCredentials(apiId, apiHash);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/config', (req, res) => {
  res.json({ configured: !!(API_ID && API_HASH) });
});

// Listar sessões (otimizado)
app.get('/api/sessions', (req, res) => {
  const list = [];
  for (const [id, s] of sessions.entries()) {
    list.push({
      id,
      name: s.name || s.phone,
      phone: s.phone,
      status: s.status,
      createdAt: s.createdAt,
    });
  }
  res.json({ sessions: list });
});

// Criar sessão
app.post('/api/sessions', async (req, res) => {
  try {
    const { name, phone, apiId, apiHash } = req.body;
    if (!name || !phone) return res.status(400).json({ error: 'Nome e telefone obrigatórios' });
    if (!apiId || !apiHash) return res.status(400).json({ error: 'API_ID e API_HASH obrigatórios' });

    const sessionId = `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const stringSession = new StringSession('');
    const client = new TelegramClient(stringSession, parseInt(apiId), apiHash, { 
      connectionRetries: 5,
      useWSS: true,
    });

    await client.connect();
    const result = await client.sendCode({ apiId: parseInt(apiId), apiHash }, phone);
    
    sessions.set(sessionId, {
      client,
      name,
      phone,
      apiId: parseInt(apiId),
      apiHash,
      status: 'pending',
      phoneCodeHash: result.phoneCodeHash,
      stringSession,
      createdAt: Date.now(),
    });

    res.json({ success: true, sessionId, phoneCodeHash: result.phoneCodeHash });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Verificar código
app.post('/api/sessions/:id/verify', async (req, res) => {
  try {
    const { id } = req.params;
    const { code } = req.body;
    if (!code) return res.status(400).json({ error: 'Código obrigatório' });

    const session = sessions.get(id);
    if (!session) return res.status(404).json({ error: 'Sessão não encontrada' });

    const { client, stringSession, phoneCodeHash, phone } = session;

    await client.invoke(new Api.auth.SignIn({
      phoneNumber: phone,
      phoneCodeHash,
      phoneCode: code.toString(),
    }));

    const sessionString = stringSession.save();
    session.status = 'active';
    session.sessionString = sessionString;
    session.phoneCodeHash = undefined;

    setupMessageHandlers(client, id);

    res.json({ success: true, sessionString });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Conectar com sessão existente
app.post('/api/sessions/connect', async (req, res) => {
  try {
    const { name, sessionString, phone, apiId, apiHash } = req.body;
    if (!name || !sessionString) return res.status(400).json({ error: 'Nome e SessionString obrigatórios' });
    if (!apiId || !apiHash) return res.status(400).json({ error: 'API_ID e API_HASH obrigatórios' });

    const sessionId = `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const stringSession = new StringSession(sessionString);
    const client = new TelegramClient(stringSession, parseInt(apiId), apiHash, { 
      connectionRetries: 5,
      useWSS: true,
    });

    await client.connect();
    if (!(await client.checkAuthorization())) {
      return res.status(401).json({ error: 'Sessão inválida' });
    }

    sessions.set(sessionId, {
      client,
      name,
      phone: phone || 'user',
      apiId: parseInt(apiId),
      apiHash,
      status: 'active',
      sessionString,
      createdAt: Date.now(),
    });

    setupMessageHandlers(client, sessionId);

    res.json({ success: true, sessionId });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Pausar sessão
app.post('/api/sessions/:id/pause', (req, res) => {
  try {
    const session = sessions.get(req.params.id);
    if (!session) return res.status(404).json({ error: 'Sessão não encontrada' });
    if (session.status === 'active') {
      session.status = 'paused';
    }
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Retomar sessão
app.post('/api/sessions/:id/resume', (req, res) => {
  try {
    const session = sessions.get(req.params.id);
    if (!session) return res.status(404).json({ error: 'Sessão não encontrada' });
    if (session.status === 'paused') {
      session.status = 'active';
    }
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Excluir sessão
app.delete('/api/sessions/:id', async (req, res) => {
  try {
    const session = sessions.get(req.params.id);
    if (session) {
      try {
        if (messageHandlers.has(req.params.id)) {
          try {
            session.client.removeEventHandler(messageHandlers.get(req.params.id));
          } catch (e) {}
          messageHandlers.delete(req.params.id);
        }
        await session.client.disconnect();
      } catch (e) {}
      sessions.delete(req.params.id);
    }
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Limpar todas as sessões
app.delete('/api/sessions', async (req, res) => {
  try {
    const disconnectPromises = [];
    for (const [id, session] of sessions.entries()) {
      if (messageHandlers.has(id)) {
        try {
          session.client.removeEventHandler(messageHandlers.get(id));
        } catch (e) {}
        messageHandlers.delete(id);
      }
      disconnectPromises.push(session.client.disconnect().catch(() => {}));
    }
    await Promise.all(disconnectPromises);
    sessions.clear();
    entityCache.clear();
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// WebSocket otimizado
wss.on('connection', (ws, req) => {
  wsClients.add(ws);
  ws.on('close', () => wsClients.delete(ws));
  ws.on('error', () => wsClients.delete(ws));
  ws.send(JSON.stringify({ type: 'connected' }));
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    sessions: sessions.size,
    connections: wsClients.size
  });
});

// Limpar cache periodicamente
setInterval(() => {
  const now = Date.now();
  for (const [key, value] of entityCache.entries()) {
    if (now - value.timestamp > 600000) { // 10 minutos
      entityCache.delete(key);
    }
  }
}, 300000); // A cada 5 minutos

// Iniciar servidor
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0'; // 0.0.0.0 para aceitar conexões externas (necessário para Docker/Easypanel)

server.listen(PORT, HOST, () => {
  console.log('');
  console.log('╔═══════════════════════════════════════════════════════╗');
  console.log('║        TELEGRAM API - GramJS MTProto                 ║');
  console.log('╚═══════════════════════════════════════════════════════╝');
  console.log('');
  console.log(`🚀 Servidor rodando em http://${HOST}:${PORT}`);
  console.log(`📡 WebSocket disponível em ws://${HOST}:${PORT}`);
  console.log(`⚡ Otimizado para milhares de conexões simultâneas`);
  console.log('');
  if (!API_ID || !API_HASH) {
    console.log('⚠️  Configure API_ID e API_HASH via variáveis de ambiente');
    console.log('   Ou use o endpoint POST /api/config');
    console.log('');
  } else {
    console.log('✓ Credenciais configuradas');
    console.log('');
  }
  console.log('📖 Documentação completa no README.md');
  console.log('');
});
