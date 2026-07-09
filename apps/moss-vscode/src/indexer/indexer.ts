import type { DocumentInfo, SessionIndex } from "@moss-dev/moss";
import * as vscode from "vscode";
import { chunkFile } from "./chunker";
import { readFileForIndex, scanWorkspaceFiles, toWorkspaceRelative } from "./scanner";

const BATCH_SIZE = 64;

export type IndexStatus =
  | { state: "idle" }
  | { state: "indexing"; processed: number; total: number }
  | { state: "ready"; files: number; chunks: number }
  | { state: "error"; message: string };

export type StatusListener = (status: IndexStatus) => void;

export class CodebaseIndexer {
  private session: SessionIndex | undefined;
  private status: IndexStatus = { state: "idle" };
  private listeners = new Set<StatusListener>();
  private pathChunkCounts = new Map<string, number>();
  private watchers: vscode.Disposable[] = [];
  private indexing = false;

  onStatus(listener: StatusListener): vscode.Disposable {
    this.listeners.add(listener);
    listener(this.status);
    return new vscode.Disposable(() => this.listeners.delete(listener));
  }

  getStatus(): IndexStatus {
    return this.status;
  }

  private setStatus(status: IndexStatus): void {
    this.status = status;
    for (const listener of this.listeners) {
      listener(status);
    }
  }

  attachSession(session: SessionIndex): void {
    this.session = session;
  }

  async rebuild(token?: vscode.CancellationToken): Promise<void> {
    if (!this.session) {
      throw new Error("Moss session not ready");
    }
    if (this.indexing) {
      return;
    }
    this.indexing = true;

    try {
      const files = await scanWorkspaceFiles(token);
      this.setStatus({ state: "indexing", processed: 0, total: files.length });

      // Clear previous local docs for known paths when rebuilding
      const staleIds: string[] = [];
      for (const [rel, count] of this.pathChunkCounts) {
        for (let i = 0; i < count; i++) {
          staleIds.push(`${rel}#chunk-${i}`);
        }
      }
      if (staleIds.length) {
        await this.deleteInBatches(staleIds);
      }
      this.pathChunkCounts.clear();

      let processed = 0;
      let totalChunks = 0;
      const pending: DocumentInfo[] = [];

      const flush = async () => {
        if (!pending.length || !this.session) {
          return;
        }
        const batch = pending.splice(0, pending.length);
        await this.session.addDocs(batch, { upsert: true });
      };

      for (const uri of files) {
        if (token?.isCancellationRequested) {
          break;
        }
        const file = await readFileForIndex(uri);
        processed += 1;
        this.setStatus({
          state: "indexing",
          processed,
          total: files.length,
        });
        if (!file) {
          continue;
        }
        const chunks = chunkFile(file.relativePath, file.content);
        if (!chunks.length) {
          continue;
        }
        this.pathChunkCounts.set(file.relativePath, chunks.length);
        totalChunks += chunks.length;
        pending.push(...chunks);
        if (pending.length >= BATCH_SIZE) {
          await flush();
        }
      }

      await flush();
      this.setStatus({
        state: "ready",
        files: this.pathChunkCounts.size,
        chunks: totalChunks,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.setStatus({ state: "error", message });
      throw err;
    } finally {
      this.indexing = false;
    }
  }

  async upsertFile(uri: vscode.Uri): Promise<void> {
    if (!this.session) {
      return;
    }
    const file = await readFileForIndex(uri);
    if (!file) {
      await this.removeFile(uri);
      return;
    }

    const previous = this.pathChunkCounts.get(file.relativePath) ?? 0;
    const chunks = chunkFile(file.relativePath, file.content);
    const next = chunks.length;

    if (previous > next) {
      const toDelete: string[] = [];
      for (let i = next; i < previous; i++) {
        toDelete.push(`${file.relativePath}#chunk-${i}`);
      }
      if (toDelete.length) {
        await this.session.deleteDocs(toDelete);
      }
    }

    if (chunks.length) {
      await this.session.addDocs(chunks, { upsert: true });
      this.pathChunkCounts.set(file.relativePath, next);
    } else {
      this.pathChunkCounts.delete(file.relativePath);
    }

    this.refreshReadyStatus();
  }

  async removeFile(uri: vscode.Uri): Promise<void> {
    if (!this.session) {
      return;
    }
    const relativePath = toWorkspaceRelative(uri);
    const count = this.pathChunkCounts.get(relativePath) ?? 0;
    if (!count) {
      // Best-effort: try deleting a reasonable number of chunks
      const guessIds = Array.from({ length: 64 }, (_, i) => `${relativePath}#chunk-${i}`);
      await this.session.deleteDocs(guessIds).catch(() => undefined);
      return;
    }
    const ids = Array.from({ length: count }, (_, i) => `${relativePath}#chunk-${i}`);
    await this.session.deleteDocs(ids);
    this.pathChunkCounts.delete(relativePath);
    this.refreshReadyStatus();
  }

  startWatching(disposables: vscode.Disposable[]): void {
    this.stopWatching();

    const save = vscode.workspace.onDidSaveTextDocument(async (doc) => {
      if (doc.uri.scheme !== "file") {
        return;
      }
      try {
        await this.upsertFile(doc.uri);
      } catch (err) {
        console.error("Moss incremental index failed", err);
      }
    });

    const create = vscode.workspace.onDidCreateFiles(async (e) => {
      for (const uri of e.files) {
        try {
          await this.upsertFile(uri);
        } catch (err) {
          console.error("Moss create index failed", err);
        }
      }
    });

    const del = vscode.workspace.onDidDeleteFiles(async (e) => {
      for (const uri of e.files) {
        try {
          await this.removeFile(uri);
        } catch (err) {
          console.error("Moss delete index failed", err);
        }
      }
    });

    const rename = vscode.workspace.onDidRenameFiles(async (e) => {
      for (const { oldUri, newUri } of e.files) {
        try {
          await this.removeFile(oldUri);
          await this.upsertFile(newUri);
        } catch (err) {
          console.error("Moss rename index failed", err);
        }
      }
    });

    this.watchers = [save, create, del, rename];
    disposables.push(...this.watchers);
  }

  stopWatching(): void {
    for (const d of this.watchers) {
      d.dispose();
    }
    this.watchers = [];
  }

  dispose(): void {
    this.stopWatching();
    this.listeners.clear();
    this.pathChunkCounts.clear();
    this.session = undefined;
  }

  private refreshReadyStatus(): void {
    let chunks = 0;
    for (const count of this.pathChunkCounts.values()) {
      chunks += count;
    }
    this.setStatus({
      state: "ready",
      files: this.pathChunkCounts.size,
      chunks,
    });
  }

  private async deleteInBatches(ids: string[]): Promise<void> {
    if (!this.session) {
      return;
    }
    for (let i = 0; i < ids.length; i += BATCH_SIZE) {
      const slice = ids.slice(i, i + BATCH_SIZE);
      await this.session.deleteDocs(slice);
    }
  }
}
