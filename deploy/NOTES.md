# デプロイ手順メモ

前提: `discord-bots/gcalcord/CLAUDE.md` と同じ `ssh raspi`(鍵認証)が使える状態であること。
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
(例: `rtmp://192.168.1.100:1935/pocket3`)。これは実際にハマった箇所なので注意。

### 重要な仕様: プロセスは配信成功後も終了しない

`connect-wifi-and-start-streaming` は配信開始に成功した後もプロセスが終了せず、
バッテリー残量などのテレメトリを毎秒出力し続ける常駐プロセスとして動作する。
`bot/index.js` は `execFile`(待機してタイムアウトで強制終了)ではなく
`spawn`(起動したら待たずに参照だけ保持)で実装している。誤って `execFile` + タイムアウトに
戻すと、配信自体は成功していても「失敗」と誤判定されるので注意。

### 発見: バッテリー残量がリアルタイムで取得できる(v2で実装済み)

`connect-wifi-and-start-streaming` 実行中、標準"エラー"出力に
`interface_app_to_video_transmission_start_live_stream.go:45 battery: NN%` が毎秒出力される。
**djictlのINFO/DEBUログは標準出力ではなくstderrに出る**ので注意(実機で1時間ほどハマった箇所)。
`bot/index.js` は `child.stdout` と `child.stderr` の両方に同じパース処理を適用することで対応済み。
バッテリー%はDiscordの配信開始embedに15秒おきに更新表示される(`buildStreamEmbed`/`BATTERY_UPDATE_INTERVAL_MS`)。

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

### ハマったポイント: `found device` 直後で毎回接続が切れる場合はラズパイ本体の再起動が必要(2026-08-22)

`requesting to pair` にすら到達せず、`found device...initializing` の直後、最初のGATTリクエスト
送信直後に接続そのものが切れる(`--log-level trace` で見るとHCIの Disconnection Complete イベント、
理由コード `0x3E` が確認できる)場合は、上記の「rfkill off/on + カメラ再起動」では直らないことがある。

**発生の経緯:** BLE/テレメトリ無応答を検知する自動停止watchdog(コミット `417d441`)が発火した際、
その時点で既にBLEリンクが切れていたため、SIGTERM経由の「カメラへ配信停止コマンドを送る」処理が
実際にはカメラへ届かないまま強制終了していた。これが引き金でラズパイ側Bluetoothコントローラの
内部状態が不整合になり、以後の接続が全て `found device` 直後で切断されるようになった
(カメラ本体の電源再投入・工場出荷設定リセットでも直らなかった)。

**対処:** `sudo systemctl restart bluetooth`(デーモン再起動)では直らない。
**`sudo reboot` でラズパイ本体を再起動する**とBluetoothコントローラごとリセットされ復旧する。
再起動後は `djictl ble --filter-device-addr <addr> battery-info` 等の軽量コマンドで
接続が維持できる(テレメトリを継続受信できる)ことを確認してから `/cam start` を試すとよい。

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
ssh raspi "sudo ufw allow from <自宅LANのサブネット, 例: 192.168.1.0/24> to any port 1935 proto tcp comment 'dji-cam RTMP (LAN only)'"
```
これを忘れると、カメラはWiFi接続・配信コマンド送信まで成功するのにRTMPパケットがラズパイに
到達せず、MediaMTX側は永久に「no stream is available」のままになる(症状だけ見ると
djictl側の問題に見えて紛らわしいので注意)。

## 3. Bot のデプロイ

```
scp -r "d:\dev\dji-cam-discord\bot" raspi:/home/<your-user>/dji-cam-discord/
ssh raspi "cd /home/<your-user>/dji-cam-discord/bot && npm install --omit=dev"
# .env をローカルで作成し scp で転送(DISCORD_BOT_TOKEN, CAMERA_BLE_ADDRESS, RTMP_URLなど)
# VIEWER_CONTROL_PASSWORD は必須(配信ページの操作パネル用の簡易パスワード)。未設定だと起動しない。
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

**2026-08-23〜: `viewer/index.html`(YouTube風カスタムページ+操作パネル)を実際にホストする方式に変更した。**
以前はMediaMTXのHLSポート(8888)が自動生成するプレーヤーページをそのまま公開していたが、
配信ページから配信開始/停止・画質変更ができる操作パネルを追加するため、Bot自身が
静的ページ配信+操作API+MediaMTXへのHLSリバースプロキシを行う専用サーバー
(`VIEWER_PUBLIC_PORT`、デフォルト3200、127.0.0.1のみで待受け)を持つようにした。
そのため **cloudflaredの`--url`はMediaMTXの8888ではなくこのポートを指す**
(`deploy/cloudflared.service` 参照)。MediaMTXの8888自体は変更なし(ローカルのみ)。

