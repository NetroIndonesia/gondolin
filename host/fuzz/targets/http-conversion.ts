import { HttpRequestBlockedError } from "../../src/http/utils.ts";
import {
  internalHttpRequestToWebRequest,
  internalHttpResponseToWebResponse,
  webRequestToInternalHttpRequest,
  webResponseToInternalHttpResponse,
} from "../../src/internal/http-conversion.ts";
import type {
  InternalHttpRequest,
  InternalHttpResponse,
} from "../../src/internal/http-types.ts";
import type { XorShift32 } from "../rng.ts";
import type { FuzzTarget } from "./types.ts";

/** request methods the Request constructor accepts verbatim (already uppercase) */
const METHODS = [
  "GET",
  "HEAD",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "OPTIONS",
  "MKCOL",
];

/** response statuses the Response constructor accepts (204/205/304 = null-body) */
const STATUSES = [
  200, 201, 204, 205, 206, 301, 302, 303, 304, 307, 400, 401, 403, 404, 413,
  429, 500, 502, 503, 504,
];

/** null-body statuses per fetch spec; 101/103 are excluded because Response rejects them */
const NULL_BODY_STATUSES = new Set([204, 205, 304]);

const TOKEN_CHARS =
  "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_";

/** URL path chars: no '.', no '%' — the URL parser normalizes "./" and ".." segments */
const PATH_CHARS = `${TOKEN_CHARS}~/`;

/** printable ASCII without space: header values keep their exact bytes on round trip */
const PRINTABLE = Array.from({ length: 94 }, (_, i) =>
  String.fromCharCode(33 + i),
).join("");

type Cursor = { buf: Buffer; off: number };

function take(c: Cursor, n: number): Buffer {
  const end = Math.min(c.off + n, c.buf.length);
  const slice = c.buf.subarray(c.off, end);
  c.off = end;
  return slice;
}

function nextByte(c: Cursor): number {
  return take(c, 1)[0] ?? 0;
}

function pickFrom(bytes: Buffer, charset: string): string {
  let out = "";
  for (const b of bytes) out += charset[b % charset.length];
  return out;
}

function invariant(cond: boolean | undefined, message: string): void {
  // accepts undefined so optional-chain checks (`body?.equals(...)`) stay terse
  if (!cond) throw new Error(`http-conversion: ${message}`);
}

/**
 * Compare two header records without assuming key order: `new Headers(record)`
 * does not preserve the record's insertion order on every runtime, and HTTP
 * header order carries no meaning.
 */
function assertSameHeaders(
  actual: Record<string, string>,
  expected: Record<string, string>,
  what: string,
): void {
  const actualKeys = Object.keys(actual).sort();
  const expectedKeys = Object.keys(expected).sort();
  invariant(
    JSON.stringify(actualKeys) === JSON.stringify(expectedKeys),
    `${what}: header names differ: ${JSON.stringify(actualKeys)} vs ${JSON.stringify(expectedKeys)}`,
  );
  for (const key of expectedKeys) {
    invariant(
      actual[key] === expected[key],
      `${what}: header ${key} changed: ${JSON.stringify(actual[key])} vs ${JSON.stringify(expected[key])}`,
    );
  }
}

type RequestModel = {
  method: string;
  url: string;
  /** header names already lowercased so they map 1:1 onto Headers */
  headers: Record<string, string>;
  body: Buffer | null;
};

/**
 * Decode a fuzz buffer into an internal-request-shaped model.
 * Every field is drawn from a charset the Request constructor accepts, so any
 * throw from the conversion functions (other than the documented rejections)
 * is a bug, not malformed input.
 */
