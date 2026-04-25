// plugin.ts — runs inside Figma's sandbox (no DOM access here)
// Communicates with UI via figma.ui.postMessage / figma.ui.onmessage

declare function btoa(data: string): string;
declare class TextDecoder {
  constructor(label?: string, options?: any);
  decode(input?: Uint8Array, options?: any): string;
}
figma.showUI(__html__, { width: 380, height: 580, title: "LaunchVid" });

// ─── Types ────────────────────────────────────────────────────────────────────

interface SerializedLayer {
  id: string;
  name: string;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  visible: boolean;
  opacity: number;
  cornerRadius: number;
  fill: FillData | null;
  stroke: StrokeData | null;
  text: TextData | null;
  children: SerializedLayer[];
  exportedImageBase64: string | null; // base64 PNG for IMAGE fills and VECTOR/BOOLEAN nodes
  exportedSvg: string | null;         // raw SVG string for VECTOR nodes (preferred over PNG)
}

interface GradientStop {
  hex: string;
  position: number; // 0–1
  opacity: number;
}

interface FillData {
  type: "SOLID" | "IMAGE" | "GRADIENT" | "NONE";
  hex?: string;
  opacity?: number;
  imageHash?: string;
  // gradient-specific
  gradientType?: "LINEAR" | "RADIAL" | "ANGULAR" | "DIAMOND";
  gradientStops?: GradientStop[];
  gradientTransform?: Transform;
}

interface StrokeData {
  hex: string;
  weight: number;
}

interface TextData {
  characters: string;
  fontSize: number;
  fontWeight: number;
  fontFamily: string;
  color: string;
  textAlign: string;
  lineHeight: number | "AUTO";
  letterSpacing: number;
}

interface FrameInfo {
  id: string;
  name: string;
  pageId: string;
  pageName: string;
  width: number;
  height: number;
  thumbnailBase64: string;
  isLikelyAppScreen: boolean;
}

const exportDebugLog: string[] = [];

function logExportDebug(message: string) {
  exportDebugLog.push(message);
  console.log(message);
}

function bytesToUtf8(bytes: Uint8Array): string {
  const normalized = toUint8Array(bytes);
  if (typeof TextDecoder !== "undefined") {
    return new TextDecoder().decode(normalized);
  }

  let binary = "";
  const chunkSize = 8192;
  for (let i = 0; i < normalized.length; i += chunkSize) {
    const chunk = normalized.subarray(i, i + chunkSize);
    for (let j = 0; j < chunk.length; j++) {
      binary += String.fromCharCode(chunk[j]);
    }
  }
  return binary;
}

function logExportCapabilities(node: SceneNode, context: string) {
  const anyNode = node as unknown as { exportAsync?: unknown; clone?: unknown };
  logExportDebug(
    `[LaunchVid] ${context} ${node.name} (${node.type}) capabilities: exportAsync=${typeof anyNode.exportAsync}, clone=${typeof anyNode.clone}, TextDecoder=${typeof TextDecoder}`
  );
}

