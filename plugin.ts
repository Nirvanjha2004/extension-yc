// plugin.ts — runs inside Figma's sandbox (no DOM access here)
// Communicates with UI via figma.ui.postMessage / figma.ui.onmessage

declare function btoa(data: string): string;

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
  exportedImageBase64: string | null; // for IMAGE fills
}

interface FillData {
  type: "SOLID" | "IMAGE" | "GRADIENT" | "NONE";
  hex?: string;
  opacity?: number;
  imageHash?: string;
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
  thumbnailBase64: string; // low-res preview for the UI checklist
  isLikelyAppScreen: boolean;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function hexFromRgb(r: number, g: number, b: number): string {
  const toHex = (v: number) => Math.round(v * 255).toString(16).padStart(2, "0");
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

function isLikelyAppScreen(frame: FrameNode): boolean {
  const { width, height, name, children } = frame;
  const lowerName = name.toLowerCase();

  // skip obvious junk pages
  const junkyWords = ["component", "archive", "wip", "old", "backup",
    "copy", "style", "color", "icon", "asset", "kit", "template",
    "library", "guide", "spec", "reference", "token"];
  if (junkyWords.some(w => lowerName.includes(w))) return false;

  // must have some content
  if (children.length < 2) return false;

  // phone screen sizes (portrait)
  const isPhone = width >= 320 && width <= 430 && height >= 600 && height <= 950;
  // web / tablet sizes
  const isWeb = width >= 768 && width <= 1920 && height >= 500;
  // square / banner — probably not an app screen
  const isSquarish = Math.abs(width - height) < 50;

  return (isPhone || isWeb) && !isSquarish;
}

async function getFillData(fills: readonly Paint[]): Promise<FillData | null> {
  if (!fills || fills.length === 0) return null;
  const fill = fills[fills.length - 1]; // topmost fill
  if (!fill.visible) return null;

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
  return { type: "GRADIENT" };
}

async function exportImageFill(imageHash: string): Promise<string | null> {
  try {
    const image = figma.getImageByHash(imageHash);
    if (!image) return null;
    const bytes = await image.getBytesAsync();
    // convert Uint8Array → base64
    let binary = "";
    const chunkSize = 8192;
    for (let i = 0; i < bytes.length; i += chunkSize) {
      const chunk = bytes.subarray(i, i + chunkSize);
      binary += String.fromCharCode(...chunk);
    }
    return btoa(binary);
  } catch {
    return null;
  }
}

async function serializeNode(node: SceneNode, depth = 0): Promise<SerializedLayer> {
  const base: SerializedLayer = {
    id: node.id,
    name: node.name,
    type: node.type,
    x: "x" in node ? (node.x as number) : 0,
    y: "y" in node ? (node.y as number) : 0,
    width: "width" in node ? (node.width as number) : 0,
    height: "height" in node ? (node.height as number) : 0,
    visible: "visible" in node ? (node.visible as boolean) : true,
    opacity: "opacity" in node ? (node.opacity as number) : 1,
    cornerRadius: "cornerRadius" in node ? (node.cornerRadius as number) : 0,
    fill: null,
    stroke: null,
    text: null,
    children: [],
    exportedImageBase64: null,
  };

  // fills
  if ("fills" in node && Array.isArray(node.fills)) {
    const fillData = await getFillData(node.fills as Paint[]);
    base.fill = fillData;

    // if it's an image fill, export the actual image bytes
    if (fillData?.type === "IMAGE" && fillData.imageHash) {
      base.exportedImageBase64 = await exportImageFill(fillData.imageHash);
    }
  }

  // strokes
  if ("strokes" in node && Array.isArray(node.strokes) && node.strokes.length > 0) {
    const stroke = node.strokes[0] as SolidPaint;
    if (stroke.type === "SOLID") {
      base.stroke = {
        hex: hexFromRgb(stroke.color.r, stroke.color.g, stroke.color.b),
        weight: "strokeWeight" in node ? (node.strokeWeight as number) : 1,
      };
    }
  }

  // text
  if (node.type === "TEXT") {
    const t = node as TextNode;
    const rawWeight = t.fontWeight;
    const fontWeight = typeof rawWeight === "number" ? rawWeight :
      typeof rawWeight === "symbol" ? 400 : 400;

    const rawSize = t.fontSize;
    const fontSize = typeof rawSize === "number" ? rawSize : 16;

    const rawFamily = t.fontName;
    const fontFamily = typeof rawFamily === "symbol" ? "Inter" :
      (rawFamily as FontName).family;

    const rawColor = t.fills;
    let colorHex = "#000000";
    if (Array.isArray(rawColor) && rawColor.length > 0) {
      const c = rawColor[0] as SolidPaint;
      if (c.type === "SOLID") colorHex = hexFromRgb(c.color.r, c.color.g, c.color.b);
    }

    const rawLH = t.lineHeight;
    const lineHeight = typeof rawLH === "symbol" ? "AUTO" :
      rawLH.unit === "AUTO" ? "AUTO" : (rawLH as { unit: string; value: number }).value;

    const rawLS = t.letterSpacing;
    const letterSpacing = typeof rawLS === "symbol" ? 0 :
      (rawLS as { unit: string; value: number }).value;

    base.text = {
      characters: t.characters,
      fontSize,
      fontWeight,
      fontFamily,
      color: colorHex,
      textAlign: typeof t.textAlignHorizontal === "symbol" ? "LEFT" : t.textAlignHorizontal,
      lineHeight,
      letterSpacing,
    };
  }

  // children — recurse but cap depth to avoid explosion on huge files
  if ("children" in node && depth < 6) {
    const childNodes = (node as FrameNode).children;
    for (const child of childNodes) {
      if ("visible" in child && !child.visible) continue; // skip hidden layers
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
    // switch to each page to access its nodes
    await figma.setCurrentPageAsync(page);

    const topLevelFrames = page.children.filter(n => n.type === "FRAME") as FrameNode[];

    for (const frame of topLevelFrames) {
      // generate a small thumbnail (max 200px wide) for the preview in UI
      let thumbnailBase64 = "";
      try {
        const scale = Math.min(1, 200 / frame.width);
        const bytes = await frame.exportAsync({
          format: "PNG",
          constraint: { type: "SCALE", value: scale },
        });
        let binary = "";
        const chunk = 8192;
        for (let i = 0; i < bytes.length; i += chunk) {
          binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
        }
        thumbnailBase64 = btoa(binary);
      } catch {
        thumbnailBase64 = "";
      }

      allFrames.push({
        id: frame.id,
        name: frame.name,
        pageId: page.id,
        pageName: page.name,
        width: frame.width,
        height: frame.height,
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

      // full resolution PNG
      let fullPngBase64 = "";
      try {
        const bytes = await frame.exportAsync({
          format: "PNG",
          constraint: { type: "SCALE", value: 2 }, // @2x for retina
        });
        let binary = "";
        for (let i = 0; i < bytes.length; i += 8192) {
          binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
        }
        fullPngBase64 = btoa(binary);
      } catch {
        fullPngBase64 = "";
      }

      // full layer tree with all images extracted
      const layers = await serializeNode(frame);

      result.push({
        frameId: frame.id,
        frameName: frame.name,
        pageId: page.id,
        pageName: page.name,
        width: frame.width,
        height: frame.height,
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

// ─── Handle messages from UI ──────────────────────────────────────────────────

figma.ui.onmessage = async (msg) => {
  if (msg.type === "EXPORT_SELECTED") {
    await exportSelectedFrames(msg.selectedIds);
  }
  if (msg.type === "CLOSE") {
    figma.closePlugin();
  }
};