function decodeRequest(input: Buffer): RequestModel {
  const c: Cursor = { buf: input, off: 0 };
  const method = METHODS[nextByte(c) % METHODS.length]!;
  const headerCount = nextByte(c) % 5;
  const headers: Record<string, string> = {};
  for (let i = 0; i < headerCount; i++) {
    const nameLen = nextByte(c);
    const valueLen = nextByte(c);
    const name = pickFrom(take(c, nameLen), TOKEN_CHARS).toLowerCase();
    const value = pickFrom(take(c, valueLen), PRINTABLE);
    if (name.length > 0) headers[name] = value;
  }
  const pathLen = nextByte(c);
  const path = pickFrom(take(c, pathLen), PATH_CHARS);
  const body = c.off < c.buf.length ? Buffer.from(c.buf.subarray(c.off)) : null;
  return { method, url: `https://h.test/${path}`, headers, body };
}

/** Mirror of decodeRequest used to build seed corpora. */
function encodeRequest(
  methodIdx: number,
  headers: Array<[string, string]>,
  path: string,
  body: Buffer | null,
): Buffer {
  const parts: Buffer[] = [Buffer.from([methodIdx, headers.length])];
  for (const [name, value] of headers) {
    parts.push(Buffer.from([name.length]));
    parts.push(Buffer.from(name, "ascii"));
    parts.push(Buffer.from([value.length]));
    parts.push(Buffer.from(value, "ascii"));
  }
  parts.push(Buffer.from([path.length]));
  parts.push(Buffer.from(path, "ascii"));
  if (body) parts.push(body);
  return Buffer.concat(parts);
}

type ResponseModel = {
  status: number;
  statusText: string;
  /** "set-cookie" is always an array, mirroring responseHeadersToRecord output */
  headers: Record<string, string | string[]>;
  body: Buffer;
};

function decodeResponse(input: Buffer): ResponseModel {
  const c: Cursor = { buf: input, off: 0 };
  const status = STATUSES[nextByte(c) % STATUSES.length]!;
  const flag = nextByte(c);
  const statusText =
    (flag & 1) === 1 ? pickFrom(take(c, nextByte(c)), PRINTABLE) : "";
  const headerCount = (flag >> 1) % 4;
  const headers: Record<string, string | string[]> = {};
  for (let i = 0; i < headerCount; i++) {
    const nameLen = nextByte(c);
    const valueLen = nextByte(c);
    const name = pickFrom(take(c, nameLen), TOKEN_CHARS).toLowerCase();
    const value = pickFrom(take(c, valueLen), PRINTABLE);
    if (name.length > 0 && name !== "set-cookie") headers[name] = value;
  }
  if ((flag & 4) === 4) {
    const cookies: string[] = [];
    const cookieCount = 1 + (nextByte(c) % 2);
    for (let i = 0; i < cookieCount; i++) {
      cookies.push(pickFrom(take(c, nextByte(c)), PRINTABLE));
    }
    headers["set-cookie"] = cookies;
  }
  const body = Buffer.from(c.buf.subarray(c.off));
  return { status, statusText, headers, body };
}

function encodeResponse(
  statusIdx: number,
  statusText: string | null,
  headers: Array<[string, string]>,
  cookies: string[] | null,
  body: Buffer,
): Buffer {
  let flag = 0;
  if (statusText !== null) flag |= 1;
  flag |= (headers.length & 3) << 1;
  if (cookies) flag |= 4;
  const parts: Buffer[] = [Buffer.from([statusIdx, flag])];
  if (statusText !== null) {
    parts.push(Buffer.from([statusText.length]));
    parts.push(Buffer.from(statusText, "ascii"));
  }
  for (const [name, value] of headers) {
    parts.push(Buffer.from([name.length]));
    parts.push(Buffer.from(name, "ascii"));
    parts.push(Buffer.from([value.length]));
    parts.push(Buffer.from(value, "ascii"));
  }
  if (cookies) {
    parts.push(Buffer.from([cookies.length - 1]));
    for (const cookie of cookies) {
      parts.push(Buffer.from([cookie.length]));
      parts.push(Buffer.from(cookie, "ascii"));
    }
  }
  parts.push(body);
  return Buffer.concat(parts);
}

function toInternalRequest(model: RequestModel): InternalHttpRequest {
  return {
    method: model.method,
    url: model.url,
    headers: model.headers,
    body: model.body,
  };
}

