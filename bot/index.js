require("dotenv").config();
const { spawn } = require("child_process");
const express = require("express");
const { Client, GatewayIntentBits, EmbedBuilder } = require("discord.js");

const {
  DISCORD_BOT_TOKEN,
  CAMERA_BLE_ADDRESS,
  HOME_WIFI_SSID,
  HOME_WIFI_PASSWORD,
  RTMP_URL,
  DJICTL_PATH,
  WEBHOOK_PORT,
  VIEWER_BASE_URL,
  CLOUDFLARED_METRICS_URL,
} = process.env;

for (const [name, value] of Object.entries({
  DISCORD_BOT_TOKEN,
  CAMERA_BLE_ADDRESS,
  HOME_WIFI_SSID,
  HOME_WIFI_PASSWORD,
  RTMP_URL,
  DJICTL_PATH,
})) {
  if (!value) {
    console.error(`環境変数 ${name} が設定されていません(.envを確認)`);
    process.exit(1);
  }
}

// cloudflaredのQuick Tunnelは再起動のたびにホスト名が変わり、.envのVIEWER_BASE_URLを
// 手動更新し忘れると視聴リンクが古いまま投稿されてしまう(実際に発生した障害)。
// cloudflaredはローカルにmetricsサーバーを立てており(デフォルトで127.0.0.1:20241)、
// `/quicktunnel` エンドポイントから現在有効なホスト名を都度取得できるため、
// 配信開始のたびにそちらを優先して使う。取得に失敗した場合のみ.envの値にフォールバックする。
const quickTunnelMetricsUrl =
  CLOUDFLARED_METRICS_URL || "http://127.0.0.1:20241/quicktunnel";

async function resolveViewerUrl() {
  try {
    const res = await fetch(quickTunnelMetricsUrl, {
      signal: AbortSignal.timeout(3000),
    });
    if (res.ok) {
      const { hostname } = await res.json();
      if (hostname) {
        return `https://${hostname}/pocket3/`;
      }
    }
  } catch (err) {
    console.error(
      `cloudflaredのトンネルURL取得に失敗(${err.message})、.envのVIEWER_BASE_URLにフォールバック`
    );
  }
  if (!VIEWER_BASE_URL) {
    console.error(
      "cloudflaredのトンネルURLを取得できず、フォールバック用のVIEWER_BASE_URLも未設定です"
    );
    return null;
  }
  return VIEWER_BASE_URL;
}

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

// 直近の配信開始通知メッセージ(配信終了時にこれを編集する)
let lastStreamMessage = null;

// 固定のチャンネルIDを設定で持たず、直近で `/cam start` が実行された
// チャンネルを通知先として記憶する(サーバー/チャンネルをまたいで使い回せるように)。
let notifyChannelId = null;

// djictlの `ble connect-wifi-and-start-streaming` は配信開始後もプロセスが終了せず、
// バッテリー等のテレメトリを監視し続ける常駐プロセスとして動作する(実機確認済み、2026-07-26)。
// そのため execFile ではなく spawn で起動し、終了を待たずに参照だけ保持する。
let cameraProcess = null;

// djictlの標準出力に毎秒流れる `battery: NN%` をパースして保持する。
// 例: "interface_app_to_video_transmission_start_live_stream.go:45 battery: 78%"
const BATTERY_LINE_RE = /battery:\s*(\d+)%/;
let lastBatteryPercent = null;
let batteryUpdateInterval = null;

const BATTERY_UPDATE_INTERVAL_MS = 15_000;

// 画質設定。/cam start でオプション指定が無ければこの値(前回値)を使う。
// 初期値は自宅WiFiの電波状況を踏まえた安定寄りの設定(1080p/6000Kbpsのdjictlデフォルトより控えめ)。
let currentSettings = { resolution: "720p", bitrateKbps: 3000, fps: 30 };