操作パネルはCloudflare Tunnel経由で誰でも開けるページに置かれるため、
`.env` の `VIEWER_CONTROL_PASSWORD`(必須)による簡易パスワード認証を掛けている。
視聴(HLS再生)自体はパスワード不要、配信開始/停止・画質変更のAPI呼び出し時のみ必要。

**Quick TunnelのURLは`cloudflared`再起動のたびに変わる**が、`.env`を手動更新する運用は
実際に更新を忘れて古いURLのまま投稿される障害を起こした(2026-08-04)。そのため
Bot側は起動時ではなく配信開始のたびに、cloudflaredのローカルmetricsサーバー
(`deploy/cloudflared.service` で `--metrics localhost:20241` を指定)の
`http://127.0.0.1:20241/quicktunnel` から現在有効なホスト名を自動取得する
(`bot/index.js` の `resolveViewerUrl()`)。`.env`の`VIEWER_BASE_URL`はこの取得に
失敗した場合のフォールバック用途のみで、通常は空でよい。
URLそのものを固定したい場合は独自ドメインをCloudflareに登録してnamed tunnelに
切り替える(将来対応、上記の自動取得があれば必須ではない)。

### 調査メモ: ジンバル(向き)/ズームの遠隔操作は現状不可(2026-08-23)

配信ページからのカメラ操作範囲を検討する際に調査。djictl公式README(GitHub)には
「現状できるのはRTMP強制配信のみ、それ以外は開発中(WIP)」と明記されており、
ジンバル/ズームの制御コマンドは実装されていない。

OSSで唯一近いものは `yigitkonur/lib-osmo-ble`(MIT、Node.js、BLEプロトコルのリバースエンジニアリング)
で、ジンバルの速度/絶対角度/相対移動コマンドは実装されているが、README曰く
「配信(WiFiストリーミング)がアクティブでないとカメラ側がコマンドを無視する」という制限があり、
10コミット程度の初期段階の個人プロジェクト。ズーム制御はこのライブラリにも実装がない。

さらに **Osmo Pocket 3 のBLE接続は同時に1本のみ**(本ファイル冒頭・CLAUDE.md参照)のため、
配信中はdjictlが既にBLE接続を保持しており、別プロセスの`lib-osmo-ble`が同時にジンバル制御しようと
すると接続が競合する。実現するにはdjictl側の接続管理に食い込む改造が必要で、今回は見送った。
将来ジンバル連携を検討する場合はここから着手すること。

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
- `/cam stop` → カメラにBLE経由で配信停止を指示してから配信制御プロセス(djictl)を終了する
  (`deploy/djictl-patches/` 参照。カメラが実際に配信を止めるところまで実機確認済み)。
  もし監視プロセスだけが落ちてカメラだけ配信し続けている場合は
  `djictl ble --filter-device-addr <addr> stop-streaming` で個別に止められる。
- 視聴ページ自体からも配信開始/停止・画質変更ができる(ページ下部の「カメラを操作」パネル、
  `VIEWER_CONTROL_PASSWORD` の入力が必要)。視聴(HLS再生)はパスワード不要で誰でも可能。

## 以後の更新デプロイ

`discord-bots/gcalcord/CLAUDE.md` の「デプロイ運用」と同じ方針に従う:
本番ファイルをバックアップ → scpで反映 → 構文チェック(`node --check`) →
`sudo systemctl restart <service>` → `journalctl` でエラー確認。

## 6. ネットワークwatchdog(2026-08-17導入)

**背景:** 2026-08-15 23:30頃、オンボードWiFi(brcmfmac、SDIO接続)がSDIOバスエラー
(`CMD53 sg block write failed -110` / `HW header checksum error`)を起こし始め、
以後 `scan error (-110)` が延々と繰り返されて約22時間ネットワークが完全無応答になった
(CPU/メモリ/温度/under-voltageは正常で、ラズパイ本体ではなくWiFi周りの障害と判明)。
過去の頻繁な再起動(6/12, 6/16, 6/22, 8/4, 8/9等)も同種の可能性がある。
現在の接続は5GHz帯・信号強度55%とやや弱め。根本対策は**有線LANへの切り替え**
(`eth0`は存在するが未接続)だが、暫定策として自動復旧watchdogを導入した。

