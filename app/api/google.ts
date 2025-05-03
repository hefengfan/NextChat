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

    // Check if the response is a stream (SSE)
    if (req?.nextUrl?.searchParams?.get("alt") === "sse") {
      // Return the original stream without modification
      return new Response(res.body, {
        status: res.status,
        statusText: res.statusText,
        headers: newHeaders,
      });
    }

    // Modify the response body to include search results
    const responseBody = await res.text();
    let parsedBody;
    try {
      parsedBody = JSON.parse(responseBody);
    } catch (error) {
      console.error("Failed to parse response body:", error);
      return new Response(responseBody, {
        status: res.status,
        statusText: res.statusText,
        headers: newHeaders,
      });
    }

    // Extract search results and append them to the response
    if (parsedBody && parsedBody.candidates && Array.isArray(parsedBody.candidates)) {
      parsedBody.candidates = parsedBody.candidates.map(candidate => {
        if (candidate.content && candidate.content.parts && Array.isArray(candidate.content.parts)) {
          candidate.content.parts = candidate.content.parts.map(part => {
            if (typeof part.text === 'string') {
              // Regular expression to find Google Search result placeholders
              const searchResultRegex = /\[.*?google_search.*?\]/g;
              let modifiedText = part.text;
              let match;

              while ((match = searchResultRegex.exec(part.text)) !== null) {
                const placeholder = match[0];
                const searchIndex = parseInt(placeholder.match(/\d+/)![0], 10);

                // Assuming searchResults are stored in a global or accessible scope
                if (body.tools && body.tools[0].googleSearch && body.tools[0].googleSearch.results && body.tools[0].googleSearch.results[searchIndex]) {
                  const searchResult = body.tools[0].googleSearch.results[searchIndex];
                  const link = searchResult.link;
                  const title = searchResult.title;

                  // Create the markdown link
                  const markdownLink = `[${title}](${link})`;
                  modifiedText = modifiedText.replace(placeholder, markdownLink);
                } else {
                  console.warn(`Search result not found for index: ${searchIndex}`);
                }
              }
              return { text: modifiedText };
            }
            return part;
          });
        }
        return candidate;
      });
      const modifiedResponseBody = JSON.stringify(parsedBody);

      return new Response(modifiedResponseBody, {
        status: res.status,
        statusText: res.statusText,
        headers: newHeaders,
      });
    }

    return new Response(responseBody, {
      status: res.status,
      statusText: res.statusText,
      headers: newHeaders,
    });
  } finally {
    clearTimeout(timeoutId);
  }
}
