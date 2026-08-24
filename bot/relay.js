// MediaMTXが受信したRTMP(pocket3)をffmpegで再エンコード無しでYouTube Live等の
// 外部RTMP宛先へ中継する。中継先のURLはYouTube連携が有効な場合にのみ渡される。

const { spawn } = require("child_process");

const FFMPEG_PATH = process.env.FFMPEG_PATH || "ffmpeg";
const LOCAL_RTMP_URL = "rtmp://127.0.0.1:1935/pocket3";

let relayProcess = null;

function start(destUrl) {
  if (relayProcess) {
    stop();
  }

  const child = spawn(FFMPEG_PATH, [
    "-i",
    LOCAL_RTMP_URL,
    "-c:v",
    "copy",
    "-c:a",
    "copy",
    "-f",
    "flv",
    destUrl,
  ]);

  relayProcess = child;

  child.stderr.on("data", (buf) => {
    console.log(`[relay/ffmpeg] ${buf.toString()}`.trimEnd());
  });
  child.on("error", (err) => {
    console.error(`[relay/ffmpeg] 起動に失敗: ${err.message}`);
    relayProcess = null;
  });
  child.on("exit", (code, signal) => {
    console.log(`[relay/ffmpeg] 終了 code=${code} signal=${signal}`);
    relayProcess = null;
  });
}

function stop() {
  if (!relayProcess) return;
  relayProcess.kill("SIGTERM");
  relayProcess = null;
}

module.exports = { start, stop };
