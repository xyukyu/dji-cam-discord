# セットアップ手順

Discord Bot の作成から、Raspberry Pi(または同等のLinux機)での常駐稼働までの手順です。
実機構築時に発生し得るトラブルの対処法は [`deploy/NOTES.md`](deploy/NOTES.md) を参照してください。

## 前提

- Bluetooth対応のLinux機(検証環境: Raspberry Pi 4)
- Node.js 18以上
- Go 1.24以上(djictlのビルド専用)
- 自宅WiFiのSSID/パスワード

## 1. Discord Botの作成

1. [Discord Developer Portal](https://discord.com/developers/applications) で新規アプリケーションを作成する
2. 「Bot」タブでBotを追加し、トークンを発行する(後で `.env` の `DISCORD_BOT_TOKEN` に設定)
3. アプリケーションの「General Information」ページで Application ID を確認する(後で `.env` の `DISCORD_CLIENT_ID` に設定)
4. 「OAuth2」→「URL Generator」で以下を選択し、生成されたURLからBotをサーバーに招待する
   - Scopes: `bot`, `applications.commands`
   - Bot Permissions: `Send Messages`, `Embed Links`

## 2. 実行環境の準備

対象機(Raspberry Pi等)に以下を導入する。

- Node.js
- Go(公式配布のtarballを利用。ディストリのパッケージは古い場合があるため注意)
- Bluetoothを有効化(`rfkill unblock bluetooth` 等)
- ファイアウォールを使う場合、RTMP用ポート(既定1935/tcp)をLAN内からのみ許可する

## 3. djictlのビルド

```
git clone https://github.com/xaionaro-go/djictl.git
cd djictl
go build -o djictl ./cmd/djictl
sudo setcap 'cap_net_raw,cap_net_admin+eip' ./djictl
```

`setcap` により、非rootユーザーでもBLEデバイスにアクセスできるようになる。

## 4. MediaMTXの導入

```
curl -sL -o mediamtx.tar.gz \
  https://github.com/bluenviron/mediamtx/releases/latest/download/mediamtx_<version>_linux_<arch>.tar.gz
tar xzf mediamtx.tar.gz
```

このリポジトリの [`mediamtx/mediamtx.yml`](mediamtx/mediamtx.yml) を配置して起動する。

## 5. Bot本体のセットアップ

```
cd bot
npm install
cp .env.example .env   # DISCORD_BOT_TOKEN / DISCORD_CLIENT_ID / CAMERA_BLE_ADDRESS 等を編集
node deploy-commands.js   # スラッシュコマンドをグローバル登録(初回・変更時のみ)
node index.js
```

`.env` の各項目は [`bot/.env.example`](bot/.env.example) のコメントを参照。

## 6. 視聴用の外部公開(Cloudflare Tunnel)

```
cloudflared tunnel --url http://localhost:8888
```

発行されたURL(`https://xxxx.trycloudflare.com`)を `.env` の `VIEWER_BASE_URL` に設定する。

## 7. 常駐化(systemd)

[`deploy/`](deploy) 配下のunitファイル(`mediamtx.service` / `dji-cam-bot.service` / `cloudflared.service`)を
`/etc/systemd/system/` に配置し、有効化する。

```
sudo systemctl daemon-reload
sudo systemctl enable --now mediamtx.service cloudflared.service dji-cam-bot.service
```

## 動作確認

Discordのチャンネルで `/cam start` を実行し、配信開始の通知(視聴リンク付き)が投稿されれば完了。
