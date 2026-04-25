# LaunchVid Figma Plugin

Extracts frames, layer trees, and all embedded images from a Figma file
and saves the export JSON on your PC in the `output/` folder.

## Setup

```bash
npm install
npm run build        # compiles plugin.ts + copies ui.html into src/
npm run package      # creates dist/launchvid-figma-plugin.zip
npm run save-local   # starts local save server (writes export files to output/)
```

## Important

This project is a **Figma plugin**, not a Chrome/Edge browser extension.
You run it inside Figma (desktop or browser), not from your browser extension toolbar.

## Load in Figma (development)

1. Open Figma Desktop app
2. Menu → Plugins → Development → Import plugin from manifest
3. Select this folder's `manifest.json`
4. Open any Figma file
5. Run plugin: Menu → Plugins → Development → LaunchVid

## Use in Figma browser app

1. Go to Figma in your browser and open a file
2. Open the command menu (`Ctrl+/`)
3. Run: `Import plugin from manifest...`
4. Choose this folder's `manifest.json`
5. Run plugin: `Plugins → Development → LaunchVid`

## Create uploadable package

Run:

```bash
npm run package
```

This creates:

- `dist/launchvid-figma-plugin.zip`

Zip includes only `manifest.json` and `src/` (compiled `plugin.js` and copied `ui.html`).

## What the plugin does

### Scanning
On open, the plugin traverses EVERY page in the file and lists all
top-level FRAME nodes. It generates a small thumbnail for each frame
so you can visually identify them in the panel.

Frames that look like real app screens (phone/web dimensions, enough
content, no junk names like "components" or "archive") are
auto-checked as suggested.

### Selection UI
You see a grouped list by page. Each frame shows:
- Thumbnail preview
- Frame name + dimensions + page name
- "✓ App screen" badge if auto-detected as a real screen
- Checkbox (click to toggle)
- Drag handle (drag to reorder selected frames)

The bottom tray shows your selected frames in order with numbered
chips. You can remove individual frames from the tray or drag rows
to reorder.

### Export
Clicking "Export for Video" triggers the plugin to:
1. Export each selected frame as a full @2x PNG
2. Recursively serialize the entire layer tree (positions, sizes,
   text content + styling, fill colors, corner radii)
3. Export each IMAGE fill as its own PNG (actual photos, illustrations)
4. POST everything as JSON to `http://127.0.0.1:3210/save-export`
5. Local server writes a timestamped JSON file into `output/`

## Data format sent to backend

```json
{
  "frames": [
    {
      "frameId": "123:45",
      "frameName": "Onboarding - Step 1",
      "pageId": "0:1",
      "pageName": "Onboarding",
      "width": 390,
      "height": 844,
      "fullPngBase64": "...",
      "layers": {
        "id": "123:45",
        "name": "Onboarding - Step 1",
        "type": "FRAME",
        "x": 0, "y": 0,
        "width": 390, "height": 844,
        "fill": { "type": "SOLID", "hex": "#F5F0FF" },
        "children": [
          {
            "type": "TEXT",
            "name": "Headline",
            "text": {
              "characters": "Track your money",
              "fontSize": 32,
              "fontWeight": 700,
              "fontFamily": "SF Pro Display",
              "color": "#1A1A2E"
            },
            ...
          },
          {
            "type": "RECTANGLE",
            "name": "Hero Image",
            "fill": { "type": "IMAGE" },
            "exportedImageBase64": "...",  ← actual image bytes
            ...
          }
        ]
      }
    }
  ]
}
```

## Save exports on your PC

1. In this project folder, run: `npm run save-local`
2. Keep that terminal open
3. Run plugin export from Figma
4. Find results in `output/launchvid-export-<timestamp>.json`

## Notes

- `documentAccess: dynamic-page` in manifest.json is required to
  traverse multiple pages (Figma API requirement since 2023)
- The plugin skips hidden layers (visible: false)
- Layer traversal is capped at depth 6 to avoid crashing on huge files
- Fonts: Figma stores font family + weight but not the actual font file.
  Your Remotion renderer needs to have those fonts available or fall
  back to Inter/system-ui
