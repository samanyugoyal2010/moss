import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  assertLocalDevOnly,
  isLoopbackIp,
  isLoopbackListenHost,
  peerIp,
  type TokenGuardConfig,
} from "./tokenGuard";

function req(headers: Record<string, string> = {}): Request {
  return new Request("http://example.test/api/token", { headers });
}

function baseConfig(overrides: Partial<TokenGuardConfig> = {}): TokenGuardConfig {
  return {
    allowRemoteToken: false,
    trustProxy: false,
    trustedProxyHops: 1,
    trustProxyHeader: "x-forwarded-for",
    listenHost: "",
    ...overrides,
  };
}

describe("isLoopbackIp", () => {
  it("accepts IPv4 and IPv6 loopback forms", () => {
    assert.equal(isLoopbackIp("127.0.0.1"), true);
    assert.equal(isLoopbackIp("127.1.2.3"), true);
    assert.equal(isLoopbackIp("::1"), true);
    assert.equal(isLoopbackIp("[::1]"), true);
    assert.equal(isLoopbackIp("::ffff:127.0.0.1"), true);
  });

  it("rejects non-loopback addresses", () => {
    assert.equal(isLoopbackIp("10.0.0.1"), false);
    assert.equal(isLoopbackIp("192.168.1.1"), false);
    assert.equal(isLoopbackIp("8.8.8.8"), false);
  });
});

describe("isLoopbackListenHost", () => {
  it("accepts loopback hosts with optional ports / brackets", () => {
    assert.equal(isLoopbackListenHost("127.0.0.1"), true);
    assert.equal(isLoopbackListenHost("127.0.0.1:3000"), true);
    assert.equal(isLoopbackListenHost("localhost"), true);
    assert.equal(isLoopbackListenHost("[::1]"), true);
    assert.equal(isLoopbackListenHost("[::1]:3000"), true);
  });

  it("rejects non-loopback listen hosts", () => {
    assert.equal(isLoopbackListenHost("0.0.0.0"), false);
    assert.equal(isLoopbackListenHost("192.168.0.5"), false);
  });
});

describe("peerIp strategies", () => {
  it("returns null when TRUST_PROXY is off", () => {
    assert.equal(
      peerIp(req({ "x-forwarded-for": "8.8.8.8", "x-real-ip": "127.0.0.1" }), baseConfig()),
      null,
    );
  });

  it("x-forwarded-for uses the rightmost trusted hop, not the forged leftmost", () => {
    const config = baseConfig({ trustProxy: true, trustProxyHeader: "x-forwarded-for", trustedProxyHops: 1 });
    assert.equal(peerIp(req({ "x-forwarded-for": "8.8.8.8, 10.0.0.5" }), config), "10.0.0.5");
    assert.equal(peerIp(req({ "x-forwarded-for": "127.0.0.1, 8.8.8.8" }), config), "8.8.8.8");
  });

  it("x-forwarded-for respects TRUSTED_PROXY_HOPS", () => {
    const config = baseConfig({ trustProxy: true, trustProxyHeader: "x-forwarded-for", trustedProxyHops: 2 });
    assert.equal(
      peerIp(req({ "x-forwarded-for": "client, proxy1, proxy2" }), config),
      "proxy1",
    );
    assert.equal(peerIp(req({ "x-forwarded-for": "only-one" }), config), null);
  });

  it("x-real-ip strategy ignores X-Forwarded-For entirely", () => {
    const config = baseConfig({ trustProxy: true, trustProxyHeader: "x-real-ip" });
    assert.equal(
      peerIp(req({ "x-real-ip": "10.0.0.9", "x-forwarded-for": "127.0.0.1" }), config),
      "10.0.0.9",
    );
    assert.equal(peerIp(req({ "x-forwarded-for": "127.0.0.1" }), config), null);
  });

  it("returns null for missing headers or invalid strategy", () => {
    assert.equal(
      peerIp(req({}), baseConfig({ trustProxy: true, trustProxyHeader: "x-forwarded-for" })),
      null,
    );
    assert.equal(
      peerIp(req({ "x-forwarded-for": "1.2.3.4" }), baseConfig({ trustProxy: true, trustProxyHeader: "nope" })),
      null,
    );
  });
});

describe("assertLocalDevOnly", () => {
  it("allows everything when ALLOW_REMOTE_TOKEN is set", () => {
    assert.equal(assertLocalDevOnly(req(), baseConfig({ allowRemoteToken: true })), null);
  });

  it("allows loopback-bound listen host without proxy (dev/start scripts)", () => {
    assert.equal(
      assertLocalDevOnly(req(), baseConfig({ listenHost: "127.0.0.1" })),
      null,
    );
    assert.equal(
      assertLocalDevOnly(req(), baseConfig({ listenHost: "localhost" })),
      null,
    );
  });

  it("denies when listen host is missing or non-loopback and peer IP is unknown", () => {
    const denied = assertLocalDevOnly(req(), baseConfig({ listenHost: "" }));
    assert.ok(denied);
    assert.equal(denied.status, 403);

    const deniedLan = assertLocalDevOnly(req(), baseConfig({ listenHost: "0.0.0.0" }));
    assert.ok(deniedLan);
    assert.equal(deniedLan.status, 403);
  });

  it("with TRUST_PROXY + xff, allows loopback peer and denies remote peer", () => {
    const config = baseConfig({
      trustProxy: true,
      trustProxyHeader: "x-forwarded-for",
      listenHost: "127.0.0.1", // must not bypass a verified non-loopback peer
    });
    assert.equal(
      assertLocalDevOnly(req({ "x-forwarded-for": "evil, 127.0.0.1" }), config),
      null,
    );
    const denied = assertLocalDevOnly(req({ "x-forwarded-for": "127.0.0.1, 8.8.8.8" }), config);
    assert.ok(denied);
    assert.equal(denied.status, 403);
  });

  it("with TRUST_PROXY + x-real-ip, forged loopback real-ip is evaluated alone", () => {
    const config = baseConfig({ trustProxy: true, trustProxyHeader: "x-real-ip" });
    assert.equal(assertLocalDevOnly(req({ "x-real-ip": "127.0.0.1" }), config), null);
    const denied = assertLocalDevOnly(req({ "x-real-ip": "8.8.8.8" }), config);
    assert.ok(denied);
    assert.equal(denied.status, 403);
  });

  it("does not treat Host spoofing as authorization", () => {
    const denied = assertLocalDevOnly(
      req({ host: "localhost", "x-forwarded-host": "127.0.0.1" }),
      baseConfig({ listenHost: "" }),
    );
    assert.ok(denied);
    assert.equal(denied.status, 403);
  });

  it("denies null peer when TRUST_PROXY is on even if listen host is loopback", () => {
    // TRUST_PROXY without a usable client header must not fall open via MOSS_LISTEN_HOST.
    const denied = assertLocalDevOnly(
      req({}),
      baseConfig({ trustProxy: true, trustProxyHeader: "x-forwarded-for", listenHost: "127.0.0.1" }),
    );
    assert.ok(denied);
    assert.equal(denied.status, 403);
  });
});
