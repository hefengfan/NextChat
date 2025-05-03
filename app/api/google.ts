import { NextRequest, NextResponse } from "next/server";
import { auth } from "./auth";
import { getServerSideConfig } from "@/app/config/server";
import { ApiPath, ModelProvider } from "@/app/constant";
import { prettyObject } from "@/app/utils/format";

const serverConfig = getServerSideConfig();

// Google Search API endpoint (replace with actual Google Search API endpoint)
const GOOGLE_SEARCH_API_ENDPOINT = "https://www.googleapis.com/customsearch/v1";

export async function handle(
  req: NextRequest,
  { params }: { params: { provider: string; path: string[] } },
) {
  console.log("[Google Route] params ", params);

  if (req.method === "OPTIONS") {
    return NextResponse.json({ body: "OK" }, { status: 200 });
  }

  const authResult = auth(req, ModelProvider.GoogleSearch); // Changed to GoogleSearch
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
    // Check if it's a Google Search request
    if (params.path[0] === "search") {
      const searchTerm = req.nextUrl.searchParams.get("q"); // Assuming 'q' is the query parameter
      if (!searchTerm) {
        return NextResponse.json(
          { error: true, message: "Missing search term 'q'" },
          { status: 400 },
        );
      }

      const cx = serverConfig.googleSearchEngineId; // Get the Search Engine ID
      if (!cx) {
        return NextResponse.json(
          { error: true, message: "Missing GOOGLE_SEARCH_ENGINE_ID in server env vars" },
          { status: 400 },
        );
      }

      const searchResponse = await googleSearch(searchTerm, apiKey, cx);
      return searchResponse;
    } else {
      // Handle other Google API requests (if any)
      const response = await request(req, apiKey);
      return response;
    }
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

  let baseUrl = serverConfig.googleUrl; // Use the config for other Google APIs, or default to Gemini
  if (!baseUrl) {
      return NextResponse.json({ error: true, message: "Missing googleUrl in server config.  This is required for non-search google API calls." }, { status: 500 });
  }

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
  const fetchOptions: RequestInit = {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "x-goog-api-key":
        req.headers.get("x-goog-api-key") ||
        (req.headers.get("Authorization") ?? "").replace("Bearer ", ""),
    },
    method: req.method,
    body: req.body,
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

    return new Response(res.body, {
      status: res.status,
      statusText: res.statusText,
      headers: newHeaders,
    });
  } finally {
    clearTimeout(timeoutId);
  }
}

async function googleSearch(searchTerm: string, apiKey: string, cx: string): Promise<NextResponse> {
  try {
    const url = `${GOOGLE_SEARCH_API_ENDPOINT}?key=${apiKey}&cx=${cx}&q=${encodeURIComponent(
      searchTerm,
    )}`;

    console.log("[Google Search URL]", url);

    const response = await fetch(url);

    if (!response.ok) {
      console.error("[Google Search Error]", response.status, response.statusText);
      return NextResponse.json(
        { error: true, message: `Google Search API error: ${response.status} ${response.statusText}` },
        { status: response.status },
      );
    }

    const data = await response.json();
    return NextResponse.json(data, { status: 200 });
  } catch (error) {
    console.error("[Google Search Fetch Error]", error);
    return NextResponse.json(
      { error: true, message: `Google Search API fetch error: ${error}` },
      { status: 500 },
    );
  }
}
