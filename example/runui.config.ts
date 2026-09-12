import { fileURLToPath } from "node:url";
import { defineConfig } from "../dist/index.js";

const port = Number(process.env.RUNUI_EXAMPLE_PORT ?? 4600);
if (!Number.isInteger(port) || port < 1024 || port > 65534) {
  throw new Error("RUNUI_EXAMPLE_PORT must be an integer between 1024 and 65534");
}
const runtime = [
  process.execPath,
  ...("Deno" in globalThis ? ["run", "-A"] : "Bun" in globalThis ? [] : ["--import", "tsx"]),
];
let site = "Ocean";

export default defineConfig({
  title: "runui example",
  cwd: fileURLToPath(new URL(".", import.meta.url)),
  status: () => [{ label: "Site", value: site, tone: "info" }],
  services: [
    {
      id: "web",
      name: "Website",
      command: [...runtime, "service.ts", "web", String(port)],
      port,
      url: `http://127.0.0.1:${port}`,
      probe: "http",
      env: () => ({ EXAMPLE_SITE: site }),
      status: () => [{ label: "Site", value: site }],
      actions: [
        {
          key: "s",
          label: "switch site",
          global: true,
          run: async (ctx) => {
            site = site === "Ocean" ? "City" : "Ocean";
            await ctx.restart("web");
          },
        },
      ],
    },
    {
      id: "api",
      name: "API",
      command: [...runtime, "service.ts", "api", String(port + 1)],
      port: port + 1,
      url: `http://127.0.0.1:${port + 1}/health`,
      probe: "http",
    },
    {
      id: "worker",
      name: "Background worker",
      command: [...runtime, "service.ts", "worker"],
      autostart: false,
    },
  ],
});
