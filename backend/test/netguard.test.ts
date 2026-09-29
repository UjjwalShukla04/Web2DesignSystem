import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import type { AddressInfo } from "node:net";
import {
  assertPublicUrl,
  getSafeProxyUrl,
  ipv6Groups,
  isBlockedIp,
  UnsafeUrlError,
} from "../src/netguard.js";

test("isBlockedIp: internal and reserved addresses are blocked", () => {
  for (const ip of [
    "127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254",
    "100.64.0.1", "0.0.0.0", "224.0.0.1", "255.255.255.255",
    "::1", "::", "fc00::1", "fe80::1", "ff02::1",
    "::ffff:127.0.0.1", "::ffff:7f00:1", // IPv4-mapped loopback
    "64:ff9b::7f00:1", "64:ff9b::a9fe:a9fe", "64:ff9b::10.0.0.1", // NAT64-wrapped internal
    "64:ff9b:1::1", // local-use NAT64
    "not-an-ip",
  ]) {
    assert.equal(isBlockedIp(ip), true, ip);
  }
});

test("isBlockedIp: public addresses are allowed (including NAT64-wrapped ones)", () => {
  for (const ip of [
    "8.8.8.8", "104.20.23.154", "172.66.147.243",
    "2606:4700:10::6814:179a",
    "::ffff:8.8.8.8",
    // Regression: DNS64 networks return every IPv4-only site like this.
    "64:ff9b::2cdb:96d7", "64:ff9b::8.8.8.8",
  ]) {
    assert.equal(isBlockedIp(ip), false, ip);
  }
});

test("ipv6Groups expands compressed and dotted forms", () => {
  assert.deepEqual(ipv6Groups("::1"), [0, 0, 0, 0, 0, 0, 0, 1]);
  assert.deepEqual(ipv6Groups("64:ff9b::1.2.3.4"), [0x64, 0xff9b, 0, 0, 0, 0, 0x0102, 0x0304]);
  assert.deepEqual(ipv6Groups("1:2:3:4:5:6:7:8"), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal(ipv6Groups("1::2::3"), null);
});

test("assertPublicUrl rejects unsafe URLs", async () => {
  for (const url of [
    "file:///etc/passwd",
    "ftp://example.com/",
    "javascript:alert(1)",
    "not a url",
    "http://127.0.0.1:8080/",
    "http://localhost/",
    "http://169.254.169.254/latest/meta-data/",
    "http://[::1]/",
    "http://2130706433/", // decimal 127.0.0.1
    "http://[::ffff:127.0.0.1]/",
    "http://10.0.0.5/",
    "http://[64:ff9b::7f00:1]/",
  ]) {
    await assert.rejects(assertPublicUrl(url), UnsafeUrlError, url);
  }
});

test("assertPublicUrl accepts public IP literals", async () => {
  assert.equal(await assertPublicUrl("http://8.8.8.8/x"), "http://8.8.8.8/x");
  assert.equal(await assertPublicUrl("https://[64:ff9b::808:808]/"), "https://[64:ff9b::808:808]/");
});

// A local "internal" service the proxy must refuse to reach.
async function startInternalServer() {
  const server = http.createServer((_req, res) => res.end("INTERNAL_SECRET"));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, port: (server.address() as AddressInfo).port };
}

test("the browser proxy refuses plain HTTP requests to internal hosts", async () => {
  const { server, port } = await startInternalServer();
  const proxy = new URL(await getSafeProxyUrl());
  try {
    const { status, body } = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = http.request(
        {
          host: proxy.hostname,
          port: proxy.port,
          method: "GET",
          path: `http://127.0.0.1:${port}/`, // absolute URL = proxy request
        },
        (res) => {
          let body = "";
          res.on("data", (c) => (body += c));
          res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
        },
      );
      req.on("error", reject);
      req.end();
    });
    assert.equal(status, 403);
    assert.ok(!body.includes("INTERNAL_SECRET"));
  } finally {
    server.close();
  }
});

test("the browser proxy refuses CONNECT tunnels to internal hosts", async () => {
  const { server, port } = await startInternalServer();
  const proxy = new URL(await getSafeProxyUrl());
  try {
    const reply = await new Promise<string>((resolve, reject) => {
      const socket = net.connect(Number(proxy.port), proxy.hostname, () => {
        socket.write(`CONNECT 127.0.0.1:${port} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n\r\n`);
      });
      let data = "";
      socket.on("data", (c) => (data += c));
      socket.on("end", () => resolve(data));
      socket.on("close", () => resolve(data));
      socket.on("error", reject);
    });
    assert.match(reply, /^HTTP\/1\.1 403/);
  } finally {
    server.close();
  }
});
