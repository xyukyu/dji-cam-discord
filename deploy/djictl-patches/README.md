# djictl パッチ: `/cam stop` でカメラの配信も止める

`djictl`(`xaionaro-go/djictl`)は本リポジトリの管理外(`deploy/NOTES.md` の手順で
ラズパイ上に直接 `git clone` & `go build` している)。そのため加えた変更はここに
パッチとして保存しておく。ラズパイを作り直す/djictlを再クローンする際は再度当てること。

## 何を直したか

元の `djictl ble connect-wifi-and-start-streaming` は、SIGTERM(Botの`/cam stop`が送る)を
受けてもプロセスをただ終了させるだけで、カメラに配信停止を指示するコマンドは一切送っていなかった。
配信自体はカメラ→ラズパイのWiFi/RTMP経路で行われBLE接続とは独立しているため、
BLE接続を切っただけではカメラは配信を続けてしまう(実機で確認済み)。

## 最初の実装がうまくいかなかった理由

SIGTERMでctxをキャンセルし、ctx.Err()を検知したらStopLiveStreamを送る、という素直な実装を
最初に試したが、実機では `unable to send the command: context deadline exceeded` で失敗した。
原因は `djible.Scan(ctx)` が渡されたctxで下位のBLEトランスポート(`gatt.NewDevice(ctx, ...)`)
を作っているため、ctxをキャンセルするとBLE接続自体(HCIソケット)ごと切断されてしまい、
その後どんなctxで書き込みを試みても物理的に送信できなくなるため。

## 採用した方式

- ctx自体はSIGTERM/SIGINTでキャンセルしない(BLE接続を生かしたままにする)。
- 代わりに `stopRequested` チャンネル(`pkg/djible/context_stop.go` で ctx 経由で運ぶ)で
  「停止要求が来たこと」だけを伝える。
- 配信中の監視ループ(バッテリー受信、約1秒間隔)で毎回 `stopRequested` を確認し、
  要求があればまだ生きているBLE接続でカメラに `StopLiveStream` を送ってから終了する。
- ペアリング中など配信ループに到達する前にSIGTERMを受けた場合のフォールバックとして、
  シグナル受信から8秒後に強制 `os.Exit(1)` する(この場合はカメラがまだ配信していないので
  停止コマンドを送る必要はなく、単純に落とせばよい)。
- 復旧用に `djictl ble stop-streaming` サブコマンドを追加。監視プロセスが既に終了しているのに
  カメラだけ配信を続けている場合(今回の検証中に実際に発生した)、これを直接叩けば止められる。

実機検証(2026-08-05)で、`/cam stop` → カメラのRTMP配信停止 → MediaMTXの`runOnUnavailable`発火 →
Discordへの「配信終了」通知、まで一連の動作を確認済み。

## 適用方法

```
ssh raspi "cd /home/yukyu/dji-cam-discord/src/djictl && git apply /tmp/stop-streaming.patch"
# ↑ 事前にこのファイルをscpで/tmp等に転送しておく
ssh raspi "export PATH=/usr/local/go-1.26/bin:\$PATH && cd /home/yukyu/dji-cam-discord/src/djictl && go build -o /home/yukyu/dji-cam-discord/bin/djictl ./cmd/djictl"
ssh raspi "sudo setcap 'cap_net_raw,cap_net_admin+eip' /home/yukyu/dji-cam-discord/bin/djictl"
```

setcapは再ビルドのたびに失われるので必ず再付与すること(`deploy/NOTES.md` 参照)。

# djictl パッチ2: 配信中のジンバル操作をUnixソケット経由で受け付ける

`gimbal-control-socket.patch`(上記の`stop-streaming.patch`適用済みの状態に対して当てる)。

## 何をするパッチか

`connect-wifi-and-start-streaming` に `--control-socket <path>` オプションを追加する。
指定すると、配信中の監視ループ(バッテリー受信ループ)がBLE接続を握ったまま、
そのUnixドメインソケットへ改行区切りJSON

```json
{"PitchDegPerSec": 20, "RollDegPerSec": 0, "YawDegPerSec": 0}
```

を書き込むことでジンバルへ速度制御コマンドを送れるようにする(`0,0,0`で停止)。
BotはWebの操作パネルからこのソケットへ中継する想定(Bot自体はカメラ用BLE接続を
持たないため、djictl側にこの受付口を作る方式を採用した。詳細は本リポジトリの
`CLAUDE.md` 参照)。

## プロトコルの出典と実機での未確認事項

ジンバルのコマンドセット(cmdSet=0x04)・速度制御コマンド(cmdId=0x0C)の
バイトレイアウトはDJI公式仕様ではなく、コミュニティのリバースエンジニアリング成果
([yigitkonur/lib-osmo-ble](https://github.com/yigitkonur/lib-osmo-ble))を移植したもの。

**結論(2026-08-23 実機検証済み): このパッチによるジンバル制御は動作しない。**
lib-osmo-ble自身も「プロトコルの見た目は正しいはずだが、20種類以上のコマンド
バリエーションを試してもOsmo Pocket 3はBLE単体では一切反応せずACKも返さなかった。
配信中(WiFi接続確立後)なら効くかもしれないが未検証」と報告していたが、本アプリで
実際に配信中(WiFi接続確立・RTMP配信中)にUnixソケット経由でコマンドを送信しても、
送信自体はエラーなく完了する(BLE書き込み自体は成功している)にもかかわらず、
カメラのジンバルは一切反応しなかった。Bot→Unixソケット→djictl→BLE送信の経路には
バグがないことを確認した上での結果であり、「BLE経由のジンバル制御コマンド送信は
(少なくともこの機種・ファームウェアでは、配信中であっても)機能しない」という
結論に至った。

このパッチのコード自体は無害(配信の起動・監視・停止には影響しない)なため
残しているが、ジンバルを実際に動かす方法としては使えない。ジンバル/ズームを
本当に動かすには、DJI Mimoアプリがジンバル操作時に実際にどの経路(BLEの別コマンド、
WiFi経由の別プロトコル等)を使っているかを、Mimoアプリとカメラ間の通信を
キャプチャして解析する必要がある(Android端末のBluetooth HCI snoop log等)。

ズーム制御は、調査した範囲のOSS(lib-osmo-ble, node-osmo, djictl本体)いずれにも
プロトコル仕様が存在しなかったため本パッチには含まれていない。実装するには
DJI Mimoアプリとカメラ間のBLE通信を別途キャプチャ・解析する必要がある。

## 適用方法

`stop-streaming.patch` を適用済みのソースに対して重ねて当てる:

```
ssh raspi "cd /home/yukyu/dji-cam-discord/src/djictl && git apply /tmp/gimbal-control-socket.patch"
ssh raspi "export PATH=/usr/local/go-1.26/bin:\$PATH && cd /home/yukyu/dji-cam-discord/src/djictl && go build -o /home/yukyu/dji-cam-discord/bin/djictl ./cmd/djictl"
ssh raspi "sudo setcap 'cap_net_raw,cap_net_admin+eip' /home/yukyu/dji-cam-discord/bin/djictl"
```

(2026-08-23、ラズパイ上のGo 1.26で`go build`/`go vet`が通ることを確認済み。
実機でのジンバル動作自体は未検証。)
