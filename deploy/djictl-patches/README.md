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
