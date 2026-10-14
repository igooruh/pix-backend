import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const fail = (status, message) => { throw new HttpError(status, message); };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function readJson(req) {
  if (req.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') {
    fail(415, 'Use Content-Type: application/json.');
  }
  const chunks = [];
  let size = 0;
  // Drain the request before replying so oversized payloads receive a JSON error.
  for await (const chunk of req) {
    size += chunk.length;
    if (size <= 16384) chunks.push(chunk);
  }
  if (size > 16384) fail(413, 'Corpo excede 16 KiB.');
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { fail(400, 'JSON inválido.'); }
}

function validate(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) fail(400, 'Informe um objeto JSON.');
  const { chaveDestino, valorCentavos, descricao = '' } = body;
  if (Object.keys(body).some(k => !['chaveDestino', 'valorCentavos', 'descricao'].includes(k))) fail(400, 'Campo desconhecido.');
  if (typeof chaveDestino !== 'string' || !chaveDestino.trim() || chaveDestino.trim().length > 140) fail(400, 'chaveDestino deve conter de 1 a 140 caracteres.');
  if (!Number.isSafeInteger(valorCentavos) || valorCentavos <= 0) fail(400, 'valorCentavos deve ser um inteiro positivo seguro.');
  if (typeof descricao !== 'string' || descricao.length > 140) fail(400, 'descricao deve conter até 140 caracteres.');
  return { chaveDestino: chaveDestino.trim(), valorCentavos, descricao };
}

// Each app owns its state: tests and independent instances never share data.
export function createApp() {
  const transactions = new Map();
  const idempotency = new Map();
  return createServer(async (req, res) => {
    const send = (status, data, headers = {}) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
      res.end(JSON.stringify(data));
    };
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname === '/pix') {
        if (req.method === 'POST') {
          const key = req.headers['idempotency-key'];
          if (typeof key !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(key)) fail(400, 'Idempotency-Key obrigatório: 1 a 100 caracteres alfanuméricos, _ ou -.');
          const input = validate(await readJson(req));
          const fingerprint = JSON.stringify(input);
          const previous = idempotency.get(key);
          if (previous) {
            if (previous.fingerprint !== fingerprint) fail(409, 'Idempotency-Key já utilizada com outros dados.');
            return send(200, transactions.get(previous.id));
          }
          const pix = { id: randomUUID(), ...input, status: 'SIMULADO', criadoEm: new Date().toISOString() };
          // No await between lookup and write: atomic within this single process.
          transactions.set(pix.id, pix);
          idempotency.set(key, { id: pix.id, fingerprint });
          return send(201, pix, { Location: `/pix/${pix.id}` });
        }
        if (req.method === 'GET') {
          const params = [...url.searchParams.keys()];
          if (params.some(k => !['pagina', 'limite'].includes(k)) || new Set(params).size !== params.length) fail(400, 'Parâmetros de paginação inválidos.');
          const parse = (name, fallback, max) => {
            const raw = url.searchParams.get(name) ?? String(fallback);
            const value = Number(raw);
            if (!/^[1-9]\d*$/.test(raw) || !Number.isSafeInteger(value) || value > max) fail(400, `${name} inválido.`);
            return value;
          };
          const pagina = parse('pagina', 1, 1000000);
          const limite = parse('limite', 20, 100);
          const data = [...transactions.values()].slice((pagina - 1) * limite, pagina * limite);
          return send(200, { data, total: transactions.size, pagina, limite });
        }
        return send(405, { erro: 'Método não permitido.' }, { Allow: 'GET, POST' });
      }
      const match = /^\/pix\/([^/]+)$/.exec(url.pathname);
      if (match) {
        if (req.method !== 'GET') return send(405, { erro: 'Método não permitido.' }, { Allow: 'GET' });
        if (!uuid.test(match[1])) fail(400, 'ID inválido.');
        const pix = transactions.get(match[1]);
        if (!pix) fail(404, 'Pix não encontrado.');
        return send(200, pix);
      }
      fail(404, 'Rota não encontrada.');
    } catch (error) {
      send(error instanceof HttpError ? error.status : 500, {
        erro: error instanceof HttpError ? error.message : 'Erro interno.'
      });
    }
  });
}