function buildStreamEmbed({ ended, viewerUrl }) {
  const embed = new EmbedBuilder()
    .setColor(ended ? 0x2f3136 : 0xed4245)
    .setTimestamp(new Date());

  if (ended) {
    embed.setTitle("⚫ 配信終了");
  } else {
    embed
      .setTitle("🔴 配信開始")
      .setDescription(
        viewerUrl
          ? `[視聴ページを開く](${viewerUrl})`
          : "(視聴URLの取得に失敗しました。ラズパイのcloudflaredの状態を確認してください)"
      );
    embed.addFields({
      name: "画質設定",
      value: `${currentSettings.resolution} / ${currentSettings.bitrateKbps}Kbps / ${currentSettings.fps}fps`,
      inline: true,
    });
  }

  if (lastBatteryPercent !== null) {
    embed.addFields({
      name: "バッテリー",
      value: `${lastBatteryPercent}%`,
      inline: true,
    });
  }

  return embed;
}

function startCameraStream() {
  if (cameraProcess) {
    throw new Error("すでに配信指示中/配信中です(先に /cam stop してください)");
  }

  // 実機の `djictl ble --help` / `djictl ble connect-wifi-and-start-streaming --help`
  // で確認済みのフラグ構成(2026-07-26時点、djictl実行バイナリ 1.26系ビルド)。
  // --filter-device-addr は `ble` の直下(サブコマンドの手前)に置く必要がある。
  const child = spawn(
    DJICTL_PATH,
    [
      "ble",
      "--filter-device-addr",
      CAMERA_BLE_ADDRESS,
      "connect-wifi-and-start-streaming",
      "--wifi-ssid",
      HOME_WIFI_SSID,
      "--wifi-psk",
      HOME_WIFI_PASSWORD,
      "--rtmp-url",
      RTMP_URL,
      "--resolution",
      currentSettings.resolution,
      "--bitrate-kbps",
      String(currentSettings.bitrateKbps),
      "--fps",
      String(currentSettings.fps),
    ],
    { stdio: ["ignore", "pipe", "pipe"] }
  );

  lastBatteryPercent = null;
  cameraProcess = child;

  // djictlはINFO/DEBUログをstdoutではなくstderrに出力する(実機確認済み)。
  // どちらに出ても拾えるよう両方のストリームでバッテリー行を解析する。
  const handleOutput = (streamName, buf) => {
    const text = buf.toString();
    const log = streamName === "stderr" ? console.error : console.log;
    log(`[djictl] ${text}`.trimEnd());
    const match = text.match(BATTERY_LINE_RE);
    if (match) {
      lastBatteryPercent = Number(match[1]);
    }
  };
  child.stdout.on("data", (buf) => handleOutput("stdout", buf));
  child.stderr.on("data", (buf) => handleOutput("stderr", buf));
  child.on("exit", (code, signal) => {
    console.log(`[djictl] 終了 code=${code} signal=${signal}`);
    cameraProcess = null;
  });

  return new Promise((resolve, reject) => {
    child.once("spawn", () => resolve());
    child.once("error", (err) => {
      cameraProcess = null;
      reject(err);
    });
  });
}

// djictl(パッチ済み)はSIGTERM受信後、カメラへBLEで配信停止コマンドを送ってから
// 終了する(最大8秒程度かかる、deploy/djictl-patches/README.md参照)。
// そのため実際の終了を待たずに「停止しました」と返信すると、その数秒の間に
// /cam start を叩いたユーザーが「まだ配信中/指示中です」の誤解を招くエラーに
// 遭遇してしまう(実際に発生した問い合わせ)。ここで実終了を待ってから返信する。
const STOP_WAIT_TIMEOUT_MS = 10_000;

