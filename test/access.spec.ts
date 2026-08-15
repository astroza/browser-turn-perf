import nacl from "tweetnacl";
import { describe, expect, it } from "vitest";

import { authorizeCloudflareAccess } from "../src/agent/access";

function metadataJwt(audience: string): string {
  return `header.${Buffer.from(JSON.stringify({ aud: audience })).toString("base64url")}.signature`;
}

describe("Cloudflare Access authorization", () => {
  it("uses the CLI transfer protocol without cloudflared", async () => {
    const service = nacl.box.keyPair();
    let printedUrl = "";
    const token = await authorizeCloudflareAccess("https://benchmark.example", {
      fetchImplementation: async (input) => {
        const url = new URL(input.toString());
        if (url.pathname === "/") {
          return new Response(null, { headers: { "cf-access-metadata": metadataJwt("audience-123") } });
        }

        const clientPublicKey = new Uint8Array(Buffer.from(decodeURIComponent(url.pathname.split("/").at(-1) ?? ""), "base64url"));
        const nonce = nacl.randomBytes(nacl.box.nonceLength);
        const ciphertext = nacl.box(
          new TextEncoder().encode(JSON.stringify({ app_token: "access-token" })),
          nonce,
          clientPublicKey,
          service.secretKey,
        );
        const encrypted = new Uint8Array(nonce.byteLength + ciphertext.byteLength);
        encrypted.set(nonce);
        encrypted.set(ciphertext, nonce.byteLength);
        return new Response(Buffer.from(encrypted).toString("base64"), {
          headers: { "service-public-key": Buffer.from(service.publicKey).toString("base64url") },
        });
      },
      onAuthorizationUrl: (url) => {
        printedUrl = url;
      },
    });

    const url = new URL(printedUrl);
    expect(token).toBe("access-token");
    expect(url.pathname).toBe("/cdn-cgi/access/cli");
    expect(url.searchParams.get("aud")).toBe("audience-123");
    expect(url.searchParams.get("edge_token_transfer")).toBe("true");
    expect(new URL(url.searchParams.get("redirect_url") ?? "").origin).toBe("https://benchmark.example");
  });
});
