import { type OpenAIListModelResponse } from "@/app/client/platforms/openai";
import { getServerSideConfig } from "@/app/config/server";
import { ModelProvider, OpenaiPath, ApiPath, GEMINI_BASE_URL } from "@/app/constant";
import { prettyObject } from "@/app/utils/format";
import { NextRequest, NextResponse } from "next/server";
import { auth } from "./auth";
import { requestOpenai } from "./common";

const ALLOWED_PATH = new Set(Object.values(OpenaiPath));
const serverConfig = getServerSideConfig();

function getModels(remoteModelRes: OpenAIListModelResponse) {
  const config = getServerSideConfig();

  if (config.disableGPT4) {
    remoteModelRes.data = remoteModelRes.data.filter(
      (m) =>
        !(
          m.id.startsWith("gpt-4") ||
          m.id.startsWith("chatgpt-4o") ||
          m.id.startsWith("o1") ||
          m.id.startsWith("o3")
        ) || m.id.startsWith("gpt-4o-mini"),
    );
  }

  return remoteModelRes;
}

async function requestGemini(req: NextRequest, apiKey: string) {
  const controller = new AbortController();

  let baseUrl = serverConfig.googleUrl || GEMINI_BASE_URL;

  let path = `${req.nextUrl.pathname}`.replaceAll(ApiPath.Google, "");

  if (!baseUrl.startsWith("http")) {
    baseUrl = `https://${baseUrl}`;
  }

  if (baseUrl.endsWith("/")) {
    baseUrl = baseUrl.slice(0, -1);
  }

  const timeoutId = setTimeout(
    () => {
      controller.abort();
    },
    10 * 60 * 1000,
  );
  
  const fetchUrl = `${baseUrl}${path}${
    req?.nextUrl?.searchParams?.get("alt") === "sse" ? "?alt=sse" : ""
  }`;

  const fetchOptions: RequestInit = {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "x-goog-api-key": apiKey,
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

async function enhanceWithGemini(openaiResponse: Response, req: NextRequest): Promise<Response> {
  try {
    // Get the OpenAI response text
    const openaiData = await openaiResponse.json();
    const openaiText = openaiData.choices?.[0]?.message?.content || openaiData;

    // Prepare the request for Gemini
    const geminiReq = new NextRequest(req);
    const geminiApiKey = serverConfig.googleApiKey;
    
    if (!geminiApiKey) {
      console.error("Missing Google API key for enhancement");
      return openaiResponse;
    }

    // Create a new request body for Gemini using the OpenAI response
    const geminiBody = JSON.stringify({
      contents: [{
        parts: [{
          text: `Please enhance the following response while keeping the original meaning and style:\n\n${openaiText}`
        }]
      }]
    });

    // @ts-ignore
    geminiReq.body = geminiBody;
    geminiReq.headers.set("Content-Type", "application/json");
    geminiReq.headers.set("x-goog-api-key", geminiApiKey);

    // Call Gemini API
    const geminiResponse = await requestGemini(geminiReq, geminiApiKey);
    const geminiData = await geminiResponse.json();

    // Extract the enhanced text from Gemini response
    const enhancedText = geminiData.candidates?.[0]?.content?.parts?.[0]?.text || openaiText;

    // Create a new response combining both
    const combinedResponse = {
      original: openaiText,
      enhanced: enhancedText,
      provider: "gemini-2.0-flash"
    };

    return new NextResponse(JSON.stringify(combinedResponse), {
      status: 200,
      headers: {
        "Content-Type": "application/json"
      }
    });
  } catch (e) {
    console.error("[Enhancement Error]", e);
    return openaiResponse;
  }
}

export async function handle(
  req: NextRequest,
  { params }: { params: { path: string[] } },
) {
  console.log("[AI Route] params ", params);

  if (req.method === "OPTIONS") {
    return NextResponse.json({ body: "OK" }, { status: 200 });
  }

  const subpath = params.path.join("/");

  if (!ALLOWED_PATH.has(subpath)) {
    console.log("[AI Route] forbidden path ", subpath);
    return NextResponse.json(
      {
        error: true,
        msg: "you are not allowed to request " + subpath,
      },
      {
        status: 403,
      },
    );
  }

  const authResult = auth(req, ModelProvider.GPT);
  if (authResult.error) {
    return NextResponse.json(authResult, {
      status: 401,
    });
  }

  try {
    const response = await requestOpenai(req);

    // list models
    if (subpath === OpenaiPath.ListModelPath && response.status === 200) {
      const resJson = (await response.json()) as OpenAIListModelResponse;
      const availableModels = getModels(resJson);
      return NextResponse.json(availableModels, {
        status: response.status,
      });
    }

    // For chat completions, enhance with Gemini
    if (subpath === OpenaiPath.ChatPath && response.status === 200) {
      const enhancedResponse = await enhanceWithGemini(response, req);
      return enhancedResponse;
    }

    return response;
  } catch (e) {
    console.error("[AI Route] ", e);
    return NextResponse.json(prettyObject(e));
  }
}

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
