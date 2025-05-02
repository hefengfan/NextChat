import { NextRequest, NextResponse } from "next/server";
import { auth } from "./auth";
import { getServerSideConfig } from "@/app/config/server";
import {
  ApiPath,
  GEMINI_BASE_URL,
  ModelProvider,
  OpenaiPath,
  Provider,
} from "@/app/constant";
import { prettyObject } from "@/app/utils/format";

const serverConfig = getServerConfig();
const ALLOWED_PATHS = new Set([...Object.values(OpenaiPath), ...Object.values(ApiPath.Google)]);

function getFilteredModels(remoteModelRes: any) {
  if (serverConfig.disableGPT4) {
    remoteModelRes.data = remoteModelRes.data.filter(
      (m: any) => !(
        m.id.startsWith("gpt-4") ||
        m.id.startsWith("chatgpt-4o") ||
        m.id.startsWith("o1") ||
        m.id.startsWith("o3") ||
        m.id === "gpt-4o-mini"
      )
    );
  }
  return remoteModelRes;
}

async function handleOpenAIRequest(req: NextRequest) {
  const response = await fetch("https://api.openai.com" + req.nextUrl.pathname, {
    headers: {
      Authorization: `Bearer ${serverConfig.openaiApiKey}`,
      "Content-Type": "application/json",
    },
    method: req.method,
    body: req.body,
  });

  if (req.nextUrl.pathname === OpenaiPath.ListModelPath && response.ok) {
    const data = await response.json();
    return NextResponse.json(getFilteredModels(data), { status: response.status });
  }

  return response;
}

async function handleGoogleRequest(req: NextRequest, apiKey: string) {
  const baseUrl = serverConfig.googleUrl || GEMINI_BASE_URL;
  const path = req.nextUrl.pathname.replace(ApiPath.Google, "");
  const url = new URL(path, baseUrl);
  
  const res = await fetch(url, {
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": apiKey,
    },
    method: req.method,
    body: req.body,
  });

  const newHeaders = new Headers(res.headers);
  newHeaders.delete("www-authenticate");
  newHeaders.set("X-Accel-Buffering", "no");

  return new Response(res.body, {
    status: res.status,
    headers: newHeaders,
  });
}

export async function handler(
  req: NextRequest,
  { params }: { params: { provider: string; path: string[] } }
) {
  try {
    // 统一认证处理
    const authResult = auth(req, params.provider as Provider);
    if (authResult.error) {
      return NextResponse.json(authResult, { status: 401 });
    }

    // 请求路由
    if (params.provider === 'openai') {
      const response = await handleOpenAIRequest(req);
      const openaiData = await response.json();
      
      // 将OpenAI响应转发给Google Gemini
      const geminiResponse = await handleGoogleRequest(
        new NextRequest(req.url, {
          body: JSON.stringify(openaiData),
          method: 'POST'
        }),
        serverConfig.googleApiKey
      );
      
      return geminiResponse;
    }

    if (params.provider === 'google') {
      return handleGoogleRequest(req, serverConfig.googleApiKey);
    }

    return NextResponse.json({ error: "Invalid provider" }, { status: 400 });

  } catch (error) {
    console.error(`[API Error] ${params.provider}`, error);
    return NextResponse.json(prettyObject(error), { status: 500 });
  }
}

// 配置
export const config = {
  runtime: "edge",
  regions: [
    "bom1", "cle1", "cpt1", "gru1", "hnd1", 
    "iad1", "icn1", "kix1", "pdx1", "sfo1",
    "sin1", "syd1"
  ],
};