function chunkedStream(
  data: Buffer,
  rng: XorShift32,
): ReadableStream<Uint8Array> {
  const chunks: Buffer[] = [];
  let off = 0;
  while (off < data.length) {
    const size = rng.int(1, data.length - off);
    chunks.push(data.subarray(off, off + size));
    off += size;
  }
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (i >= chunks.length) {
        controller.close();
        return;
      }
      controller.enqueue(new Uint8Array(chunks[i]!));
      i++;
    },
  });
}

async function expectBlocked413(
  run: Promise<InternalHttpRequest>,
  what: string,
): Promise<void> {
  try {
    await run;
  } catch (err) {
    invariant(
      err instanceof HttpRequestBlockedError && err.status === 413,
      `${what}: expected 413 overflow, got ${String(err)}`,
    );
    return;
  }
  invariant(false, `${what}: body over the limit was accepted`);
}

async function checkRequest(
  model: RequestModel,
  rng: XorShift32,
): Promise<boolean> {
  const hasBody = model.body !== null;
  const isGetLike = model.method === "GET" || model.method === "HEAD";

  // internal -> web
  let web: Request | null = null;
  let blocked: HttpRequestBlockedError | null = null;
  try {
    web = internalHttpRequestToWebRequest(toInternalRequest(model));
  } catch (err) {
    if (err instanceof HttpRequestBlockedError) blocked = err;
    else throw err;
  }

  if (isGetLike && hasBody) {
    invariant(
      blocked !== null && blocked.status === 400,
      `${model.method} with a body must be rejected with 400, got ${String(blocked ?? "a Request")}`,
    );
    return false;
  }
  invariant(
    blocked === null,
    `${model.method} without a body was rejected: ${String(blocked)}`,
  );
  const request = web!;
  // Every conversion below consumes the body stream, so build a fresh
  // Request for each pass instead of reusing a disturbed one.
  const freshWeb = (): Request =>
    internalHttpRequestToWebRequest(toInternalRequest(model));

  invariant(request.method === model.method, "method changed in conversion");
  invariant(request.url === model.url, `url changed: ${request.url}`);
  const headerNames = Object.keys(model.headers);
  let webHeaderCount = 0;
  request.headers.forEach(() => {
    webHeaderCount++;
  });
  invariant(
    webHeaderCount === headerNames.length,
    `header count changed: ${webHeaderCount} vs ${headerNames.length}`,
  );
  for (const [name, value] of Object.entries(model.headers)) {
    invariant(
      request.headers.get(name) === value,
      `header ${name} changed: ${request.headers.get(name)}`,
    );
  }
  if (hasBody) {
    const webBody = Buffer.from(await request.arrayBuffer());
    invariant(
      webBody.equals(model.body!),
      `body changed: ${webBody.length} vs ${model.body!.length} bytes`,
    );
  } else {
    invariant(request.body === null, "bodyless request gained a body");
  }

  // web -> internal, buffered path (the allowBody:true config the proxy uses)
  const back = await webRequestToInternalHttpRequest(freshWeb(), {
    allowBody: true,
    maxBodyBytes: null,
  });
  invariant(back.method === model.method, "method changed on round trip");
  invariant(back.url === model.url, "url changed on round trip");
  assertSameHeaders(back.headers, model.headers, "round trip");
  if (hasBody) {
    invariant(back.body?.equals(model.body!), "body changed on round trip");
  } else {
    invariant(back.body === null, "bodyless request grew a body on round trip");
  }

  // web -> internal, head-only path: must never read a body
  if (hasBody) {
    invariant(!isGetLike, "GET/HEAD with body should have returned earlier");
    try {
      const headOnly = await webRequestToInternalHttpRequest(freshWeb(), {
        allowBody: false,
        maxBodyBytes: null,
      });
      invariant(
        false,
        `head-only conversion accepted a body: ${String(headOnly)}`,
      );
    } catch (err) {
      invariant(
        err instanceof HttpRequestBlockedError && err.status === 400,
        `head-only conversion: expected 400, got ${String(err)}`,
      );
    }
  } else {
    const headOnly = await webRequestToInternalHttpRequest(freshWeb(), {
      allowBody: false,
      maxBodyBytes: null,
    });
    invariant(headOnly.body === null, "head-only conversion kept a body");
    invariant(
      headOnly.method === model.method && headOnly.url === model.url,
      "head-only conversion changed method/url",
    );
  }

  // body limit: reject over-limit bodies with 413, keep under-limit ones intact
  const limit = rng.int(0, 32);
  if (hasBody && model.body!.length > limit) {
    await expectBlocked413(
      webRequestToInternalHttpRequest(freshWeb(), {
        allowBody: true,
        maxBodyBytes: limit,
      }),
      "buffered limit",
    );
  } else if (!isGetLike) {
    const limited = await webRequestToInternalHttpRequest(freshWeb(), {
      allowBody: true,
      maxBodyBytes: limit,
    });
    invariant(
      (limited.body === null && !hasBody) || limited.body?.equals(model.body!),
      "body changed under a limit that should fit",
    );
  }

  // stream path must agree with the buffered path for the same body bytes
  if (hasBody && !isGetLike) {
    const streamLike = {
      url: model.url,
      method: model.method,
      headers: new Headers(model.headers),
      body: chunkedStream(model.body!, rng),
      arrayBuffer: undefined,
    };
    const streamed = await webRequestToInternalHttpRequest(streamLike, {
      allowBody: true,
      maxBodyBytes: null,
    });
    invariant(
      streamed.body?.equals(model.body!),
      "streamed body differs from buffered body",
    );
    if (model.body!.length > limit) {
      await expectBlocked413(
        webRequestToInternalHttpRequest(
          {
            url: model.url,
            method: model.method,
            headers: new Headers(model.headers),
            body: chunkedStream(model.body!, rng),
            arrayBuffer: undefined,
          },
          { allowBody: true, maxBodyBytes: limit },
        ),
        "streamed limit",
      );
    }
  }

  return true;
}

