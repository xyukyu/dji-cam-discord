# デプロイ手順メモ

前提: `discord-bots/gcalcord/CLAUDE.md` と同じ `ssh raspi`(鍵認証、`192.168.1.43`)が使える状態であること。
2026-07-26に実機で一通り構築・動作確認済み(`/cam start` → 実映像視聴まで成功)。

## 0. ラズパイの下調べ・前提セットアップ(確認済み)

- 機種: **Raspberry Pi 4 Model B Rev 1.5**(`aarch64` / arm64)。Node.js v22.23.1導入済み。
- Go: apt版(1.19)はdjictlのビルドに使えない(go.modがGo1.24以上を要求)。公式バイナリを別途導入:
  ```
  ssh raspi "curl -L -o /tmp/go.tar.gz https://go.dev/dl/go1.26.5.linux-arm64.tar.gz && sudo tar -C /tmp -xzf /tmp/go.tar.gz && sudo mv /tmp/go /usr/local/go-1.26"
  ```
  ビルド時は `PATH=/usr/local/go-1.26/bin:$PATH` を通す。
- Bluetooth: 内蔵コントローラがrfkillでソフトブロックされていたため解除(再起動後も保持される):
  ```
  ssh raspi "echo 0 | sudo tee /sys/class/rfkill/rfkill0/soft; sudo bluetoothctl power on"
  ```
- **ufw(ファイアウォール)が有効**で、デフォルトはLAN外からの通信を全てDROPする設定。
  RTMP(1935/tcp)をLANからだけ許可する必要がある(後述)。

## 1. djictl の導入(ビルド済み)

```
ssh raspi "git clone https://github.com/xaionaro-go/djictl.git /home/<your-user>/dji-cam-discord/src/djictl"
ssh raspi "export PATH=/usr/local/go-1.26/bin:\$PATH && cd /home/<your-user>/dji-cam-discord/src/djictl && go build -o /home/<your-user>/dji-cam-discord/bin/djictl ./cmd/djictl"
```

**重要: ビルド後に必ずcapabilityを付与する。** 付与しないと非rootユーザーでBLEデバイスを開けず
`operation not permitted` で失敗する(sudoで都度実行する必要がなくなる):
```
ssh raspi "sudo setcap 'cap_net_raw,cap_net_admin+eip' /home/<your-user>/dji-cam-discord/bin/djictl"
```
バイナリを再ビルドするたびにcapabilityは失われるので、再ビルド後は必ず再付与すること。

実機確認済みのCLI構成:
```
djictl ble scan                                            # カメラのBLEアドレスをスキャン(電源ONのカメラが近くに必要)
djictl ble --filter-device-addr <addr> connect-wifi-and-start-streaming \
  --wifi-ssid <SSID> --wifi-psk <PASSWORD> --rtmp-url <RTMP_URL> \
  [--resolution 1080p] [--bitrate-kbps 6000] [--fps 30]
```
`--filter-device-addr` は `ble` の直下(サブコマンド名の手前)に置く。

### 重要な仕様: RTMP_URLは「カメラから見た」宛先

`--rtmp-url` はカメラ自身がWiFi経由で直接接続する宛先。**`127.0.0.1`はカメラ自身を指してしまい、
ラズパイには絶対に届かない。** 必ずラズパイのLAN上の実IPアドレスを指定すること
(例: `rtmp://192.168.1.43:1935/pocket3`)。これは実際にハマった箇所なので注意。

### 重要な仕様: プロセスは配信成功後も終了しない

`connect-wifi-and-start-streaming` は配信開始に成功した後もプロセスが終了せず、
バッテリー残量などのテレメトリを毎秒出力し続ける常駐プロセスとして動作する。
`bot/index.js` は `execFile`(待機してタイムアウトで強制終了)ではなく
`spawn`(起動したら待たずに参照だけ保持)で実装している。誤って `execFile` + タイムアウトに
戻すと、配信自体は成功していても「失敗」と誤判定されるので注意。

### 発見: バッテリー残量がリアルタイムで取得できる

事前調査(README/Issueベース)では「Pocket 3ではバッテリー取得は未検証」とされていたが、
実機では `connect-wifi-and-start-streaming` 実行中、標準出力に
`interface_app_to_video_transmission_start_live_stream.go:45 battery: NN%` が毎秒出力されることを確認した。
v1のスコープ外だが、v2でステータス表示を追加する際は真っ先にこれをパースする実装を検討すること。

### ハマったポイント: 「pairing_started」の繰り返しは正常な場合がある

