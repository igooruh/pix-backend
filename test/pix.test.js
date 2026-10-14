import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createApp } from '../src/app.js';

const valid = { chaveDestino: 'cliente@example.com', valorCentavos: 1050, descricao: 'Teste' };
async function fixture(t) {
  const app = createApp();
  app.listen(0, '127.0.0.1');
  await once(app, 'listening');
  t.after(() => new Promise(resolve => { app.close(resolve); app.closeAllConnections(); }));
  const request = async (path = '/pix', options = {}) => {
    const response = await fetch(`http://127.0.0.1:${app.address().port}${path}`, options);
    return { status: response.status, headers: response.headers, body: await response.json() };
  };
  const post = (body = valid, key = randomUUID()) => request('/pix', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key }, body: JSON.stringify(body)
  });
  return { request, post };
}
test('cria Pix e consulta todos os dados pelo ID', async t => {
  const { post, request } = await fixture(t);
  const created = await post();
  assert.equal(created.status, 201);
  assert.equal(created.body.status, 'SIMULADO');
  assert.equal(created.body.valorCentavos, 1050);
  assert.equal(created.body.chaveDestino, valid.chaveDestino);
  assert.ok(!Number.isNaN(Date.parse(created.body.criadoEm)));
  assert.equal(created.headers.get('location'), `/pix/${created.body.id}`);
  const fetched = await request(`/pix/${created.body.id}`);
  assert.equal(fetched.status, 200);
  assert.deepEqual(fetched.body, created.body);
});
test('lista vazia e paginação sem perder a ordem de criação', async t => {
  const { post, request } = await fixture(t);
  assert.deepEqual((await request()).body, { data: [], total: 0, pagina: 1, limite: 20 });
  await post();
  const second = await post({ ...valid, valorCentavos: 1 });
  const result = await request('/pix?pagina=2&limite=1');
  assert.equal(result.status, 200);
  assert.equal(result.body.total, 2);
  assert.deepEqual(result.body.data, [second.body]);
  assert.deepEqual((await request('/pix?pagina=3&limite=1')).body.data, []);
});
test('repetição idempotente retorna mesmo ID e não duplica', async t => {
  const { post, request } = await fixture(t);
  const first = await post(valid, 'pedido-1');
  const repeated = await post(valid, 'pedido-1');
  assert.equal(repeated.status, 200);
  assert.deepEqual(repeated.body, first.body);
  assert.equal((await request()).body.total, 1);
});
test('mesma chave e payload diferente retorna 409 sem alterar Pix', async t => {
  const { post, request } = await fixture(t);
  const first = await post(valid, 'pedido-1');
  assert.equal((await post({ ...valid, valorCentavos: 999 }, 'pedido-1')).status, 409);
  assert.deepEqual((await request(`/pix/${first.body.id}`)).body, first.body);
});
test('requisições concorrentes com mesma chave criam apenas um Pix', async t => {
  const { post, request } = await fixture(t);
  const results = await Promise.all(Array.from({ length: 10 }, () => post(valid, 'concorrente')));
  assert.equal(results.filter(r => r.status === 201).length, 1);
  assert.equal(results.filter(r => r.status === 200).length, 9);
  assert.equal(new Set(results.map(r => r.body.id)).size, 1);
  assert.equal((await request()).body.total, 1);
});
for (const value of [0, -1, 1.5, '100', null, Number.MAX_SAFE_INTEGER + 1]) {
  test(`rejeita valorCentavos ${JSON.stringify(value)}`, async t => {
    const { post, request } = await fixture(t);
    assert.equal((await post({ ...valid, valorCentavos: value })).status, 400);
    assert.equal((await request()).body.total, 0);
  });
}
for (const [name, body] of [
  ['chave vazia', { ...valid, chaveDestino: ' ' }],
  ['chave longa', { ...valid, chaveDestino: 'a'.repeat(141) }],
  ['chave numérica', { ...valid, chaveDestino: 123 }],
  ['descrição longa', { ...valid, descricao: 'a'.repeat(141) }],
  ['descrição numérica', { ...valid, descricao: 1 }],
  ['campo extra', { ...valid, status: 'CONCLUIDO' }],
  ['null', null], ['array', []], ['campos ausentes', {}]
]) test(`rejeita ${name}`, async t => {
  const { post } = await fixture(t);
  assert.equal((await post(body)).status, 400);
});
test('normaliza chave e permite descrição omitida', async t => {
  const { post } = await fixture(t);
  const result = await post({ chaveDestino: ' exemplo ', valorCentavos: 1 });
  assert.equal(result.status, 201);
  assert.equal(result.body.chaveDestino, 'exemplo');
  assert.equal(result.body.descricao, '');
});
test('rejeita ausência ou formato inválido de Idempotency-Key', async t => {
  const { request, post } = await fixture(t);
  assert.equal((await request('/pix', { method: 'POST' })).status, 400);
  assert.equal((await post(valid, 'chave inválida')).status, 400);
});
test('JSON malformado, Content-Type errado e payload excessivo', async t => {
  const { request } = await fixture(t);
  const headers = { 'Content-Type': 'application/json', 'Idempotency-Key': 'req1' };
  assert.equal((await request('/pix', { method: 'POST', headers, body: '{' })).status, 400);
  assert.equal((await request('/pix', { method: 'POST', headers: { ...headers, 'Content-Type': 'text/plain' }, body: '{}' })).status, 415);
  assert.equal((await request('/pix', { method: 'POST', headers, body: JSON.stringify({ text: 'x'.repeat(17000) }) })).status, 413);
});
test('ID inválido e ID inexistente', async t => {
  const { request } = await fixture(t);
  assert.equal((await request('/pix/abc')).status, 400);
  assert.equal((await request(`/pix/${randomUUID()}`)).status, 404);
});
test('paginação inválida retorna 400', async t => {
  const { request } = await fixture(t);
  for (const query of ['pagina=0', 'pagina=-1', 'pagina=1.2', 'limite=101', 'limite=0', 'limite=abc', 'pagina=1&pagina=2', 'foo=1', 'pagina=1000001']) {
    assert.equal((await request(`/pix?${query}`)).status, 400, query);
  }
});
test('rota desconhecida e métodos não permitidos', async t => {
  const { request } = await fixture(t);
  assert.equal((await request('/desconhecida')).status, 404);
  const result = await request('/pix', { method: 'DELETE' });
  assert.equal(result.status, 405);
  assert.equal(result.headers.get('allow'), 'GET, POST');
  assert.equal((await request(`/pix/${randomUUID()}`, { method: 'PUT' })).status, 405);
});
