import { NextRequest, NextResponse } from "next/server";
import { auth } from "./auth";
import { getServerSideConfig } from "@/app/config/server";
import { ApiPath, GEMINI_BASE_URL, ModelProvider } from "@/app/constant";
import { prettyObject } from "@/app/utils/format";

const serverConfig = getServerSideConfig();

export async function handle(
  req: NextRequest,
  { params }: { params: { provider: string; path: string[] } },
) {
  console.log("[Google Route] params ", params);

  if (req.method === "OPTIONS") {
    return NextResponse.json({ body: "OK" }, { status: 200 });
  }

  const authResult = auth(req, ModelProvider.GeminiPro);
  if (authResult.error) {
    return NextResponse.json(authResult, {
      status: 401,
    });
  }

  const bearToken =
    req.headers.get("x-goog-api-key") || req.headers.get("Authorization") || "";
  const token = bearToken.trim().replaceAll("Bearer ", "").trim();

  const apiKey = token ? token : serverConfig.googleApiKey;

  if (!apiKey) {
    return NextResponse.json(
      {
        error: true,
        message: `missing GOOGLE_API_KEY in server env vars`,
      },
      {
        status: 401,
      },
    );
  }
  try {
    const response = await request(req, apiKey);
    return response;
  } catch (e) {
    console.error("[Google] ", e);
    return NextResponse.json(prettyObject(e));
  }
}

export const GET = handle;
export const POST = handle;

export const runtime = "edge";
export const preferredRegion = [
  "bom1",
  "cle1",
  "cpt1",
  "gru1",
  "hnd1",
  "iad1",
  "icn1",
  "kix1",
  "pdx1",
  "sfo1",
  "sin1",
  "syd1",
];

async function request(req: NextRequest, apiKey: string) {
  const controller = new AbortController();

  let baseUrl = serverConfig.googleUrl || GEMINI_BASE_URL;

  let path = `${req.nextUrl.pathname}`.replaceAll(ApiPath.Google, "");

  // Remove the specific path segment
  path = path.replace("/v1beta/models/gemini-pro:streamGenerateContent", "");

  if (!baseUrl.startsWith("http")) {
    baseUrl = `https://${baseUrl}`;
  }

  if (baseUrl.endsWith("/")) {
    baseUrl = baseUrl.slice(0, -1);
  }

  console.log("[Proxy] ", path);
  console.log("[Base Url]", baseUrl);

  const timeoutId = setTimeout(
    () => {
      controller.abort();
    },
    10 * 60 * 1000,
  );
  const fetchUrl = `${baseUrl}${path}${
    req?.nextUrl?.searchParams?.get("alt") === "sse" ? "?alt=sse" : ""
  }`;

  console.log("[Fetch Url] ", fetchUrl);

  // Parse the request body to potentially add the tools
  let body;
  try {
    body = await req.json();
  } catch (error) {
    // If the body is not JSON, or there's an error parsing it, use an empty object.
    body = {};
  }

  // Add the tools array if it doesn't exist and we want to use googleSearch
  if (
    body &&
    typeof body === "object" &&
    !Array.isArray(body) &&
    !body.tools
  ) {
    body.tools = [{ googleSearch: {} }];
  }

  const fetchOptions: RequestInit = {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "x-goog-api-key":
        req.headers.get("x-goog-api-key") ||
        (req.headers.get("Authorization") ?? "").replace("Bearer ", ""),
    },
    method: req.method,
    body: JSON.stringify(body), // Stringify the modified body
    // to fix #2485: https://stackoverflow.com/questions/55920957/cloudflare-worker-typeerror-one-time-use-body
    redirect: "manual",
    // @ts-ignore
    duplex: "half",
    signal: controller.signal,
  };

  try {
    const res = await fetch(fetchUrl, fetchOptions);
    // to prevent browser prompt for credentials
    const newHeaders = new Headers(res.headers);
    newHeaders.delete("www-authenticate");
    // to disable nginx buffering
    newHeaders.set("X-Accel-Buffering", "no");

    // Use tee() to create two independent streams
    const [body1, body2] = res.body ? res.body.tee() : [null, null];

    // Check if the stream is empty (optional, but good practice)
    if (!body1) {
        return new Response(null, { // Return an empty response
            status: res.status,
            statusText: res.statusText,
            headers: newHeaders,
        });
    }

    const transformStream = new TransformStream({
      transform(chunk, controller) {
        try {
          const text = new TextDecoder().decode(chunk);
          const urlRegex = /(https?:\/\/[^\s]+)/g;
          let formattedText = "";
          let lastIndex = 0;
          let match;

          while ((match = urlRegex.exec(text)) !== null) {
            formattedText += text.substring(lastIndex, match.index);
            formattedText += ` [${match[0]}](${match[0]}) `;
            lastIndex = urlRegex.lastIndex;
          }

          formattedText += text.substring(lastIndex);
          controller.enqueue(new TextEncoder().encode(formattedText));
        } catch (e) {
          console.error("TransformStream error:", e);
          controller.error(e); // Signal an error to the stream
        }
      },
      flush(controller) {
        // Optional: Handle any remaining data or cleanup here
      },
    }, { highWaterMark: 0 }); // Setting highWaterMark to 0 can help with backpressure

    // Pipe the *second* stream (body2) through the transform stream
    const transformedStream = body2.pipeThrough(transformStream);

    return new Response(transformedStream, {
      status: res.status,
      statusText: res.statusText,
      headers: newHeaders,
    });

  } catch (e) {
    console.error("Fetch error:", e);
    return new NextResponse(JSON.stringify({ error: "Fetch failed", details: e }), { status: 500 });
  } finally {
    clearTimeout(timeoutId);
  }
}
