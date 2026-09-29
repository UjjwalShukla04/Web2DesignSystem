import dns from "node:dns/promises";
import http from "node:http";
import net from "node:net";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";

// --- SSRF protection ---
// Every network request the headless browser makes (navigation, redirects,
// subresources, fetch/XHR, WebSockets) is sent through a local proxy. The proxy
// resolves the hostname itself, rejects private/internal addresses, and then
// connects to the exact IP it validated, so redirects and DNS rebinding can't
// be used to reach internal services.

export class UnsafeUrlError extends Error {}

const blockList = new net.BlockList();
for (const [addr, prefix] of [
  ["0.0.0.0", 8], // "this" network
  ["10.0.0.0", 8], // private
  ["100.64.0.0", 10], // carrier-grade NAT
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local (cloud metadata endpoints)
  ["172.16.0.0", 12], // private
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.0.2.0", 24], // documentation
  ["192.168.0.0", 16], // private
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // documentation
  ["203.0.113.0", 24], // documentation
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved + broadcast
] as const) {
  blockList.addSubnet(addr, prefix, "ipv4");
}
for (const [addr, prefix] of [
  ["::", 128], // unspecified
  ["::1", 128], // loopback
  // No "::ffff:0:0/96" rule: BlockList already checks IPv4-mapped addresses
  // against the IPv4 rules, and that rule would block every IPv4 address.
  // NAT64 (64:ff9b::/96) is handled separately below.
  ["64:ff9b:1::", 48], // local-use NAT64
  ["100::", 64], // discard
  ["2001:db8::", 32], // documentation
  ["fc00::", 7], // unique local
  ["fe80::", 10], // link-local
  ["ff00::", 8], // multicast
] as const) {
  blockList.addSubnet(addr, prefix, "ipv6");
}

// DNS64 networks (IPv6-only hosts, many mobile networks) return every IPv4-only
// site as 64:ff9b::<IPv4>. Those are checked by their embedded IPv4 address.
const nat64 = new net.BlockList();
nat64.addSubnet("64:ff9b::", 96, "ipv6");

/** Expands an IPv6 address into its 8 16-bit groups, or null if malformed. */
export function ipv6Groups(ip: string): number[] | null {
  let address = ip;
  // A trailing dotted IPv4 part (e.g. ::ffff:1.2.3.4) becomes two groups.
  const dotted = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(address);
  if (dotted) {
    const [a, b, c, d] = dotted.slice(1).map(Number) as [number, number, number, number];
    address = `${address.slice(0, dotted.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = address.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const groups =
    halves.length === 2 ? [...head, ...Array(8 - head.length - tail.length).fill("0"), ...tail] : head;
  if (groups.length !== 8) return null;
  const numbers = groups.map((g) => parseInt(g, 16));
  return numbers.every((n) => Number.isInteger(n) && n >= 0 && n <= 0xffff) ? numbers : null;
}

export function isBlockedIp(ip: string): boolean {
  const family = net.isIP(ip);
  if (family === 0) return true;
  if (family === 6 && nat64.check(ip, "ipv6")) {
    const groups = ipv6Groups(ip);
    if (!groups) return true;
    const [hi = 0, lo = 0] = groups.slice(6);
    const ipv4 = [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff].join(".");
    return blockList.check(ipv4, "ipv4");
  }
  return blockList.check(ip, family === 4 ? "ipv4" : "ipv6");
}

/** Resolves a hostname and returns a public IP for it, or throws UnsafeUrlError. */
async function resolvePublicAddress(hostname: string): Promise<string> {
  const host = hostname.replace(/^\[|\]$/g, "");
  if (net.isIP(host)) {
    if (isBlockedIp(host)) {
      throw new UnsafeUrlError(`Access to internal address ${host} is not allowed`);
    }
    return host;
  }

  let addresses: { address: string }[];
  try {
    addresses = await dns.lookup(host, { all: true, verbatim: true });
  } catch {
    throw new UnsafeUrlError(`Could not resolve host ${host}`);
  }
  // Reject if ANY record is internal, so a mixed answer can't be abused.
  if (addresses.length === 0 || addresses.some((a) => isBlockedIp(a.address))) {
    throw new UnsafeUrlError(`Host ${host} resolves to an internal address`);
  }
  return addresses[0]!.address;
}

/** Validates a user-supplied URL before scraping. Returns the normalized URL. */
export async function assertPublicUrl(rawUrl: string): Promise<string> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new UnsafeUrlError("Invalid URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new UnsafeUrlError("Only http and https URLs are allowed");
  }
  await resolvePublicAddress(url.hostname);
  return url.toString();
}

// --- Filtering forward proxy used by the browser ---

const UPSTREAM_TIMEOUT_MS = 30_000;
const HOP_BY_HOP_HEADERS = [
  "proxy-connection",
  "proxy-authorization",
  "connection",
  "keep-alive",
];

function handleHttpRequest(req: http.IncomingMessage, res: http.ServerResponse) {
  let target: URL;
  try {
    target = new URL(req.url ?? "");
  } catch {
    res.writeHead(400).end();
    return;
  }
  if (target.protocol !== "http:") {
    res.writeHead(400).end();
    return;
  }

  resolvePublicAddress(target.hostname)
    .then((ip) => {
      const headers = { ...req.headers };
      for (const h of HOP_BY_HOP_HEADERS) delete headers[h];

      const upstream = http.request({
        host: ip,
        port: target.port || 80,
        method: req.method,
        path: target.pathname + target.search,
        headers,
        timeout: UPSTREAM_TIMEOUT_MS,
      });
      upstream.on("response", (upRes) => {
        res.writeHead(upRes.statusCode ?? 502, upRes.headers);
        upRes.pipe(res);
      });
      upstream.on("timeout", () => upstream.destroy());
      upstream.on("error", () => {
        if (!res.headersSent) res.writeHead(502);
        res.end();
      });
      req.pipe(upstream);
    })
    .catch(() => res.writeHead(403).end());
}

function handleConnect(
  req: http.IncomingMessage,
  clientSocket: Duplex,
  head: Buffer,
) {
  clientSocket.on("error", () => {});
  let target: URL;
  try {
    // req.url is "host:port" for CONNECT
    target = new URL(`http://${req.url}`);
  } catch {
    clientSocket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
    return;
  }

  resolvePublicAddress(target.hostname)
    .then((ip) => {
      const upstream = net.connect(Number(target.port) || 443, ip, () => {
        clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length) upstream.write(head);
        upstream.pipe(clientSocket);
        clientSocket.pipe(upstream);
      });
      upstream.setTimeout(UPSTREAM_TIMEOUT_MS, () => upstream.destroy());
      upstream.on("error", () => clientSocket.destroy());
      upstream.on("close", () => clientSocket.destroy());
      clientSocket.on("close", () => upstream.destroy());
    })
    .catch(() => clientSocket.end("HTTP/1.1 403 Forbidden\r\n\r\n"));
}

let proxyUrlPromise: Promise<string> | null = null;

/** Starts (once) the filtering proxy on loopback and returns its URL. */
export function getSafeProxyUrl(): Promise<string> {
  if (!proxyUrlPromise) {
    proxyUrlPromise = new Promise((resolve, reject) => {
      const server = http.createServer(handleHttpRequest);
      server.on("connect", handleConnect);
      server.on("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const { port } = server.address() as AddressInfo;
        resolve(`http://127.0.0.1:${port}`);
      });
      // The proxy alone shouldn't keep the process alive (e.g. in tests or scripts).
      server.unref();
    });
    proxyUrlPromise.catch(() => {
      proxyUrlPromise = null;
    });
  }
  return proxyUrlPromise;
}
