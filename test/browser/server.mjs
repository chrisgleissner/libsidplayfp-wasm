import { createReadStream, existsSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "../..");
const port = Number(process.env.PLAYWRIGHT_PORT ?? 4173);

createServer((request, response) => {
  const pathname = new URL(request.url ?? "/", `http://127.0.0.1:${port}`).pathname;
  if (pathname === "/") {
    response.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-store" }).end("<!doctype html><title>libsidplayfp WASM</title>");
    return;
  }
  const relative = pathname === "/test-tone-c4.sid" ? pathname.slice(1) : pathname.replace(/^\/dist\//, "dist/");
  const file = path.resolve(root, relative);
  if (!file.startsWith(root) || !existsSync(file)) {
    response.writeHead(404).end();
    return;
  }
  const contentType = file.endsWith(".wasm") ? "application/wasm" : file.endsWith(".js") ? "text/javascript" : "application/octet-stream";
  response.writeHead(200, { "Content-Type": contentType, "Cache-Control": "no-store" });
  createReadStream(file).pipe(response);
}).listen(port, "127.0.0.1", () => console.log(`browser fixture server listening on ${port}`));
