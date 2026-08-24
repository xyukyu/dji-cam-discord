// YouTube Live への完全自動連携(任意機能)。
// /stream-started 受信時に liveBroadcast + liveStream を自動作成・bindし、
// ffmpeg中継先のRTMP URLと視聴用URLを返す。/stream-stopped 受信時に
// broadcastをcomplete状態へ遷移させる。
//
// 依存を増やさないため googleapis は使わず、組込み fetch でREST直叩きする。

const {
  YOUTUBE_ENABLED,
  YOUTUBE_CLIENT_ID,
  YOUTUBE_CLIENT_SECRET,
  YOUTUBE_REFRESH_TOKEN,
  YOUTUBE_PRIVACY_STATUS,
} = process.env;

const API_BASE = "https://www.googleapis.com/youtube/v3";

function isEnabled() {
  return YOUTUBE_ENABLED === "true";
}

async function getAccessToken() {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: YOUTUBE_CLIENT_ID,
      client_secret: YOUTUBE_CLIENT_SECRET,
      refresh_token: YOUTUBE_REFRESH_TOKEN,
      grant_type: "refresh_token",
    }),
  });
  const json = await res.json();
  if (!res.ok) {
    throw new Error(
      `アクセストークン取得に失敗: ${json.error_description || json.error || res.status}`
    );
  }
  return json.access_token;
}

// djictlの解像度指定("720p"等)をYouTube Data APIのcdn.resolutionに変換。
// 対応外の値が来た場合はYouTube側に自動判定させる"variable"を使う。
function toYoutubeResolution(resolution) {
  const known = ["240p", "360p", "480p", "720p", "1080p", "1440p", "2160p"];
  return known.includes(resolution) ? resolution : "variable";
}

function toYoutubeFrameRate(fps) {
  if (fps === 30) return "30fps";
  if (fps === 60) return "60fps";
  return "variable";
}

async function apiRequest(accessToken, method, path, query) {
  const url = new URL(`${API_BASE}${path}`);
  for (const [key, value] of Object.entries(query || {})) {
    url.searchParams.set(key, value);
  }
  const res = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const json = await res.json();
  if (!res.ok) {
    const message = json.error?.message || res.status;
    throw new Error(`YouTube API呼び出しに失敗(${path}): ${message}`);
  }
  return json;
}

async function apiInsert(accessToken, path, part, body) {
  const url = new URL(`${API_BASE}${path}`);
  url.searchParams.set("part", part);
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!res.ok) {
    const message = json.error?.message || res.status;
    throw new Error(`YouTube API呼び出しに失敗(${path}): ${message}`);
  }
  return json;
}

async function createLiveSession({ resolution, fps }) {
  const accessToken = await getAccessToken();
  const title = `DJI Osmo Pocket 3 配信 ${new Date().toLocaleString("ja-JP")}`;

  const broadcast = await apiInsert(
    accessToken,
    "/liveBroadcasts",
    "snippet,status,contentDetails",
    {
      snippet: { title, scheduledStartTime: new Date().toISOString() },
      status: {
        privacyStatus: YOUTUBE_PRIVACY_STATUS || "unlisted",
        selfDeclaredMadeForKids: false,
      },
      contentDetails: { enableAutoStart: true, enableAutoStop: true },
    }
  );

  const stream = await apiInsert(accessToken, "/liveStreams", "snippet,cdn", {
    snippet: { title },
    cdn: {
      ingestionType: "rtmp",
      resolution: toYoutubeResolution(resolution),
      frameRate: toYoutubeFrameRate(fps),
    },
  });

  await apiRequest(accessToken, "POST", "/liveBroadcasts/bind", {
    part: "id,status",
    id: broadcast.id,
    streamId: stream.id,
  });

  const { ingestionAddress, streamName } = stream.cdn.ingestionInfo;

  return {
    broadcastId: broadcast.id,
    ingestUrl: `${ingestionAddress}/${streamName}`,
    watchUrl: `https://youtu.be/${broadcast.id}`,
  };
}

async function completeBroadcast(broadcastId) {
  const accessToken = await getAccessToken();
  try {
    await apiRequest(accessToken, "POST", "/liveBroadcasts/transition", {
      part: "id,status",
      id: broadcastId,
      broadcastStatus: "complete",
    });
  } catch (err) {
    // enableAutoStopで既にcomplete済みの場合など、失敗しても実害がないため
    // ログのみに留める。
    console.error(`YouTube broadcastのcomplete遷移に失敗(無視): ${err.message}`);
  }
}

module.exports = { isEnabled, createLiveSession, completeBroadcast };
