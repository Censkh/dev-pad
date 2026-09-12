import { createServer } from "node:http";

const [mode, rawPort] = process.argv.slice(2);
if (mode === "worker") {
  let jobs = 0;
  console.log("Worker started");
  setInterval(() => console.log(`Completed example job ${++jobs}`), 2000);
} else if (mode === "web" || mode === "api") {
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Invalid port");
  const site = process.env.EXAMPLE_SITE === "City" ? "City" : "Ocean";
  const server = createServer((request, response) => {
    console.log(`${request.method} ${request.url} 200`);
    if (mode === "api") {
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ ok: true, service: "example-api" }));
    } else {
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.end(`<!doctype html><html lang="en"><meta charset="utf-8"><title>${site} site</title>
        <style>body{font:20px system-ui;max-width:40rem;margin:15vh auto;padding:2rem;background:#11111a;color:#f4f4f5}h1{color:#67e8f9}code{color:#fbbf24}</style>
        <h1>${site} site</h1><p>Served by the dev-pad example.</p>
        <p>In the dashboard, press <code>1</code> then <code>s</code> to switch sites.</p></html>`);
    }
  });
  server.on("error", (error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
  server.listen(port, "127.0.0.1", () => console.log(`${mode} listening on http://127.0.0.1:${port}`));
} else {
  throw new Error("Usage: service.ts web|api PORT, or service.ts worker");
}
