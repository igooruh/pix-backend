# Backend Pix — Node.js

Aplicação didática com **3 endpoints**, testes HTTP automatizados, Dockerfile e pipeline GitHub Actions. Usa Node.js 24 e módulos nativos, sem dependências externas.

**Escopo:** simula o registro de uma transferência. Não movimenta dinheiro, não consulta chaves no DICT, não gera QR Code e não integra bancos/Banco Central. O status `SIMULADO` nunca representa liquidação real. Dados e idempotência ficam em memória, são perdidos ao reiniciar e não são compartilhados entre réplicas. Sem autenticação de clientes ou isolamento por conta; use localmente para estudo.

## Execução

Requisitos: Node.js 24 e npm. Na pasta do projeto:

```bash
npm ci
npm start
```

Servidor em `http://localhost:8080`. Para outra porta: `PORT=3001 npm start` em Linux/macOS. `.env.example` documenta a variável; o servidor não carrega `.env` automaticamente. Se copiar para `.env`, execute `node --env-file=.env src/server.js`.

```bash
npm test
npm run test:coverage
```

## APIs

| Método | Rota | Objetivo | Sucesso |
|---|---|---|---|
| POST | `/pix` | Criar Pix simulado | 201; 200 em repetição idempotente |
| GET | `/pix/:id` | Consultar por UUID v4 | 200 |
| GET | `/pix?pagina=1&limite=20` | Listar por ordem de criação | 200 |

### 1. Criar

```bash
curl -i -X POST http://localhost:8080/pix \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: pedido-001' \
  -d '{"chaveDestino":"cliente@example.com","valorCentavos":1050,"descricao":"Pedido 001"}'
```

Exemplo de resposta (ID e data variam):

```json
{
  "id": "e824df4a-b9ab-451d-bd04-20fe5c32f027",
  "chaveDestino": "cliente@example.com",
  "valorCentavos": 1050,
  "descricao": "Pedido 001",
  "status": "SIMULADO",
  "criadoEm": "2026-10-14T18:00:00.000Z"
}
```

- `chaveDestino`: texto obrigatório, 1–140 caracteres após remover espaços externos. Apenas validação textual, sem confirmar tipo, titular ou existência da chave.
- `valorCentavos`: inteiro positivo seguro de JavaScript (até 9007199254740991). Exemplo: 1050 = R$ 10,50. Não aceita string, fração ou zero. Esse teto é técnico, não um limite bancário.
- `descricao`: texto opcional de até 140 caracteres, padrão vazio.
- Campos desconhecidos são rejeitados. Limite de corpo: 16 KiB.
- `Idempotency-Key`: obrigatório, 1–100 caracteres entre letras ASCII, números, `_` e `-`.
- Mesma chave e mesmos dados normalizados retornam o registro original (200); mesma chave com dados diferentes retorna 409. Para nova operação use nova chave.
- A criação retorna também o header `Location` com a rota de consulta.

### 2. Consultar

Substitua pelo ID devolvido na criação:

```bash
curl http://localhost:8080/pix/e824df4a-b9ab-451d-bd04-20fe5c32f027
```

### 3. Listar

```bash
curl 'http://localhost:8080/pix?pagina=1&limite=20'
```

Formato: `{"data":[],"total":0,"pagina":1,"limite":20}`. `total` considera todos os registros; `data` contém somente a página solicitada. Página começa em 1 (máximo 1000000), limite de 1 a 100. Página além dos dados retorna lista vazia. Parâmetros desconhecidos ou repetidos retornam 400.

### Erros

Formato: `{"erro":"Mensagem descritiva."}`.

| Código | Situação |
|---|---|
| 400 | Dados, JSON, ID, paginação ou chave de idempotência inválidos |
| 404 | Pix ou rota não encontrados |
| 405 | Método não permitido; header `Allow` informa os permitidos |
| 409 | Conflito de idempotência |
| 413 | Corpo maior que 16 KiB |
| 415 | POST sem Content-Type application/json |
| 500 | Erro interno inesperado, sem expor detalhes |

## Docker

```bash
docker build -t pix-backend:local .
docker run --rm -p 127.0.0.1:8080:8080 --name pix-backend pix-backend:local
```

O Dockerfile executa os testes em um estágio próprio antes da imagem final. A imagem final copia desse estágio, portanto falha nos testes impede sua construção. Roda com usuário `node`, sem incluir os testes ou credenciais na imagem final. Como o projeto é JavaScript, não há etapa de compilação: o build solicitado é o da imagem.

