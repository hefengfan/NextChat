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
    const response = await request(req, apiKey, req); // Pass the original request
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

// Function to detect if the prompt is likely code
function isLikelyCode(prompt: string): boolean {
  // Simple heuristics:  Adjust as needed
  const codeKeywords = ["function", "class", "import", "def", "for", "while", "if", "else", "return", "console.log", "print", "<", ">", "{", "}", "[", "]", "(", ")", ";", "=", "+", "-", "*", "/", "=>"];
  const codeKeywordCount = codeKeywords.filter(keyword => prompt.includes(keyword)).length;
  const codeLineCount = prompt.split('\n').filter(line => line.trim().startsWith('//') || line.trim().startsWith('#')).length;

  // Check if the prompt contains common code keywords or many code-like lines
  return codeKeywordCount >= 3 || codeLineCount >= 2; // Adjust thresholds as needed
}

async function request(req: NextRequest, apiKey: string, originalReq: NextRequest) { // Added originalReq
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

  // Parse the request body
  let body;
  try {
    body = await req.json();
  } catch (error) {
    body = {};
  }

  // Extract the prompt from the request body
  let prompt = "";
  if (body && body.messages && Array.isArray(body.messages)) {
    prompt = body.messages.map(message => message.content).join("\n");
  } else if (body && body.contents && Array.isArray(body.contents)) {
    prompt = body.contents.map(content => content.parts.map(part => part.text).join("\n")).join("\n");
  }

  // Check if the prompt is likely code
  const isCode = isLikelyCode(prompt);
  console.log("[Code Detection] isCode:", isCode);

  // Define the citation instruction (role-based)
  const citationInstruction = {
    role: "system",
    content: "You are an AI assistant whose primary function is to provide information and answer questions based on the data you have been trained on and any external sources you are given access to.  Whenever you provide information from an external source, you MUST cite it by including the URL in the format [URL](URL) immediately after the statement or piece of information.  Failure to cite sources correctly is a critical error.",
  };

  // Conditionally add the tools array based on code detection
  if (
    body &&
    typeof body === "object" &&
    !Array.isArray(body)
  ) {
    if (!isCode) {
      body.tools = [{ googleSearch: {} }];
    } else {
      delete body.tools; // Remove tools if it's code
    }
  }


  // Inject the citation instruction as the first message in the conversation
  if (body && body.messages && Array.isArray(body.messages)) {
    // Check if a system message already exists, and if so, prepend to it
    const existingSystemMessageIndex = body.messages.findIndex(message => message.role === "system");
    if (existingSystemMessageIndex !== -1) {
      body.messages[existingSystemMessageIndex].content = citationInstruction.content + "\n" + body.messages[existingSystemMessageIndex].content;
    } else {
      body.messages.unshift(citationInstruction); // Add it to the beginning
    }
  } else if (body && body.contents && Array.isArray(body.contents)) {
    // Handle the 'contents' format (less common for chat, but possible)
    // This is a simplified approach; you might need to adapt it based on the exact structure
    body.contents.unshift({ role: "system", parts: [{ text: citationInstruction.content }] });
  } else {
    // If the body doesn't have a recognized structure, log a warning
    console.warn("Warning: Request body format not recognized. Citation instruction may not be applied.");
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

    return new Response(res.body, {
      status: res.status,
      statusText: res.statusText,
      headers: newHeaders,
    });
  } finally {
    clearTimeout(timeoutId);
  }
}
