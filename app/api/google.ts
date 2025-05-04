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

// Helper function to append citations to the AI response
// function appendCitations(
//   responseText: string,
//   citations: { title: string; url: string }[],
// ): string {
//   if (!citations || citations.length === 0) {
//     return responseText;
//   }

//   let augmentedResponse = responseText;
//   citations.forEach((citation, index) => {
//     augmentedResponse += ` [${citation.title}](${citation.url})`;
//   });

//   return augmentedResponse;
// }

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

  // Extract URLs and titles from the request body (assuming it contains the googleSearch tool results)
  const citations = extractUrlsAndTitles(body);

  // Construct the prompt augmentation with citation instructions.
  let promptAugmentation = "";
  if (citations.length > 0) {
    promptAugmentation = `\n\n请注意，我为你提供了以下搜索结果，你可以在回答中引用它们。请使用以下格式引用：[链接文本](${citations[0].url}),  [链接文本](${citations[1].url}) 等. 请用中文回答。`;
    // Example:  Please cite your sources using the format [title](url).  Answer in Chinese.
    // Note:  You can adjust the prompt to be more specific.
  } else {
    promptAugmentation = "\n\n请用中文回答。"; // Just instruct to answer in Chinese if no citations.
  }

  // Augment the prompt in the request body.  This assumes the body has a "prompt" or "messages" field.  Adjust as needed.
  if (body && body.prompt) {
    body.prompt += promptAugmentation;
  } else if (body && body.messages && Array.isArray(body.messages)) {
    // Find the last message in the array, and append the augmentation to it.
    const lastMessage = body.messages[body.messages.length - 1];
    if (lastMessage && lastMessage.content) {
      lastMessage.content += promptAugmentation;
    } else if (lastMessage) {
      lastMessage.content = promptAugmentation; // If no content, just set it.
    }
  } else {
    // If we can't find a place to inject the prompt, log it.
    console.warn("Could not inject prompt augmentation.  Request body:", body);
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

    // Read the response body as text
    const responseText = await res.text();

    // Return the response.  The AI should now generate citations itself.
    return new Response(responseText, {
      status: res.status,
      statusText: res.statusText,
      headers: newHeaders,
    });
  } finally {
    clearTimeout(timeoutId);
  }
}
