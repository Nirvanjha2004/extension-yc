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

// ─── Helpers ──────────────────────────────────────────────────────────────────

function hexFromRgb(r: number, g: number, b: number): string {
  const toHex = (v: number) => Math.round(v * 255).toString(16).padStart(2, "0");
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

function uint8ToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 8192;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
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
      const bytes = await image.getBytesAsync();
      if (bytes && bytes.length > 0) {
        return uint8ToBase64(bytes);
      }
    }
  } catch (e) {
    console.warn(`[LaunchVid] getBytesAsync failed for hash ${imageHash}:`, e);
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
    } catch (e) {
      console.error(`[LaunchVid] exportAsync also failed for "${fallbackNode.name}":`, e);
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
    const bytes = await (node as ExportMixin).exportAsync({
      format: "PNG",
      constraint: { type: "SCALE", value: 2 },
    });
    return bytes && bytes.length > 0 ? uint8ToBase64(bytes) : null;
  } catch (e) {
    console.error(`[LaunchVid] exportNodeAsPng failed for "${node.name}":`, e);
    return null;
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
    const bytes = await (node as ExportMixin).exportAsync({ format: "SVG" });
    svg = new TextDecoder().decode(bytes);
  } catch (e) {
    console.warn(`[LaunchVid] SVG export failed for "${node.name}", trying PNG:`, e);
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
      // Pass the node as fallback for BOOLEAN_OPERATION children etc.
      base.exportedImageBase64 = await exportImageByHash(fillData.imageHash, node);
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
    base.exportedImageBase64 = png; // only set if SVG failed
  }

  // ── BOOLEAN_OPERATION → export as PNG (complex path math) ──
  if (node.type === "BOOLEAN_OPERATION") {
    base.exportedImageBase64 = await exportNodeAsPng(node);
    // Still recurse into children so the layer tree is complete,
    // but the renderer should prefer the rasterized PNG for display.
  }

  // ── ELLIPSE with non-trivial fills → export PNG as fallback ──
  // Simple SOLID fills on ellipses can be rendered with border-radius: 50%,
  // but IMAGE or GRADIENT fills on ellipses need a raster export.
  if (node.type === "ELLIPSE" && base.fill && base.fill.type !== "SOLID") {
    base.exportedImageBase64 = await exportNodeAsPng(node);
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
        fullPngBase64 = uint8ToBase64(bytes);
      } catch (e) {
        console.error(`[LaunchVid] Full frame export failed for "${frame.name}":`, e);
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