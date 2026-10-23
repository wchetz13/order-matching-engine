import { createApp } from "./server.js";

const port = Number(process.env.PORT ?? 8080);
const server = createApp().listen(port, () => {
  console.log(`order-matching-engine listening on http://localhost:${port}`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
