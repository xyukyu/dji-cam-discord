#!/bin/bash
# wlan0(オンボードWiFi/SDIO)がハングしてラズパイごと無応答になる問題への自動復旧watchdog。
# 2026-08-16、SDIOバスエラー(CMD53 write failed -110 / HW header checksum error)を起点に
# 約22時間ネットワークが死んだまま気づけなかった実例があったため導入。
set -u

STATE_DIR="/var/lib/network-watchdog"
FAIL_COUNT_FILE="$STATE_DIR/fail_count"
LAST_REBOOT_FILE="$STATE_DIR/last_reboot_epoch"
REBOOT_COOLDOWN_SEC=3600   # watchdogによる再起動は1時間に1回まで(ブートループ防止)
SOFT_RECOVERY_AT=2         # 連続失敗2回(約4分)でwlan0再接続を試みる
REBOOT_AT=5                # 連続失敗5回(約10分)でシステム再起動にエスカレーション

mkdir -p "$STATE_DIR"
[ -f "$FAIL_COUNT_FILE" ] || echo 0 > "$FAIL_COUNT_FILE"
[ -f "$LAST_REBOOT_FILE" ] || echo 0 > "$LAST_REBOOT_FILE"

GATEWAY="$(ip -4 route show default | awk '{print $3; exit}')"
if [ -z "$GATEWAY" ]; then
    echo "network-watchdog: デフォルトゲートウェイが取得できません(wlan0がリンクダウン?)"
    fail_count=$(( $(cat "$FAIL_COUNT_FILE") + 1 ))
else
    if ping -c 3 -W 3 "$GATEWAY" >/dev/null 2>&1; then
        if [ "$(cat "$FAIL_COUNT_FILE")" != "0" ]; then
            echo "network-watchdog: ゲートウェイ($GATEWAY)への疎通が回復しました"
        fi
        echo 0 > "$FAIL_COUNT_FILE"
        exit 0
    fi
    fail_count=$(( $(cat "$FAIL_COUNT_FILE") + 1 ))
    echo "network-watchdog: ゲートウェイ($GATEWAY)へのping失敗(連続${fail_count}回目)"
fi

echo "$fail_count" > "$FAIL_COUNT_FILE"

if [ "$fail_count" -eq "$SOFT_RECOVERY_AT" ]; then
    echo "network-watchdog: wlan0を再接続します(nmcli disconnect/connect)"
    nmcli device disconnect wlan0 >/dev/null 2>&1
    sleep 3
    nmcli device connect wlan0 >/dev/null 2>&1
elif [ "$fail_count" -ge "$REBOOT_AT" ]; then
    now=$(date +%s)
    last_reboot=$(cat "$LAST_REBOOT_FILE")
    elapsed=$(( now - last_reboot ))
    if [ "$elapsed" -ge "$REBOOT_COOLDOWN_SEC" ]; then
        echo "network-watchdog: wlan0再接続でも復旧せず。システムを再起動します"
        echo "$now" > "$LAST_REBOOT_FILE"
        echo 0 > "$FAIL_COUNT_FILE"
        systemctl reboot
    else
        echo "network-watchdog: ネットワーク断が継続中ですが、直近の再起動から${elapsed}秒しか経っていないため再起動を見送ります(クールダウン${REBOOT_COOLDOWN_SEC}秒)"
    fi
fi
