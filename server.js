const http = require("http");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");

const HOST = "0.0.0.0";
const PORT = process.env.PORT || 3000;
const ROOT_DIR = __dirname;
const GEMINI_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-pro-preview:generateContent";
const RATE_LIMITS = {
  dailyRequests: 20,
  dailyRecommendations: 10,
  hourlyRequests: 30,
};
const rateLimitStore = new Map();

loadEnvFile(path.join(ROOT_DIR, ".env"));

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
};

const server = http.createServer(async (req, res) => {
  const requestUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);

  if (req.method === "POST" && requestUrl.pathname === "/api/gemini") {
    await handleGeminiProxy(req, res);
    return;
  }

  if (req.method !== "GET" && req.method !== "HEAD") {
    sendJson(res, 405, { error: "Method Not Allowed" });
    return;
  }

  serveStaticFile(requestUrl.pathname, res, req.method);
});

server.listen(PORT, HOST, () => {
  console.log(`GiftMuse server running at http://localhost:${PORT}`);
});

function loadEnvFile(envPath) {
  if (!fs.existsSync(envPath)) return;

  const content = fs.readFileSync(envPath, "utf8");
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const separatorIndex = line.indexOf("=");
    if (separatorIndex === -1) continue;

    const key = line.slice(0, separatorIndex).trim();
    const value = line.slice(separatorIndex + 1).trim().replace(/^['"]|['"]$/g, "");
    if (key && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

async function handleGeminiProxy(req, res) {
  if (!process.env.GEMINI_API_KEY) {
    sendJson(res, 500, { error: "Missing GEMINI_API_KEY on the server." });
    return;
  }

  let bodyText = "";
  for await (const chunk of req) {
    bodyText += chunk;
    if (bodyText.length > 100_000) {
      sendJson(res, 413, { error: "Request body is too large." });
      return;
    }
  }

  let payload;
  try {
    payload = JSON.parse(bodyText || "{}");
  } catch {
    sendJson(res, 400, { error: "Request body must be valid JSON." });
    return;
  }

  if (!Array.isArray(payload.contents) || !payload.contents.length) {
    sendJson(res, 400, { error: "Missing conversation contents." });
    return;
  }

  const clientIp = getClientIp(req);
  const isRecommendationRequest = isInitialRecommendationRequest(payload);
  const limitResult = checkRateLimit(clientIp, isRecommendationRequest);
  if (!limitResult.allowed) {
    sendJson(res, 429, {
      error: limitResult.message,
      limitType: limitResult.limitType,
      remaining: limitResult.remaining,
    });
    return;
  }

  try {
    const response = await fetch(`${GEMINI_ENDPOINT}?key=${encodeURIComponent(process.env.GEMINI_API_KEY)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        system_instruction: payload.system_instruction,
        contents: payload.contents,
        generationConfig: payload.generationConfig,
      }),
    });

    const responseText = await response.text();
    res.writeHead(response.status, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    });
    res.end(responseText);
  } catch (error) {
    console.error("Gemini proxy request failed:", error);
    sendJson(res, 502, { error: "Failed to reach Gemini API." });
  }
}

function serveStaticFile(requestPath, res, method) {
  const normalizedPath = requestPath === "/" ? "/index.html" : requestPath;
  const safePath = path.normalize(normalizedPath).replace(/^(\.\.[/\\])+/, "");
  const filePath = path.join(ROOT_DIR, safePath);
  const pathSegments = safePath.split(path.sep).filter(Boolean);

  if (pathSegments.some((segment) => segment.startsWith("."))) {
    sendPlainText(res, 404, "Not Found");
    return;
  }

  if (!filePath.startsWith(ROOT_DIR)) {
    sendPlainText(res, 403, "Forbidden");
    return;
  }

  fs.stat(filePath, (statError, stats) => {
    if (statError || !stats.isFile()) {
      sendPlainText(res, 404, "Not Found");
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || "application/octet-stream";
    res.writeHead(200, {
      "Content-Type": contentType,
      "Cache-Control": "no-store",
    });

    if (method === "HEAD") {
      res.end();
      return;
    }

    fs.createReadStream(filePath).pipe(res);
  });
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(payload));
}

function sendPlainText(res, statusCode, message) {
  res.writeHead(statusCode, {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(message);
}

function getClientIp(req) {
  const forwardedFor = req.headers["x-forwarded-for"];
  if (typeof forwardedFor === "string" && forwardedFor.trim()) {
    return forwardedFor.split(",")[0].trim();
  }

  return req.socket.remoteAddress || "unknown";
}

function isInitialRecommendationRequest(payload) {
  return Array.isArray(payload.contents) && payload.contents.length === 1;
}

function checkRateLimit(clientIp, isRecommendationRequest) {
  const now = Date.now();
  const dailyWindowStart = getDayWindowStart(now);
  const hourlyWindowStart = getHourWindowStart(now);
  const entry = getOrCreateRateLimitEntry(clientIp, dailyWindowStart, hourlyWindowStart);

  if (entry.hourlyRequests >= RATE_LIMITS.hourlyRequests) {
    return buildRateLimitResult(false, "hourlyRequests", entry);
  }

  entry.hourlyRequests += 1;

  if (isRecommendationRequest) {
    if (entry.dailyRequests >= RATE_LIMITS.dailyRequests) {
      entry.hourlyRequests -= 1;
      return buildRateLimitResult(false, "dailyRequests", entry);
    }

    if (entry.dailyRecommendations >= RATE_LIMITS.dailyRecommendations) {
      entry.hourlyRequests -= 1;
      return buildRateLimitResult(false, "dailyRecommendations", entry);
    }

    entry.dailyRequests += 1;
    entry.dailyRecommendations += 1;
  }

  return {
    allowed: true,
    remaining: getRemainingCounts(entry),
  };
}

function getOrCreateRateLimitEntry(clientIp, dailyWindowStart, hourlyWindowStart) {
  const existing = rateLimitStore.get(clientIp);
  if (!existing) {
    const created = {
      dailyWindowStart,
      hourlyWindowStart,
      dailyRequests: 0,
      dailyRecommendations: 0,
      hourlyRequests: 0,
    };
    rateLimitStore.set(clientIp, created);
    cleanupRateLimitStore(nowKeyCutoff(dailyWindowStart));
    return created;
  }

  if (existing.dailyWindowStart !== dailyWindowStart) {
    existing.dailyWindowStart = dailyWindowStart;
    existing.dailyRequests = 0;
    existing.dailyRecommendations = 0;
  }

  if (existing.hourlyWindowStart !== hourlyWindowStart) {
    existing.hourlyWindowStart = hourlyWindowStart;
    existing.hourlyRequests = 0;
  }

  return existing;
}

function buildRateLimitResult(allowed, limitType, entry) {
  const messages = {
    hourlyRequests: "当前使用有点频繁，请 1 小时后再试。",
    dailyRequests: "今天的可用次数已经用完啦，明天再来找我挑礼物吧。",
    dailyRecommendations: "今天的推荐次数已经用完啦，明天再来找我挑礼物吧。",
  };

  return {
    allowed,
    limitType,
    message: messages[limitType],
    remaining: getRemainingCounts(entry),
  };
}

function getRemainingCounts(entry) {
  return {
    dailyRequests: Math.max(0, RATE_LIMITS.dailyRequests - entry.dailyRequests),
    dailyRecommendations: Math.max(0, RATE_LIMITS.dailyRecommendations - entry.dailyRecommendations),
    hourlyRequests: Math.max(0, RATE_LIMITS.hourlyRequests - entry.hourlyRequests),
  };
}

function getDayWindowStart(timestamp) {
  const date = new Date(timestamp);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function getHourWindowStart(timestamp) {
  const date = new Date(timestamp);
  date.setMinutes(0, 0, 0);
  return date.getTime();
}

function nowKeyCutoff(currentDayStart) {
  return currentDayStart - 24 * 60 * 60 * 1000;
}

function cleanupRateLimitStore(cutoff) {
  for (const [ip, entry] of rateLimitStore.entries()) {
    if (entry.dailyWindowStart < cutoff) {
      rateLimitStore.delete(ip);
    }
  }
}
