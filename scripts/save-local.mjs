import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const PORT = 3210;
const OUTPUT_DIR = resolve("output");
const IMAGES_DIR = resolve(OUTPUT_DIR, "images");

function sanitizeFilePart(value) {
  return String(value)
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80) || "unnamed";
}

function decodeBase64ToBuffer(base64) {
  return Buffer.from(base64, "base64");
}

function walkLayers(layer, visitor, path = []) {
  const nextPath = [...path, layer.name || layer.id || layer.type];
  visitor(layer, nextPath);

  if (Array.isArray(layer.children)) {
    for (const child of layer.children) {
      walkLayers(child, visitor, nextPath);
    }
  }
}

function summarizeNullExports(payload) {
  const warnings = [];
  const frames = Array.isArray(payload?.frames) ? payload.frames : [];

  for (const frame of frames) {
    if (!frame.fullPngBase64) {
      warnings.push(`[LaunchVid] frame "${frame.frameName}" has empty fullPngBase64`);
    }

    const layers = frame.layers;
    if (!layers) continue;

    walkLayers(layers, (layer, path) => {
      const fillType = layer.fill?.type;
      const looksExportable =
        fillType === "IMAGE" ||
        layer.type === "VECTOR" ||
        layer.type === "BOOLEAN_OPERATION" ||
        (layer.type === "ELLIPSE" && fillType && fillType !== "SOLID");

      if (!looksExportable) return;

      const hasRaster = Boolean(layer.exportedImageBase64);
      const hasSvg = Boolean(layer.exportedSvg);

      if (!hasRaster && !hasSvg) {
        warnings.push(
          `[LaunchVid] null export at ${path.join(" > ")} | type=${layer.type} | fill=${fillType ?? "none"} | imageHash=${layer.fill?.imageHash ?? "none"}`
        );
      }
    });
  }

  return warnings;
}

function printDebugLogs(payload) {
  const frames = Array.isArray(payload?.frames) ? payload.frames : [];

  for (const frame of frames) {
    if (!Array.isArray(frame.debugLog) || frame.debugLog.length === 0) continue;

    console.log(`[LaunchVid] Debug log for frame "${frame.frameName}":`);
    for (const line of frame.debugLog) {
      console.log(line);
    }
  }
}

async function saveExtractedImages(payload) {
  const frames = Array.isArray(payload?.frames) ? payload.frames : [];
  const savedFiles = [];

  await mkdir(IMAGES_DIR, { recursive: true });

  for (const frame of frames) {
    const frameName = sanitizeFilePart(frame.frameName || frame.pageName || frame.frameId || "frame");
    const layers = frame.layers;
    if (!layers) continue;

    const pending = [[layers, [frameName]]];

    while (pending.length > 0) {
      const [layer, pathParts] = pending.pop();
      const layerName = sanitizeFilePart(layer.name || layer.id || layer.type);
      const nextPath = [...pathParts, layerName];
      const fileStem = nextPath.join("__");

      if (layer.exportedImageBase64) {
        const pngPath = resolve(IMAGES_DIR, `${fileStem}.png`);
        await writeFile(pngPath, decodeBase64ToBuffer(layer.exportedImageBase64));
        savedFiles.push(pngPath);
      }

      if (layer.exportedSvg) {
        const svgPath = resolve(IMAGES_DIR, `${fileStem}.svg`);
        await writeFile(svgPath, layer.exportedSvg, "utf8");
        savedFiles.push(svgPath);
      }

      if (Array.isArray(layer.children)) {
        for (const child of layer.children) {
          pending.push([child, nextPath]);
        }
      }
    }
  }

  return savedFiles;
}

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

    const warnings = summarizeNullExports(parsed);
    printDebugLogs(parsed);
    console.log(`[LaunchVid] Received export payload: ${Array.isArray(parsed?.frames) ? parsed.frames.length : 0} frame(s)`);
    if (warnings.length === 0) {
      console.log("[LaunchVid] No null export fields found on image-related nodes.");
    } else {
      console.warn(`[LaunchVid] Found ${warnings.length} null export warning(s):`);
      for (const warning of warnings) {
        console.warn(warning);
      }
    }

    await mkdir(OUTPUT_DIR, { recursive: true });

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const fileName = `launchvid-export-${timestamp}.json`;
    const filePath = resolve(OUTPUT_DIR, fileName);

    await writeFile(filePath, JSON.stringify(parsed, null, 2), "utf8");

    const savedFiles = await saveExtractedImages(parsed);
    console.log(`[LaunchVid] Saved ${savedFiles.length} extracted image file(s) to ${IMAGES_DIR}`);
    for (const savedFile of savedFiles) {
      console.log(`[LaunchVid] saved: ${savedFile}`);
    }

    sendJson(res, 200, {
      ok: true,
      fileName,
      filePath,
      imageCount: savedFiles.length,
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
