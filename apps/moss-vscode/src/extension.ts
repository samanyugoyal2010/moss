import * as vscode from "vscode";
import { MossSessionManager } from "./moss/client";
import {
  promptAndStoreCredentials,
  resolveCredentials,
} from "./moss/config";
import { CodebaseIndexer } from "./indexer/indexer";
import { SemanticSearch, type SearchHit } from "./search/search";
import { MossSearchViewProvider } from "./ui/sidebar";

let statusBarItem: vscode.StatusBarItem | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const sessionManager = new MossSessionManager();
  const indexer = new CodebaseIndexer();
  const search = new SemanticSearch(() =>
    sessionManager.isReady ? sessionManager.getSession() : undefined,
  );

  statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    100,
  );
  statusBarItem.text = "$(search) Moss: starting…";
  statusBarItem.command = "moss.search.focus";
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);

  const provider = new MossSearchViewProvider(context.extensionUri, {
    onQuery: async (query) => search.query(query),
    onOpen: async (hit) => openHit(hit),
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
      if (!statusBarItem) {
        return;
      }
      if (status.state === "indexing") {
        statusBarItem.text = `$(sync~spin) Moss: indexing ${status.processed}/${status.total}`;
      } else if (status.state === "ready") {
        statusBarItem.text = `$(check) Moss: ${status.files} files`;
      } else if (status.state === "error") {
        statusBarItem.text = "$(error) Moss: error";
        statusBarItem.tooltip = status.message;
      } else {
        statusBarItem.text = "$(search) Moss";
      }
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
        await bootstrap(context, sessionManager, indexer, provider);
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("moss.index.rebuild", async () => {
      if (!sessionManager.isReady) {
        vscode.window.showWarningMessage("Moss is not ready yet.");
        return;
      }
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: "Moss: rebuilding index…",
          cancellable: true,
        },
        async (_progress, token) => {
          await indexer.rebuild(token);
        },
      );
    }),
  );

  context.subscriptions.push({
    dispose: () => {
      indexer.dispose();
      sessionManager.dispose();
    },
  });

  await bootstrap(context, sessionManager, indexer, provider);
}

async function bootstrap(
  context: vscode.ExtensionContext,
  sessionManager: MossSessionManager,
  indexer: CodebaseIndexer,
  provider: MossSearchViewProvider,
): Promise<void> {
  let credentials = await resolveCredentials(context);
  if (!credentials) {
    const choice = await vscode.window.showInformationMessage(
      "Moss Code Search needs project credentials to index your workspace.",
      "Configure",
    );
    if (choice === "Configure") {
      credentials = await promptAndStoreCredentials(context);
    }
  }

  if (!credentials) {
    provider.setStatus({
      state: "error",
      message: "Missing Moss credentials. Run “Moss: Configure Credentials”.",
    });
    if (statusBarItem) {
      statusBarItem.text = "$(warning) Moss: credentials needed";
    }
    return;
  }

  try {
    if (statusBarItem) {
      statusBarItem.text = "$(sync~spin) Moss: connecting…";
    }
    const session = await sessionManager.initialize(credentials);
    indexer.attachSession(session);
    indexer.startWatching(context.subscriptions);

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "Moss: indexing workspace…",
        cancellable: true,
      },
      async (_progress, token) => {
        await indexer.rebuild(token);
      },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    provider.setStatus({ state: "error", message });
    vscode.window.showErrorMessage(`Moss failed to start: ${message}`);
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
