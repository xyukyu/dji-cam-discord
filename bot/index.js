require("dotenv").config();
const { spawn } = require("child_process");
const express = require("express");
const { Client, GatewayIntentBits, EmbedBuilder } = require("discord.js");

const {
  DISCORD_BOT_TOKEN,
  DISCORD_CHANNEL_ID,
  CAMERA_BLE_ADDRESS,
  HOME_WIFI_SSID,
  HOME_WIFI_PASSWORD,
  RTMP_URL,
  DJICTL_PATH,
  WEBHOOK_PORT,
  VIEWER_BASE_URL,
} = process.env;

for (const [name, value] of Object.entries({
  DISCORD_BOT_TOKEN,
  DISCORD_CHANNEL_ID,
  CAMERA_BLE_ADDRESS,
  HOME_WIFI_SSID,
  HOME_WIFI_PASSWORD,
  RTMP_URL,
  DJICTL_PATH,
  VIEWER_BASE_URL,
})) {
  if (!value) {
    console.error(`環境変数 ${name} が設定されていません(.envを確認)`);
    process.exit(1);
  }
}

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

// 直近の配信開始通知メッセージ(配信終了時にこれを編集する)
let lastStreamMessage = null;

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

function buildStreamEmbed({ ended }) {
  const embed = new EmbedBuilder()
    .setColor(ended ? 0x2f3136 : 0xed4245)
    .setTimestamp(new Date());

  if (ended) {
    embed.setTitle("⚫ 配信終了");
  } else {
    embed.setTitle("🔴 配信開始").setDescription(`[視聴ページを開く](${VIEWER_BASE_URL})`);
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

function stopCameraStream() {
  if (!cameraProcess) {
    return false;
  }
  cameraProcess.kill("SIGTERM");
  return true;
}

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName !== "cam") return;

  const sub = interaction.options.getSubcommand();

  if (sub === "start") {
    await interaction.deferReply();
    try {
      await startCameraStream();
      await interaction.editReply(
        "カメラにWiFi接続+配信開始を指示しました。数秒〜数十秒後に配信が始まると自動でお知らせします。"
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
    const stopped = stopCameraStream();
    await interaction.editReply(
      stopped
        ? "配信プロセスを停止しました。"
        : "現在、配信指示中/配信中のプロセスはありません。"
    );
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
  try {
    const channel = await client.channels.fetch(DISCORD_CHANNEL_ID);
    lastStreamMessage = await channel.send({
      embeds: [buildStreamEmbed({ ended: false })],
    });

    clearInterval(batteryUpdateInterval);
    batteryUpdateInterval = setInterval(async () => {
      if (!lastStreamMessage) return;
      try {
        await lastStreamMessage.edit({
          embeds: [buildStreamEmbed({ ended: false })],
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
  try {
    const channel = await client.channels.fetch(DISCORD_CHANNEL_ID);
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
