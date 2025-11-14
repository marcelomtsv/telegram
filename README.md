# Telegram API - GramJS MTProto

API REST completa usando GramJS MTProto para gerenciar múltiplas sessões do Telegram simultaneamente.

## 🚀 Funcionalidades

- ✅ Gerenciamento de múltiplas sessões Telegram simultâneas
- ✅ Autenticação via telefone e código SMS
- ✅ Conexão usando sessão existente
- ✅ Recebimento de mensagens em tempo real via WebSocket
- ✅ Pausar/Retomar/Excluir sessões
- ✅ Otimizado para milhares de conexões simultâneas
- ✅ Batching de mensagens para performance
- ✅ Cache de entidades para reduzir chamadas

## 📋 Pré-requisitos

- Node.js 18+ instalado
- Conta no Telegram
- API ID e API Hash do Telegram (obtenha em https://my.telegram.org/apps)

## 🔧 Instalação

```bash
npm install
```

## ⚙️ Configuração

Crie um arquivo `.env` na raiz do projeto:

```env
API_ID=seu_api_id_aqui
API_HASH=seu_api_hash_aqui
PORT=3001
```

**Obtenha suas credenciais em:** https://my.telegram.org/apps

## 🎯 Como usar

### Iniciar o servidor

```bash
npm start
```

Ou em modo desenvolvimento (com auto-reload):

```bash
npm run dev
```

O servidor estará rodando em `http://localhost:3001`

## 📡 Endpoints da API

### Configuração

#### `POST /api/config`
Configurar credenciais do Telegram.

**Body:**
```json
{
  "apiId": "12345678",
  "apiHash": "abcdef1234567890abcdef1234567890"
}
```

#### `GET /api/config`
Verificar se está configurado.

**Response:**
```json
{
  "configured": true
}
```

### Sessões

#### `GET /api/sessions`
Listar todas as sessões ativas.

**Response:**
```json
{
  "sessions": [
    {
      "id": "session_1234567890_abc123",
      "name": "Minha Sessão",
      "phone": "+5511999999999",
      "status": "active",
      "createdAt": "2024-01-01T00:00:00.000Z"
    }
  ]
}
```

#### `POST /api/sessions`
Criar nova sessão (enviar código SMS).

**Body:**
```json
{
  "name": "Nome da Sessão",
  "phone": "+5511999999999",
  "apiId": "12345678",
  "apiHash": "abcdef1234567890abcdef1234567890"
}
```

**Response:**
```json
{
  "success": true,
  "sessionId": "session_1234567890_abc123",
  "phoneCodeHash": "abc123def456"
}
```

#### `POST /api/sessions/:id/verify`
Verificar código SMS e ativar sessão.

**Body:**
```json
{
  "code": "12345"
}
```

**Response:**
```json
{
  "success": true,
  "sessionString": "1BVtsOHwBu..."
}
```

#### `POST /api/sessions/connect`
Conectar com sessão existente.

**Body:**
```json
{
  "name": "Nome da Sessão",
  "sessionString": "1BVtsOHwBu...",
  "phone": "+5511999999999",
  "apiId": "12345678",
  "apiHash": "abcdef1234567890abcdef1234567890"
}
```

**Response:**
```json
{
  "success": true,
  "sessionId": "session_1234567890_abc123"
}
```

#### `POST /api/sessions/:id/pause`
Pausar uma sessão.

**Response:**
```json
{
  "success": true
}
```

#### `POST /api/sessions/:id/resume`
Retomar uma sessão pausada.

**Response:**
```json
{
  "success": true
}
```

#### `DELETE /api/sessions/:id`
Excluir uma sessão (desconecta completamente).

**Response:**
```json
{
  "success": true
}
```

#### `DELETE /api/sessions`
Excluir todas as sessões.

**Response:**
```json
{
  "success": true
}
```

## 🔌 WebSocket

O servidor WebSocket está disponível em `ws://localhost:3001` e envia mensagens em batch:

**Mensagem recebida:**
```json
{
  "type": "batch_messages",
  "data": [
    {
      "sessionId": "session_1234567890_abc123",
      "id": 123,
      "message": "Texto da mensagem",
      "senderName": "Nome do Remetente",
      "fromId": "user_id",
      "timestamp": 1704067200000
    }
  ]
}
```

## ⚡ Otimizações

- **Batching**: Mensagens agrupadas em batches de até 50, enviadas a cada 100ms
- **Cache**: Cache de entidades (nomes de remetentes) com TTL de 5 minutos
- **Processamento assíncrono**: Handlers não bloqueantes
- **Compressão WebSocket**: Habilitada para reduzir tráfego
- **Limpeza automática**: Cache limpo periodicamente

## 📝 Exemplo de Uso

```javascript
// Configurar credenciais
await fetch('http://localhost:3001/api/config', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    apiId: '12345678',
    apiHash: 'abcdef1234567890abcdef1234567890'
  })
});

// Criar sessão
const response = await fetch('http://localhost:3001/api/sessions', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    name: 'Minha Sessão',
    phone: '+5511999999999',
    apiId: '12345678',
    apiHash: 'abcdef1234567890abcdef1234567890'
  })
});

const { sessionId } = await response.json();

// Verificar código
await fetch(`http://localhost:3001/api/sessions/${sessionId}/verify`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ code: '12345' })
});

// Conectar WebSocket
const ws = new WebSocket('ws://localhost:3001');
ws.onmessage = (event) => {
  const data = JSON.parse(event.data);
  if (data.type === 'batch_messages') {
    data.data.forEach(msg => {
      console.log(`[${msg.senderName}]: ${msg.message}`);
    });
  }
};
```

## 🛠️ Tecnologias

- **Node.js** - Runtime
- **Express** - Framework web
- **GramJS (telegram)** - Cliente MTProto
- **WebSocket (ws)** - Comunicação em tempo real

## 📄 Licença

MIT