`--log-level debug` で見ると、ペアリングと無関係な `gimbal_status`/`keep_alive`/`battery_status`/
`pairing_started` 通知が常時1秒間隔で流れており、「nobody waits for this message」と出るのは正常。
本当に見るべきログは `connect_wifi_and_start_streaming.go` 由来の
`requesting to pair` → `is already paired`(または `waiting for PIN approve` → 承認) →
`prepare to live stream` → `requesting to connect to WiFi` → `start live stream` という一連の流れ。
これが `requesting to pair` 直後で止まって進まない場合は、前回の強制終了(kill -9等)でBluetooth/
カメラ側の状態がおかしくなっている可能性が高い。rfkillでBluetoothを一度off/onし、
**カメラ本体も電源を入れ直す**とだいたい復旧する
([xaionaro-go/djictl issue #4](https://github.com/xaionaro-go/djictl/issues/4) と同種の既知の症状)。

## 2. MediaMTX の導入

```
ssh raspi "mkdir -p /home/<your-user>/dji-cam-discord/mediamtx"
ssh raspi "curl -sL -o /tmp/mediamtx.tar.gz https://github.com/bluenviron/mediamtx/releases/download/v1.19.3/mediamtx_v1.19.3_linux_arm64.tar.gz"
ssh raspi "tar xzf /tmp/mediamtx.tar.gz -C /home/<your-user>/dji-cam-discord/mediamtx"
```
(最新版のURLは `curl -s https://api.github.com/repos/bluenviron/mediamtx/releases/latest` で確認)

このリポジトリの `mediamtx/mediamtx.yml` を配置する(`runOnAvailable`/`runOnUnavailable` は
v1.19.3で実機確認済みのキー名)。

**ufwでRTMPポートをLANからだけ許可する(重要・実際にこれで最初ハマった):**
```
ssh raspi "sudo ufw allow from 192.168.1.0/24 to any port 1935 proto tcp comment 'dji-cam RTMP (LAN only)'"
```
これを忘れると、カメラはWiFi接続・配信コマンド送信まで成功するのにRTMPパケットがラズパイに
到達せず、MediaMTX側は永久に「no stream is available」のままになる(症状だけ見ると
djictl側の問題に見えて紛らわしいので注意)。

## 3. Bot のデプロイ

```
scp -r "d:\dev\dji-cam-discord\bot" raspi:/home/<your-user>/dji-cam-discord/
ssh raspi "cd /home/<your-user>/dji-cam-discord/bot && npm install --omit=dev"
# .env をローカルで作成し scp で転送(DISCORD_BOT_TOKEN, CAMERA_BLE_ADDRESS, RTMP_URLなど)
ssh raspi "cd /home/<your-user>/dji-cam-discord/bot && node deploy-commands.js"   # スラッシュコマンド登録(初回・変更時のみ)
```

## 4. Cloudflare Tunnel(Quick Tunnelを採用)

Cloudflareに独自ドメインを登録していない場合、`cloudflared tunnel login` は
「ゾーンを選択」画面で詰む(ドメインが無いと選べるゾーンが無い)。
**ログイン不要のQuick Tunnelで十分**:
```
ssh raspi "curl -sL -o /tmp/cloudflared https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64 && sudo install -m 755 /tmp/cloudflared /usr/local/bin/cloudflared"
```
`deploy/cloudflared.service` で `cloudflared tunnel --url http://localhost:8888` を常駐実行する。

MediaMTXはHLSポート(8888)で `/<path名>/` にアクセスすると**自動生成のプレーヤーページ**を
返してくれるため、`viewer/index.html` を別途ホストする必要はない
(このリポジトリの `viewer/index.html` はカスタマイズしたくなった時の参考実装として残してある)。
`VIEWER_BASE_URL` は `https://<発行されたホスト名>.trycloudflare.com/pocket3/` を設定する。

**既知の制限**: Quick TunnelのURLは`cloudflared`再起動のたびに変わる。サービスが再起動したら
`sudo journalctl -u cloudflared.service | grep trycloudflare.com` で新URLを確認し、
`bot/.env` の `VIEWER_BASE_URL` を更新して `dji-cam-bot.service` を再起動する必要がある。
URLを固定したい場合は独自ドメインをCloudflareに登録してnamed tunnelに切り替える(将来対応)。

## 5. systemd化

```
scp "d:\dev\dji-cam-discord\deploy\dji-cam-bot.service" "d:\dev\dji-cam-discord\deploy\mediamtx.service" "d:\dev\dji-cam-discord\deploy\cloudflared.service" raspi:/tmp/
ssh raspi "sudo mv /tmp/dji-cam-bot.service /tmp/mediamtx.service /tmp/cloudflared.service /etc/systemd/system/"
ssh raspi "sudo systemctl daemon-reload"
ssh raspi "sudo systemctl enable --now mediamtx.service cloudflared.service dji-cam-bot.service"
ssh raspi "sudo journalctl -u mediamtx.service -u dji-cam-bot.service -u cloudflared.service --no-pager -n 40"
```

## 使い方

- Discordで `/cam start` → 数秒〜十数秒後にカメラがWiFi接続・配信開始し、Botが自動で
  視聴リンク付きembedをチャンネルに投稿する。
- `/cam stop` → 配信制御プロセス(djictl)を停止する。

## 以後の更新デプロイ

`discord-bots/gcalcord/CLAUDE.md` の「デプロイ運用」と同じ方針に従う:
本番ファイルをバックアップ → scpで反映 → 構文チェック(`node --check`) →
`sudo systemctl restart <service>` → `journalctl` でエラー確認。