## Pipeline — .github/workflows/CI.yaml

Escolha adotada: **GitHub Actions**. O arquivo está no diretório reconhecido pelo GitHub; mantenha esse caminho ao enviar o projeto ao seu repositório.

Ordem das três atividades: **testes → build da imagem → push no Docker Hub**. Checkout e instalação do Node são apenas preparação. Testes e build rodam em pull requests para `main`, push em `main` e execução manual. Se os testes falharem, o build e o push não executam. Os testes são repetidos dentro do Dockerfile para também proteger builds locais.

O push fica **desativado por padrão** e não ocorre em pull requests nem fora de `main`. Nenhuma integração ou credencial foi configurada. Posteriormente, em `Settings > Secrets and variables > Actions`, cadastre:

| Tipo | Nome | Valor |
|---|---|---|
| Secret | `DOCKERHUB_USERNAME` | Usuário Docker Hub |
| Secret | `DOCKERHUB_TOKEN` | Token Docker Hub com permissão de escrita no repositório |
| Variable | `DOCKERHUB_REPOSITORY` | Nome do repositório sem usuário; padrão `pix-backend` |
| Variable | `DOCKERHUB_PUSH_ENABLED` | `true` para habilitar; padrão `false` |

Crie o repositório correspondente no Docker Hub antes de habilitar. A imagem publicada será `docker.io/USUARIO/REPOSITORIO:SHA_DO_COMMIT`. A mesma imagem construída é marcada e publicada, sem um segundo build. Não há deploy, integração bancária ou outras etapas. Se ativar o push sem os secrets, essa etapa falha com indicação da variável ausente. O token entra via stdin e não deve ser colocado no código ou `.env`.

## Cenários de testes automatizados

Arquivo: `test/pix.test.js`. Os testes sobem um servidor HTTP real em porta efêmera, usam `fetch` e fecham o servidor ao terminar. Cada teste recebe armazenamento isolado. Nenhum serviço externo é chamado.

| Cenário | Resultado esperado |
|---|---|
| Criar e consultar por ID | 201, Location correto, status SIMULADO, consulta 200 com mesmos dados |
| Listar sem dados | 200, lista vazia e total 0 |
| Paginar dois registros e ultrapassar última página | Ordem preservada, total 2 e página excedente vazia |
| Repetir chave e corpo | 200, mesmo ID e somente um registro |
| Repetir chave com outro valor | 409, registro original intacto |
| Dez POSTs simultâneos com mesma chave | Uma criação 201, nove respostas 200, apenas um registro |
| Valor zero, negativo, fracionário, string, null ou acima do inteiro seguro | 400 sem criar registro (6 testes) |
| Chave vazia, longa ou numérica | 400 (3 testes) |
| Descrição longa ou numérica | 400 (2 testes) |
| Campo desconhecido, corpo null, array ou campos ausentes | 400 (4 testes) |
| Chave com espaços e descrição omitida | 201, chave normalizada e descrição vazia |
| Idempotency-Key ausente ou inválida | 400 |
| JSON quebrado, mídia incorreta ou corpo excessivo | 400, 415 e 413 respectivamente |
| UUID inválido ou inexistente | 400 e 404 respectivamente |
| Paginação zero, negativa, fracionária, excessiva, não numérica, repetida ou desconhecida | 400 |
| Rota desconhecida e métodos incorretos | 404 e 405, header Allow |

Validação realizada na entrega: **26 testes passaram**, Node.js v24.19.0. Cobertura de `src/app.js`: **100% de linhas, 97,01% de branches e 100% de funções**. Essa medição não inclui o bootstrap `src/server.js`; não é uma alegação de cobertura de toda a aplicação. Docker não está disponível no ambiente de criação: construção da imagem e execução remota do workflow não foram realizadas. Push não foi executado.

## Estrutura

- `src/app.js`: servidor, rotas, validação, memória e idempotência.
- `src/server.js`: porta, inicialização e encerramento.
- `test/pix.test.js`: testes HTTP automatizados.
- `package.json` / `package-lock.json`: comandos e metadados npm.
- `Dockerfile` / `.dockerignore`: imagem com testes obrigatórios.
- `.github/workflows/CI.yaml`: testes, build e push opcional.
- `.env.example`: variável de execução.

## Referências

- [Node.js — Test runner](https://nodejs.org/api/test.html)
- [GitHub Actions — Sintaxe de workflows](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax)
