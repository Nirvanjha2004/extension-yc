import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { execSync } from "node:child_process";

mkdirSync(resolve("dist"), { recursive: true });

const outputZip = resolve("dist", "launchvid-figma-plugin.zip");

// PowerShell Compress-Archive is available on Windows, matching this workspace OS.
execSync(
  `powershell -NoProfile -Command "Compress-Archive -Path manifest.json,src -DestinationPath '${outputZip}' -Force"`,
  { stdio: "inherit" }
);

console.log(`Created package: ${outputZip}`);
