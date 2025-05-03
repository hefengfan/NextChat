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
    // 使用更精确的路径匹配
    const fullPath = req.nextUrl.pathname;
    if (fullPath.endsWith("/api/google/search")) { // 假设你的 Google Search API 路径是 /api/google/search
      return await handleGoogleSearch(req, apiKey);
    }

    const response = await request(req, apiKey);
    return response;
  } catch (e) {
    console.error("[Google] ", e);
    return NextResponse.json(prettyObject(e), { status: 500 }); // 添加状态码
  }
}

// 新增 Google Search 处理函数
async function handleGoogleSearch(req: NextRequest, apiKey: string) {
  const searchQuery = req.nextUrl.searchParams.get("q");
  if (!searchQuery) {
    return NextResponse.json(
      { error: true, message: "Missing search query 'q' parameter" },
      { status: 400 },
    );
  }

  if (!serverConfig.googleSearchEngineId) {
      return NextResponse.json(
          { error: true, message: "Missing Google Search Engine ID (cx) in server config" },
          { status: 500 }
      );
  }

  const searchUrl = `https://www.googleapis.com/customsearch/v1?key=${apiKey}&cx=${serverConfig.googleSearchEngineId}&q=${encodeURIComponent(searchQuery)}`;

  try {
    const response = await fetch(searchUrl);

    if (!response.ok) {
      console.error("[Google Search] API request failed with status:", response.status);
      const errorData = await response.json();
      console.error("[Google Search] Error Data:", errorData);
      return NextResponse.json({
        error: true,
        message: `Google Search API error: ${errorData?.error?.message || response.statusText}`
      }, { status: response.status });
    }

    const data = await response.json();
    return NextResponse.json(data);
  } catch (e) {
    console.error("[Google Search] ", e);
    return NextResponse.json(prettyObject(e), { status: 500 }); // 添加状态码
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
  const fetchOptions: RequestInit = {
    headers: {
      "x-goog-api-client": req.headers.get("x-goog-api-client") || "genai-js/0.21.0",
      "Content-Type": req.headers.get("Content-Type") || "application/json",
      "Cache-Control": "no-store",
      "x-goog-api-key":
        req.headers.get("x-goog-api-key") ||
        (req.headers.get("Authorization") ?? "").replace("Bearer ", ""),
    },
    method: req.method,
    body: req.body,
    redirect: "manual",
    // @ts-ignore
    duplex: "half",
    signal: controller.signal,
  };

  try {
    const res = await fetch(fetchUrl, fetchOptions);
    const newHeaders = new Headers(res.headers);
    newHeaders.delete("www-authenticate");
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
