import { spawn } from "node:child_process";
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer, request as proxyRequest } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const clientRoot = path.join(root, "dist", "client");
const vinextCli = path.join(root, "node_modules", "vinext", "dist", "cli.js");
const publicPort = Number(process.env.PORT || 3000);
const internalPort = publicPort + 1;
const basePath = (process.env.NEXT_PUBLIC_BASE_PATH || "").replace(/\/$/, "");

if (!existsSync(path.join(root, "dist", "server", "index.js"))) {
  console.error("没有找到生产构建，请先执行 npm run build。");
  process.exit(1);
}

const mime = {
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

const backend = spawn(
  process.execPath,
  [vinextCli, "start", "--port", String(internalPort), "--hostname", "127.0.0.1"],
  { cwd: root, env: process.env, stdio: ["ignore", "inherit", "inherit"] },
);

const server = createServer((incoming, outgoing) => {
  const url = new URL(incoming.url || "/", `http://${incoming.headers.host}`);
  let decoded;
  try {
    decoded = decodeURIComponent(url.pathname);
  } catch {
    outgoing.writeHead(400).end("Bad Request");
    return;
  }
  const clientPath =
    basePath && decoded.startsWith(`${basePath}/`)
      ? decoded.slice(basePath.length)
      : decoded;
  const candidate = path.resolve(clientRoot, `.${clientPath}`);
  const insideClient =
    candidate === clientRoot || candidate.startsWith(`${clientRoot}${path.sep}`);
  if (
    insideClient &&
    decoded !== "/" &&
    existsSync(candidate) &&
    statSync(candidate).isFile()
  ) {
    const extension = path.extname(candidate).toLowerCase();
    outgoing.writeHead(200, {
      "Content-Type": mime[extension] || "application/octet-stream",
      "Cache-Control": clientPath.startsWith("/assets/")
        ? "public, max-age=31536000, immutable"
        : "public, max-age=3600",
    });
    if (incoming.method === "HEAD") {
      outgoing.end();
      return;
    }
    createReadStream(candidate).pipe(outgoing);
    return;
  }

  const proxied = proxyRequest(
    {
      hostname: "127.0.0.1",
      port: internalPort,
      path: incoming.url,
      method: incoming.method,
      headers: incoming.headers,
    },
    (response) => {
      outgoing.writeHead(response.statusCode || 502, response.headers);
      response.pipe(outgoing);
    },
  );
  proxied.on("error", () => {
    if (!outgoing.headersSent) outgoing.writeHead(503);
    outgoing.end("SSR 服务正在启动，请稍后重试。");
  });
  incoming.pipe(proxied);
});

server.listen(publicPort, "0.0.0.0", () => {
  console.log(`番鉴本地服务：http://localhost:${publicPort}`);
});

function shutdown() {
  server.close();
  backend.kill();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
backend.on("exit", (code) => {
  if (code && code !== 0) process.exitCode = code;
  server.close();
});
