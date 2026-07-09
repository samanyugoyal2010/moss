import { MossClient, SessionIndex } from "@moss-dev/moss";
import type { MossCredentials } from "./config";
import { workspaceSessionName } from "./config";

export class MossSessionManager {
  private client: MossClient | undefined;
  private session: SessionIndex | undefined;
  private ready = false;

  get isReady(): boolean {
    return this.ready && !!this.session;
  }

  getSession(): SessionIndex {
    if (!this.session) {
      throw new Error("Moss session is not initialized");
    }
    return this.session;
  }

  async initialize(credentials: MossCredentials): Promise<SessionIndex> {
    this.ready = false;
    this.client = new MossClient(credentials.projectId, credentials.projectKey);
    const name = workspaceSessionName();
    this.session = await this.client.session(name, "moss-minilm");
    this.ready = true;
    return this.session;
  }

  dispose(): void {
    this.ready = false;
    this.session = undefined;
    this.client = undefined;
  }
}
