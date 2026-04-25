import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const PORT = 3210;
const OUTPUT_DIR = resolve("output");

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  });
  res.end(JSON.stringify(payload));
}

const server = createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    });
    res.end();
    return;
  }

  if (req.method !== "POST" || req.url !== "/save-export") {
    sendJson(res, 404, { ok: false, error: "Not found" });
    return;
  }

  try {
    const chunks = [];
    let bytes = 0;

    for await (const chunk of req) {
      chunks.push(chunk);
      bytes += chunk.length;
      if (bytes > 512 * 1024 * 1024) {
        sendJson(res, 413, { ok: false, error: "Payload too large" });
        return;
      }
    }

    const raw = Buffer.concat(chunks).toString("utf8");
    const parsed = JSON.parse(raw);

    await mkdir(OUTPUT_DIR, { recursive: true });

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const fileName = `launchvid-export-${timestamp}.json`;
    const filePath = resolve(OUTPUT_DIR, fileName);

    await writeFile(filePath, JSON.stringify(parsed, null, 2), "utf8");

    sendJson(res, 200, {
      ok: true,
      fileName,
      filePath,
    });
  } catch (error) {
    sendJson(res, 500, {
      ok: false,
      error: error instanceof Error ? error.message : "Unknown server error",
    });
  }
});

server.listen(PORT, () => {
  console.log(`LaunchVid local save server listening on http://127.0.0.1:${PORT}`);
  console.log(`Exports will be written to: ${OUTPUT_DIR}`);
});
