import { NextRequest, NextResponse } from "next/server";
import { auth } from "./auth";
import { getServerSideConfig } from "@/app/config/server";
import { ApiPath, GEMINI_BASE_URL, ModelProvider } from "@/app/constant";
import { prettyObject } from "@/app/utils/format";

const serverConfig = getServerSideConfig();

async function handle(
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

  // Check if the user input is too long.  If so, skip the google search.
  const userInput = (body?.contents?.[0]?.parts?.[0]?.text || "").trim();
  const MAX_INPUT_LENGTH = 200; // Adjust this value as needed.
  const shouldSearch = userInput.length <= MAX_INPUT_LENGTH;

  // Add the tools array if it doesn't exist and we want to use googleSearch AND the input isn't too long.
  if (
    shouldSearch &&
    body &&
    typeof body === "object" &&
    !Array.isArray(body) &&
    !body.tools
  ) {
    body.tools = [{ googleSearch: {} }];
  } else if (body?.tools) {
    // If input is too long, remove the tools array to prevent Google Search.
    delete body.tools;
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

    // Check if the response is a stream (SSE)
    if (req?.nextUrl?.searchParams?.get("alt") === "sse") {
      // For SSE, just return the raw response.
      const newHeaders = new Headers(res.headers);
      newHeaders.delete("www-authenticate");
      newHeaders.set("X-Accel-Buffering", "no");

      return new Response(res.body, {
        status: res.status,
        statusText: res.statusText,
        headers: newHeaders,
      });
    } else {
      // For non-SSE, process the JSON response to include links and titles.
      const data = await res.json();

      if (shouldSearch && data?.candidates?.[0]?.content?.parts) {
        // Extract search results and append them to the response.
        const searchResults =
          data.candidates[0].content.parts.find(
            (part: any) => part.tool_calls,
          )?.tool_calls?.[0]?.function_response?.content;

        if (searchResults) {
          try {
            const searchResultsJson = JSON.parse(searchResults);

            if (searchResultsJson?.results && Array.isArray(searchResultsJson.results)) {
              const formattedResults = searchResultsJson.results.map((result: any) => {
                return `[${result.title}](${result.link})`;
              }).join("\n");

              // Append search results to the last part of the content.
              const lastPart = data.candidates[0].content.parts.pop();
              const newContent = (lastPart?.text || "") + "\n\n**Search Results:**\n" + formattedResults;
              data.candidates[0].content.parts.push({ text: newContent });
            }

          } catch (error) {
            console.error("Error parsing search results:", error);
          }
        }
      }

      const newHeaders = new Headers(res.headers);
      newHeaders.delete("www-authenticate");
      newHeaders.set("X-Accel-Buffering", "no");

      return NextResponse.json(data, {
        status: res.status,
        statusText: res.statusText,
        headers: newHeaders,
      });
    }
  } finally {
    clearTimeout(timeoutId);
  }
}
