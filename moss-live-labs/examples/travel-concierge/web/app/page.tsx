"use client";

import { useCallback, useState } from "react";
import { LiveKitRoom, RoomAudioRenderer } from "@livekit/components-react";
import { AgentSide } from "@/components/AgentSide";
import { DualPanel } from "@/components/DualPanel";

type Conn = { serverUrl: string; roomName: string; participantToken: string };

export default function Page() {
  const [conn, setConn] = useState<Conn | null>(null);
  const [roomLive, setRoomLive] = useState(false);
  const [connecting, setConnecting] = useState(false);

  const reset = useCallback(() => {
    setConn(null);
    setRoomLive(false);
  }, []);

  const connect = useCallback(async () => {
    setConnecting(true);
    try {
      const headers: HeadersInit = {};
      const secret = process.env.NEXT_PUBLIC_APP_SECRET;
      if (secret) headers.Authorization = `Bearer ${secret}`;

      const res = await fetch("/api/token", { headers });
      if (!res.ok) throw new Error(await res.text());
      setConn((await res.json()) as Conn);
      setRoomLive(false);
    } catch (err) {
      console.error("failed to get token", err);
      alert("Could not reach the token endpoint. Is the app running and LiveKit reachable?");
      reset();
    } finally {
      setConnecting(false);
    }
  }, [reset]);

  const statusLabel = conn ? (roomLive ? "live" : "connecting") : "offline";

  return (
    <div className="app">
      <header className="header">
        <div className="brand">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/moss-wordmark.svg" alt="Moss" />
          <span className="divider" />
          <span className="title">Wander · travel concierge</span>
        </div>
        <div className={`status ${roomLive ? "live" : ""}`}>
          <span className="dot" />
          {statusLabel}
        </div>
      </header>

      {conn ? (
        <LiveKitRoom
          className="main"
          serverUrl={conn.serverUrl}
          token={conn.participantToken}
          connect
          audio
          video={false}
          onConnected={() => setRoomLive(true)}
          onError={(err) => {
            console.error("LiveKit room error", err);
            alert("Could not connect to the voice room. Check LiveKit and try again.");
            reset();
          }}
          onDisconnected={() => reset()}
        >
          <AgentSide />
          <DualPanel />
          <RoomAudioRenderer />
        </LiveKitRoom>
      ) : (
        <main className="main" style={{ gridTemplateColumns: "1fr" }}>
          <div className="card connect">
            <h1>
              Plan a trip out loud — it <span className="accent">remembers</span> what you say.
            </h1>
            <p>
              Ask about destinations from the catalog, tell it your budget, dates, and who&apos;s coming.
              Watch Moss pull from the pre-loaded catalog and your live conversation, together.
            </p>
            <button className="btn" onClick={connect} disabled={connecting}>
              {connecting ? "Connecting…" : "Start planning"}
            </button>
          </div>
        </main>
      )}

      <footer className="footer">
        <a href="https://docs.moss.dev/docs/integrate/sessions" target="_blank" rel="noreferrer">
          docs.moss.dev
        </a>
        <span className="sep">·</span>
        <a href="https://github.com/usemoss/moss" target="_blank" rel="noreferrer">
          github.com/usemoss/moss
        </a>
      </footer>
    </div>
  );
}