function toUint8Array(bytes: Uint8Array | ArrayBuffer | ArrayBufferView): Uint8Array {
  if (bytes instanceof Uint8Array) return bytes;
  if (bytes instanceof ArrayBuffer) return new Uint8Array(bytes);
  return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function describeBytes(value: unknown): string {
  if (value == null) return String(value);
  const objectValue = value as Record<string, unknown>;
  return [
    `type=${typeof value}`,
    `ctor=${(value as { constructor?: { name?: string } }).constructor?.name ?? "unknown"}`,
    `tag=${Object.prototype.toString.call(value)}`,
    `hasBuffer=${"buffer" in objectValue}`,
    `hasSubarray=${typeof (value as { subarray?: unknown }).subarray}`,
    `hasLength=${"length" in objectValue ? String(objectValue.length) : "false"}`,
  ].join(" ");
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function hexFromRgb(r: number, g: number, b: number): string {
  const toHex = (v: number) => Math.round(v * 255).toString(16).padStart(2, "0");
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

function uint8ToBase64(bytes: Uint8Array): string {
  const normalized = toUint8Array(bytes);
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let output = "";

  for (let i = 0; i < normalized.length; i += 3) {
    const byte1 = normalized[i];
    const byte2 = i + 1 < normalized.length ? normalized[i + 1] : 0;
    const byte3 = i + 2 < normalized.length ? normalized[i + 2] : 0;

    const triple = (byte1 << 16) | (byte2 << 8) | byte3;

    output += alphabet[(triple >> 18) & 63];
    output += alphabet[(triple >> 12) & 63];
    output += i + 1 < normalized.length ? alphabet[(triple >> 6) & 63] : "=";
    output += i + 2 < normalized.length ? alphabet[triple & 63] : "=";
  }

  return output;
}

function isLikelyAppScreen(frame: FrameNode): boolean {
  const { width, height, name, children } = frame;
  const lowerName = name.toLowerCase();

  const junkyWords = [
    "component", "archive", "wip", "old", "backup", "copy",
    "style", "color", "icon", "asset", "kit", "template",
    "library", "guide", "spec", "reference", "token",
  ];
  if (junkyWords.some(w => lowerName.includes(w))) return false;
  if (children.length < 2) return false;

  const isPhone = width >= 320 && width <= 430 && height >= 600 && height <= 950;
  const isWeb   = width >= 768 && width <= 1920 && height >= 500;
  const isSquarish = Math.abs(width - height) < 50;

  return (isPhone || isWeb) && !isSquarish;
}

// ─── Fill extraction ──────────────────────────────────────────────────────────

function getFillData(fills: readonly Paint[]): FillData | null {
  if (!fills || fills.length === 0) return null;

  // Use the topmost visible fill
  const fill = [...fills].reverse().find(f => f.visible !== false);
  if (!fill) return null;

  if (fill.type === "SOLID") {
    return {
      type: "SOLID",
      hex: hexFromRgb(fill.color.r, fill.color.g, fill.color.b),
      opacity: fill.opacity ?? 1,
    };
  }

  if (fill.type === "IMAGE") {
    return {
      type: "IMAGE",
      imageHash: fill.imageHash ?? undefined,
    };
  }

  if (
    fill.type === "GRADIENT_LINEAR" ||
    fill.type === "GRADIENT_RADIAL" ||
    fill.type === "GRADIENT_ANGULAR" ||
    fill.type === "GRADIENT_DIAMOND"
  ) {
    const gradientTypeMap: Record<string, "LINEAR" | "RADIAL" | "ANGULAR" | "DIAMOND"> = {
      GRADIENT_LINEAR:  "LINEAR",
      GRADIENT_RADIAL:  "RADIAL",
      GRADIENT_ANGULAR: "ANGULAR",
      GRADIENT_DIAMOND: "DIAMOND",
    };
    return {
      type: "GRADIENT",
      gradientType: gradientTypeMap[fill.type],
      gradientStops: fill.gradientStops.map(stop => ({
        hex:      hexFromRgb(stop.color.r, stop.color.g, stop.color.b),
        position: stop.position,
        opacity:  stop.color.a,
      })),
      gradientTransform: fill.gradientTransform,
    };
  }

  return { type: "NONE" };
}

// ─── Image export — two-strategy approach ─────────────────────────────────────

/**
 * Strategy 1: use figma.getImageByHash() — fastest, no re-render needed.
 * Strategy 2: exportAsync on the node — fallback when hash lookup fails
 *             (common inside BOOLEAN_OPERATION children).
 */
async function exportImageByHash(
  imageHash: string,
  fallbackNode?: SceneNode,
): Promise<string | null> {
  // Strategy 1 — hash lookup
  try {
    const image = figma.getImageByHash(imageHash);
    if (image) {
      const imageAny = image as unknown as { getBytesAsync?: () => Promise<Uint8Array> };
      logExportDebug(`[LaunchVid] imageHash ${imageHash} getBytesAsync=${typeof imageAny.getBytesAsync}`);
      if (typeof imageAny.getBytesAsync !== "function") {
        logExportDebug(`[LaunchVid] imageHash ${imageHash} does not expose getBytesAsync()`);
      } else {
        const bytes = toUint8Array(await imageAny.getBytesAsync());
        if (bytes && bytes.length > 0) {
          return uint8ToBase64(bytes);
        }
        logExportDebug(`[LaunchVid] imageHash ${imageHash} returned empty bytes`);
      }
    } else {
      logExportDebug(`[LaunchVid] imageHash ${imageHash} was not found via figma.getImageByHash()`);
    }
  } catch (e) {
    logExportDebug(`[LaunchVid] getBytesAsync failed for hash ${imageHash}: ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
  }

  // Strategy 2 — exportAsync on the node itself
  if (fallbackNode) {
    try {
      console.log(`[LaunchVid] Falling back to exportAsync for: "${fallbackNode.name}"`);
      const bytes = await (fallbackNode as ExportMixin).exportAsync({
        format: "PNG",
        constraint: { type: "SCALE", value: 1 },
      });
      if (bytes && bytes.length > 0) {
        return uint8ToBase64(bytes);
      }
      logExportDebug(`[LaunchVid] exportAsync returned empty bytes for fallback node "${fallbackNode.name}"`);
    } catch (e) {
      logExportDebug(`[LaunchVid] exportAsync also failed for "${fallbackNode.name}": ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
    }
  }

  return null;
}

/**
 * Export any node as a PNG (used for VECTOR, BOOLEAN_OPERATION, ELLIPSE with
 * complex fills that can't be represented as a simple CSS shape).
 */
async function exportNodeAsPng(node: SceneNode): Promise<string | null> {
  try {
    logExportCapabilities(node, "exportNodeAsPng");
    const exportAny = node as unknown as { exportAsync?: (settings: ExportSettings) => Promise<Uint8Array> };
    if (typeof exportAny.exportAsync !== "function") {
      logExportDebug(`[LaunchVid] exportAsync is not a function for "${node.name}" (${node.type})`);
      return null;
    }

    const rawBytes = await exportAny.exportAsync({
      format: "PNG",
      constraint: { type: "SCALE", value: 2 },
    } as ExportSettings);
    logExportDebug(`[LaunchVid] exportAsync(PNG) raw result for "${node.name}" (${node.type}): ${describeBytes(rawBytes)}`);
    const bytes = toUint8Array(rawBytes);
    if (bytes && bytes.length > 0) return uint8ToBase64(bytes);
    logExportDebug(`[LaunchVid] exportAsync(PNG) returned empty bytes for "${node.name}" (${node.type})`);
    return null;
  } catch (e) {
    logExportDebug(`[LaunchVid] exportNodeAsPng failed for "${node.name}" (${node.type}): ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
    return null;
  }
}

async function exportNodeAsPngViaClone(node: SceneNode): Promise<string | null> {
  const parent = node.parent;
  if (!parent || !("appendChild" in parent) || !("clone" in node)) return null;

  let clone: SceneNode | null = null;
  try {
    clone = node.clone();
    parent.appendChild(clone);

    if ("visible" in clone) clone.visible = true;
    if ("opacity" in clone) clone.opacity = 1;

    if ("x" in clone && "x" in node) clone.x = node.x;
    if ("y" in clone && "y" in node) clone.y = node.y;

    logExportCapabilities(clone, "exportNodeAsPngViaClone");
    const cloneAny = clone as unknown as { exportAsync?: (settings: ExportSettings) => Promise<Uint8Array> };
    if (typeof cloneAny.exportAsync !== "function") {
      logExportDebug(`[LaunchVid] clone exportAsync is not a function for "${node.name}" (${node.type})`);
      return null;
    }

    const rawBytes = await cloneAny.exportAsync({
      format: "PNG",
      constraint: { type: "SCALE", value: 2 },
    } as ExportSettings);
    logExportDebug(`[LaunchVid] exportAsync(PNG) clone raw result for "${node.name}" (${node.type}): ${describeBytes(rawBytes)}`);
    const bytes = toUint8Array(rawBytes);

    if (bytes && bytes.length > 0) return uint8ToBase64(bytes);
    logExportDebug(`[LaunchVid] exportAsync(PNG) on clone returned empty bytes for "${node.name}" (${node.type})`);
    return null;
  } catch (e) {
    logExportDebug(`[LaunchVid] exportNodeAsPngViaClone failed for "${node.name}" (${node.type}): ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
    return null;
  } finally {
    if (clone) clone.remove();
  }
}

/**
 * Export a VECTOR node as SVG — preferred over PNG for crisp rendering at
 * any resolution. Falls back to PNG if SVG export fails.
 */
async function exportNodeAsSvg(node: SceneNode): Promise<{ svg: string | null; png: string | null }> {
  let svg: string | null = null;
  let png: string | null = null;

  try {
    logExportCapabilities(node, "exportNodeAsSvg");
    const exportAny = node as unknown as { exportAsync?: (settings: ExportSettings) => Promise<Uint8Array> };
    if (typeof exportAny.exportAsync !== "function") {
      logExportDebug(`[LaunchVid] exportAsync is not a function for SVG on "${node.name}" (${node.type})`);
      png = await exportNodeAsPng(node);
    } else {
      const rawBytes = await exportAny.exportAsync({ format: "SVG" } as ExportSettings);
      logExportDebug(`[LaunchVid] exportAsync(SVG) raw result for "${node.name}" (${node.type}): ${describeBytes(rawBytes)}`);
      const bytes = toUint8Array(rawBytes);
      svg = bytes && bytes.length > 0 ? bytesToUtf8(bytes) : null;
      if (!svg) {
        logExportDebug(`[LaunchVid] exportAsync(SVG) returned empty bytes for "${node.name}" (${node.type})`);
        png = await exportNodeAsPng(node);
      }
    }
  } catch (e) {
    logExportDebug(`[LaunchVid] SVG export failed for "${node.name}" (${node.type}), trying PNG: ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
    png = await exportNodeAsPng(node);
  }

  return { svg, png };
}

// ─── Node serializer ──────────────────────────────────────────────────────────

async function serializeNode(node: SceneNode, depth = 0): Promise<SerializedLayer> {
  const base: SerializedLayer = {
    id:           node.id,
    name:         node.name,
    type:         node.type,
    x:            "x"            in node ? (node.x as number)       : 0,
    y:            "y"            in node ? (node.y as number)       : 0,
    width:        "width"        in node ? (node.width as number)   : 0,
    height:       "height"       in node ? (node.height as number)  : 0,
    visible:      "visible"      in node ? (node.visible as boolean): true,
    opacity:      "opacity"      in node ? (node.opacity as number) : 1,
    cornerRadius: "cornerRadius" in node ? (node.cornerRadius as number) : 0,
    fill:              null,
    stroke:            null,
    text:              null,
    children:          [],
    exportedImageBase64: null,
    exportedSvg:         null,
  };

  // ── Fills ──
  if ("fills" in node && Array.isArray(node.fills) && (node.fills as Paint[]).length > 0) {
    const fillData = getFillData(node.fills as Paint[]);
    base.fill = fillData;

    if (fillData?.type === "IMAGE" && fillData.imageHash) {
      // Prefer exporting the node directly so IMAGE fills reliably produce bytes.
      // Hash lookup stays as a fallback when node export fails.
      base.exportedImageBase64 =
        (await exportNodeAsPng(node)) ??
        (await exportImageByHash(fillData.imageHash, node)) ??
        (await exportNodeAsPngViaClone(node));
    }
  }

  // ── Strokes ──
  if ("strokes" in node && Array.isArray(node.strokes) && node.strokes.length > 0) {
    const stroke = (node.strokes as Paint[]).find(s => s.type === "SOLID") as SolidPaint | undefined;
    if (stroke) {
      base.stroke = {
        hex:    hexFromRgb(stroke.color.r, stroke.color.g, stroke.color.b),
        weight: "strokeWeight" in node ? (node.strokeWeight as number) : 1,
      };
    }
  }

  // ── Text ──
  if (node.type === "TEXT") {
    const t = node as TextNode;

    const rawWeight = t.fontWeight;
    const fontWeight = typeof rawWeight === "number" ? rawWeight : 400;

    const rawSize = t.fontSize;
    const fontSize = typeof rawSize === "number" ? rawSize : 16;

    const rawFamily = t.fontName;
    const fontFamily = (rawFamily as FontName).family ?? "Inter";

    let colorHex = "#000000";
    if (Array.isArray(t.fills) && t.fills.length > 0) {
      const c = (t.fills as Paint[])[0];
      if (c.type === "SOLID") colorHex = hexFromRgb(c.color.r, c.color.g, c.color.b);
    }

    const rawLH = t.lineHeight;
    const lineHeight: number | "AUTO" =
      typeof rawLH === "symbol" ? "AUTO" :
      rawLH.unit === "AUTO"     ? "AUTO" :
      (rawLH as { unit: string; value: number }).value;

    const rawLS = t.letterSpacing;
    const letterSpacing =
      typeof rawLS === "symbol" ? 0 :
      (rawLS as { unit: string; value: number }).value;

    base.text = {
      characters:   t.characters,
      fontSize,
      fontWeight,
      fontFamily,
      color:        colorHex,
      textAlign:    typeof t.textAlignHorizontal === "symbol" ? "LEFT" : t.textAlignHorizontal,
      lineHeight,
      letterSpacing,
    };
  }

  // ── VECTOR nodes → export as SVG (crisp at any scale) ──
  // We do this regardless of fill because vector paths can't be
  // represented as a CSS div — they need SVG or a raster image.
  if (node.type === "VECTOR") {
    const { svg, png } = await exportNodeAsSvg(node);
    base.exportedSvg         = svg;
    base.exportedImageBase64 = base.exportedImageBase64 ?? png ?? await exportNodeAsPngViaClone(node); // only set if SVG failed
  }

  // ── BOOLEAN_OPERATION → export as PNG (complex path math) ──
  if (node.type === "BOOLEAN_OPERATION") {
    base.exportedImageBase64 = base.exportedImageBase64 ?? await exportNodeAsPng(node) ?? await exportNodeAsPngViaClone(node);
    // Still recurse into children so the layer tree is complete,
    // but the renderer should prefer the rasterized PNG for display.
  }

  // ── ELLIPSE with non-trivial fills → export PNG as fallback ──
  // Simple SOLID fills on ellipses can be rendered with border-radius: 50%,
  // but IMAGE or GRADIENT fills on ellipses need a raster export.
  if (node.type === "ELLIPSE" && base.fill && base.fill.type !== "SOLID") {
    base.exportedImageBase64 = base.exportedImageBase64 ?? await exportNodeAsPng(node) ?? await exportNodeAsPngViaClone(node);
  }

  // ── Children (recursive, capped at depth 6) ──
  if ("children" in node && depth < 6) {
    // For BOOLEAN_OPERATION we already have a PNG of the whole thing,
    // but still recurse so metadata is available.
    const childNodes = (node as FrameNode | GroupNode | BooleanOperationNode).children;
    for (const child of childNodes) {
      if ("visible" in child && !(child as SceneNode & { visible: boolean }).visible) continue;
      base.children.push(await serializeNode(child, depth + 1));
    }
  }

  return base;
}

// ─── Main scan — runs on plugin open ─────────────────────────────────────────

async function scanAllFrames(): Promise<FrameInfo[]> {
  const allFrames: FrameInfo[] = [];
  const pages = figma.root.children;

  for (const page of pages) {
    await figma.setCurrentPageAsync(page);

    const topLevelFrames = page.children.filter(n => n.type === "FRAME") as FrameNode[];

    for (const frame of topLevelFrames) {
      let thumbnailBase64 = "";
      try {
        const scale = Math.min(1, 200 / frame.width);
        const bytes = await frame.exportAsync({
          format: "PNG",
          constraint: { type: "SCALE", value: scale },
        });
        thumbnailBase64 = uint8ToBase64(bytes);
      } catch (e) {
        console.warn(`[LaunchVid] Thumbnail failed for "${frame.name}":`, e);
      }

      allFrames.push({
        id:               frame.id,
        name:             frame.name,
        pageId:           page.id,
        pageName:         page.name,
        width:            frame.width,
        height:           frame.height,
        thumbnailBase64,
        isLikelyAppScreen: isLikelyAppScreen(frame),
      });
    }
  }

  return allFrames;
}

// ─── Export selected frames ───────────────────────────────────────────────────

async function exportSelectedFrames(selectedIds: string[]) {
  figma.ui.postMessage({ type: "EXPORT_PROGRESS", message: "Starting export..." });

  const result = [];
  let done = 0;
  exportDebugLog.length = 0;

  for (const page of figma.root.children) {
    await figma.setCurrentPageAsync(page);

    for (const frameId of selectedIds) {
      const node = page.findOne(n => n.id === frameId);
      if (!node || node.type !== "FRAME") continue;

      const frame = node as FrameNode;

      figma.ui.postMessage({
        type: "EXPORT_PROGRESS",
        message: `Exporting "${frame.name}"... (${done + 1}/${selectedIds.length})`,
      });

      // Full-resolution @2x PNG of the entire frame (used as fallback renderer)
      let fullPngBase64 = "";
      try {
        const bytes = await frame.exportAsync({
          format: "PNG",
          constraint: { type: "SCALE", value: 2 },
        });
        if (bytes && bytes.length > 0) {
          fullPngBase64 = uint8ToBase64(bytes);
        } else {
          logExportDebug(`[LaunchVid] full frame export returned empty bytes for "${frame.name}" (${frame.id})`);
        }
      } catch (e) {
        logExportDebug(`[LaunchVid] Full frame export failed for "${frame.name}" (${frame.id}): ${e instanceof Error ? e.message : String(e)}`);
      }

      // Full layer tree with all images, SVGs, gradients extracted
      const layers = await serializeNode(frame);

      result.push({
        frameId:      frame.id,
        frameName:    frame.name,
        pageId:       page.id,
        pageName:     page.name,
        width:        frame.width,
        height:       frame.height,
        fullPngBase64,
        layers,
        debugLog: [...exportDebugLog],
      });

      done++;
    }
  }

  figma.ui.postMessage({ type: "EXPORT_DONE", data: result });
}

// ─── Boot ─────────────────────────────────────────────────────────────────────

(async () => {
  figma.ui.postMessage({ type: "LOADING", message: "Scanning your file..." });
  const frames = await scanAllFrames();
  figma.ui.postMessage({ type: "FRAMES_LOADED", frames });
})();

// ─── Message handler ──────────────────────────────────────────────────────────

figma.ui.onmessage = async (msg) => {
  if (msg.type === "EXPORT_SELECTED") {
    await exportSelectedFrames(msg.selectedIds);
  }
  if (msg.type === "CLOSE") {
    figma.closePlugin();
  }
};