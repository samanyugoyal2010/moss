import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { config as loadDotenv } from "dotenv";

const SECRET_PROJECT_ID = "moss.projectId";
const SECRET_PROJECT_KEY = "moss.projectKey";

export interface MossCredentials {
  projectId: string;
  projectKey: string;
}

function loadEnvFile(): void {
  const candidates = [
    path.join(__dirname, "..", ".env"),
    path.join(__dirname, "..", "..", ".env"),
  ];
  for (const envPath of candidates) {
    if (fs.existsSync(envPath)) {
      loadDotenv({ path: envPath, quiet: true });
      return;
    }
  }
}

export async function resolveCredentials(
  context: vscode.ExtensionContext,
): Promise<MossCredentials | undefined> {
  loadEnvFile();

  const config = vscode.workspace.getConfiguration("moss");
  const fromSettingsId = (config.get<string>("projectId") ?? "").trim();
  const fromSettingsKey = (config.get<string>("projectKey") ?? "").trim();

  const fromSecretsId = (await context.secrets.get(SECRET_PROJECT_ID)) ?? "";
  const fromSecretsKey = (await context.secrets.get(SECRET_PROJECT_KEY)) ?? "";

  const fromEnvId = (process.env.MOSS_PROJECT_ID ?? "").trim();
  const fromEnvKey = (process.env.MOSS_PROJECT_KEY ?? "").trim();

  const projectId = fromSettingsId || fromSecretsId || fromEnvId;
  const projectKey = fromSettingsKey || fromSecretsKey || fromEnvKey;

  if (projectId && projectKey) {
    return { projectId, projectKey };
  }
  return undefined;
}

export async function promptAndStoreCredentials(
  context: vscode.ExtensionContext,
): Promise<MossCredentials | undefined> {
  const projectId = await vscode.window.showInputBox({
    title: "Moss Project ID",
    prompt: "Enter your Moss project ID",
    ignoreFocusOut: true,
  });
  if (!projectId?.trim()) {
    return undefined;
  }

  const projectKey = await vscode.window.showInputBox({
    title: "Moss Project Key",
    prompt: "Enter your Moss project key",
    password: true,
    ignoreFocusOut: true,
  });
  if (!projectKey?.trim()) {
    return undefined;
  }

  await context.secrets.store(SECRET_PROJECT_ID, projectId.trim());
  await context.secrets.store(SECRET_PROJECT_KEY, projectKey.trim());
  return { projectId: projectId.trim(), projectKey: projectKey.trim() };
}

export function workspaceSessionName(): string {
  const folders = vscode.workspace.workspaceFolders;
  const root =
    folders?.[0]?.uri.fsPath ??
    vscode.workspace.name ??
    "default-workspace";
  const hash = crypto.createHash("sha256").update(root).digest("hex").slice(0, 12);
  return `vscode-${hash}`;
}

export function getSearchOptions(): { topK: number; alpha: number } {
  const config = vscode.workspace.getConfiguration("moss");
  return {
    topK: config.get<number>("topK", 20),
    alpha: config.get<number>("alpha", 0.7),
  };
}

export function getIncludeGlobs(): string[] {
  return vscode.workspace
    .getConfiguration("moss")
    .get<string[]>("includeGlobs", [
      "**/*.{ts,tsx,js,jsx,mjs,cjs,py,go,rs,md,json,yaml,yml,java,kt,swift,rb,php,cs,cpp,c,h,hpp}",
    ]);
}

export function getExcludeGlobs(): string[] {
  return vscode.workspace
    .getConfiguration("moss")
    .get<string[]>("excludeGlobs", [
      "**/node_modules/**",
      "**/.git/**",
      "**/dist/**",
      "**/build/**",
      "**/.next/**",
      "**/coverage/**",
      "**/.venv/**",
      "**/venv/**",
      "**/target/**",
      "**/__pycache__/**",
    ]);
}