**仕組み(`bin/network-watchdog.sh` + `network-watchdog.timer`、2分間隔で実行):**
- デフォルトゲートウェイへのpingで疎通確認
- 連続失敗2回(約4分)で `nmcli device disconnect/connect wlan0` によるソフト復旧を試行
- 連続失敗5回(約10分)で `systemctl reboot`(ただし直近の再起動から1時間未満ならクールダウンとして見送り、ブートループを防止)

**デプロイ手順:**
```
scp "d:\dev\dji-cam-discord\deploy\network-watchdog.sh" raspi:/tmp/
scp "d:\dev\dji-cam-discord\deploy\network-watchdog.service" "d:\dev\dji-cam-discord\deploy\network-watchdog.timer" raspi:/tmp/
ssh raspi "sed -i 's#<your-user>#yukyu#g' /tmp/network-watchdog.service"
ssh raspi "mv /tmp/network-watchdog.sh /home/yukyu/dji-cam-discord/bin/network-watchdog.sh && chmod +x /home/yukyu/dji-cam-discord/bin/network-watchdog.sh"
ssh raspi "sudo mv /tmp/network-watchdog.service /tmp/network-watchdog.timer /etc/systemd/system/ && sudo systemctl daemon-reload && sudo systemctl enable --now network-watchdog.timer"
```

**動作確認・トラブルシュート:**
```
ssh raspi "systemctl status network-watchdog.timer --no-pager"
ssh raspi "sudo journalctl -u network-watchdog.service --no-pager -n 50"
```
自動リブートが発生した形跡は `journalctl -u network-watchdog.service | grep 再起動` で確認できる。

## 7. YouTube Live連携(任意機能、既定オフ)

`/cam start` だけでYouTube Live配信の作成〜開始〜停止までを自動化する機能(`bot/youtube.js`
/ `bot/relay.js`)。既定では `YOUTUBE_ENABLED=false` で無効化されており、有効化しない限り
既存の自前視聴ページのみのフローに影響しない。

**事前準備(1回のみ):**
1. 対象のYouTubeチャンネルでライブ配信を有効化する(電話番号確認が必要。反映まで最大24時間
   かかる場合があるので早めに済ませておく)。
2. Google Cloud Consoleで新規プロジェクトを作成し「YouTube Data API v3」を有効化。
3. OAuth同意画面を設定(テスト/内部利用でよい)。
4. OAuthクライアントID(種類: デスクトップアプリ)を作成し、`client_id`/`client_secret`を取得。

**refresh_tokenの取得(ローカルPC等、ブラウザが開ける環境で実行):**
```
YOUTUBE_CLIENT_ID=<client_id> YOUTUBE_CLIENT_SECRET=<client_secret> node bot/scripts/youtube-oauth-setup.js
```
表示されたURLをブラウザで開いて許可すると、refresh_tokenが標準出力に表示される。

**ラズパイ側のセットアップ:**
```
ssh raspi "sudo apt install -y ffmpeg"
ssh raspi "ffmpeg -version"   # 導入確認
```
`.env` に以下を設定してBotを再起動する:
```
YOUTUBE_ENABLED=true
YOUTUBE_CLIENT_ID=<client_id>
YOUTUBE_CLIENT_SECRET=<client_secret>
YOUTUBE_REFRESH_TOKEN=<取得したrefresh_token>
YOUTUBE_PRIVACY_STATUS=unlisted   # 公開範囲。unlisted/public/private
```

**動作確認:**
- `/cam start` → Discord embedに「YouTubeで視聴」リンクが追加される(反映まで数十秒かかる場合あり)。
- YouTube Studioの「配信」画面で状態が「LIVE」になっていることを確認。
- `/cam stop` → ラズパイ上のffmpeg中継プロセスが終了し、YouTube Studio側も「終了」になることを確認。

**注意点:**
- 中継はffmpegによる再エンコード無しコピー(`-c copy`)。ffmpeg自体が落ちても既存の
  djictl監視・ウォッチドッグとは独立しており、自動再起動はしない(ログのみ)。
- refresh_token失効・API利用制限・チャンネルのライブ配信権限無効化時はYouTube連携のみ
  失敗し、自前視聴ページ側の配信・通知は継続する(`console.error`にエラーが出るのみ)。
- `YOUTUBE_PRIVACY_STATUS=private`を使う場合、URLを知っていても視聴を許可した特定の
  Googleアカウント以外は視聴できない。配信(broadcast)は`/cam start`のたびに新規作成される
  ため、視聴させたい相手のGoogleアカウントをYouTube Studioの共有設定で都度(または
  事前にまとめて)許可する運用が必要になる(2026-08-24、本番はprivateで運用開始)。