async function checkResponse(
  model: ResponseModel,
  rng: XorShift32,
): Promise<boolean> {
  const internal: InternalHttpResponse = {
    status: model.status,
    statusText: model.statusText,
    headers: model.headers,
    body: model.body,
  };
  const nullBody = NULL_BODY_STATUSES.has(model.status);
  // Each conversion consumes the body stream: build a fresh Response per pass.
  const freshResponse = (): Response =>
    internalHttpResponseToWebResponse(internal);

  // internal -> web
  const web = freshResponse();
  invariant(web.status === model.status, "status changed in conversion");
  invariant(
    web.statusText === model.statusText,
    `statusText changed: ${JSON.stringify(web.statusText)}`,
  );
  if (nullBody) {
    invariant(web.body === null, `status ${model.status} kept a body`);
  } else {
    const webBody = Buffer.from(await web.arrayBuffer());
    invariant(
      webBody.equals(model.body),
      `body changed: ${webBody.length} vs ${model.body.length} bytes`,
    );
  }
  for (const [name, value] of Object.entries(model.headers)) {
    if (Array.isArray(value)) continue; // set-cookie checked below
    invariant(
      web.headers.get(name) === value,
      `header ${name} changed: ${web.headers.get(name)}`,
    );
  }
  const modelCookies = model.headers["set-cookie"];
  const webCookies = web.headers.getSetCookie();
  if (Array.isArray(modelCookies)) {
    invariant(
      JSON.stringify(webCookies) === JSON.stringify(modelCookies),
      `set-cookie changed: ${JSON.stringify(webCookies)}`,
    );
  } else {
    invariant(webCookies.length === 0, "set-cookie appeared from nowhere");
  }

  // web -> internal round trip
  const back = await webResponseToInternalHttpResponse(freshResponse(), {
    maxBodyBytes: null,
  });
  invariant(back.status === model.status, "status changed on round trip");
  invariant(
    back.statusText === (model.statusText === "" ? "OK" : model.statusText),
    `statusText changed on round trip: ${JSON.stringify(back.statusText)}`,
  );
  if (nullBody) {
    invariant(back.body.length === 0, `status ${model.status} kept a body`);
  } else {
    invariant(back.body.equals(model.body), "body changed on round trip");
  }
  for (const [name, value] of Object.entries(model.headers)) {
    if (Array.isArray(value)) continue;
    invariant(
      back.headers[name] === value,
      `header ${name} changed on round trip: ${String(back.headers[name])}`,
    );
  }
  if (Array.isArray(modelCookies)) {
    const backCookieValue = back.headers["set-cookie"];
    // responseHeadersToRecord collapses a one-element set-cookie into a plain
    // string; InternalHeaderValue accepts both shapes, so normalize before
    // comparing.
    const backCookies =
      backCookieValue === undefined
        ? []
        : Array.isArray(backCookieValue)
          ? backCookieValue
          : [backCookieValue];
    invariant(
      JSON.stringify(backCookies) === JSON.stringify(modelCookies),
      "set-cookie changed on round trip",
    );
  }

  // body limit: 502 overflow for over-limit bodies (buffered and streamed)
  const limit = rng.int(0, 32);
  if (!nullBody && model.body.length > limit) {
    try {
      await webResponseToInternalHttpResponse(freshResponse(), {
        maxBodyBytes: limit,
      });
      invariant(false, "response body over the limit was accepted");
    } catch (err) {
      invariant(
        err instanceof HttpRequestBlockedError && err.status === 502,
        `expected 502 overflow, got ${String(err)}`,
      );
    }
  } else if (!nullBody) {
    const limited = await webResponseToInternalHttpResponse(freshResponse(), {
      maxBodyBytes: limit,
    });
    invariant(limited.body.equals(model.body), "body changed under the limit");
  }

  if (!nullBody && model.body.length > 0) {
    const streamLike = {
      status: model.status,
      statusText: model.statusText,
      headers: new Headers(
        Object.entries(model.headers).flatMap(([name, value]) =>
          Array.isArray(value)
            ? value.map((item) => [name, item] as [string, string])
            : [[name, value] as [string, string]],
        ),
      ),
      body: chunkedStream(model.body, rng),
      arrayBuffer: undefined,
    };
    const streamed = await webResponseToInternalHttpResponse(streamLike, {
      maxBodyBytes: null,
    });
    invariant(
      streamed.body.equals(model.body),
      "streamed response body differs from buffered body",
    );
  }

  return true;
}