function stopCameraStream() {
  if (!cameraProcess) {
    return Promise.resolve({ wasRunning: false, exited: false });
  }
  const proc = cameraProcess;
  proc.kill("SIGTERM");
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      resolve({ wasRunning: true, exited: false });
    }, STOP_WAIT_TIMEOUT_MS);
    proc.once("exit", () => {
      clearTimeout(timer);
      resolve({ wasRunning: true, exited: true });
    });
  });
}

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName !== "cam") return;

  const sub = interaction.options.getSubcommand();

  if (sub === "start") {
    await interaction.deferReply();
    notifyChannelId = interaction.channelId;

    const resolution = interaction.options.getString("resolution");
    const bitrateKbps = interaction.options.getInteger("bitrate_kbps");
    const fps = interaction.options.getInteger("fps");
    if (resolution) currentSettings.resolution = resolution;
    if (bitrateKbps) currentSettings.bitrateKbps = bitrateKbps;
    if (fps) currentSettings.fps = fps;

    try {
      await startCameraStream();
      await interaction.editReply(
        `カメラにWiFi接続+配信開始を指示しました(${currentSettings.resolution} / ${currentSettings.bitrateKbps}Kbps / ${currentSettings.fps}fps)。数秒〜数十秒後に配信が始まると自動でお知らせします。`
      );
    } catch (err) {
      console.error("カメラへの配信開始指示に失敗:", err);
      await interaction.editReply(
        `配信開始の指示に失敗しました: ${err.message}`
      );
    }
    return;
  }

  if (sub === "stop") {
    await interaction.deferReply();
    const { wasRunning, exited } = await stopCameraStream();
    let message;
    if (!wasRunning) {
      message = "現在、配信指示中/配信中のプロセスはありません。";
    } else if (exited) {
      message = "配信プロセスを停止しました。";
    } else {
      message =
        "停止コマンドを送信しましたが、カメラへの応答待ちで完全な停止確認までは至りませんでした。もう少し待ってから /cam start をお試しください。";
    }
    await interaction.editReply(message);
    return;
  }
});

client.once("clientReady", () => {
  console.log(`Bot起動: ${client.user.tag}`);
});

client.login(DISCORD_BOT_TOKEN);

// --- MediaMTXからのwebhookを受信するサーバー ---

const app = express();

app.post("/stream-started", async (_req, res) => {
  res.sendStatus(200);
  if (!notifyChannelId) {
    console.error("通知先チャンネル未確定のため配信開始通知をスキップ(先に/cam startを実行してください)");
    return;
  }
  try {
    const viewerUrl = await resolveViewerUrl();
    const channel = await client.channels.fetch(notifyChannelId);
    lastStreamMessage = await channel.send({
      embeds: [buildStreamEmbed({ ended: false, viewerUrl })],
    });

    clearInterval(batteryUpdateInterval);
    batteryUpdateInterval = setInterval(async () => {
      if (!lastStreamMessage) return;
      try {
        await lastStreamMessage.edit({
          embeds: [buildStreamEmbed({ ended: false, viewerUrl })],
        });
      } catch (err) {
        console.error("バッテリー表示の更新に失敗:", err);
      }
    }, BATTERY_UPDATE_INTERVAL_MS);
  } catch (err) {
    console.error("配信開始通知の送信に失敗:", err);
  }
});

app.post("/stream-stopped", async (_req, res) => {
  res.sendStatus(200);
  clearInterval(batteryUpdateInterval);
  batteryUpdateInterval = null;
  if (!notifyChannelId) {
    return;
  }
  try {
    const channel = await client.channels.fetch(notifyChannelId);
    const embed = buildStreamEmbed({ ended: true });

    if (lastStreamMessage) {
      await lastStreamMessage.edit({ embeds: [embed] });
      lastStreamMessage = null;
    } else {
      await channel.send({ embeds: [embed] });
    }
  } catch (err) {
    console.error("配信終了通知の送信に失敗:", err);
  }
});

const port = Number(WEBHOOK_PORT) || 3100;
app.listen(port, "127.0.0.1", () => {
  console.log(`Webhookサーバーがポート${port}で待ち受け中(localhostのみ)`);
});
