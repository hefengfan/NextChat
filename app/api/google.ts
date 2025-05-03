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
    body.tools = [{ function_declarations: [
        {
          name: "google_search",
          description: "Use Google Search to find relevant information.",
          parameters: {
            type: "OBJECT",
            properties: {
              query: {
                type: "STRING",
                description: "The search query to use."
              }
            },
            required: ["query"]
          }
        }
      ] }];
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

    // Handle streaming responses (SSE)
    if (req?.nextUrl?.searchParams?.get("alt") === "sse") {
      const reader = res.body?.getReader();
      if (!reader) {
        return new NextResponse("Failed to read response body", { status: 500 });
      }

      const encoder = new TextEncoder();
      const decoder = new TextDecoder();

      return new ReadableStream({
        async start(controller) {
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) {
                controller.close();
                break;
              }

              const text = decoder.decode(value);
              // Process the SSE data to extract search results and format them

              const processedText = await processSSEData(text);

              if (processedText) {
                controller.enqueue(encoder.encode(processedText));
              } else {
                controller.enqueue(encoder.encode(text)); // Pass through original data if processing fails or is not needed
              }
            }
          } catch (error) {
            console.error("Error during SSE processing:", error);
            controller.error(error);
          } finally {
            reader.releaseLock();
            clearTimeout(timeoutId);
          }
        },
      }, { headers: newHeaders });
    }

    return new Response(res.body, {
      status: res.status,
      statusText: res.statusText,
      headers: newHeaders,
    });
  } finally {
    clearTimeout(timeoutId);
  }
}

async function processSSEData(data: string): Promise<string | null> {
  // Split the data into individual SSE events
  const events = data.split("data: ").filter(Boolean);

  let searchResults = [];

  for (const event of events) {
    try {
      const jsonString = event.trim();

      // Attempt to parse the JSON string
      const parsedData = JSON.parse(jsonString);

      // Check if the function call is a google_search result
      if (parsedData?.candidates?.[0]?.content?.parts) {
        parsedData.candidates[0].content.parts.forEach(part => {
          if (part.function_response?.name === 'google_search') {
            const searchResult = JSON.parse(part.function_response.content);
            if (searchResult?.results && Array.isArray(searchResult.results)) {
              searchResults = searchResult.results.map(result => ({
                title: result.title,
                link: result.link,
              }));
            }
          }
        });
      }
    } catch (error) {
      console.error("Error parsing JSON:", error);
      return null; // Return null if parsing fails to avoid crashing the stream
    }
  }

  // If search results are found, format them into a markdown list
  if (searchResults.length > 0) {
    const formattedResults = searchResults
      .map((result) => `- [${result.title}](${result.link})`)
      .join("\n");
    return `\n\n**Search Results:**\n${formattedResults}\n\n`;
  }

  return null; // Return null if no search results are found
}
