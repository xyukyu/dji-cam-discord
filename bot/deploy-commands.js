require("dotenv").config();
const { REST, Routes, SlashCommandBuilder } = require("discord.js");

const commands = [
  new SlashCommandBuilder()
    .setName("cam")
    .setDescription("DJIカメラの配信を操作する")
    .addSubcommand((sub) =>
      sub.setName("start").setDescription("カメラにWiFi接続+RTMP配信開始を指示する")
    )
    .addSubcommand((sub) =>
      sub.setName("stop").setDescription("配信制御プロセスを停止する")
    ),
].map((c) => c.toJSON());

const rest = new REST().setToken(process.env.DISCORD_BOT_TOKEN);

(async () => {
  await rest.put(
    Routes.applicationGuildCommands(
      process.env.DISCORD_CLIENT_ID,
      process.env.DISCORD_GUILD_ID
    ),
    { body: commands }
  );
  console.log("スラッシュコマンドを登録しました。");
})();
