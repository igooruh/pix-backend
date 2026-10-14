import { createApp } from './app.js';
const port = Number(process.env.PORT || 8080);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT inválida.');
const app = createApp();
app.listen(port, '0.0.0.0', () => console.log(`Pix simulado disponível na porta ${port}`));
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    app.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10000).unref();
  });
}
