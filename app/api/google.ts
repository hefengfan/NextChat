```typescript
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

// Helper function to extract URLs from the googleSearch tool results
function extractUrls(body: any): string[] {
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

  return results.map((result: any) => result.link || result.url || "");
}


// Helper function to append citations to the AI response using only URLs
function appendCitations(
  responseText: string,
  citations: string[],
): string {
  if (!citations || citations.length === 0) {
    return responseText;
  }

  // Parse the response text to handle both plain text and JSON responses
  try {
    // Try to parse as JSON (for streaming responses)
    const responseJson = JSON.parse(responseText);
    if (responseJson.candidates && responseJson.candidates[0]?.content?.parts) {
      // This is a Gemini response with parts
      const parts = responseJson.candidates[0].content.parts;
      if (parts.length > 0 && parts[0].text) {
        let augmentedText = parts[0].text;
        citations.forEach((url, index) => {
          augmentedText += ` [${url}](${url})`; // Use URL as both text and link
        });
        parts[0].text = augmentedText;
        responseJson.candidates[0].content.parts[0].text = augmentedText; // Correctly modify the JSON object
        return JSON.stringify(responseJson);
      }
    } else if (responseJson.text) {
      // This is a simple text response
      let augmentedText = responseJson.text;
      citations.forEach((url, index) => {
        augmentedText += ` [${url}](${url})`; // Use URL as both text and link
      });
      responseJson.text = augmentedText;
      return JSON.stringify(responseJson);
    }
  } catch (e) {
    // If not JSON, treat as plain text
    let augmentedText = responseText;
    citations.forEach((url, index) => {
      augmentedText += ` [${url}](${url})`; // Use URL as both text and link
    });
    return augmentedText;
  }

  return responseText;
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

    // Read the response body as text
    let responseText = await res.text();

    // Extract URLs from the request body (assuming it contains the googleSearch tool results)
    const citations = extractUrls(body);

    // Append citations to the response text
    responseText = appendCitations(responseText, citations);

    return new Response(responseText, {
      status: res.status,
      statusText: res.statusText,
      headers: newHeaders,
    });
  } finally {
    clearTimeout(timeoutId);
  }
}
```

Key changes:

* **`extractUrls` function:** This function now extracts only the URLs from the Google Search results.
* **`appendCitations` function:** This function now takes an array of URLs as input. Inside the function, the citation is created using the URL as both the text and the link: `[${url}](${url})`.
* **Type changes:**  The type of the `citations` parameter in `appendCitations` and the return type of `extractUrls` are changed to `string[]`.

This revised code will now generate citations that display the URL directly as the clickable link text.  For example: `[https://www.example.com](https://www.example.com)`.
