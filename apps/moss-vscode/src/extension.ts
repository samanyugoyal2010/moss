import * as vscode from "vscode";
import { MossSessionManager } from "./moss/client";
import {
  clearWorkspaceIndexed,
  isWorkspaceMarkedIndexed,
  markWorkspaceIndexed,
  promptAndStoreCredentials,
  resolveCredentials,
  workspaceSessionName,
} from "./moss/config";
import { CodebaseIndexer } from "./indexer/indexer";
import { SemanticSearch, type SearchHit } from "./search/search";
import { MossSearchViewProvider } from "./ui/sidebar";

let statusBarItem: vscode.StatusBarItem | undefined;
let outputChannel: vscode.OutputChannel | undefined;

function log(message: string): void {
  outputChannel?.appendLine(`[${new Date().toISOString()}] ${message}`);
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  outputChannel = vscode.window.createOutputChannel("Moss Code Search");
  context.subscriptions.push(outputChannel);

  const sessionManager = new MossSessionManager();
  const indexer = new CodebaseIndexer();
  const search = new SemanticSearch(
    () => (indexer.canSearch() ? sessionManager.getSession() : undefined),
    () => indexer.canSearch(),
  );

  statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    100,
  );
  statusBarItem.text = "$(search) Moss";
  statusBarItem.command = "moss.search.focus";
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);

  const createIndex = async (): Promise<void> => {
    await runCreateIndex(context, sessionManager, indexer, provider);
  };

  const provider = new MossSearchViewProvider(context.extensionUri, {
    onQuery: async (query) => search.query(query),
    onOpen: async (hit) => openHit(hit),
    onCreateIndex: createIndex,
  });

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      MossSearchViewProvider.viewType,
      provider,
    ),
  );

  context.subscriptions.push(
    indexer.onStatus((status) => {
      provider.setStatus(status);
      updateStatusBar(status);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("moss.search.focus", async () => {
      await vscode.commands.executeCommand("moss.searchView.focus");
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("moss.credentials.configure", async () => {
      const creds = await promptAndStoreCredentials(context);
      if (creds) {
        provider.setStatus({ state: "unindexed" });
        vscode.window.showInformationMessage(
          "Moss credentials saved. Click Create Index in the sidebar to index this workspace.",
        );
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("moss.index.create", createIndex),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("moss.index.rebuild", async () => {
      await runCreateIndex(context, sessionManager, indexer, provider, true);
    }),
  );

  context.subscriptions.push({
    dispose: () => {
      indexer.dispose();
      sessionManager.dispose();
    },
  });

  process.on("unhandledRejection", (reason) => {
    const message = reason instanceof Error ? reason.message : String(reason);
    log(`Unhandled rejection: ${message}`);
    vscode.window.showErrorMessage(`Moss error: ${message}`);
  });

  await bootstrap(context, sessionManager, indexer, provider);
}

function updateStatusBar(status: import("./indexer/indexer").IndexStatus): void {
  if (!statusBarItem) {
    return;
  }
  if (status.state === "indexing") {
    statusBarItem.text = `$(sync~spin) Moss: indexing ${status.processed}/${status.total}`;
    statusBarItem.tooltip = undefined;
  } else if (status.state === "ready") {
    statusBarItem.text = `$(check) Moss: ${status.files} files`;
    statusBarItem.tooltip = undefined;
  } else if (status.state === "error") {
    statusBarItem.text = "$(error) Moss: error";
    statusBarItem.tooltip = status.message;
  } else if (status.state === "unindexed") {
    statusBarItem.text = "$(database) Moss: not indexed";
    statusBarItem.tooltip = "Click Create Index in the Moss Search sidebar";
  }
}

async function bootstrap(
  context: vscode.ExtensionContext,
  sessionManager: MossSessionManager,
  indexer: CodebaseIndexer,
  provider: MossSearchViewProvider,
): Promise<void> {
  const credentials = await resolveCredentials(context);
  if (!credentials) {
    provider.setStatus({
      state: "error",
      message: "Missing credentials. Run “Moss: Configure Credentials”.",
    });
    if (statusBarItem) {
      statusBarItem.text = "$(warning) Moss: credentials needed";
    }
    return;
  }

  if (!isWorkspaceMarkedIndexed(context)) {
    provider.setStatus({ state: "unindexed" });
    log(`Workspace ${workspaceSessionName()} has no index — waiting for Create Index`);
    return;
  }

  try {
    if (statusBarItem) {
      statusBarItem.text = "$(sync~spin) Moss: loading index…";
    }
    const session = await sessionManager.initialize(credentials);
    indexer.attachSession(session);
    indexer.startWatching(context.subscriptions);

    const docCount = session.docCount ?? 0;
    if (docCount > 0) {
      indexer.markReadyFromSession(docCount, docCount);
      log(`Resumed existing index with ${docCount} chunks`);
      return;
    }

    await clearWorkspaceIndexed(context);
    provider.setStatus({ state: "unindexed" });
    log("Marked index missing in session — Create Index required");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(`Bootstrap failed: ${message}`);
    await clearWorkspaceIndexed(context);
    provider.setStatus({ state: "unindexed" });
    vscode.window.showWarningMessage(
      `Moss could not load a previous index. Click Create Index to try again. (${message})`,
    );
  }
}

async function runCreateIndex(
  context: vscode.ExtensionContext,
  sessionManager: MossSessionManager,
  indexer: CodebaseIndexer,
  provider: MossSearchViewProvider,
  rebuild = false,
): Promise<void> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders?.length) {
    vscode.window.showWarningMessage("Open a folder before creating an index.");
    return;
  }

  let credentials = await resolveCredentials(context);
  if (!credentials) {
    const choice = await vscode.window.showInformationMessage(
      "Moss needs project credentials before indexing.",
      "Configure",
    );
    if (choice === "Configure") {
      credentials = await promptAndStoreCredentials(context);
    }
  }
  if (!credentials) {
    provider.setStatus({
      state: "error",
      message: "Missing credentials. Run “Moss: Configure Credentials”.",
    });
    return;
  }

  if (indexer.getStatus().state === "indexing") {
    vscode.window.showInformationMessage("Moss is already indexing this workspace.");
    return;
  }

  try {
    if (!sessionManager.isReady) {
      if (statusBarItem) {
        statusBarItem.text = "$(sync~spin) Moss: connecting…";
      }
      const session = await sessionManager.initialize(credentials);
      indexer.attachSession(session);
      indexer.startWatching(context.subscriptions);
    }

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: rebuild ? "Moss: rebuilding index…" : "Moss: creating index…",
        cancellable: true,
      },
      async (_progress, token) => {
        await indexer.rebuild(token);
      },
    );

    if (indexer.isIndexed()) {
      await markWorkspaceIndexed(context);
      const status = indexer.getStatus();
      const files = status.state === "ready" ? status.files : 0;
      log(`Index created for ${workspaceSessionName()}`);
      vscode.window.showInformationMessage(
        `Moss index ready — ${files} files indexed.`,
      );
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(`Create index failed: ${message}`);
    provider.setStatus({ state: "error", message });
    vscode.window.showErrorMessage(`Moss indexing failed: ${message}`);
    if (statusBarItem) {
      statusBarItem.text = "$(error) Moss: error";
      statusBarItem.tooltip = message;
    }
  }
}

async function openHit(hit: SearchHit): Promise<void> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders?.length) {
    return;
  }

  let target: vscode.Uri | undefined;
  for (const folder of folders) {
    const candidate = vscode.Uri.joinPath(folder.uri, hit.filePath);
    try {
      await vscode.workspace.fs.stat(candidate);
      target = candidate;
      break;
    } catch {
      // try next folder
    }
  }

  if (!target) {
    vscode.window.showWarningMessage(`Could not open ${hit.filePath}`);
    return;
  }

  const line = Math.max(0, (hit.startLine || 1) - 1);
  const doc = await vscode.workspace.openTextDocument(target);
  const editor = await vscode.window.showTextDocument(doc, { preview: true });
  const position = new vscode.Position(line, 0);
  editor.selection = new vscode.Selection(position, position);
  editor.revealRange(
    new vscode.Range(position, position),
    vscode.TextEditorRevealType.InCenter,
  );
}

export function deactivate(): void {
  // disposed via subscriptions
}
