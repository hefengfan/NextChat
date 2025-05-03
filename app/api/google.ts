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

  // Parse the request body
  let body;
  try {
    body = await req.json();
  } catch (error) {
    body = {};
  }

  // Add the tools array if it doesn't exist
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
      "x-goog-api-key": apiKey,
    },
    method: req.method,
    body: JSON.stringify(body),
    redirect: "manual",
    // @ts-ignore
    duplex: "half",
    signal: controller.signal,
  };

  try {
    const res = await fetch(fetchUrl, fetchOptions);
    
    // Create new headers
    const newHeaders = new Headers(res.headers);
    newHeaders.delete("www-authenticate");
    newHeaders.set("X-Accel-Buffering", "no");
    newHeaders.set("Content-Type", "text/plain; charset=utf-8");

    if (!res.body) {
      return new Response(res.body, {
        status: res.status,
        statusText: res.statusText,
        headers: newHeaders,
      });
    }

    // Create a transform stream to process the streaming response
    const transformStream = new TransformStream({
      // Buffer to hold partial data between chunks
      partialBuffer: "",
      
      transform(chunk, controller) {
        // Decode the chunk and combine with any partial data from previous chunks
        const text = this.partialBuffer + new TextDecoder().decode(chunk);
        
        // Format URLs in markdown style
        const formattedText = text.replace(
          /(https?:\/\/[^\s"'<>{}|\\^[\]]+)/g, 
          (url) => ` [${url}](${url}) `
        );
        
        // Find the last valid URL end position
        const lastValidUrlEnd = formattedText.lastIndexOf(") ");
        if (lastValidUrlEnd === -1) {
          this.partialBuffer = text;
          return;
        }
        
        // Send the complete part
        const completePart = formattedText.substring(0, lastValidUrlEnd + 2);
        controller.enqueue(new TextEncoder().encode(completePart));
        
        // Store any remaining partial data
        this.partialBuffer = formattedText.substring(lastValidUrlEnd + 2);
      },
      
      flush(controller) {
        // Send any remaining data
        if (this.partialBuffer) {
          controller.enqueue(new TextEncoder().encode(this.partialBuffer));
        }
      }
    });

    // Pipe the original response through our transform stream
    const transformedStream = res.body.pipeThrough(transformStream);

    return new Response(transformedStream, {
      status: res.status,
      statusText: res.statusText,
      headers: newHeaders,
    });
  } finally {
    clearTimeout(timeoutId);
  }
}
