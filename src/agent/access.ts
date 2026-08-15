import nacl from "tweetnacl";

const ACCESS_LOGIN_TIMEOUT_MS = 10 * 60 * 1_000;
const POLL_REQUEST_TIMEOUT_MS = 60 * 1_000;
const POLL_RETRY_DELAY_MS = 2 * 1_000;
const TRANSFER_ORIGIN = "https://login.cloudflareaccess.org";

type AccessMetadata = {
  aud: string;
};

type TransferResponse = {
  app_token: string;
};

type AuthorizeOptions = {
  fetchImplementation?: typeof fetch;
  onAuthorizationUrl?: (url: string) => void;
};

function urlSafeBase64(value: Uint8Array): string {
  return Buffer.from(value).toString("base64").replace(/\+/g, "-").replace(/\//g, "_");
}

function decodeBase64Url(value: string, description: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+={0,2}$/.test(value)) {
    throw new Error(`Cloudflare Access returned an invalid ${description}`);
  }
  return new Uint8Array(Buffer.from(value, "base64url"));
}

function accessAudience(metadata: string): string {
  const encodedPayload = metadata.split(".")[1];
  if (encodedPayload === undefined) {
    throw new Error("Cloudflare Access metadata is not a JWT");
  }

  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder().decode(decodeBase64Url(encodedPayload, "metadata JWT")));
  } catch (error) {
    throw new Error(`Could not parse Cloudflare Access metadata: ${String(error)}`);
  }
  if (typeof payload !== "object" || payload === null || typeof (payload as AccessMetadata).aud !== "string") {
    throw new Error("Cloudflare Access metadata is missing the application audience");
  }
  return (payload as AccessMetadata).aud;
}

async function accessMetadata(origin: string, fetchImplementation: typeof fetch): Promise<AccessMetadata> {
  const response = await fetchImplementation(origin, {
    headers: {
      "cf-access-metadata-request": "true",
    },
    method: "HEAD",
    redirect: "manual",
  });
  const metadata = response.headers.get("cf-access-metadata");
  if (metadata === null || metadata.length === 0) {
    throw new Error("Cloudflare Access metadata is unavailable; confirm this hostname is protected by Access");
  }
  return { aud: accessAudience(metadata) };
}

function authorizationUrl(origin: string, audience: string, publicKey: string): string {
  const redirect = new URL(origin);
  redirect.searchParams.set("aud", audience);
  redirect.searchParams.set("token", publicKey);

  const url = new URL("/cdn-cgi/access/cli", origin);
  url.searchParams.set("aud", audience);
  url.searchParams.set("edge_token_transfer", "true");
  url.searchParams.set("redirect_url", redirect.toString());
  url.searchParams.set("send_org_token", "true");
  url.searchParams.set("token", publicKey);
  return url.toString();
}

async function wait(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

function appToken(ciphertext: Uint8Array, servicePublicKey: string, keyPair: nacl.BoxKeyPair): string {
  if (ciphertext.byteLength <= nacl.box.nonceLength) {
    throw new Error("Cloudflare Access returned an empty encrypted token");
  }
  const publicKey = decodeBase64Url(servicePublicKey, "service public key");
  if (publicKey.byteLength !== nacl.box.publicKeyLength) {
    throw new Error("Cloudflare Access returned a service public key with the wrong length");
  }

  const plaintext = nacl.box.open(
    ciphertext.slice(nacl.box.nonceLength),
    ciphertext.slice(0, nacl.box.nonceLength),
    publicKey,
    keyPair.secretKey,
  );
  if (plaintext === null) {
    throw new Error("Cloudflare Access token decryption failed");
  }

  let transfer: unknown;
  try {
    transfer = JSON.parse(new TextDecoder().decode(plaintext));
  } catch (error) {
    throw new Error(`Could not parse Cloudflare Access token response: ${String(error)}`);
  }
  if (typeof transfer !== "object" || transfer === null || typeof (transfer as TransferResponse).app_token !== "string") {
    throw new Error("Cloudflare Access token response is missing the application token");
  }
  return (transfer as TransferResponse).app_token;
}

async function pollForToken(
  publicKey: string,
  keyPair: nacl.BoxKeyPair,
  fetchImplementation: typeof fetch,
): Promise<string> {
  const deadline = Date.now() + ACCESS_LOGIN_TIMEOUT_MS;
  const transferUrl = `${TRANSFER_ORIGIN}/transfer/${encodeURIComponent(publicKey)}`;

  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    const response = await fetchImplementation(transferUrl, {
      headers: { "User-Agent": "webrtc-turn-benchmark" },
      signal: AbortSignal.timeout(Math.min(POLL_REQUEST_TIMEOUT_MS, remaining)),
    });
    if (response.status >= 500) {
      throw new Error(`Cloudflare Access token transfer failed with HTTP ${response.status}: ${await response.text()}`);
    }
    if (response.status === 200) {
      const servicePublicKey = response.headers.get("service-public-key");
      if (servicePublicKey === null || servicePublicKey.length === 0) {
        throw new Error("Cloudflare Access token transfer did not include a service public key");
      }
      return appToken(new Uint8Array(Buffer.from((await response.text()).trim(), "base64")), servicePublicKey, keyPair);
    }
    await response.body?.cancel();
    await wait(Math.min(POLL_RETRY_DELAY_MS, Math.max(0, deadline - Date.now())));
  }

  throw new Error("Timed out waiting for Cloudflare Access authorization");
}

export async function authorizeCloudflareAccess(origin: string, options: AuthorizeOptions = {}): Promise<string> {
  const fetchImplementation = options.fetchImplementation ?? fetch;
  const metadata = await accessMetadata(origin, fetchImplementation);
  const keyPair = nacl.box.keyPair();
  const publicKey = urlSafeBase64(keyPair.publicKey);
  const url = authorizationUrl(origin, metadata.aud, publicKey);
  options.onAuthorizationUrl?.(url);
  return pollForToken(publicKey, keyPair, fetchImplementation);
}
