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

// Helper function to extract URLs and titles from the googleSearch tool results
function extractUrlsAndTitles(body: any): { title: string; url: string }[] {
  if (!body || !body.tools) {
    return [];
  }

  const googleSearchTool = body.tools.find(
    (tool: any) => tool.googleSearch !== undefined,
  );

  if (!googleSearchTool || !googleSearchTool.googleSearch) {
    return [];
  }

  const results = googleSearchTool.googleSearch.results;

  if (!results || !Array.isArray(results)) {
    return [];
  }

  return results.map((result: any) => ({
    title: result.title || "Untitled",
    url: result.link || result.url || "",
  }));
}


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
  let body: any;
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

  // Extract URLs and titles from the request body (assuming it contains the googleSearch tool results)
  const citations = extractUrlsAndTitles(body);

  // Construct the citation string to be added to the prompt.
  const citationString = citations
    .map(citation => `[${citation.title}](${citation.url})`)
    .join(", ");

  const instructionPrefix = `请用中文回答，并在必要时引用以下来源：${citationString}\n\n`;

  // Modify the body based on the expected API structure
  if (body && body.messages && Array.isArray(body.messages)) {
    // Chat API: Append to the last message
    const lastMessage = body.messages[body.messages.length - 1];
    if (lastMessage && lastMessage.content) {
      lastMessage.content = instructionPrefix + lastMessage.content;
    } else {
      lastMessage.content = instructionPrefix;
    }
  } else {
    // Assume a text generation API that uses a "prompt" or similar field.  Try to find it.
    let promptField = "prompt"; // Default assumption
    if (!body || typeof body !== 'object') {
        body = {}; // Ensure body is an object
    }

    if (body.hasOwnProperty("input")) {
        promptField = "input";
    } else {
        // Check for other common prompt-like field names (add more if needed)
        const possibleFields = ["text", "query"];
        for (const field of possibleFields) {
            if (body.hasOwnProperty(field)) {
                promptField = field;
                break;
            }
        }
    }

    if (body && body[promptField]) {
      body[promptField] = instructionPrefix + body[promptField];
    } else {
      // If no prompt field is found, create a "messages" array with a single message. This is a last resort.
      body.messages = [{ role: "user", content: instructionPrefix }];
    }
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
    body: JSON.stringify(body),
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

    const response = new Response(res.body, {
      status: res.status,
      statusText: res.statusText,
      headers: newHeaders,
    });

    return response;
  } finally {
    clearTimeout(timeoutId);
  }
}
