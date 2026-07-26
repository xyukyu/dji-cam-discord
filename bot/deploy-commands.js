require("dotenv").config();
const { REST, Routes, SlashCommandBuilder } = require("discord.js");

const commands = [
  new SlashCommandBuilder()
    .setName("cam")
    .setDescription("DJIカメラの配信を操作する")
    .addSubcommand((sub) =>
      sub
        .setName("start")
        .setDescription("カメラにWiFi接続+RTMP配信開始を指示する")
        .addStringOption((opt) =>
          opt
            .setName("resolution")
            .setDescription("解像度(未指定なら前回値/デフォルト720p)")
            .addChoices(
              { name: "480p", value: "480p" },
              { name: "720p", value: "720p" },
              { name: "1080p", value: "1080p" }
            )
        )
        .addIntegerOption((opt) =>
          opt
            .setName("bitrate_kbps")
            .setDescription("ビットレート(Kbps、未指定なら前回値/デフォルト3000)")
            .setMinValue(500)
            .setMaxValue(8000)
        )
        .addIntegerOption((opt) =>
          opt
            .setName("fps")
            .setDescription("フレームレート(未指定なら前回値/デフォルト30)")
            .addChoices({ name: "25", value: 25 }, { name: "30", value: 30 })
        )
    )
    .addSubcommand((sub) =>
      sub.setName("stop").setDescription("配信制御プロセスを停止する")
    ),
].map((c) => c.toJSON());

const rest = new REST().setToken(process.env.DISCORD_BOT_TOKEN);

(async () => {
  // グローバル登録: どのサーバーにBotを招待しても使える(ギルドID不要)。
  // ただし反映まで最大1時間ほどかかる(ギルド限定登録は即時だがサーバーごとの設定が必要になる)。
  await rest.put(Routes.applicationCommands(process.env.DISCORD_CLIENT_ID), {
    body: commands,
  });
  console.log(
    "スラッシュコマンドをグローバル登録しました(反映まで最大1時間ほどかかる場合があります)。"
  );
})();