export const httpConversionTarget: FuzzTarget = {
  name: "http-conversion",
  description: "internal: web <-> internal HTTP request/response conversion",
  defaultMaxLen: 4096,
  seeds: [
    encodeRequest(0, [["accept", "text/plain"]], "index.html", null),
    encodeRequest(
      2,
      [
        ["content-type", "text/plain"],
        ["x-trace", "abc123"],
      ],
      "api/v1/items",
      Buffer.from("hello=world"),
    ),
    // GET/HEAD with a body: the documented 400 rejection path
    encodeRequest(0, [], "x", Buffer.from("b")),
    encodeRequest(1, [["accept", "*/*"]], "head", null),
    encodeRequest(5, [], "a/b", Buffer.from([1, 2, 3])),
    encodeResponse(
      0,
      "OK",
      [
        ["content-type", "text/html"],
        ["x-count", "42"],
      ],
      ["a=1", "b=2"],
      Buffer.from("<html></html>"),
    ),
    encodeResponse(2, null, [], null, Buffer.alloc(0)),
    encodeResponse(
      16,
      "Internal Server Error",
      [["server", "gond"]],
      null,
      Buffer.from("boom"),
    ),
    encodeResponse(11, "", [["x-empty", ""]], ["only=one"], Buffer.alloc(0)),
  ],
  async runOne(input: Buffer, rng: XorShift32): Promise<boolean> {
    // Odd inputs check requests, even inputs check responses: alternating
    // keeps both paths warm regardless of corpus size.
    const isRequest = (input.length + rng.int(0, 1)) % 2 === 1;
    if (isRequest) {
      return await checkRequest(decodeRequest(input), rng);
    }
    return await checkResponse(decodeResponse(input), rng);
  },
};
