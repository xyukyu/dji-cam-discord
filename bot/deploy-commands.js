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
