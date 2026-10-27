import {
  createHash,
  createSign,
  generateKeyPairSync,
  randomBytes,
  type KeyObject,
} from "node:crypto";

// Authentificateur WebAuthn logiciel (ES256, attestation « none ») pour tester les passkeys de bout
// en bout côté serveur, sans navigateur. Il produit les mêmes structures qu'une vraie clé.

function cborHead(major: number, length: number): Buffer {
  if (length < 24) return Buffer.from([(major << 5) | length]);
  if (length < 256) return Buffer.from([(major << 5) | 24, length]);
  const b = Buffer.alloc(3);
  b[0] = (major << 5) | 25;
  b.writeUInt16BE(length, 1);
  return b;
}

type Cbor = number | string | Buffer | Map<Cbor, Cbor>;

export function cbor(value: Cbor): Buffer {
  if (typeof value === "number") {
    return value >= 0 ? cborHead(0, value) : cborHead(1, -1 - value);
  }
  if (typeof value === "string") {
    const bytes = Buffer.from(value, "utf8");
    return Buffer.concat([cborHead(3, bytes.length), bytes]);
  }
  if (Buffer.isBuffer(value)) {
    return Buffer.concat([cborHead(2, value.length), value]);
  }
  return Buffer.concat([
    cborHead(5, value.size),
    ...[...value.entries()].flatMap(([k, v]) => [cbor(k), cbor(v)]),
  ]);
}

const b64url = (b: Buffer) => b.toString("base64url");

export class SoftAuthenticator {
  readonly credentialId = randomBytes(16);
  readonly #privateKey: KeyObject;
  readonly #cose: Buffer;
  #counter = 0;

  constructor(
    private readonly rpId: string,
    private readonly origin: string,
  ) {
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    this.#privateKey = privateKey;
    const jwk = publicKey.export({ format: "jwk" });
    this.#cose = cbor(
      new Map<Cbor, Cbor>([
        [1, 2],
        [3, -7],
        [-1, 1],
        [-2, Buffer.from(jwk.x ?? "", "base64url")],
        [-3, Buffer.from(jwk.y ?? "", "base64url")],
      ]),
    );
  }

  #authData(flags: number, attested: boolean): Buffer {
    const rpIdHash = createHash("sha256").update(this.rpId).digest();
    const count = Buffer.alloc(4);
    count.writeUInt32BE(++this.#counter);
    const parts: Buffer[] = [rpIdHash, Buffer.from([flags]), count];
    if (attested) {
      const len = Buffer.alloc(2);
      len.writeUInt16BE(this.credentialId.length);
      parts.push(Buffer.alloc(16), len, this.credentialId, this.#cose);
    }
    return Buffer.concat(parts);
  }

  register(challenge: string) {
    const clientDataJSON = Buffer.from(
      JSON.stringify({
        type: "webauthn.create",
        challenge,
        origin: this.origin,
        crossOrigin: false,
      }),
    );
    // UP (0x01) + UV (0x04) + AT (0x40)
    const authData = this.#authData(0x45, true);
    const attestationObject = cbor(
      new Map<Cbor, Cbor>([
        ["fmt", "none"],
        ["attStmt", new Map()],
        ["authData", authData],
      ]),
    );
    return {
      id: b64url(this.credentialId),
      rawId: b64url(this.credentialId),
      type: "public-key" as const,
      response: {
        clientDataJSON: b64url(clientDataJSON),
        attestationObject: b64url(attestationObject),
        transports: ["internal" as const],
      },
      clientExtensionResults: {},
    };
  }

  authenticate(challenge: string) {
    const clientDataJSON = Buffer.from(
      JSON.stringify({ type: "webauthn.get", challenge, origin: this.origin, crossOrigin: false }),
    );
    const authData = this.#authData(0x05, false);
    const signature = createSign("SHA256")
      .update(Buffer.concat([authData, createHash("sha256").update(clientDataJSON).digest()]))
      .sign(this.#privateKey);
    return {
      id: b64url(this.credentialId),
      rawId: b64url(this.credentialId),
      type: "public-key" as const,
      response: {
        clientDataJSON: b64url(clientDataJSON),
        authenticatorData: b64url(authData),
        signature: b64url(signature),
      },
      clientExtensionResults: {},
    };
  }
}
